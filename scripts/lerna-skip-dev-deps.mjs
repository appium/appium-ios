// Runs lerna, ignoring packages whose commits since their last release are all `chore(deps-dev)`.
// Usage: node scripts/lerna-skip-dev-deps.mjs <lerna args...>
import {execFile, spawn} from 'node:child_process';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/** @returns {Promise<string|null>} the package's glob if it only has dev-dep commits, else null */
async function devDepOnlyGlob(dir, ignoreChanges) {
  const pkgDir = path.join('packages', dir);
  let name, version;
  try {
    ({name, version} = await readJson(path.join(pkgDir, 'package.json')));
  } catch {
    return null; // not a package
  }
  let stdout;
  try {
    // Skip commits touching only paths lerna itself ignores (e.g. docs, tests)
    const excludes = ignoreChanges.map((g) => `:(exclude,glob)${g}`);
    ({stdout} = await execFileAsync('git', [
      'log',
      '--format=%s',
      `${name}@${version}..HEAD`,
      '--',
      pkgDir,
      ...excludes,
    ]));
  } catch {
    return null; // no release tag yet
  }
  const subjects = stdout.split('\n').filter(Boolean);
  return subjects.length && subjects.every((s) => /^chore\(deps-dev\)/.test(s)) ? `${pkgDir}/**` : null;
}

async function main() {
  const [lernaConfig, dirs] = await Promise.all([readJson('lerna.json'), readdir('packages')]);
  const ignoreChanges = lernaConfig.ignoreChanges ?? [];
  const devDepGlobs = (await Promise.all(dirs.map((d) => devDepOnlyGlob(d, ignoreChanges)))).filter(Boolean);
  // The CLI flag replaces lerna.json's `ignoreChanges`, so re-add those.
  const ignore = [...ignoreChanges, ...devDepGlobs];
  const lerna = spawn('npx', ['lerna', ...process.argv.slice(2), ...ignore.flatMap((g) => ['--ignore-changes', g])], {
    stdio: 'inherit',
  });
  return new Promise((resolve, reject) => {
    lerna.on('error', reject);
    lerna.on('close', (code) => resolve(code ?? 1));
  });
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(1);
  },
);
