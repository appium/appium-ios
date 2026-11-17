import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import {once} from 'node:events';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, it, beforeEach, afterEach} from 'node:test';

import {getMacAppPidByPath, getMacAppPidsByPath, killMacAppByPath} from '../../lib/utils/process.js';

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await once(child, 'exit');
}

describe('process utils', function () {
  let tmpRoot: string;
  let realAppPath: string;
  let linkedAppPath: string;
  let missingAppPath: string;
  let fakeApps: ChildProcess[];

  /**
   * Not `sh -c 'sleep …'`: the shell execs `sleep`, which drops the path from the command line.
   */
  function startFakeApp(appPath: string): ChildProcess {
    const fakeApp = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 30_000)', path.join(appPath, 'Contents', 'MacOS', 'DeviceHub')],
      {stdio: 'ignore'},
    );
    fakeApps.push(fakeApp);
    return fakeApp;
  }

  beforeEach(async function () {
    tmpRoot = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'process-spec-')));
    realAppPath = path.join(tmpRoot, 'Xcode-27.0.app', 'Contents', 'Applications', 'DeviceHub.app');
    await fsPromises.mkdir(realAppPath, {recursive: true});
    await fsPromises.symlink(path.join(tmpRoot, 'Xcode-27.0.app'), path.join(tmpRoot, 'Xcode.app'));
    linkedAppPath = path.join(tmpRoot, 'Xcode.app', 'Contents', 'Applications', 'DeviceHub.app');
    missingAppPath = path.join(tmpRoot, 'Missing.app');
    fakeApps = [];
  });

  afterEach(async function () {
    for (const fakeApp of fakeApps) {
      fakeApp.kill('SIGKILL');
      await waitForExit(fakeApp);
    }
    await fsPromises.rm(tmpRoot, {recursive: true, force: true});
  });

  describe('getMacAppPidByPath', function () {
    it('finds an app started from the real path of a symlinked Xcode', async function () {
      // LaunchServices starts an app from its real path, so its command line never contains the symlink.
      const app = startFakeApp(realAppPath);
      assert.strictEqual(await getMacAppPidByPath(linkedAppPath), String(app.pid));
    });

    it('finds an app started through a symlinked Xcode', async function () {
      const app = startFakeApp(linkedAppPath);
      assert.strictEqual(await getMacAppPidByPath(linkedAppPath), String(app.pid));
    });

    it('finds an app at a path without symlinks', async function () {
      const app = startFakeApp(realAppPath);
      assert.strictEqual(await getMacAppPidByPath(realAppPath), String(app.pid));
    });

    it('returns null for a path that does not exist', async function () {
      startFakeApp(realAppPath);
      assert.strictEqual(await getMacAppPidByPath(missingAppPath), null);
    });

    it('finds an app whose path contains regular expression characters', async function () {
      const specialAppPath = path.join(tmpRoot, 'Xcode (beta)+[1].app', 'Contents', 'Applications', 'DeviceHub.app');
      await fsPromises.mkdir(specialAppPath, {recursive: true});
      const app = startFakeApp(specialAppPath);
      assert.strictEqual(await getMacAppPidByPath(specialAppPath), String(app.pid));
    });
  });

  describe('getMacAppPidsByPath', function () {
    it('finds every app started from either the real or the symlinked path', async function () {
      const apps = [startFakeApp(realAppPath), startFakeApp(linkedAppPath)];
      assert.deepStrictEqual(
        (await getMacAppPidsByPath(linkedAppPath)).toSorted(),
        apps.map((app) => String(app.pid)).toSorted(),
      );
    });

    it('returns an empty array for a path that does not exist', async function () {
      startFakeApp(realAppPath);
      assert.deepStrictEqual(await getMacAppPidsByPath(missingAppPath), []);
    });
  });

  describe('killMacAppByPath', function () {
    it('kills an app started from the real path of a symlinked Xcode', async function () {
      const app = startFakeApp(realAppPath);
      assert.strictEqual(await killMacAppByPath(linkedAppPath), true);
      await waitForExit(app);
      assert.strictEqual(app.signalCode, 'SIGKILL');
    });

    it('kills an app started through a symlinked Xcode', async function () {
      const app = startFakeApp(linkedAppPath);
      assert.strictEqual(await killMacAppByPath(linkedAppPath), true);
      await waitForExit(app);
      assert.strictEqual(app.signalCode, 'SIGKILL');
    });

    it('returns false for a path that does not exist', async function () {
      const app = startFakeApp(realAppPath);
      assert.strictEqual(await killMacAppByPath(missingAppPath), false);
      assert.strictEqual(app.exitCode, null);
      assert.strictEqual(app.signalCode, null);
    });
  });
});
