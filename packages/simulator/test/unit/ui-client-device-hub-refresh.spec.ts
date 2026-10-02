import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, it, beforeEach, mock} from 'node:test';

let commonPrefs: Record<string, any> = {};
let prefsUpdated = true;
const renames: string[] = [];
let renameFails: ((name: string) => boolean) | undefined;
let listed: {udid: string; name: string}[] = [];

mock.module('../../lib/extensions/settings.js', {
  namedExports: {
    compileSimulatorPreferences: () => [{}, commonPrefs],
    updatePreferences: async () => prefsUpdated,
  },
});

const {run} = await import('../../lib/extensions/ui-client.js');
const {DEVICE_HUB_UI_CLIENT_BUNDLE_ID, SIMULATOR_UI_CLIENT_BUNDLE_ID} = await import('../../lib/utils/constants.js');

const UDID = 'FAKE-UDID';

function makeSim(uiClientBundleId: string) {
  const logs: string[] = [];
  return {
    logs,
    udid: UDID,
    uiClientBundleId,
    _native: {
      getDevices: async () => listed,
      renameDevice: async (udid: string, name: string) => {
        renames.push(`${udid}:${name}`);
        if (renameFails?.(name)) {
          throw new Error('rename failed');
        }
      },
    },
    startupTimeout: 1000,
    log: {debug() {}, info() {}, warn: (m: string) => logs.push(m)},
    isRunning: async () => true,
    getUIClientPid: async () => '123',
    launchWindow: async () => {},
    waitForBoot: async () => {},
    disableKeyboardIntroduction: async () => {},
  };
}

describe('ui-client DeviceHub preference refresh', function () {
  beforeEach(async function () {
    commonPrefs = {PasteboardAutomaticSync: false};
    prefsUpdated = true;
    renames.length = 0;
    renameFails = undefined;
    listed = [{udid: UDID, name: 'iPhone 17'}];
    for (const id of [DEVICE_HUB_UI_CLIENT_BUNDLE_ID, SIMULATOR_UI_CLIENT_BUNDLE_ID]) {
      await fsPromises.rm(path.join(os.tmpdir(), `appium-ios-simulator-ui-client-${id}.lock`), {force: true});
    }
  });

  it('renames the running Simulator temporarily and restores its name', async function () {
    await run.call(makeSim(DEVICE_HUB_UI_CLIENT_BUNDLE_ID) as any, {});
    assert.deepEqual(renames, [`${UDID}:iPhone 17 (refresh)`, `${UDID}:iPhone 17`]);
  });

  it('does nothing for the legacy Simulator UI client', async function () {
    await run.call(makeSim(SIMULATOR_UI_CLIENT_BUNDLE_ID) as any, {});
    assert.deepEqual(renames, []);
  });

  it('does nothing if the pasteboard preference was not written', async function () {
    commonPrefs = {};
    await run.call(makeSim(DEVICE_HUB_UI_CLIENT_BUNDLE_ID) as any, {});
    assert.deepEqual(renames, []);
  });

  it('does nothing if updating the preferences failed', async function () {
    prefsUpdated = false;
    await run.call(makeSim(DEVICE_HUB_UI_CLIENT_BUNDLE_ID) as any, {});
    assert.deepEqual(renames, []);
  });

  it('matches the Simulator UDID case-insensitively and renames by the canonical one', async function () {
    listed = [{udid: UDID.toUpperCase(), name: 'iPhone 17'}];
    const sim = {...makeSim(DEVICE_HUB_UI_CLIENT_BUNDLE_ID), udid: UDID.toLowerCase()};
    await run.call(sim as any, {});
    assert.deepEqual(renames, [`${UDID.toUpperCase()}:iPhone 17 (refresh)`, `${UDID.toUpperCase()}:iPhone 17`]);
  });

  it('does nothing if the Simulator is not running yet', async function () {
    const sim = makeSim(DEVICE_HUB_UI_CLIENT_BUNDLE_ID);
    sim.isRunning = async () => false;
    await run.call(sim as any, {});
    assert.deepEqual(renames, []);
  });

  it('does not fail the run if the first rename fails', async function () {
    renameFails = (name) => name === 'iPhone 17 (refresh)';
    const sim = makeSim(DEVICE_HUB_UI_CLIENT_BUNDLE_ID);
    await run.call(sim as any, {});
    // The first rename failed, so there is nothing to restore and the run still succeeds
    assert.equal(renames.length, 1);
    assert.match(sim.logs[0], /Cannot refresh/);
  });

  it('warns and does not fail the run if restoring the name fails', async function () {
    renameFails = (name) => name === 'iPhone 17';
    const sim = makeSim(DEVICE_HUB_UI_CLIENT_BUNDLE_ID);
    await run.call(sim as any, {});
    assert.equal(renames.length, 2);
    assert.match(sim.logs[0], /Cannot refresh/);
  });

  it('does not rename if the Simulator is missing from its device set', async function () {
    listed = [];
    const sim = makeSim(DEVICE_HUB_UI_CLIENT_BUNDLE_ID);
    await run.call(sim as any, {});
    assert.deepEqual(renames, []);
    assert.match(sim.logs[0], /not listed/);
  });
});
