import assert from 'node:assert/strict';
import {describe, it, mock} from 'node:test';

import {pressHidButton, setSimulatedHingeAngle, setHidOrientation} from '../../src/commands/hid.js';

describe('simulator HID input boundaries', () => {
  it('rejects malformed input before looking up or touching a simulator', async () => {
    const find = mock.fn(async () => {
      throw new Error('unexpected native call');
    });
    const sim = {_findDevice: find} as any;
    for (const angle of [-1, 181, NaN, Infinity, '90', null]) {
      await assert.rejects(setSimulatedHingeAngle.call(sim, 'test', angle as any), TypeError);
    }
    for (const value of [-1, 65536, 1.5, NaN]) {
      await assert.rejects(pressHidButton.call(sim, 'test', value, 64), TypeError);
      await assert.rejects(pressHidButton.call(sim, 'test', 12, value), TypeError);
    }
    for (const duration of [-1, 61, NaN, Infinity]) {
      await assert.rejects(pressHidButton.call(sim, 'test', 12, 64, duration), TypeError);
    }
    await assert.rejects(setHidOrientation.call(sim, 'test', 0 as any, true), TypeError);
    await assert.rejects(setHidOrientation.call(sim, 'test', 1, undefined as any), TypeError);
    assert.equal(find.mock.callCount(), 0);
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
      }),
    } as any;
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
