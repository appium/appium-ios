import type {HasNativeSimctl} from '../native/types.js';
import type {CoreSimulator, DisplayInfo, SupportsDisplays} from '../types.js';

declare module '../simulator-xcode-15.js' {
  interface SimulatorXcode15 extends SupportsDisplays {}
}

type CoreSimulatorWithDisplays = CoreSimulator & SupportsDisplays & HasNativeSimctl;

/**
 * Lists the Simulator's renderable displays. The Simulator must be booted.
 *
 * @returns The displays, whose `id` can be passed as `displayId` to the screenshot/recording APIs.
 */
export async function getDisplays(this: CoreSimulatorWithDisplays): Promise<DisplayInfo[]> {
  return await this._native.getDisplays(this.udid);
}
