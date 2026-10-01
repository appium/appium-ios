// Runs lerna, ignoring packages whose commits since their last release are all `chore(deps-dev)`.
// Usage: node scripts/lerna-skip-dev-deps.mjs <lerna args...>
import {execFileSync, spawnSync} from 'node:child_process';
import {readdirSync, readFileSync, existsSync} from 'node:fs';
import path from 'node:path';

const git = (...args) => execFileSync('git', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
const lernaConfig = JSON.parse(readFileSync('lerna.json', 'utf8'));

function devDepOnlyGlobs() {
  const globs = [];
  for (const dir of readdirSync('packages')) {
    const manifest = path.join('packages', dir, 'package.json');
    if (!existsSync(manifest)) {
      continue;
    }
    const {name, version} = JSON.parse(readFileSync(manifest, 'utf8'));
    let subjects;
    try {
      subjects = git('log', '--format=%s', `${name}@${version}..HEAD`, '--', path.dirname(manifest))
        .split('\n')
        .filter(Boolean);
    } catch {
      continue; // no release tag yet
    }
    if (subjects.length && subjects.every((s) => /^chore\(deps-dev\)/.test(s))) {
      globs.push(`${path.dirname(manifest)}/**`);
    }
  }
  return globs;
}

// The CLI flag replaces lerna.json's `ignoreChanges`, so re-add those.
const ignore = [...(lernaConfig.ignoreChanges ?? []), ...devDepOnlyGlobs()];
const result = spawnSync(
  'npx',
  ['lerna', ...process.argv.slice(2), ...ignore.flatMap((g) => ['--ignore-changes', g])],
  {stdio: 'inherit'},
);
process.exit(result.status ?? 1);
