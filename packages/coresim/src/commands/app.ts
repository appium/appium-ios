import {fileURLToPath} from 'node:url';

import type {NativeSimctl} from '../native-simctl.js';
import {runCatchingAsync} from '../utils/index.js';

declare module '../native-simctl.js' {
  interface NativeSimctl {
    installApp(udid: string, appPath: string, options?: Record<string, unknown>): Promise<void>;
    removeApp(udid: string, bundleId: string, options?: Record<string, unknown>): Promise<void>;
    launchApp(udid: string, bundleId: string, options?: Record<string, unknown>): Promise<number>;
    terminateApp(udid: string, bundleId: string): Promise<void>;
    isAppInstalled(udid: string, bundleId: string): Promise<boolean>;
    appInfo(udid: string, bundleId: string): Promise<Record<string, unknown>>;
    installedApps(udid: string): Promise<Record<string, unknown>>;
    getAppContainer(udid: string, bundleId: string, containerType?: AppContainerType | string): Promise<string>;
  }
}

/**
 * Which of an app's on-disk containers {@link getAppContainer} should resolve — `'app'` (the
 * `.app` bundle itself), `'data'` (its data container), `'groups'` (its sole App Group container,
 * if it has exactly one), or any other string naming a specific App Group identifier.
 */
export type AppContainerType = 'app' | 'data' | 'groups';

/**
 * Installs an `.app` bundle onto the given device.
 *
 * @param udid — UDID of the target device
 * @param appPath — path to the `.app` bundle on disk
 * @param options — passed through to `installApplication:withOptions:error:`
 */
export async function installApp(
  this: NativeSimctl,
  udid: string,
  appPath: string,
  options: Record<string, unknown> = {},
): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).installApp(appPath, options));
}

/**
 * Uninstalls an app from the given device.
 *
 * @param udid — UDID of the target device
 * @param bundleId — bundle identifier of the app to remove
 * @param options — passed through to `uninstallApplication:withOptions:error:`
 */
export async function removeApp(
  this: NativeSimctl,
  udid: string,
  bundleId: string,
  options: Record<string, unknown> = {},
): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).uninstallApp(bundleId, options));
}

/**
 * Launches an installed app on the given device.
 *
 * @param udid — UDID of the target device
 * @param bundleId — bundle identifier of the app to launch
 * @param options — passed through to `launchApplicationWithID:options:error:`
 * @returns the launched process's pid
 */
export async function launchApp(
  this: NativeSimctl,
  udid: string,
  bundleId: string,
  options: Record<string, unknown> = {},
): Promise<number> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).launchApp(bundleId, options));
}

/**
 * @param udid — UDID of the target device
 * @param bundleId — bundle identifier of the app to terminate
 */
export async function terminateApp(this: NativeSimctl, udid: string, bundleId: string): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).terminateApp(bundleId));
}

/**
 * @param udid — UDID of the device to check
 * @param bundleId — bundle identifier to look up
 * @returns whether an app with that bundle identifier is installed
 */
export async function isAppInstalled(this: NativeSimctl, udid: string, bundleId: string): Promise<boolean> {
  return runCatchingAsync(async () => bundleId in (await (await this._findDevice(udid)).installedApps()));
}

/**
 * @param udid — UDID of the device to read from
 * @param bundleId — bundle identifier of the installed app
 * @returns the app's properties, as reported by `propertiesOfApplication:`
 */
export async function appInfo(this: NativeSimctl, udid: string, bundleId: string): Promise<Record<string, unknown>> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).propertiesOfApplication(bundleId));
}

/**
 * @param udid — UDID of the device to read from
 * @returns every installed app's properties, keyed by bundle identifier
 */
export async function installedApps(this: NativeSimctl, udid: string): Promise<Record<string, unknown>> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).installedApps());
}

/** Converts a `file://` URL string (as `appInfo`'s container fields report) to a plain fs path. */
function toFsPath(fileUrl: unknown): string | undefined {
  if (typeof fileUrl !== 'string') {
    return undefined;
  }
  return fileURLToPath(fileUrl).replace(/\/$/, '');
}

/**
 * Resolves the full filesystem path to one of an installed app's on-disk containers — the same
 * paths {@link appInfo}'s `Path`/`DataContainer`/`GroupContainers` fields already carry, just
 * picked out and normalized to a plain path (no new native call).
 *
 * @example
 * // Resolve a specific App Group container by its identifier (see appInfo's GroupContainers
 * // field, or catch the error thrown below, to discover which identifiers an app has)
 * const groupPath = await sim.getAppContainer(udid, bundleId, 'group.com.example.myapp');
 *
 * @param udid — UDID of the (booted) device to read from
 * @param bundleId — bundle identifier of the installed app
 * @param containerType — see {@link AppContainerType}; defaults to `'app'`
 * @returns the resolved container's path
 * @throws if the requested container doesn't exist (e.g. `'data'` before the device has booted
 * once with the app installed), if `'groups'` is ambiguous (more than one App Group container —
 * pass the specific group identifier instead), or if a given group identifier doesn't match any
 * of the app's App Group containers — in both of the latter cases, the error message lists the
 * app's actual App Group identifiers
 */
export async function getAppContainer(
  this: NativeSimctl,
  udid: string,
  bundleId: string,
  containerType: AppContainerType | string = 'app',
): Promise<string> {
  return runCatchingAsync(async () => {
    const info = await this.appInfo(udid, bundleId);
    if (containerType === 'app') {
      const path = info.Path;
      if (typeof path !== 'string') {
        throw new Error(`No app bundle path was reported for '${bundleId}'`);
      }
      return path;
    }
    if (containerType === 'data') {
      const path = toFsPath(info.DataContainer);
      if (!path) {
        throw new Error(`No data container was found for '${bundleId}' — has the device been booted since install?`);
      }
      return path;
    }
    const groupContainers = (info.GroupContainers ?? {}) as Record<string, unknown>;
    if (containerType === 'groups') {
      const entries = Object.entries(groupContainers);
      if (entries.length === 0) {
        throw new Error(`'${bundleId}' has no App Group containers`);
      }
      if (entries.length > 1) {
        throw new Error(
          `'${bundleId}' has multiple App Group containers (${Object.keys(groupContainers).join(', ')}) — ` +
            `specify one by its group identifier instead of 'groups'`,
        );
      }
      const path = toFsPath(entries[0][1]);
      if (!path) {
        throw new Error(`'${bundleId}''s App Group container has no reported path`);
      }
      return path;
    }
    const path = toFsPath(groupContainers[containerType]);
    if (!path) {
      const available = Object.keys(groupContainers);
      const availability =
        available.length > 0 ? `available: ${available.join(', ')}` : 'it has no App Group containers at all';
      throw new Error(`'${bundleId}' has no App Group container with identifier '${containerType}' — ${availability}`);
    }
    return path;
  });
}
