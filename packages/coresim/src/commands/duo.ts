import type {NativeSimctl} from '../native-simctl.js';
import type {DeviceOrientation} from '../types.js';
import {runCatchingAsync} from '../utils/index.js';

declare module '../native-simctl.js' {
  interface NativeSimctl {
    isDuo(udid: string): Promise<boolean>;
    setSimulatedHingeAngle(udid: string, angle: number): Promise<void>;
    setHidOrientation(udid: string, orientation: DeviceOrientation, isMainDisplay: boolean): Promise<void>;
  }
}

/**
 * Identifies iPhone Duo by its CoreSimulator device type, without booting or sending events.
 * Does not imply HID service availability or infer Duo from hinge/multiple-display support.
 * @param udid - Target simulator identifier.
 * @returns Whether the device type is iPhone Duo; false if its type is no longer installed.
 */
export async function isDuo(this: NativeSimctl, udid: string): Promise<boolean> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).isDuo());
}

/**
 * Requests a simulated fold through the target simulator's CoreDevice HID service.
 *
 * Requires an iPhone Duo device type and a hinge-capable runtime. Runs in the Mac process using private XPC transport
 * symbols; missing symbols or services produce an error. No guest helper or WDA entitlement
 * is required. Completion confirms submission only: check hinge readings and wait for the
 * expected application layout separately.
 *
 * @param udid - Target simulator identifier.
 * @param angle - Finite hinge angle from 0 (closed) to 180 (fully open), inclusive.
 */
export async function setSimulatedHingeAngle(this: NativeSimctl, udid: string, angle: number): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).setSimulatedHingeAngle(angle));
}

/**
 * Sends Duo's vendor orientation control for the selected display through CoreDevice HID.
 * The ordinary `setOrientation` API is unchanged.
 *
 * Runs in the Mac process using private XPC transport symbols; missing symbols or services
 * produce an error. No guest helper or WDA entitlement is required.
 * Completion confirms submission only; verify the app scene separately. This does not update
 * XCTest's cached device orientation, which may remain unknown or retain an earlier value.
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
  return runCatchingAsync(async () => (await this._findDevice(udid)).setHidOrientation(orientation, isMainDisplay));
}
