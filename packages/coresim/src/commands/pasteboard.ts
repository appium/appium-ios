import type {NativeSimctl} from '../native-simctl.js';
import {runCatchingAsync} from '../utils/index.js';

declare module '../native-simctl.js' {
  interface NativeSimctl {
    getPasteboard(udid: string): Promise<string>;
    setPasteboard(udid: string, content: string): Promise<void>;
    startPasteboardSync(udid: string): Promise<void>;
    stopPasteboardSync(udid: string): Promise<void>;
  }
}

/**
 * Reads the device's current pasteboard content — the native equivalent of `simctl pbpaste`
 * (see native/sim_pasteboard.mm for which private CoreSimulator API this uses). Rejects with
 * `NativeSimUnavailableError` if neither is present.
 *
 * @param udid — UDID of the device to read from; must be booted
 * @returns the pasteboard's string content, or `""` if it holds no string-typed content
 */
export async function getPasteboard(this: NativeSimctl, udid: string): Promise<string> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).getPasteboard());
}

/**
 * Sets the device's pasteboard content — the native equivalent of `simctl pbcopy`.
 *
 * @param udid — UDID of the target device; must be booted
 * @param content — string content to set
 */
export async function setPasteboard(this: NativeSimctl, udid: string, content: string): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).setPasteboard(content));
}

/**
 * Keeps the device's pasteboard in sync with the host's general pasteboard in both directions,
 * which is what the Simulator UI client's "automatic pasteboard sync" does. The sync runs in this
 * process, so it lasts until `stopPasteboardSync`, the end of the process, or the device
 * shutting down. Does nothing if it is already running for the device.
 * Rejects with `NativeSimUnavailableError` if this CoreSimulator has no continuous sync support.
 *
 * @param udid — UDID of the target device; must be booted
 */
export async function startPasteboardSync(this: NativeSimctl, udid: string): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).startPasteboardSync());
}

/**
 * Stops the sync started by `startPasteboardSync`. Does nothing if it is not running.
 *
 * @param udid — UDID of the target device
 */
export async function stopPasteboardSync(this: NativeSimctl, udid: string): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).stopPasteboardSync());
}
