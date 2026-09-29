import assert from 'node:assert';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {describe, it} from 'node:test';

import {getPkgRoot} from '../../src/utils/index.js';

// getPkgRoot() resolves the actual package root regardless of how deep the compiled test file
// lives under lib/ — scripts/ and package.json aren't part of the src/ -> lib/src/ mirror, so a
// relative "../../../" climb from here would need to know (and keep in sync with) that exact
// nesting depth, the same fragile counting the native addon loader itself avoids.
const INSTALL_SCRIPT = path.join(getPkgRoot(), 'scripts', 'install.mjs');
const PACKAGE_JSON = path.join(getPkgRoot(), 'package.json');

/**
 * `npm install` must never fail off macOS — CoreSimulator.framework doesn't exist anywhere else,
 * so there's nothing to build there. Spawns the real install script as a subprocess (with a
 * CORESIM_TEST_PLATFORM override scripts/install.mjs reads instead of the real process.platform,
 * since that can't be faked for a child process) rather than importing it in-process, so a bug
 * that makes it actually try to shell out to node-gyp-build on an unsupported platform would fail
 * this test with a real non-zero exit code instead of silently passing.
 */
describe('scripts/install.mjs', () => {
  it('exits 0 without building on an unsupported platform', () => {
    const output = execFileSync(process.execPath, [INSTALL_SCRIPT], {
      encoding: 'utf8',
      env: {...process.env, CORESIM_TEST_PLATFORM: 'win32'},
    });
    assert.match(output, /Skipping native addon build/);
    assert.match(output, /win32/);
  });

  it('attempts to build on macOS regardless of arch (fails here only because PATH excludes node-gyp-build)', () => {
    // Confirms the script actually reaches the build branch on darwin — an Intel Mac is expected
    // to compile from source, not skip, so the gate checks platform only, never arch — by
    // asserting it does NOT print the skip message and instead fails trying to exec node-gyp-build.
    assert.throws(() => {
      execFileSync(process.execPath, [INSTALL_SCRIPT], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {...process.env, CORESIM_TEST_PLATFORM: 'darwin', PATH: '/usr/bin:/bin'},
      });
    }, /node-gyp-build/);
  });

  it('is declared in package.json so npm actually publishes and runs it', async () => {
    // A script that only exists in the repo but isn't in "files" would silently break every
    // consumer's `npm install` (ENOENT on the "install" script) — assert both halves stay in sync.
    const pkg = JSON.parse(await readFile(PACKAGE_JSON, 'utf8'));
    assert.strictEqual(pkg.scripts.install, 'node scripts/install.mjs');
    assert.ok(pkg.files.includes('scripts/install.mjs'), '"scripts/install.mjs" missing from package.json "files"');
  });
});
