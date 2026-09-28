import type {NativeSimctl} from '../native-simctl.js';
import {runCatchingAsync} from '../utils/index.js';

declare module '../native-simctl.js' {
  interface NativeSimctl {
    getDarwinNotificationState(udid: string, name: string): Promise<bigint>;
    setDarwinNotificationState(udid: string, name: string, state: bigint): Promise<void>;
    postDarwinNotification(udid: string, name: string): Promise<void>;
  }
}

/**
 * The "state" here is Darwin's low-level `notify(3)` per-name state value (`notify_get_state`) —
 * a full 64-bit integer any process can attach to a notification name independently of posting
 * it, so a reader can check the last-set value without having been listening at post time.
 * Returned as `bigint`, not `number` — a JS `number` only has 53 bits of safe integer precision,
 * not enough for an arbitrary 64-bit counter or bit field another process may have stored.
 *
 * @see https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/notify.3.html
 * @param udid — UDID of the device to read from
 * @param name — Darwin notification name
 * @returns the last-set state value for that notification (`0n` if never set)
 */
export async function getDarwinNotificationState(this: NativeSimctl, udid: string, name: string): Promise<bigint> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).darwinNotificationGetState(name));
}

/**
 * Sets the state value of a Darwin notification on the given device, without posting it (see
 * {@link getDarwinNotificationState} for what "state" means here — `notify(3)`'s `notify_set_state`).
 *
 * @param udid — UDID of the target device
 * @param name — Darwin notification name
 * @param state — state value to store; must fit in an unsigned 64-bit integer (`0n` to `2n**64n-1n`)
 */
export async function setDarwinNotificationState(
  this: NativeSimctl,
  udid: string,
  name: string,
  state: bigint,
): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).darwinNotificationSetState(name, state));
}

/**
 * @param udid — UDID of the target device
 * @param name — Darwin notification name to post
 */
export async function postDarwinNotification(this: NativeSimctl, udid: string, name: string): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).postDarwinNotification(name));
}
