import type {NativeSimctl} from '../native-simctl.js';
import type {ScreenshotOptions, SimDisplayInfo} from '../types.js';
import {runCatchingAsync, validateDisplayId} from '../utils/index.js';
import {captureScreenshot} from '../utils/screenshot-display-cache.js';

declare module '../native-simctl.js' {
  interface NativeSimctl {
    getScreenshot(udid: string, options?: ScreenshotOptions): Promise<Buffer>;
    getDisplays(udid: string): Promise<SimDisplayInfo[]>;
  }
}

/**
 * Captures a device display as an image — the native equivalent of `simctl io <udid> screenshot`
 * (see native/sim_screenshot.mm for how this reads the framebuffer directly, with no temp file or
 * subprocess). Rejects if the resolved display has no renderable surface yet (e.g. not booted).
 * Display selection follows {@link validateDisplayId}; numeric IDs resolve to display port UUIDs.
 * See {@link ScreenshotOptions.cacheDisplayId} for optional boot-scoped numeric-ID caching.
 *
 * @param udid — UDID of the device to capture; must be booted
 * @param options — `format` (defaults to `'png'`), `displayId`,
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
  if (options.cacheDisplayId !== undefined && typeof options.cacheDisplayId !== 'boolean') {
    throw new TypeError('cacheDisplayId must be a boolean');
  }
  return runCatchingAsync(async () => await captureScreenshot(this, udid, options));
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
