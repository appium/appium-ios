import assert from 'node:assert/strict';
import {it} from 'node:test';

import {SimulatorXcode15} from '../../lib/simulator-xcode-15.js';
import {SimulatorXcode27} from '../../lib/simulator-xcode-27.js';

it('keeps generic HID on older Xcode classes and exposes Duo controls only on Xcode 27', async () => {
  const version = (major: number) => ({versionString: `${major}.0`, versionFloat: major, major, minor: 0});
  const old = new SimulatorXcode15('old', version(16));
  const duo = new SimulatorXcode27('duo', version(27));
  assert.equal(typeof old.pressHidButton, 'function');
  assert.equal(typeof old.isDuo, 'function');
  assert.equal('setSimulatedHingeAngle' in old, false);
  assert.equal('setHidOrientation' in old, false);
  const calls: unknown[][] = [];
  (duo as any)._native = {
    isDuo: async (id: string) => id === 'duo',
    setSimulatedHingeAngle: async (...args: unknown[]) => {
      calls.push(args);
    },
    setHidOrientation: async (...args: unknown[]) => {
      calls.push(args);
    },
  };
  assert.equal(await duo.isDuo(), true);
  await duo.setSimulatedHingeAngle(90.5);
  await duo.setHidOrientation('landscape-left', false);
  assert.deepEqual(calls, [
    ['duo', 90.5],
    ['duo', 4, false],
  ]);
});
