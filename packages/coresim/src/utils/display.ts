import type {DisplayOptions, NativeDeviceHandle} from '../types.js';

export function validateDisplayId(displayId: unknown): void {
  if (displayId !== undefined && typeof displayId !== 'string' && typeof displayId !== 'number') {
    throw new TypeError('displayId must be a port UUID string or a numeric guest screen ID');
  }
  if (typeof displayId === 'number' && (!Number.isInteger(displayId) || displayId < 0 || displayId > 0xffffffff)) {
    throw new RangeError('A numeric displayId must be an unsigned 32-bit integer');
  }
}

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
