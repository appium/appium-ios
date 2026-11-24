import type {HasNativeSimctl} from '../native/types.js';
import type {CoreSimulator, SupportsGeolocation} from '../types.js';

declare module '../simulator-xcode-15.js' {
  interface SimulatorXcode15 extends SupportsGeolocation {}
}

type CoreSimulatorWithGeolocation = CoreSimulator & SupportsGeolocation & HasNativeSimctl;

/**
 * Sets the geolocation for the simulator.
 *
 * @param latitude The latitude coordinate.
 * @param longitude The longitude coordinate.
 * @param altitude The altitude in meters above sea level. If omitted, apps observe an altitude of
 * zero, which CoreLocation itself reports as invalid (negative vertical accuracy).
 * @returns True if the geolocation was set successfully.
 */
export async function setGeolocation(
  this: CoreSimulatorWithGeolocation,
  latitude: string | number,
  longitude: string | number,
  altitude?: string | number | null,
): Promise<boolean> {
  if (altitude === undefined || altitude === null) {
    await this._native.setLocation(this.udid, Number(latitude), Number(longitude));
  } else {
    await this._native.setLocation(this.udid, Number(latitude), Number(longitude), Number(altitude));
  }
  return true;
}
