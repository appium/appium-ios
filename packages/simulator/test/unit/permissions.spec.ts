import assert from 'node:assert/strict';
import path from 'node:path';
import {afterEach, beforeEach, describe, it, mock} from 'node:test';

import {fs, plist, tempDir} from '@appium/support';
import * as asyncbox from 'asyncbox';
import sinon from 'sinon';
import * as teenProcess from 'teen_process';

let currentExec: (...args: any[]) => any = async () => ({stdout: '', stderr: ''});
let currentWaitForCondition: (...args: any[]) => any = asyncbox.waitForCondition;

mock.module('teen_process', {
  namedExports: {
    ...teenProcess,
    exec: (...args: any[]) => currentExec(...args),
  },
});
mock.module('asyncbox', {
  namedExports: {
    ...asyncbox,
    waitForCondition: (...args: any[]) => currentWaitForCondition(...args),
  },
});

const {setPermissions} = await import('../../lib/extensions/permissions.js');

const UDID = 'sim-udid';
const BUNDLE_ID = 'com.example.app';
const OTHER_BUNDLE_ID = 'com.example.other';
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
  let dataDir: string;
  let plistPath: string;
  let sim: any;

  async function readStore(): Promise<{sectionInfoVersionNumber: number; sectionInfo: Record<string, Buffer>}> {
    return (await plist.parsePlistFile(plistPath)) as any;
  }

  async function readSection(bundleId: string): Promise<{sectionID: string; displayName: string; settings: any}> {
    const {sectionInfo} = await readStore();
    const {$objects} = plist.parsePlist(Buffer.from(sectionInfo[bundleId])) as any;
    return {sectionID: $objects[2], displayName: $objects[5], settings: $objects[3]};
  }

  beforeEach(async function () {
    sandbox = sinon.createSandbox();
    exec = sandbox.stub().resolves({stdout: '', stderr: ''});
    currentExec = exec;
    currentWaitForCondition = asyncbox.waitForCondition;
    dataDir = await tempDir.openDir();
    plistPath = path.join(dataDir, 'Library', 'BulletinBoard', 'VersionedSectionInfo.plist');
    await fs.mkdir(path.dirname(plistPath), {recursive: true});
    await fs.writeFile(
      plistPath,
      plist.createPlist({sectionInfoVersionNumber: 2, sectionInfo: {[OTHER_BUNDLE_ID]: Buffer.from('other')}}, false),
    );
    sim = {
      udid: UDID,
      log: {debug: sandbox.stub(), warn: sandbox.stub(), errorWithException: (message: string) => new Error(message)},
      getDir: () => dataDir,
      ps: sandbox.stub().resolves([]),
      _native: {
        grantPermission: sandbox.stub().resolves(),
        revokePermission: sandbox.stub().resolves(),
        resetPermission: sandbox.stub().resolves(),
      },
    };
  });

  afterEach(async function () {
    sandbox.restore();
    await fs.rimraf(dataDir);
  });

  describe('notifications', function () {
    for (const [status, allowsNotifications, criticalAlertSetting] of [
      ['yes', true, 0],
      ['YES', true, 0],
      ['no', false, 0],
      ['critical', true, 2],
    ] as const) {
      it(`writes the BulletinBoard section of the app for '${status}'`, async function () {
        await setPermissions.call(sim, BUNDLE_ID, {notifications: status});

        const {sectionID, displayName, settings} = await readSection(BUNDLE_ID);
        assert.equal(sectionID, BUNDLE_ID);
        assert.equal(displayName, BUNDLE_ID);
        assert.equal(settings.allowsNotifications, allowsNotifications);
        assert.equal(settings.criticalAlertSetting, criticalAlertSetting);
        const {sectionInfoVersionNumber, sectionInfo} = await readStore();
        assert.equal(sectionInfoVersionNumber, 2);
        assert.equal(Buffer.from(sectionInfo[OTHER_BUNDLE_ID]).toString(), 'other');
        sinon.assert.notCalled(sim._native.grantPermission);
      });
    }

    it(`removes the BulletinBoard section of the app for 'unset'`, async function () {
      await setPermissions.call(sim, BUNDLE_ID, {notifications: 'yes'});
      await setPermissions.call(sim, BUNDLE_ID, {notifications: 'unset'});

      const {sectionInfo} = await readStore();
      assert.deepEqual(Object.keys(sectionInfo), [OTHER_BUNDLE_ID]);
    });

    it('restarts SpringBoard and leaves the store writable', async function () {
      sim.devicesSetPath = '/tmp/device-set';
      await setPermissions.call(sim, BUNDLE_ID, {notifications: 'yes'});

      sinon.assert.calledWithExactly(exec, 'xcrun', [
        'simctl',
        '--set',
        '/tmp/device-set',
        'spawn',
        UDID,
        'launchctl',
        'stop',
        'com.apple.SpringBoard',
      ]);
      const chflagsCalls = exec.getCalls().filter(({args: [cmd]}) => cmd === 'chflags');
      assert.ok(chflagsCalls.length > 0);
      assert.deepEqual(chflagsCalls.at(-1)!.args, ['chflags', ['nouchg', plistPath]]);
    });

    it('waits for SpringBoard and Spotlight to restart', async function () {
      sim.ps.onFirstCall().resolves([
        {name: 'com.apple.SpringBoard', pid: 1},
        {name: 'com.apple.Spotlight', pid: 2},
      ]);
      sim.ps.resolves([
        {name: 'com.apple.SpringBoard', pid: 3},
        {name: 'com.apple.Spotlight', pid: 4},
      ]);

      await setPermissions.call(sim, BUNDLE_ID, {notifications: 'yes', camera: 'yes'});

      assert.ok(sim.ps.callCount >= 3);
      sinon.assert.notCalled(sim.log.warn);
      sinon.assert.calledOnceWithExactly(sim._native.grantPermission, UDID, 'camera', BUNDLE_ID);
    });

    it('rejects unsupported values without touching the store', async function () {
      const before = await fs.readFile(plistPath);

      await assert.rejects(
        setPermissions.call(sim, BUNDLE_ID, {notifications: 'maybe'}),
        /'maybe' is not a supported value for 'notifications'/,
      );

      assert.deepEqual(await fs.readFile(plistPath), before);
      sinon.assert.notCalled(exec);
    });

    it('fails with a clear error if the BulletinBoard store does not exist', async function () {
      await fs.rimraf(plistPath);
      currentWaitForCondition = async () => {
        throw new Error('Condition unmet');
      };

      await assert.rejects(setPermissions.call(sim, BUNDLE_ID, {notifications: 'yes'}), /does not exist/);
    });
  });

  describe('all', function () {
    it('applies the status to every TCC-backed service', async function () {
      await setPermissions.call(sim, BUNDLE_ID, {all: 'yes'});

      assert.deepEqual(
        sim._native.grantPermission.getCalls().map(({args}: sinon.SinonSpyCall) => args),
        TCC_SERVICES.map((service) => [UDID, service, BUNDLE_ID]),
      );
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
