import type {NativeSimctl} from '../native-simctl.js';
import {runCatchingAsync} from '../utils/index.js';

declare module '../native-simctl.js' {
  interface NativeSimctl {
    pressHidButton(udid: string, page: number, usage: number, duration?: number): Promise<void>;
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
  return runCatchingAsync(async () => (await this._findDevice(udid)).pressHidButton(page, usage, duration));
}
