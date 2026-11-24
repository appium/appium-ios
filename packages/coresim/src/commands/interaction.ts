import type {NativeSimctl} from '../native-simctl.js';
import type {PushNotificationPayload} from '../types.js';
import {runCatchingAsync} from '../utils/index.js';

declare module '../native-simctl.js' {
  interface NativeSimctl {
    getEnv(udid: string, name: string): Promise<string>;
    openUrl(udid: string, url: string): Promise<void>;
    setLocation(udid: string, latitude: number, longitude: number, altitude?: number): Promise<void>;
    clearLocation(udid: string): Promise<void>;
    pushNotification(udid: string, bundleId: string, payload: PushNotificationPayload): Promise<void>;
  }
}

/**
 * @param udid — UDID of the (booted) device to read from
 * @param name — environment variable name
 * @returns the variable's value
 */
export async function getEnv(this: NativeSimctl, udid: string, name: string): Promise<string> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).getenv(name));
}

/**
 * Opens a URL on the given device; iOS resolves the app matching the URL's scheme.
 *
 * @param udid — UDID of the target device
 * @param url — the URL to open, e.g. `https://appium.io`
 */
export async function openUrl(this: NativeSimctl, udid: string, url: string): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).openUrl(url));
}

/**
 * Sets the given device's simulated GPS location.
 *
 * Without `altitude` apps observe an altitude of `0` whose vertical accuracy is negative, i.e. one
 * CoreLocation itself considers invalid. With `altitude` the device is pinned to a single-location
 * simulation scenario instead, so apps observe that altitude along with a valid vertical accuracy.
 *
 * @param udid — UDID of the target device
 * @param latitude — location latitude
 * @param longitude — location longitude
 * @param altitude — location altitude in meters above sea level; may be negative
 */
export async function setLocation(
  this: NativeSimctl,
  udid: string,
  latitude: number,
  longitude: number,
  altitude?: number,
): Promise<void> {
  return runCatchingAsync(async () => {
    const device = await this._findDevice(udid);
    // The argument is only forwarded when given, so the call shape stays unchanged otherwise.
    return altitude === undefined || altitude === null
      ? device.setLocation(latitude, longitude)
      : device.setLocation(latitude, longitude, altitude);
  });
}

/**
 * Stops simulating a GPS location previously set via {@link setLocation}, reverting the device to
 * its default (no simulated location) behavior.
 *
 * @param udid — UDID of the target device
 */
export async function clearLocation(this: NativeSimctl, udid: string): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).clearLocation());
}

/**
 * Delivers a simulated push notification to the given device.
 *
 * @param udid — UDID of the target device
 * @param bundleId — bundle identifier of the app to receive the notification
 * @param payload — see {@link PushNotificationPayload}
 */
export async function pushNotification(
  this: NativeSimctl,
  udid: string,
  bundleId: string,
  payload: PushNotificationPayload,
): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).sendPushNotification(bundleId, payload));
}
