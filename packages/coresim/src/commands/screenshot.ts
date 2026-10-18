import {LRUCache} from 'lru-cache';

import type {NativeSimctl} from '../native-simctl.js';
import {SimDeviceState, type NativeDeviceHandle, type ScreenshotOptions, type SimDisplayInfo} from '../types.js';
import {resolveDisplayPortId, runCatchingAsync, validateDisplayId} from '../utils/index.js';

const MAX_CACHED_DEVICES = 32;
interface CachedDisplay {
  screenId: number;
  portId: string;
  bootMarker: number;
}
const displayCaches = new WeakMap<NativeSimctl, LRUCache<string, CachedDisplay>>();

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
 * Display selection follows {@link validateDisplayId} and {@link resolveDisplayPortId}.
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
  return runCatchingAsync(async () => {
    const device = await this._findDevice(udid);
    return await captureScreenshot(this, udid, device, options);
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

/**
 * Reuses a successful numeric selection within an observed boot, scoped to this client and UDID.
 * Failures discard the entry; a failed cache hit gets one fresh resolution/capture attempt.
 * Default selection is always fresh so adding a second default port cannot hide ambiguity.
 */
async function captureScreenshot(
  client: NativeSimctl,
  udid: string,
  device: NativeDeviceHandle,
  {cacheDisplayId, ...options}: ScreenshotOptions,
): Promise<Buffer> {
  const key = udid.toLowerCase();
  let cache = displayCaches.get(client);
  if (!cacheDisplayId || typeof options.displayId !== 'number') {
    cache?.delete(key);
    const displayId = await resolveDisplayPortId(device, options.displayId);
    return await device.screenshot({...options, displayId});
  }
  if (!cache) {
    cache = new LRUCache<string, CachedDisplay>({max: MAX_CACHED_DEVICES});
    displayCaches.set(client, cache);
  }
  let bootMarker = readBootMarker(device);
  const cached = cache.get(key);
  if (bootMarker !== null && cached && cached.screenId === options.displayId && bootMarker === cached.bootMarker) {
    try {
      const result = await device.screenshot({...options, displayId: cached.portId});
      if (readBootMarker(device) === bootMarker) {
        return result;
      }
    } catch {
      // A replaced port or capture failure invalidates the entry. Retry the same numeric ID
      // once with fresh resolution; never select another display or loop on capture failures.
    }
    bootMarker = readBootMarker(device);
  }
  cache.delete(key);
  const displayId = await resolveDisplayPortId(device, options.displayId);
  const result = await device.screenshot({...options, displayId});
  if (displayId && bootMarker !== null && readBootMarker(device) === bootMarker) {
    cache.set(key, {screenId: options.displayId, portId: displayId, bootMarker});
  }
  return result;
}

/**
 * Returns a boot marker only while the device is Booted. Unsupported or unreadable metadata
 * disables caching. The timestamp persists after shutdown and is not a guaranteed unique UUID.
 */
function readBootMarker(device: NativeDeviceHandle): number | null {
  try {
    if (device.state() !== SimDeviceState.Booted) {
      return null;
    }
    const marker = device.lastBootedAt();
    return marker !== null && Number.isFinite(marker) && marker > 0 && device.state() === SimDeviceState.Booted
      ? marker
      : null;
  } catch {
    return null;
  }
}
