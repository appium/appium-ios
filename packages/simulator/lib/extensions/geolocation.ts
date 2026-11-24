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
 * @param altitude The altitude in meters above sea level. If omitted (or a blank string), apps
 * observe an altitude of zero, which CoreLocation itself reports as invalid (negative vertical
 * accuracy).
 * @returns True if the geolocation was set successfully.
 */
export async function setGeolocation(
  this: CoreSimulatorWithGeolocation,
  latitude: string | number,
  longitude: string | number,
  altitude?: string | number | null,
): Promise<boolean> {
  const isAltitudeOmitted =
    altitude === undefined || altitude === null || (typeof altitude === 'string' && altitude.trim() === '');
  await this._native.setLocation(
    this.udid,
    toFiniteNumber(latitude, 'latitude'),
    toFiniteNumber(longitude, 'longitude'),
    isAltitudeOmitted ? undefined : toFiniteNumber(altitude, 'altitude'),
  );
  return true;
}

function toFiniteNumber(value: string | number, name: string): number {
  // `Number()` turns a blank string into 0 rather than NaN
  const result = typeof value === 'string' && value.trim() === '' ? Number.NaN : Number(value);
  if (!Number.isFinite(result)) {
    throw new Error(`The ${name} must be a finite number, got '${value}' instead`);
  }
  return result;
}
