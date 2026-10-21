import {LRUCache} from 'lru-cache';

import type {NativeSimctl} from '../native-simctl.js';
import {SimDeviceState, type DisplayId, type NativeDeviceHandle} from '../types.js';
import {resolveDisplayPortId} from './display.js';

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

/** One operation's display selection. Call commit only after the operation succeeds. */
export interface DisplaySelection {
  device: NativeDeviceHandle;
  cachedPortId?: string;
  resolveFresh(): Promise<string | undefined>;
  /** Returns whether the observed boot is unchanged, even if another operation owns the cache. */
  commit(portId: string | undefined): boolean;
}

/** Reserves cache ownership before lookup. Disabled/default/UUID selections invalidate the device entry. */
export async function beginDisplaySelection(
  client: NativeSimctl,
  udid: string,
  displayId: DisplayId | undefined,
  useCache: boolean = false,
): Promise<DisplaySelection> {
  const key = udid.toLowerCase();
  let cache = displayCaches.get(client);
  const cacheable = useCache && typeof displayId === 'number';
  let cached: CachedDisplay | undefined;
  const entry: DisplayCacheEntry = {};
  if (cacheable) {
    if (!cache) {
      cache = new LRUCache<string, DisplayCacheEntry>({max: MAX_CACHED_DEVICES});
      displayCaches.set(client, cache);
    }
    cached = cache.get(key)?.display;
    cache.set(key, entry);
  } else {
    cache?.delete(key);
  }
  const device = await client._findDevice(udid);
  let bootMarker = cacheable ? readBootMarker(device) : null;
  const cachedPortId =
    bootMarker !== null && cached && cached.screenId === displayId && cached.bootMarker === bootMarker
      ? cached.portId
      : undefined;
  return {
    device,
    cachedPortId,
    async resolveFresh() {
      bootMarker = cacheable ? readBootMarker(device) : null;
      return await resolveDisplayPortId(device, displayId);
    },
    commit(portId) {
      const sameBoot = bootMarker !== null && readBootMarker(device) === bootMarker;
      if (sameBoot && bootMarker !== null && cacheable && portId && cache?.peek(key) === entry) {
        entry.display = {screenId: displayId, portId, bootMarker};
      }
      return sameBoot;
    },
  };
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
