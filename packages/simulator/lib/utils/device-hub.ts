import {constants as fsConstants} from 'node:fs';
import path from 'node:path';

import {fs} from '@appium/support';

import {DEVICE_HUB_UI_CLIENT_BUNDLE_ID} from './constants.js';

/** Thrown when macOS denies access to DeviceHub's sandbox container. */
export class DeviceHubAccessError extends Error {
  constructor(deniedPath: string, options?: ErrorOptions) {
    super(
      `macOS denies access to the DeviceHub preferences at '${deniedPath}'. ` +
        `Grant Full Disk Access to the application running this process ` +
        `(System Settings > Privacy & Security > Full Disk Access) and restart it`,
      options,
    );
    this.name = 'DeviceHubAccessError';
  }
}

/** DeviceHub is sandboxed, so its preferences live in its own container. */
export function getDeviceHubContainerPath(homeFolderPath: string): string {
  return path.resolve(homeFolderPath, 'Library', 'Containers', DEVICE_HUB_UI_CLIENT_BUNDLE_ID);
}

export function getDeviceHubPreferencesPath(homeFolderPath: string): string {
  return path.join(
    getDeviceHubContainerPath(homeFolderPath),
    'Data',
    'Library',
    'Preferences',
    `${DEVICE_HUB_UI_CLIENT_BUNDLE_ID}.plist`,
  );
}

/**
 * Verifies that the DeviceHub preferences directory is readable and writable.
 * Does nothing if the container does not exist, i.e. DeviceHub has never run.
 *
 * @param homeFolderPath - The user's home folder
 * @throws {DeviceHubAccessError} If macOS denies access to the container
 */
export async function assertDeviceHubPreferencesAccess(homeFolderPath: string): Promise<void> {
  const containerPath = getDeviceHubContainerPath(homeFolderPath);
  try {
    // stat is not subject to the container protection, unlike access/open
    await fs.stat(containerPath);
  } catch (e) {
    if (isErrno(e, 'ENOENT')) {
      return;
    }
    throw toAccessError(e, containerPath);
  }
  // Walk up to the deepest existing directory, since the protection applies to the whole container
  let dir = path.dirname(getDeviceHubPreferencesPath(homeFolderPath));
  while (dir !== containerPath) {
    try {
      await fs.access(dir, fsConstants.R_OK | fsConstants.W_OK);
      return;
    } catch (e) {
      if (!isErrno(e, 'ENOENT')) {
        throw toAccessError(e, dir);
      }
      dir = path.dirname(dir);
    }
  }
}

function isErrno(e: unknown, ...codes: string[]): boolean {
  return codes.includes((e as NodeJS.ErrnoException)?.code ?? '');
}

function toAccessError(e: unknown, deniedPath: string): unknown {
  return isErrno(e, 'EPERM', 'EACCES') ? new DeviceHubAccessError(deniedPath, {cause: e}) : e;
}
