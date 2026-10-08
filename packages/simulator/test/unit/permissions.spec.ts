import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it, mock} from 'node:test';

import sinon from 'sinon';
import * as teenProcess from 'teen_process';

let currentExec: (...args: any[]) => any = async () => ({stdout: '', stderr: ''});

mock.module('teen_process', {
  namedExports: {
    ...teenProcess,
    exec: (...args: any[]) => currentExec(...args),
  },
});

const {setPermissions} = await import('../../lib/extensions/permissions.js');

const UDID = 'sim-udid';
const BUNDLE_ID = 'com.example.app';
const TCC_SERVICES = [
  'calendar',
  'camera',
  'contacts',
  'faceid',
  'health',
  'homekit',
  'medialibrary',
  'microphone',
  'motion',
  'photos',
  'reminders',
  'siri',
  'speech',
  'usertracking',
];

describe('permissions', function () {
  let sandbox: sinon.SinonSandbox;
  let exec: sinon.SinonStub;
  let sim: any;

  beforeEach(function () {
    sandbox = sinon.createSandbox();
    exec = sandbox.stub().resolves({stdout: '', stderr: ''});
    currentExec = exec;
    sim = {
      udid: UDID,
      log: {debug: sandbox.stub(), warn: sandbox.stub(), errorWithException: (message: string) => new Error(message)},
      ps: sandbox.stub().resolves([]),
      _native: {
        grantPermission: sandbox.stub().resolves(),
        revokePermission: sandbox.stub().resolves(),
        resetPermission: sandbox.stub().resolves(),
      },
    };
  });

  afterEach(function () {
    sandbox.restore();
  });

  describe('notifications', function () {
    for (const [status, method, extraArgs] of [
      ['yes', 'grantPermission', []],
      ['YES', 'grantPermission', []],
      ['critical', 'grantPermission', ['critical']],
      ['no', 'revokePermission', []],
      ['unset', 'resetPermission', []],
    ] as const) {
      it(`passes '${status}' to @appium/coresim`, async function () {
        await setPermissions.call(sim, BUNDLE_ID, {notifications: status});

        sinon.assert.calledOnce(sim._native[method]);
        assert.deepEqual(sim._native[method].firstCall.args, [UDID, 'notifications', BUNDLE_ID, ...extraArgs]);
        sinon.assert.notCalled(exec);
      });
    }

    it('waits for SpringBoard and Spotlight to restart', async function () {
      sim.ps.onFirstCall().resolves([
        {name: 'com.apple.SpringBoard', pid: 1},
        {name: 'com.apple.Spotlight', pid: 2},
      ]);
      sim.ps.resolves([
        {name: 'com.apple.SpringBoard', pid: 3},
        {name: 'com.apple.Spotlight', pid: 4},
      ]);

      await setPermissions.call(sim, BUNDLE_ID, {Notifications: 'yes', camera: 'yes'});

      assert.ok(sim.ps.callCount >= 3);
      sinon.assert.notCalled(sim.log.warn);
      sinon.assert.calledWithExactly(sim._native.grantPermission, UDID, 'notifications', BUNDLE_ID);
      sinon.assert.calledWithExactly(sim._native.grantPermission, UDID, 'camera', BUNDLE_ID);
    });

    it('rejects unsupported values', async function () {
      await assert.rejects(
        setPermissions.call(sim, BUNDLE_ID, {notifications: 'maybe'}),
        /'maybe' is not a supported value for 'notifications'/,
      );
      sinon.assert.notCalled(sim._native.grantPermission);
    });
  });

  describe('all', function () {
    it('applies the status to every TCC-backed service', async function () {
      await setPermissions.call(sim, BUNDLE_ID, {all: 'yes'});

      assert.deepEqual(
        sim._native.grantPermission.getCalls().map(({args}: sinon.SinonSpyCall) => args),
        TCC_SERVICES.map((service) => [UDID, service, BUNDLE_ID]),
      );
      sinon.assert.notCalled(sim.ps);
      sinon.assert.notCalled(exec);
    });

    it('lets explicitly listed services override it', async function () {
      await setPermissions.call(sim, BUNDLE_ID, {ALL: 'unset', camera: 'yes', Photos: 'limited'});

      assert.deepEqual(
        sim._native.resetPermission.getCalls().map(({args}: sinon.SinonSpyCall) => args[1]),
        TCC_SERVICES.filter((service) => !['camera', 'photos'].includes(service)),
      );
      sinon.assert.calledWithExactly(sim._native.grantPermission, UDID, 'camera', BUNDLE_ID);
      sinon.assert.calledWithExactly(sim._native.grantPermission, UDID, 'photos', BUNDLE_ID, 'limited');
      sinon.assert.calledTwice(sim._native.grantPermission);
    });
  });

  it('still rejects unknown services', async function () {
    await assert.rejects(setPermissions.call(sim, BUNDLE_ID, {foo: 'yes'}), /'foo' is unknown/);
  });
});
