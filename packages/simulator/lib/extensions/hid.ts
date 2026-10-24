import type {HasNativeSimctl} from '../native/types.js';
import {orientationToRaw} from '../native/ui-mappings.js';
import type {CoreSimulator, SupportsHid} from '../types.js';
import type {DeviceOrientation} from '../types.js';

declare module '../simulator-xcode-15.js' {
  interface SimulatorXcode15 extends SupportsHid {}
}
type HIDSimulator = CoreSimulator & HasNativeSimctl;
export async function pressHidButton(this: HIDSimulator, page: number, usage: number, duration = 0.1): Promise<void> {
  await this._native.pressHidButton(this.udid, page, usage, duration);
}
export async function setSimulatedHingeAngle(this: HIDSimulator, angle: number): Promise<void> {
  await this._native.setSimulatedHingeAngle(this.udid, angle);
}
export async function setHidOrientation(
  this: HIDSimulator,
  orientation: DeviceOrientation,
  isMainDisplay: boolean,
): Promise<void> {
  await this._native.setHidOrientation(this.udid, orientationToRaw(orientation), isMainDisplay);
}
