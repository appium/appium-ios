import assert from 'node:assert/strict';
import path from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {fs} from '@appium/support';
import sinon from 'sinon';

import {
  DeviceHubAccessError,
  assertDeviceHubPreferencesAccess,
  getDeviceHubPreferencesPath,
} from '../../lib/utils/index.js';

const HOME = '/Users/test';
const CONTAINER = path.join(HOME, 'Library/Containers/com.apple.dt.Devices');
const DATA = path.join(CONTAINER, 'Data');
const PREFS_DIR = path.join(DATA, 'Library/Preferences');

function errno(code: string): Error {
  return Object.assign(new Error(code), {code});
}

describe('assertDeviceHubPreferencesAccess', () => {
  let sandbox: sinon.SinonSandbox;
  let stat: sinon.SinonStub;
  let access: sinon.SinonStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    stat = sandbox.stub(fs, 'stat').resolves({} as any);
    access = sandbox.stub(fs, 'access').resolves();
  });
  afterEach(() => sandbox.restore());

  it('builds the plist path inside the DeviceHub container', () => {
    assert.equal(getDeviceHubPreferencesPath(HOME), path.join(PREFS_DIR, 'com.apple.dt.Devices.plist'));
  });

  it('passes if the preferences directory is accessible', async () => {
    await assertDeviceHubPreferencesAccess(HOME);
    assert.deepEqual(access.firstCall.args[0], PREFS_DIR);
  });

  it('does nothing if the container does not exist', async () => {
    stat.rejects(errno('ENOENT'));
    await assertDeviceHubPreferencesAccess(HOME);
    assert.equal(access.called, false);
  });

  it('raises a permission error if the preferences directory is denied', async () => {
    access.rejects(errno('EPERM'));
    await assert.rejects(assertDeviceHubPreferencesAccess(HOME), (e: Error) => {
      assert.ok(e instanceof DeviceHubAccessError);
      assert.match(e.message, /Full Disk Access/);
      assert.match(e.message, new RegExp(PREFS_DIR));
      assert.equal((e.cause as any).code, 'EPERM');
      return true;
    });
  });

  it('raises a permission error on EACCES', async () => {
    access.rejects(errno('EACCES'));
    await assert.rejects(assertDeviceHubPreferencesAccess(HOME), DeviceHubAccessError);
  });

  it('checks the deepest existing directory if the preferences directory is missing', async () => {
    access.withArgs(PREFS_DIR).rejects(errno('ENOENT'));
    access.withArgs(path.join(DATA, 'Library')).rejects(errno('ENOENT'));
    access.withArgs(DATA).rejects(errno('EPERM'));
    await assert.rejects(assertDeviceHubPreferencesAccess(HOME), DeviceHubAccessError);
  });

  it('passes if the container exists but has no data directory yet', async () => {
    access.rejects(errno('ENOENT'));
    await assertDeviceHubPreferencesAccess(HOME);
    assert.equal(access.callCount, 4);
    assert.equal(access.lastCall.args[0], CONTAINER);
  });

  it('raises a permission error if only the container is left to check and it is denied', async () => {
    access.rejects(errno('ENOENT'));
    access.withArgs(CONTAINER).rejects(errno('EPERM'));
    await assert.rejects(assertDeviceHubPreferencesAccess(HOME), (e: Error) => {
      assert.ok(e instanceof DeviceHubAccessError);
      assert.match(e.message, new RegExp(CONTAINER));
      return true;
    });
  });

  it('does not wrap unrelated errors', async () => {
    const error = errno('EIO');
    access.rejects(error);
    await assert.rejects(assertDeviceHubPreferencesAccess(HOME), (e: Error) => e === error);
  });

  it('raises a permission error if the container itself is denied', async () => {
    stat.rejects(errno('EPERM'));
    await assert.rejects(assertDeviceHubPreferencesAccess(HOME), DeviceHubAccessError);
  });
});
