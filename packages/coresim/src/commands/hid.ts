import type {NativeSimctl} from '../native-simctl.js';
import type {DeviceOrientation} from '../types.js';
import {runCatchingAsync} from '../utils/index.js';

declare module '../native-simctl.js' {
  interface NativeSimctl {
    pressHidButton(udid: string, page: number, usage: number, duration?: number): Promise<void>;
    setSimulatedHingeAngle(udid: string, angle: number): Promise<void>;
    setHidOrientation(udid: string, orientation: DeviceOrientation, isMainDisplay: boolean): Promise<void>;
  }
}

/** Submits a paired button press to the target simulator's CoreDevice HID service. */
export async function pressHidButton(
  this: NativeSimctl,
  udid: string,
  page: number,
  usage: number,
  duration = 0.1,
): Promise<void> {
  for (const [name, value] of [
    ['page', page],
    ['usage', usage],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new TypeError(`${name} must be an unsigned 16-bit integer`);
    }
  }
  if (!Number.isFinite(duration) || duration < 0 || duration > 60) {
    throw new TypeError('duration must be between 0 and 60 seconds');
  }
  return runCatchingAsync(async () => (await this._findDevice(udid)).pressHidButton(page, usage, duration));
}

/** Requests a simulated fold. Submission does not wait for layout or angle convergence. */
export async function setSimulatedHingeAngle(this: NativeSimctl, udid: string, angle: number): Promise<void> {
  if (!Number.isFinite(angle) || angle < 0 || angle > 180) {
    throw new TypeError('angle must be between 0 and 180 degrees');
  }
  return runCatchingAsync(async () => (await this._findDevice(udid)).setSimulatedHingeAngle(angle));
}

/** Duo's vendor orientation control; the caller selects the panel and verifies the app's orientation. */
export async function setHidOrientation(
  this: NativeSimctl,
  udid: string,
  orientation: DeviceOrientation,
  isMainDisplay: boolean,
): Promise<void> {
  if (![1, 2, 3, 4].includes(orientation)) {
    throw new TypeError('orientation must be an interface orientation (1–4)');
  }
  if (typeof isMainDisplay !== 'boolean') {
    throw new TypeError('isMainDisplay must be a boolean');
  }
  return runCatchingAsync(async () => (await this._findDevice(udid)).setHidOrientation(orientation, isMainDisplay));
}
