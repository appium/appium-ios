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

/**
 * Sends a paired button press/release through the target simulator's CoreDevice HID service.
 *
 * Runs in the Mac process using private XPC transport symbols; missing symbols or services
 * produce an error. No guest helper or WDA entitlement is required.
 * Completion confirms submission only. Check the resulting lock or application state separately.
 *
 * @param udid - Target simulator identifier.
 * @param page - Unsigned 16-bit HID usage page.
 * @param usage - Unsigned 16-bit HID usage within the page.
 * @param duration - Hold time in seconds, from 0 to 60 inclusive. Defaults to 0.1.
 */
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

/**
 * Requests a simulated fold through the target simulator's CoreDevice HID service.
 *
 * Requires a hinge-capable runtime. Runs in the Mac process using private XPC transport
 * symbols; missing symbols or services produce an error. No guest helper or WDA entitlement
 * is required. Completion confirms submission only: check hinge readings and wait for the
 * expected application layout separately.
 *
 * @param udid - Target simulator identifier.
 * @param angle - Finite hinge angle from 0 (closed) to 180 (fully open), inclusive.
 */
export async function setSimulatedHingeAngle(this: NativeSimctl, udid: string, angle: number): Promise<void> {
  if (!Number.isFinite(angle) || angle < 0 || angle > 180) {
    throw new TypeError('angle must be between 0 and 180 degrees');
  }
  return runCatchingAsync(async () => (await this._findDevice(udid)).setSimulatedHingeAngle(angle));
}

/**
 * Sends Duo's vendor orientation control for the selected display through CoreDevice HID.
 * The ordinary `setOrientation` API is unchanged.
 *
 * Runs in the Mac process using private XPC transport symbols; missing symbols or services
 * produce an error. No guest helper or WDA entitlement is required.
 * Completion confirms submission only. Update XCTest's device orientation before sending HID,
 * then verify the app scene without updating XCTest again.
 *
 * @param udid - Target simulator identifier.
 * @param orientation - CoreSimulator DeviceOrientation value; landscape numbering differs from UIDeviceOrientation.
 * @param isMainDisplay - Whether the selected panel is the main display; controls the inner-panel orientation mapping.
 */
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
