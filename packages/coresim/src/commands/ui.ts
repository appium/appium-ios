import type {NativeSimctl} from '../native-simctl.js';
import type {DeviceOrientation} from '../types.js';
import {runCatchingAsync} from '../utils/index.js';

declare module '../native-simctl.js' {
  interface NativeSimctl {
    getAppearance(udid: string): Promise<number>;
    setAppearance(udid: string, style: number): Promise<void>;
    getIncreaseContrast(udid: string): Promise<number>;
    setIncreaseContrast(udid: string, enabled: boolean): Promise<void>;
    getContentSize(udid: string): Promise<number>;
    setContentSize(udid: string, category: number): Promise<void>;
    setOrientation(udid: string, orientation: DeviceOrientation): Promise<void>;
    getOrientation(udid: string): Promise<DeviceOrientation>;
  }
}

/**
 * @param udid — UDID of the device to read from
 * @returns the device's current UI appearance style, as a raw `UIUserInterfaceStyle` value
 */
export async function getAppearance(this: NativeSimctl, udid: string): Promise<number> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).getUIAppearance());
}

/**
 * @param udid — UDID of the target device
 * @param style — a raw `UIUserInterfaceStyle` value to apply
 */
export async function setAppearance(this: NativeSimctl, udid: string, style: number): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).setUIAppearance(style));
}

/**
 * @param udid — UDID of the device to read from
 * @returns the device's current Increase Contrast accessibility setting
 */
export async function getIncreaseContrast(this: NativeSimctl, udid: string): Promise<number> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).getIncreaseContrast());
}

/**
 * @param udid — UDID of the target device
 * @param enabled — whether Increase Contrast should be enabled
 */
export async function setIncreaseContrast(this: NativeSimctl, udid: string, enabled: boolean): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).setIncreaseContrast(enabled));
}

/**
 * @param udid — UDID of the device to read from
 * @returns the device's current Dynamic Type content size category
 */
export async function getContentSize(this: NativeSimctl, udid: string): Promise<number> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).getContentSize());
}

/**
 * @param udid — UDID of the target device
 * @param category — the Dynamic Type content size category to apply
 */
export async function setContentSize(this: NativeSimctl, udid: string, category: number): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).setContentSize(category));
}

/**
 * Rotates the device — the same effect as Simulator.app's Hardware > Rotate menu items. Known to
 * silently no-op in two cases — see CLAUDE.md's "Known gaps": a device-motion-capable runtime, and
 * a device this same process both created and booted.
 *
 * @param udid — UDID of the target device
 * @param orientation — the orientation to rotate to
 */
export async function setOrientation(this: NativeSimctl, udid: string, orientation: DeviceOrientation): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).setOrientation(orientation));
}

/**
 * The device's current orientation — a live read (not just this process's own last
 * {@link setOrientation} call), via a guest-spawned `defaults read` of a backboardd digitizer
 * preference; see CLAUDE.md for how and its limits (notably: portrait until the frontmost app has
 * actually rotated at least once this boot).
 *
 * @param udid — UDID of the device to inspect; must be booted
 */
export async function getOrientation(this: NativeSimctl, udid: string): Promise<DeviceOrientation> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).getOrientation());
}
