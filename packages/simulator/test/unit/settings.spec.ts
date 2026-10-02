import assert from 'node:assert/strict';
import path from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {fs, plist} from '@appium/support';
import sinon from 'sinon';

import {compileSimulatorPreferences, updatePreferences} from '../../lib/extensions/settings.js';
import {DEVICE_HUB_UI_CLIENT_BUNDLE_ID, NSUserDefaults} from '../../lib/utils/index.js';

describe('DeviceHub preferences', () => {
  let sandbox: sinon.SinonSandbox;
  let update: sinon.SinonStub;
  let parse: sinon.SinonStub;
  let debug: sinon.SinonStub;
  const sim = {
    udid: 'device-a',
    uiClientBundleId: DEVICE_HUB_UI_CLIENT_BUNDLE_ID,
    log: {debug() {}, info() {}, warn() {}},
  };

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    debug = sandbox.stub(sim.log, 'debug');
    sandbox.stub(fs, 'exists').resolves(false);
    sandbox.stub(fs, 'mkdir').resolves();
    parse = sandbox.stub(plist, 'parsePlistFile').resolves({});
    update = sandbox.stub(NSUserDefaults.prototype, 'update').resolves();
  });
  afterEach(() => sandbox.restore());

  for (const [mode, enabled] of [
    ['on', true],
    ['off', false],
    ['OFF', false],
    ['invalid', false],
  ] as const) {
    it(`applies ${mode} to the DeviceHub preference for the current device`, async () => {
      const [device, common] = compileSimulatorPreferences.call(sim as any, {pasteboardAutomaticSync: mode});
      assert.equal(await updatePreferences.call(sim as any, device, common), true);
      const call = update.getCalls().find((call) => call.thisValue.plist.includes('/Containers/'))!;
      assert.equal(
        call.thisValue.plist,
        path.join(
          process.env.HOME!,
          'Library/Containers/com.apple.dt.Devices/Data/Library/Preferences/com.apple.dt.Devices.plist',
        ),
      );
      assert.equal(call.args[0].DevicePreferences['DEVICE-A'].pasteboardSyncEnabled, enabled);
    });
  }

  it('preserves the device’s existing preferences, including when the plist contains data', async () => {
    parse.resolves({
      lastSelectedDeviceIdentifier: Buffer.from('device-a'),
      DevicePreferences: {
        'DEVICE-A': {zoom: 2, pasteboardSyncEnabled: true},
        'DEVICE-B': {pasteboardSyncEnabled: true},
      },
    });
    await updatePreferences.call(sim as any, {}, {PasteboardAutomaticSync: false});
    assert.deepEqual(update.lastCall.args[0], {
      DevicePreferences: {'DEVICE-A': {zoom: 2, pasteboardSyncEnabled: false}},
    });
  });

  it('leaves the clipboard unchanged while applying the default keyboard preference in system mode', async () => {
    const [device, common] = compileSimulatorPreferences.call(sim as any, {pasteboardAutomaticSync: 'system'});
    await updatePreferences.call(sim as any, device, common);
    assert.equal(parse.called, false);
    assert.equal(update.callCount, 2);
    assert.deepEqual(update.lastCall.args[0], {alwaysSimulateHardwareKeyboard: false});
  });

  for (const enabled of [true, false]) {
    it(`applies hardware keyboard ${enabled} without changing the clipboard in system mode`, async () => {
      const [device, common] = compileSimulatorPreferences.call(sim as any, {
        connectHardwareKeyboard: enabled,
        pasteboardAutomaticSync: 'system',
      });
      assert.equal(await updatePreferences.call(sim as any, device, common), true);
      assert.deepEqual(update.lastCall.args[0], {alwaysSimulateHardwareKeyboard: enabled});
      assert.equal(parse.called, false);
      assert.equal(update.firstCall.args[0].ConnectHardwareKeyboard, enabled);
    });
  }

  it('updates the global keyboard and per-device clipboard together', async () => {
    const [device, common] = compileSimulatorPreferences.call(sim as any, {
      connectHardwareKeyboard: true,
      pasteboardAutomaticSync: 'off',
    });
    await updatePreferences.call(sim as any, device, common);
    assert.deepEqual(update.lastCall.args[0], {
      alwaysSimulateHardwareKeyboard: true,
      DevicePreferences: {'DEVICE-A': {pasteboardSyncEnabled: false}},
    });
  });

  it('skips DeviceHub when no supported preferences are provided', async () => {
    await updatePreferences.call(sim as any, {}, {});
    assert.equal(update.callCount, 1);
    assert.equal(parse.called, false);
  });

  it('reports a keyboard-only write failure', async () => {
    const error = new Error('write failed');
    update.onSecondCall().rejects(error);
    assert.equal(await updatePreferences.call(sim as any, {}, {ConnectHardwareKeyboard: false}), false);
    assert.equal(debug.lastCall.args[0], error.stack);
  });

  it('keeps older Xcode versions on the existing Simulator preferences', async () => {
    await updatePreferences.call(
      {...sim, uiClientBundleId: 'com.apple.iphonesimulator'} as any,
      {},
      {PasteboardAutomaticSync: false, ConnectHardwareKeyboard: true},
    );
    assert.equal(parse.called, false);
    assert.equal(update.callCount, 1);
    assert.equal(update.firstCall.args[0].PasteboardAutomaticSync, false);
    assert.equal(update.firstCall.args[0].ConnectHardwareKeyboard, true);
  });

  it('reports failure if DeviceHub preferences cannot be updated', async () => {
    const error = new Error('unreadable preferences');
    parse.rejects(error);
    assert.equal(await updatePreferences.call(sim as any, {}, {PasteboardAutomaticSync: false}), false);
    assert.equal(debug.lastCall.args[0], error.stack);
  });
});
