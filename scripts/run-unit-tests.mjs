#!/usr/bin/env node
/* eslint-disable no-console */
// Runs unit tests for every eligible package on a push to main (safety net - nothing was
// filtered), or only for the packages discover-affected-packages.mjs selected on a pull
// request (self changed, or a direct in-monorepo dependency changed).
import {spawnSync} from 'node:child_process';

function runTestUnit(extraArgs) {
  // "npm run test:unit --" forwards extraArgs onto the root "test:unit" script (its own
  // --ignore flags stay in one place: package.json), narrowing lerna's package set further.
  const result = spawnSync('npm', ['run', 'test:unit', '--', ...extraArgs], {stdio: 'inherit'});
  process.exit(result.status ?? 1);
}

if (process.env.EVENT_NAME !== 'pull_request') {
  runTestUnit([]);
} else {
  const names = JSON.parse(process.env.UNIT_PACKAGES || '[]');
  if (names.length === 0) {
    console.log('No unit-test-relevant package changes detected; skipping.');
    process.exit(0);
  }
  console.log(`Running unit tests for: ${names.join(', ')}`);
  runTestUnit(names.flatMap((name) => ['--scope', name]));
}
