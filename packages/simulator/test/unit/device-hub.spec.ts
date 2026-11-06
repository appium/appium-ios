import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {fs} from '@appium/support';
import sinon from 'sinon';

import {
  DeviceHubAccessError,
  assertDeviceHubPreferencesAccess,
  getDeviceHubPreferencesPath,
  macOs,
} from '../../lib/utils/index.js';

const HOME = '/Users/test';
const CONTAINER = path.join(HOME, 'Library/Containers/com.apple.dt.Devices');
const DATA = path.join(CONTAINER, 'Data');
const LIBRARY = path.join(DATA, 'Library');
const PREFS_DIR = path.join(LIBRARY, 'Preferences');

function errno(code: string): Error {
  return Object.assign(new Error(code), {code});
}

describe('assertDeviceHubPreferencesAccess', () => {
  let sandbox: sinon.SinonSandbox;
  let stat: sinon.SinonStub;
  let probe: sinon.SinonStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    stat = sandbox.stub(fs, 'stat').resolves({} as any);
    probe = sandbox.stub().resolves('ok');
  });
  afterEach(() => sandbox.restore());

  it('builds the plist path inside the DeviceHub container', () => {
    assert.equal(getDeviceHubPreferencesPath(HOME), path.join(PREFS_DIR, 'com.apple.dt.Devices.plist'));
  });

  it('passes if the preferences directory is accessible', async () => {
    await assertDeviceHubPreferencesAccess(HOME, probe);
    assert.deepEqual(probe.firstCall.args, [PREFS_DIR]);
  });

  it('does nothing if the container does not exist', async () => {
    stat.rejects(errno('ENOENT'));
    await assertDeviceHubPreferencesAccess(HOME, probe);
    assert.equal(probe.called, false);
  });

  it('raises a permission error if the preferences directory is denied', async () => {
    probe.resolves('denied');
    await assert.rejects(assertDeviceHubPreferencesAccess(HOME, probe), (e: Error) => {
      assert.ok(e instanceof DeviceHubAccessError);
      assert.match(e.message, /denies access/);
      assert.match(e.message, /Full Disk Access/);
      assert.match(e.message, new RegExp(PREFS_DIR));
      return true;
    });
  });

  it('raises a distinct error if macOS does not answer in time', async () => {
    probe.resolves('timeout');
    await assert.rejects(assertDeviceHubPreferencesAccess(HOME, probe), (e: Error) => {
      assert.ok(e instanceof DeviceHubAccessError);
      assert.match(e.message, /did not answer within 1000ms/);
      assert.match(e.message, /Full Disk Access/);
      return true;
    });
  });

  it('probes the deepest existing directory if the preferences directory is missing', async () => {
    stat.withArgs(PREFS_DIR).rejects(errno('ENOENT'));
    stat.withArgs(LIBRARY).rejects(errno('ENOENT'));
    await assertDeviceHubPreferencesAccess(HOME, probe);
    assert.deepEqual(probe.firstCall.args, [DATA]);
  });

  it('probes the container itself if nothing exists below it', async () => {
    stat.callsFake(async (p: string) => {
      if (p !== CONTAINER) {
        throw errno('ENOENT');
      }
      return {};
    });
    probe.resolves('denied');
    await assert.rejects(assertDeviceHubPreferencesAccess(HOME, probe), (e: Error) => {
      assert.ok(e instanceof DeviceHubAccessError);
      assert.match(e.message, new RegExp(CONTAINER));
      return true;
    });
    assert.deepEqual(probe.firstCall.args, [CONTAINER]);
  });

  it('does not wrap unrelated stat errors', async () => {
    const error = errno('EIO');
    stat.withArgs(PREFS_DIR).rejects(error);
    await assert.rejects(assertDeviceHubPreferencesAccess(HOME, probe), (e: Error) => e === error);
  });

  describe('default probe', () => {
    let access: sinon.SinonStub;
    let version: sinon.SinonStub;

    beforeEach(() => {
      access = sandbox.stub(fs, 'access').resolves();
      version = sandbox.stub(macOs, 'getMajorVersion').resolves(27);
    });

    for (const [name, major] of [
      ['macOS 27', 27],
      ['a newer macOS', 28],
    ] as const) {
      it(`checks access in-process on ${name}`, async () => {
        version.resolves(major);
        await assertDeviceHubPreferencesAccess(HOME);
        assert.equal(access.firstCall.args[0], PREFS_DIR);
      });
    }

    it('reports EPERM and EACCES as denied on macOS 27', async () => {
      for (const code of ['EPERM', 'EACCES']) {
        access.rejects(errno(code));
        await assert.rejects(assertDeviceHubPreferencesAccess(HOME), DeviceHubAccessError);
      }
    });

    it('does not wrap unrelated access errors on macOS 27', async () => {
      const error = errno('EIO');
      access.rejects(error);
      await assert.rejects(assertDeviceHubPreferencesAccess(HOME), (e: Error) => e === error);
    });

    for (const [name, major] of [
      ['macOS 26', 26],
      ['an unknown macOS version', NaN],
    ] as const) {
      it(`uses a child process instead of an in-process check on ${name}`, async () => {
        version.resolves(major);
        stat.callsFake(async (p: string) => {
          if (p !== CONTAINER) {
            throw errno('ENOENT');
          }
          return {};
        });
        // The container is a real directory, but stat is faked, so the child checks a missing path and fails
        await assert.rejects(assertDeviceHubPreferencesAccess(HOME), DeviceHubAccessError);
        assert.equal(access.called, false);
      });
    }

    describe('child process', () => {
      const realHome = path.join(os.tmpdir(), `appium-device-hub-${process.pid}`);
      const realPrefsDir = path.join(realHome, 'Library/Containers/com.apple.dt.Devices/Data/Library/Preferences');

      beforeEach(() => {
        version.resolves(26);
        stat.restore();
      });
      afterEach(async () => {
        await fs.rimraf(realHome);
      });

      it('passes for a readable directory', async () => {
        await fs.mkdir(realPrefsDir, {recursive: true});
        await assertDeviceHubPreferencesAccess(realHome);
      });

      it('reports an unreadable directory as denied', {skip: process.getuid?.() === 0}, async () => {
        await fs.mkdir(realPrefsDir, {recursive: true});
        await fs.chmod(realPrefsDir, 0o000);
        try {
          await assert.rejects(assertDeviceHubPreferencesAccess(realHome), DeviceHubAccessError);
        } finally {
          await fs.chmod(realPrefsDir, 0o700);
        }
      });
    });
  });
});
