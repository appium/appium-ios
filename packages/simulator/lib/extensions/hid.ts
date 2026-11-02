import type {HasNativeSimctl} from '../native/types.js';
import type {CoreSimulator, SupportsHid} from '../types.js';

declare module '../simulator-xcode-15.js' {
  interface SimulatorXcode15 extends SupportsHid {}
}
type HIDSimulator = CoreSimulator & HasNativeSimctl;
/**
 * Sends a button press/release through the simulator's HID service.
 * Requires host XPC symbols and a compatible runtime service; submission does not confirm UI effects.
 * @param page - Unsigned 16-bit HID usage page (`kHIDPage_*` in the linked Apple header).
 * @param usage - Unsigned 16-bit HID usage within the page (`kHIDUsage_*` in the linked Apple header).
 * @param duration - Hold time in seconds (0–60); defaults to 0.1.
 * @see https://github.com/apple-oss-distributions/IOHIDFamily/blob/main/IOHIDFamily/IOHIDUsageTables.h
 */
export async function pressHidButton(this: HIDSimulator, page: number, usage: number, duration = 0.1): Promise<void> {
  await this._native.pressHidButton(this.udid, page, usage, duration);
}
