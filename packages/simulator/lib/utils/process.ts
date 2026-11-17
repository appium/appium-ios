import {realpath} from 'node:fs/promises';

import {exec} from 'teen_process';

import {log} from '../logger.js';

/**
 * Scans the process table for a running macOS app by its executable path, rather than
 * `lsappinfo`'s LaunchServices/WindowServer-backed lookup — confirmed on at least one hosted CI
 * runner to never see a genuinely-running app (verified via its orphaned process still showing up
 * in job cleanup), presumably for lack of a login/GUI session.
 *
 * @param appPath - Path to the app's `.app` bundle.
 * @returns The process ID or null if the application is not running.
 */
export async function getMacAppPidByPath(appPath: string): Promise<string | null> {
  let stdout: string;
  try {
    ({stdout} = await exec('pgrep', ['-f', await toAppPathPattern(appPath)]));
  } catch {
    return null;
  }
  return stdout.trim().split('\n')[0] || null;
}

/**
 * @param appPath - Path to the app's `.app` bundle.
 * @returns True if the kill command succeeded.
 */
export async function killMacAppByPath(appPath: string): Promise<boolean> {
  try {
    await exec('pkill', ['-9', '-f', await toAppPathPattern(appPath)]);
    return true;
  } catch (e: any) {
    log.debug(`Could not kill app at '${appPath}': ${e.stderr || e.message}`);
    return false;
  }
}

/**
 * LaunchServices starts an app from its real path, so the command line of an app inside a
 * symlinked Xcode.app (e.g. `Xcode.app -> Xcode-27.0.app`) never contains the symlinked path,
 * while an app started directly through the symlink still does.
 *
 * @param appPath - Path to the app's `.app` bundle.
 * @returns An extended regular expression for `pgrep -f` / `pkill -f` that matches the given
 * path or, if it differs, its real path.
 */
async function toAppPathPattern(appPath: string): Promise<string> {
  let realAppPath: string;
  try {
    realAppPath = await realpath(appPath);
  } catch {
    return appPath;
  }
  return realAppPath === appPath ? appPath : `${appPath}|${realAppPath}`;
}
