#!/usr/bin/env node
/* eslint-disable no-console */
// Selects which packages/* need their e2e suite run: those that changed
// themselves, or whose direct in-monorepo dependency changed. Falls back to
// running everything when the diff can't be computed or shared root config
// changed, since skipping e2e silently is worse than an extra run.
import {execFile} from 'node:child_process';
import {readFile, readdir, appendFile, access} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

const PACKAGES_DIR = join(process.cwd(), 'packages');
const baseSha = process.env.BASE_SHA;
const headSha = process.env.HEAD_SHA || 'HEAD';
const githubOutput = process.env.GITHUB_OUTPUT;

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function hasRealE2eScript(pkg) {
  const script = pkg.scripts && pkg.scripts['test:e2e'];
  return Boolean(script) && !script.includes('echo') && !script.includes('No e2e tests');
}

function directWorkspaceDeps(pkg, nameToDir) {
  const deps = {...pkg.dependencies, ...pkg.devDependencies};
  return Object.keys(deps)
    .map((depName) => nameToDir.get(depName))
    .filter(Boolean);
}

async function main() {
  const entries = await readdir(PACKAGES_DIR, {withFileTypes: true});
  const candidateDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const packageDirs = (
    await Promise.all(
      candidateDirs.map(async (dir) => ((await pathExists(join(PACKAGES_DIR, dir, 'package.json'))) ? dir : null)),
    )
  ).filter(Boolean);

  const pkgByDir = new Map();
  const nameToDir = new Map();
  await Promise.all(
    packageDirs.map(async (dir) => {
      const pkg = JSON.parse(await readFile(join(PACKAGES_DIR, dir, 'package.json'), 'utf8'));
      pkgByDir.set(dir, pkg);
      nameToDir.set(pkg.name, dir);
    }),
  );

  const e2eDirs = packageDirs.filter((dir) => hasRealE2eScript(pkgByDir.get(dir)));

  function selectAll(reason) {
    console.log(`Running e2e for all packages with a test:e2e script: ${reason}`);
    return e2eDirs;
  }

  let selected;
  if (!baseSha || /^0+$/.test(baseSha)) {
    selected = selectAll('no usable base commit to diff against');
  } else {
    let changedFiles;
    try {
      const {stdout} = await execFileAsync('git', ['diff', '--name-only', `${baseSha}...${headSha}`]);
      changedFiles = stdout.split('\n').filter(Boolean);
    } catch (err) {
      console.log(`git diff failed: ${err.message}`);
      changedFiles = null;
    }

    if (changedFiles === null) {
      selected = selectAll('failed to compute the diff');
    } else if (changedFiles.some((file) => !file.startsWith('packages/'))) {
      selected = selectAll('shared root config/tooling changed');
    } else {
      const changedDirs = new Set(changedFiles.map((file) => file.match(/^packages\/([^/]+)\//)?.[1]).filter(Boolean));
      console.log(`Changed packages: ${[...changedDirs].join(', ') || '(none)'}`);

      selected = e2eDirs.filter((dir) => {
        if (changedDirs.has(dir)) {
          return true;
        }
        return directWorkspaceDeps(pkgByDir.get(dir), nameToDir).some((depDir) => changedDirs.has(depDir));
      });
    }
  }

  console.log('Packages selected for e2e:');
  for (const dir of selected) {
    console.log(`  - ${dir}`);
  }

  const packagesJson = JSON.stringify(selected);
  if (githubOutput) {
    await appendFile(githubOutput, `packages=${packagesJson}\n`);
  } else {
    console.log(packagesJson);
  }
}

await main();
