import type {HasNativeSimctl} from '../native/types.js';
import {orientationToRaw} from '../native/ui-mappings.js';
import type {CoreSimulator, SupportsDuo, DeviceOrientation} from '../types.js';

declare module '../simulator-xcode-27.js' {
  interface SimulatorXcode27 extends SupportsDuo {}
}
type DuoSimulator = CoreSimulator & HasNativeSimctl;

/**
 * Submits iPhone Duo's hinge control. Requires Xcode 27+ and a booted, supported runtime.
 * @param angle - Hinge angle in degrees, from 0 (closed) to 180 (open). Verify the result separately.
 */
export async function setSimulatedHingeAngle(this: DuoSimulator, angle: number): Promise<void> {
  await this._native.setSimulatedHingeAngle(this.udid, angle);
}
/**
 * Submits iPhone Duo's orientation control without updating XCTest's cached orientation.
 * Requires Xcode 27+; completion confirms submission, not app rotation or animation stability.
 * @param orientation - Requested interface orientation.
 * @param isMainDisplay - Whether the selected display is the outer/main panel.
 */
export async function setHidOrientation(
  this: DuoSimulator,
  orientation: DeviceOrientation,
  isMainDisplay: boolean,
): Promise<void> {
  await this._native.setHidOrientation(this.udid, orientationToRaw(orientation), isMainDisplay);
}
