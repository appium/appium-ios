#!/usr/bin/env node
/* eslint-disable no-console */
// Selects which packages/* are affected by the current diff, for two purposes:
//   - e2e: only a package that changed itself (a dependency bump doesn't need a full
//     downstream e2e run - the dependency's own unit tests already cover that).
//   - unit: a package that changed itself, OR whose direct in-monorepo dependency changed
//     (a shared dep's behavior can break a dependent package's unit tests too).
// Excludes packages/tuntap and packages/coresim from unit selection - they have their own
// dedicated, path-scoped CI (tuntap-ci.yml/coresim-ci.yml) and are never installed here.
// Falls back to running everything when the diff can't be computed or shared root config
// changed, since skipping tests silently is worse than an extra run.
import {execFile} from 'node:child_process';
import {readFile, readdir, appendFile, access} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

const PACKAGES_DIR = join(process.cwd(), 'packages');
// Have their own dedicated CI (tuntap-ci.yml/coresim-ci.yml) - never installed/run here.
const UNIT_TEST_IGNORE_DIRS = new Set(['tuntap', 'coresim']);
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
  const unitDirs = packageDirs.filter((dir) => !UNIT_TEST_IGNORE_DIRS.has(dir));

  function selectAll(reason) {
    console.log(`Running tests for all packages: ${reason}`);
    return {e2e: e2eDirs, unit: unitDirs};
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

      const e2eSelected = e2eDirs.filter((dir) => changedDirs.has(dir));
      const unitSelected = unitDirs.filter((dir) => {
        if (changedDirs.has(dir)) {
          return true;
        }
        return directWorkspaceDeps(pkgByDir.get(dir), nameToDir).some((depDir) => changedDirs.has(depDir));
      });
      selected = {e2e: e2eSelected, unit: unitSelected};
    }
  }

  console.log('Packages selected for e2e:');
  for (const dir of selected.e2e) {
    console.log(`  - ${dir}`);
  }
  console.log('Packages selected for unit tests:');
  for (const dir of selected.unit) {
    console.log(`  - ${dir}`);
  }

  const e2ePackagesJson = JSON.stringify(selected.e2e);
  // lerna --scope needs npm package names, not directory names.
  const unitPackageNamesJson = JSON.stringify(selected.unit.map((dir) => pkgByDir.get(dir).name));
  if (githubOutput) {
    await appendFile(githubOutput, `e2e_packages=${e2ePackagesJson}\n`);
    await appendFile(githubOutput, `unit_packages=${unitPackageNamesJson}\n`);
  } else {
    console.log(e2ePackagesJson);
    console.log(unitPackageNamesJson);
  }
}

await main();
