import {LRUCache} from 'lru-cache';

import {NativeSimDisplayResolutionError} from '../errors.js';
import type {NativeSimctl} from '../native-simctl.js';
import {SimDeviceState, type NativeDeviceHandle, type ScreenshotOptions} from '../types.js';
import {resolveDisplayPortId} from './display.js';
import {runCatchingAsync} from './run-catching.js';

const MAX_CACHED_DEVICES = 32;
interface CachedDisplay {
  screenId: number;
  portId: string;
  bootMarker: number;
}
interface DisplayCacheEntry {
  display?: CachedDisplay;
}
const displayCaches = new WeakMap<NativeSimctl, LRUCache<string, DisplayCacheEntry>>();

/**
 * Reuses a successful numeric selection within an observed boot, scoped to this client and UDID.
 * Failures discard the entry; an unresolved cached port gets one fresh resolution/capture attempt.
 * Default selection is always fresh so adding a second default port cannot hide ambiguity.
 */
export async function captureScreenshot(
  client: NativeSimctl,
  udid: string,
  {cacheDisplayId, ...options}: ScreenshotOptions,
): Promise<Buffer> {
  const key = udid.toLowerCase();
  let cache = displayCaches.get(client);
  if (!cacheDisplayId || typeof options.displayId !== 'number') {
    cache?.delete(key);
    const device = await client._findDevice(udid);
    const displayId = await resolveDisplayPortId(device, options.displayId);
    return await device.screenshot({...options, displayId});
  }
  if (!cache) {
    cache = new LRUCache<string, DisplayCacheEntry>({max: MAX_CACHED_DEVICES});
    displayCaches.set(client, cache);
  }
  const cached = cache.get(key)?.display;
  // Reserve ownership before device lookup; later captures or invalidation supersede it.
  const entry: DisplayCacheEntry = {};
  cache.set(key, entry);
  const device = await client._findDevice(udid);
  let bootMarker = readBootMarker(device);
  if (bootMarker !== null && cached && cached.screenId === options.displayId && bootMarker === cached.bootMarker) {
    try {
      const result = await runCatchingAsync(async () => device.screenshot({...options, displayId: cached.portId}));
      if (readBootMarker(device) === bootMarker) {
        if (cache.peek(key) === entry) {
          entry.display = cached;
        }
        return result;
      }
    } catch (err) {
      if (!(err instanceof NativeSimDisplayResolutionError)) {
        throw err;
      }
      // Retry a missing cached port once, using the same numeric display ID.
    }
    bootMarker = readBootMarker(device);
  }
  const displayId = await resolveDisplayPortId(device, options.displayId);
  const result = await device.screenshot({...options, displayId});
  if (cache.peek(key) === entry && displayId && bootMarker !== null && readBootMarker(device) === bootMarker) {
    entry.display = {screenId: options.displayId, portId: displayId, bootMarker};
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
