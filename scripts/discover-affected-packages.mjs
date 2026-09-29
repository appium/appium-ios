#!/usr/bin/env node
/* eslint-disable no-console */
// Selects which packages/* are affected by the current diff, for two purposes:
//   - e2e: a package that changed itself, OR whose direct in-monorepo dependency changed (e.g. a
//     packages/coresim change also runs packages/simulator's e2e, since simulator depends on it
//     and a coresim regression can only show up there) - but a shared root config/tooling change
//     does NOT widen this to every package, since e2e runs are the expensive one to run
//     unnecessarily on a signal that untargeted.
//   - unit: the same self-or-direct-dependency rule as e2e, OR every package when a shared root
//     config/tooling file changed (cheap enough to be the safety net for "something outside any
//     single package might affect everyone" instead of e2e).
// Excludes packages with their own dedicated, path-scoped CI (tuntap-ci.yml/coresim-ci.yml/
// remote-debugger-ci.yml) from both e2e and unit selection - they're never installed here.
// Falls back to running everything (e2e included) only when the diff itself can't be
// computed at all - there's no changed-file list to scope e2e against in that case, and
// skipping tests silently is worse than an extra run.
import {execFile} from 'node:child_process';
import {readFile, readdir, appendFile, access} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

const PACKAGES_DIR = join(process.cwd(), 'packages');
// Have their own dedicated CI (tuntap-ci.yml/coresim-ci.yml/remote-debugger-ci.yml) - never
// installed/run here.
const DEDICATED_CI_DIRS = new Set(['tuntap', 'coresim', 'remote-debugger']);
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

// A dir is selected if it changed itself, or if any of its direct in-monorepo dependencies did.
function selectSelfOrDependency(dirs, changedDirs, pkgByDir, nameToDir) {
  return dirs.filter((dir) => {
    if (changedDirs.has(dir)) {
      return true;
    }
    return directWorkspaceDeps(pkgByDir.get(dir), nameToDir).some((depDir) => changedDirs.has(depDir));
  });
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

  const e2eDirs = packageDirs.filter((dir) => !DEDICATED_CI_DIRS.has(dir) && hasRealE2eScript(pkgByDir.get(dir)));
  const unitDirs = packageDirs.filter((dir) => !DEDICATED_CI_DIRS.has(dir));

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
    } else {
      const changedDirs = new Set(changedFiles.map((file) => file.match(/^packages\/([^/]+)\//)?.[1]).filter(Boolean));
      const sharedRootChanged = changedFiles.some((file) => !file.startsWith('packages/'));
      console.log(`Changed packages: ${[...changedDirs].join(', ') || '(none)'}`);
      if (sharedRootChanged) {
        console.log(
          'Shared root config/tooling also changed - widening unit test selection to all packages (e2e stays scoped to actual package changes).',
        );
      }

      const e2eSelected = selectSelfOrDependency(e2eDirs, changedDirs, pkgByDir, nameToDir);
      const unitSelected = sharedRootChanged
        ? unitDirs
        : selectSelfOrDependency(unitDirs, changedDirs, pkgByDir, nameToDir);
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
