#!/usr/bin/env node
// Selects which packages/* need their e2e suite run: those that changed
// themselves, or whose direct in-monorepo dependency changed. Falls back to
// running everything when the diff can't be computed or shared root config
// changed, since skipping e2e silently is worse than an extra run.
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync, appendFileSync} from 'node:fs';
import {join} from 'node:path';

const PACKAGES_DIR = join(process.cwd(), 'packages');
const baseSha = process.env.BASE_SHA;
const headSha = process.env.HEAD_SHA || 'HEAD';
const githubOutput = process.env.GITHUB_OUTPUT;

const packageDirs = readdirSync(PACKAGES_DIR, {withFileTypes: true})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((dir) => existsSync(join(PACKAGES_DIR, dir, 'package.json')));

const pkgByDir = new Map();
const nameToDir = new Map();
for (const dir of packageDirs) {
  const pkg = JSON.parse(readFileSync(join(PACKAGES_DIR, dir, 'package.json'), 'utf8'));
  pkgByDir.set(dir, pkg);
  nameToDir.set(pkg.name, dir);
}

function hasRealE2eScript(pkg) {
  const script = pkg.scripts && pkg.scripts['test:e2e'];
  return Boolean(script) && !script.includes('echo') && !script.includes('No e2e tests');
}

const e2eDirs = packageDirs.filter((dir) => hasRealE2eScript(pkgByDir.get(dir)));

function selectAll(reason) {
  console.log(`Running e2e for all packages with a test:e2e script: ${reason}`);
  return e2eDirs;
}

function directWorkspaceDeps(pkg) {
  const deps = {...pkg.dependencies, ...pkg.devDependencies};
  return Object.keys(deps)
    .map((depName) => nameToDir.get(depName))
    .filter(Boolean);
}

let selected;
if (!baseSha || /^0+$/.test(baseSha)) {
  selected = selectAll('no usable base commit to diff against');
} else {
  let changedFiles;
  try {
    changedFiles = execFileSync('git', ['diff', '--name-only', `${baseSha}...${headSha}`], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
  } catch (err) {
    console.log(`git diff failed: ${err.message}`);
    changedFiles = null;
  }

  if (changedFiles === null) {
    selected = selectAll('failed to compute the diff');
  } else if (changedFiles.some((file) => !file.startsWith('packages/'))) {
    selected = selectAll('shared root config/tooling changed');
  } else {
    const changedDirs = new Set(
      changedFiles.map((file) => file.match(/^packages\/([^/]+)\//)?.[1]).filter(Boolean),
    );
    console.log(`Changed packages: ${[...changedDirs].join(', ') || '(none)'}`);

    selected = e2eDirs.filter((dir) => {
      if (changedDirs.has(dir)) {
        return true;
      }
      return directWorkspaceDeps(pkgByDir.get(dir)).some((depDir) => changedDirs.has(depDir));
    });
  }
}

console.log('Packages selected for e2e:');
for (const dir of selected) {
  console.log(`  - ${dir}`);
}

const packagesJson = JSON.stringify(selected);
if (githubOutput) {
  appendFileSync(githubOutput, `packages=${packagesJson}\n`);
} else {
  console.log(packagesJson);
}
