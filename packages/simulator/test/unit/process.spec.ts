import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import {once} from 'node:events';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, it, beforeEach, afterEach} from 'node:test';

import {getMacAppPidByPath, killMacAppByPath} from '../../lib/utils/process.js';

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await once(child, 'exit');
}

describe('process utils with a symlinked Xcode', function () {
  let tmpRoot: string;
  let linkedAppPath: string;
  let fakeApp: ChildProcess;

  beforeEach(async function () {
    tmpRoot = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'process-spec-')));
    const realAppPath = path.join(tmpRoot, 'Xcode-27.0.app', 'Contents', 'Applications', 'DeviceHub.app');
    await fsPromises.mkdir(realAppPath, {recursive: true});
    await fsPromises.symlink(path.join(tmpRoot, 'Xcode-27.0.app'), path.join(tmpRoot, 'Xcode.app'));
    linkedAppPath = path.join(tmpRoot, 'Xcode.app', 'Contents', 'Applications', 'DeviceHub.app');
    // LaunchServices starts an app from its real path, so its command line never contains the symlink.
    // Not `sh -c 'sleep …'`: the shell execs `sleep`, which drops the path from the command line.
    fakeApp = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 30_000)', path.join(realAppPath, 'Contents', 'MacOS', 'DeviceHub')],
      {stdio: 'ignore'},
    );
  });

  afterEach(async function () {
    fakeApp.kill('SIGKILL');
    await waitForExit(fakeApp);
    await fsPromises.rm(tmpRoot, {recursive: true, force: true});
  });

  it('getMacAppPidByPath finds an app running from the real path', async function () {
    assert.strictEqual(await getMacAppPidByPath(linkedAppPath), String(fakeApp.pid));
  });

  it('killMacAppByPath kills an app running from the real path', async function () {
    assert.strictEqual(await killMacAppByPath(linkedAppPath), true);
    await waitForExit(fakeApp);
    assert.strictEqual(fakeApp.signalCode, 'SIGKILL');
  });
});
