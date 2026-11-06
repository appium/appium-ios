import {constants as fsConstants} from 'node:fs';
import path from 'node:path';

import {fs, util} from '@appium/support';
import {exec} from 'teen_process';

import {DEVICE_HUB_UI_CLIENT_BUNDLE_ID} from './constants.js';

const ACCESS_PROBE_TIMEOUT_MS = 1000;

/** Thrown when macOS denies access to DeviceHub's sandbox container, or does not answer in time. */
export class DeviceHubAccessError extends Error {
  constructor(deniedPath: string, options?: ErrorOptions & {timedOutMs?: number}) {
    const hint =
      `Grant Full Disk Access to the application running this process ` +
      `(System Settings > Privacy & Security > Full Disk Access) and restart it`;
    super(
      options?.timedOutMs
        ? `macOS did not answer within ${options.timedOutMs}ms the request to access the DeviceHub preferences ` +
            `at '${deniedPath}'. It is probably waiting for the access permission to be granted. ${hint}`
        : `macOS denies access to the DeviceHub preferences at '${deniedPath}'. ${hint}`,
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

export type AccessProbeResult = 'ok' | 'denied' | 'timeout';
export type AccessProbe = (dir: string) => Promise<AccessProbeResult>;

// macOS 27 denies access to other apps' containers right away, while older versions block
// the caller until the user answers the permission prompt (or forever, if it is never shown)
const MIN_NON_BLOCKING_MACOS_MAJOR = 27;

/** Replaceable in unit tests. */
export const macOs = {
  /** @returns The major macOS version, or NaN if it cannot be determined */
  getMajorVersion: util.memoize(async (): Promise<number> => {
    try {
      const {stdout} = await exec('sw_vers', ['-productVersion']);
      return parseInt(stdout.trim(), 10);
    } catch {
      return NaN;
    }
  }),
};

/** Checks access in the current process, which is fine as long as the answer is immediate. */
async function checkDirectoryAccess(dir: string): Promise<AccessProbeResult> {
  try {
    await fs.access(dir, fsConstants.R_OK | fsConstants.W_OK);
    return 'ok';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'EPERM' || code === 'EACCES') {
      return 'denied';
    }
    if (code === 'ENOENT') {
      return 'ok';
    }
    throw e;
  }
}

/** Checks access in a child process, since only a child can be killed if the request never gets answered. */
async function probeDirectoryAccess(dir: string): Promise<AccessProbeResult> {
  try {
    await exec('/bin/sh', ['-c', 'test -r "$0" && test -w "$0"', dir], {
      timeout: ACCESS_PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return 'ok';
  } catch (e: any) {
    if (/timed out/.test(e.message)) {
      return 'timeout';
    }
    if (typeof e.code === 'number') {
      return 'denied';
    }
    throw e;
  }
}

async function selectAccessProbe(): Promise<AccessProbe> {
  return (await macOs.getMajorVersion()) >= MIN_NON_BLOCKING_MACOS_MAJOR ? checkDirectoryAccess : probeDirectoryAccess;
}

/**
 * Verifies that the DeviceHub preferences directory is readable and writable.
 * Does nothing if the container does not exist, i.e. DeviceHub has never run.
 *
 * @param homeFolderPath - The user's home folder
 * @param probe - Checks access to an existing directory. Defaults to a check suitable for the macOS version
 * @throws {DeviceHubAccessError} If macOS denies access to the container or does not answer in time
 */
export async function assertDeviceHubPreferencesAccess(homeFolderPath: string, probe?: AccessProbe): Promise<void> {
  const containerPath = getDeviceHubContainerPath(homeFolderPath);
  // stat is not subject to the container protection, unlike access/open, so it cannot block
  if (!(await statExists(containerPath))) {
    return;
  }
  // Probe the deepest existing directory (the container included), since the protection applies to all of it
  let dir = path.dirname(getDeviceHubPreferencesPath(homeFolderPath));
  while (dir !== containerPath && !(await statExists(dir))) {
    dir = path.dirname(dir);
  }
  switch (await (probe ?? (await selectAccessProbe()))(dir)) {
    case 'denied':
      throw new DeviceHubAccessError(dir);
    case 'timeout':
      throw new DeviceHubAccessError(dir, {timedOutMs: ACCESS_PROBE_TIMEOUT_MS});
  }
}

async function statExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return false;
    }
    throw e;
  }
}
