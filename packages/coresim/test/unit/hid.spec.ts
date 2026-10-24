import assert from 'node:assert/strict';
import {describe, it, mock} from 'node:test';

import {setSimulatedHingeAngle, setHidOrientation, isDuo} from '../../src/commands/duo.js';
import {pressHidButton} from '../../src/commands/hid.js';
import {NativeSimctl} from '../../src/index.js';

describe('simulator HID input boundaries', () => {
  it('validates raw native calls before conversion or HID dispatch', async () => {
    const sim = new NativeSimctl();
    const devices = await sim.getDevices();
    assert.ok(devices.length);
    const device = await sim._findDevice(devices[0].udid);
    for (const value of [-1, 65536, 2 ** 32, 1.5, NaN, Infinity, '12', null, undefined]) {
      assert.throws(() => device.pressHidButton(value as any, 64, 0.1), TypeError);
      assert.throws(() => device.pressHidButton(12, value as any, 0.1), TypeError);
    }
    for (const value of [-1, 61, NaN, Infinity, '1', null, undefined]) {
      assert.throws(() => device.pressHidButton(12, 64, value as any), TypeError);
    }
    for (const value of [-1, 181, NaN, Infinity, '90', null, undefined]) {
      assert.throws(() => device.setSimulatedHingeAngle(value as any), TypeError);
    }
    for (const value of [0, 5, 1.5, 2 ** 32 + 1, NaN, Infinity, '1', null, undefined]) {
      assert.throws(() => device.setHidOrientation(value as any, true), TypeError);
    }
    for (const value of [0, 'true', null, undefined]) {
      assert.throws(() => device.setHidOrientation(1, value as any), TypeError);
    }
  });
  it('identifies Duo by device type without booting and rejects controls on other types', async () => {
    const sim = new NativeSimctl();
    const devices = await sim.getDevices();
    for (const device of devices) {
      assert.equal(
        await sim.isDuo(device.udid),
        device.deviceTypeIdentifier === 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo',
      );
    }
    const ordinary = devices.find((d) => d.deviceTypeIdentifier && !d.deviceTypeIdentifier.endsWith('.iPhone-Duo'));
    assert.ok(ordinary);
    await assert.rejects(sim.setSimulatedHingeAngle(ordinary.udid, 90), /iPhone Duo/);
    await assert.rejects(sim.setHidOrientation(ordinary.udid, 1, true), /iPhone Duo/);
  });
  it('preserves fractional angles and the selected panel across native dispatch', async () => {
    const angle = mock.fn(async (_angle: number) => {});
    const orientation = mock.fn(async (_orientation: number, _main: boolean) => {});
    const button = mock.fn(async (_page: number, _usage: number, _duration: number) => {});
    const sim = {
      _findDevice: async () => ({
        setSimulatedHingeAngle: angle,
        setHidOrientation: orientation,
        pressHidButton: button,
        isDuo: async () => true,
      }),
    } as any;
    assert.equal(await isDuo.call(sim, 'test'), true);
    await setSimulatedHingeAngle.call(sim, 'test', 90.5);
    await setHidOrientation.call(sim, 'test', 3, false);
    await pressHidButton.call(sim, 'test', 12, 64);
    assert.deepEqual(angle.mock.calls[0].arguments, [90.5]);
    assert.deepEqual(orientation.mock.calls[0].arguments, [3, false]);
    assert.deepEqual(button.mock.calls[0].arguments, [12, 64, 0.1]);
  });
  it('propagates an unavailable native HID service', async () => {
    const sim = {
      _findDevice: async () => {
        throw new Error('HID service unavailable');
      },
    } as any;
    await assert.rejects(pressHidButton.call(sim, 'test', 12, 64), /HID service unavailable/);
  });
});
