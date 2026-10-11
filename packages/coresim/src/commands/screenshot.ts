import type {NativeSimctl} from '../native-simctl.js';
import type {NativeDeviceHandle, ScreenshotOptions, SimDisplayInfo} from '../types.js';
import {runCatchingAsync} from '../utils/index.js';

declare module '../native-simctl.js' {
  interface NativeSimctl {
    getScreenshot(udid: string, options?: ScreenshotOptions): Promise<Buffer>;
    getDisplays(udid: string): Promise<SimDisplayInfo[]>;
  }
}

/**
 * Captures a device display as an image — the native equivalent of `simctl io <udid> screenshot`
 * (see native/sim_screenshot.mm for how this reads the framebuffer directly, with no temp file or
 * subprocess). Rejects if the resolved display has no renderable surface yet (e.g. not booted), or
 * if `options.displayId` cannot be uniquely resolved. UUID strings select ports directly;
 * numeric IDs are matched against the guest screen IDs from {@link getDisplays}.
 *
 * @param udid — UDID of the device to capture; must be booted
 * @param options — `format` (defaults to `'png'`), `displayId` (defaults to the primary display),
 * and `quality` (JPEG only, 0-100 percent)
 * @returns image data encoded as `options.format`
 */
export async function getScreenshot(
  this: NativeSimctl,
  udid: string,
  options: ScreenshotOptions = {},
): Promise<Buffer> {
  if (
    options.quality !== undefined &&
    (!Number.isFinite(options.quality) || options.quality < 0 || options.quality > 100)
  ) {
    throw new RangeError(`quality must be a number between 0 and 100, got ${options.quality}`);
  }
  validateDisplayId(options.displayId);
  return runCatchingAsync(async () => {
    const device = await this._findDevice(udid);
    const displayId = await resolveDisplayPortId(device, options.displayId);
    return await device.screenshot({...options, displayId});
  });
}

/**
 * Lists the device's renderable displays — the same information `simctl io <udid> enumerate`
 * reports for its own `--display` selection. Most devices report exactly one (the primary
 * display); a device with a secondary display (e.g. tvOS's TVOut) reports more than one.
 *
 * @param udid — UDID of the device to inspect; must be booted
 */
export async function getDisplays(this: NativeSimctl, udid: string): Promise<SimDisplayInfo[]> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).getDisplays());
}

function validateDisplayId(displayId: unknown): void {
  if (displayId !== undefined && typeof displayId !== 'string' && typeof displayId !== 'number') {
    throw new TypeError('displayId must be a port UUID string or a numeric guest screen ID');
  }
  if (typeof displayId === 'number' && (!Number.isInteger(displayId) || displayId < 0 || displayId > 0xffffffff)) {
    throw new RangeError('A numeric displayId must be an unsigned 32-bit integer');
  }
}

async function resolveDisplayPortId(
  device: NativeDeviceHandle,
  displayId: ScreenshotOptions['displayId'],
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
