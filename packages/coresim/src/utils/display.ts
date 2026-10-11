import type {DisplayOptions, NativeDeviceHandle} from '../types.js';

/**
 * Validates a capture API's display selection without querying the device.
 * Strings pass through without UUID syntax or port-existence checks.
 *
 * @param displayId — port UUID string, unsigned 32-bit guest screen ID, or `undefined` for default selection
 * @throws {TypeError} if the value is neither a string, a number, nor `undefined`
 * @throws {RangeError} if a numeric value is not an unsigned 32-bit integer
 */
export function validateDisplayId(displayId: unknown): void {
  if (displayId !== undefined && typeof displayId !== 'string' && typeof displayId !== 'number') {
    throw new TypeError('displayId must be a port UUID string or a numeric guest screen ID');
  }
  if (typeof displayId === 'number' && (!Number.isInteger(displayId) || displayId < 0 || displayId > 0xffffffff)) {
    throw new RangeError('A numeric displayId must be an unsigned 32-bit integer');
  }
}

/**
 * Resolves a validated display selection to the port UUID expected by native capture APIs.
 * UUID strings pass through without enumeration; numeric IDs are matched against a fresh list
 * of guest screen IDs on each call. An omitted ID selects the unique `isMain` (class-0) port.
 * Call once at recording/stream startup, or on each screenshot capture.
 *
 * @param device — native handle for the device whose display ports are queried
 * @param displayId — selection already checked by {@link validateDisplayId}
 * @returns the selected port UUID, or `undefined` to retain native fallback when no default port exists
 * @throws {Error} if a numeric ID has no unique match with a nonempty UUID, or multiple default ports exist
 */
export async function resolveDisplayPortId(
  device: NativeDeviceHandle,
  displayId: DisplayOptions['displayId'],
): Promise<string | undefined> {
  if (typeof displayId === 'string') {
    return displayId;
  }

  const displays = await device.getDisplays();
  if (typeof displayId === 'number') {
    const matches = displays.filter(({screenId}) => screenId === displayId);
    if (matches.length !== 1 || !matches[0].id) {
      throw new Error(`Cannot uniquely resolve guest screen ID ${displayId} to a display port`);
    }
    return matches[0].id;
  }

  // Both integrated Duo displays have class 0. Never pick one by port order.
  const defaults = displays.filter(({isMain}) => isMain);
  if (defaults.length > 1) {
    throw new Error('Multiple default display ports are available; specify displayId');
  }
  return defaults[0]?.id;
}
