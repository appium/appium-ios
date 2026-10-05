import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import path from 'node:path';
import {promisify} from 'node:util';

import {fs, plist} from '@appium/support';
import {waitForCondition} from 'asyncbox';

import type {NativeSimctl} from '../native-simctl.js';
import {SimDeviceState, type SimPermissionService, type SimPermissionStatus} from '../types.js';
import {runCatchingAsync} from '../utils/index.js';

const execFileAsync = promisify(execFile);

const NOTIFICATIONS_SERVICE = 'notifications';
const SPRINGBOARD_SERVICE = 'com.apple.SpringBoard';
// The `sectionInfoVersionNumber` of the BulletinBoard stores SpringBoard writes (iOS 18 and 26).
const BULLETIN_BOARD_STORE_VERSION = 2;
const SPRINGBOARD_RESTART_TIMEOUT_MS = 30000;

// The last pending notifications update of each BulletinBoard store, see withStoreLock.
const storeUpdates = new Map<string, Promise<void>>();

declare module '../native-simctl.js' {
  interface NativeSimctl {
    grantPermission(
      udid: string,
      service: SimPermissionService,
      bundleId: string,
      status?: 'granted' | 'limited' | 'critical',
    ): Promise<void>;
    revokePermission(udid: string, service: SimPermissionService, bundleId: string): Promise<void>;
    resetPermission(udid: string, service: SimPermissionService, bundleId: string): Promise<void>;
    getPermission(udid: string, service: SimPermissionService, bundleId: string): Promise<SimPermissionStatus>;
  }
}

/**
 * Grants a privacy permission to the given app on the given device, by writing directly to the
 * simulator's own TCC (privacy) database — see CLAUDE.md for why this bypasses CoreSimulator's own
 * privacy API.
 *
 * @param udid — UDID of the target device
 * @param service — permission to grant, e.g. `"camera"`, `"contacts"`, `"photos"`
 * @param bundleId — bundle identifier of the app the permission applies to
 * @param status — defaults to `'granted'`. `'limited'` ("selected photos" access) is only valid
 * for the `photos` service, `'critical'` (critical alerts allowed too) — for `notifications`.
 */
export async function grantPermission(
  this: NativeSimctl,
  udid: string,
  service: SimPermissionService,
  bundleId: string,
  status: 'granted' | 'limited' | 'critical' = 'granted',
): Promise<void> {
  return runCatchingAsync(async () => {
    if (status === 'limited' && service !== 'photos') {
      throw new Error(`'limited' is only a valid status for the 'photos' service, not '${service}'`);
    }
    if (service === NOTIFICATIONS_SERVICE) {
      return await setNotificationsAccess.call(this, udid, bundleId, status === 'critical' ? 'critical' : 'granted');
    }
    if (status === 'critical') {
      throw new Error(`'critical' is only a valid status for the 'notifications' service, not '${service}'`);
    }
    const tccIdentifier = toTCCIdentifier(service);
    return (await this._findDevice(udid)).grantPermission(tccIdentifier, bundleId, status);
  });
}

/**
 * Revokes a previously granted privacy permission from the given app.
 *
 * @param udid — UDID of the target device
 * @param service — permission to revoke (see {@link grantPermission})
 * @param bundleId — bundle identifier of the app the permission applies to
 */
export async function revokePermission(
  this: NativeSimctl,
  udid: string,
  service: SimPermissionService,
  bundleId: string,
): Promise<void> {
  return runCatchingAsync(async () => {
    if (service === NOTIFICATIONS_SERVICE) {
      return await setNotificationsAccess.call(this, udid, bundleId, 'denied');
    }
    const tccIdentifier = toTCCIdentifier(service);
    return (await this._findDevice(udid)).revokePermission(tccIdentifier, bundleId);
  });
}

/**
 * Resets a privacy permission for the given app to its default (unprompted) state.
 *
 * @param udid — UDID of the target device
 * @param service — permission to reset (see {@link grantPermission})
 * @param bundleId — bundle identifier of the app the permission applies to
 */
export async function resetPermission(
  this: NativeSimctl,
  udid: string,
  service: SimPermissionService,
  bundleId: string,
): Promise<void> {
  return runCatchingAsync(async () => {
    if (service === NOTIFICATIONS_SERVICE) {
      return await setNotificationsAccess.call(this, udid, bundleId, 'unset');
    }
    const tccIdentifier = toTCCIdentifier(service);
    return (await this._findDevice(udid)).resetPermission(tccIdentifier, bundleId);
  });
}

/**
 * Reads a privacy permission's current status directly from the simulator's own TCC database —
 * there's no CoreSimulator getter for this, only the setters {@link grantPermission}/
 * {@link revokePermission}/{@link resetPermission} write to (see CLAUDE.md).
 *
 * @param udid — UDID of the device to read from
 * @param service — permission to check (see {@link grantPermission})
 * @param bundleId — bundle identifier of the app the permission applies to
 * @returns `'unset'` if the app has never been prompted/decided for this permission
 */
export async function getPermission(
  this: NativeSimctl,
  udid: string,
  service: SimPermissionService,
  bundleId: string,
): Promise<SimPermissionStatus> {
  return runCatchingAsync(async () => {
    if (service === NOTIFICATIONS_SERVICE) {
      throw new Error(`The status of the '${NOTIFICATIONS_SERVICE}' permission cannot be read`);
    }
    const tccIdentifier = toTCCIdentifier(service);
    return (await this._findDevice(udid)).getPermission(tccIdentifier, bundleId);
  });
}

// Maps a friendly service name to the internal TCC service identifier its row in the simulator's
// own TCC.db is keyed on (see native/tcc_privacy.h). `location` is deliberately absent: it isn't a
// plain TCC row (CoreLocation simulation has its own subsystem), so it isn't supported by this
// TCC.db-based implementation. `notifications` isn't a TCC row either, see setNotificationsAccess.
const SERVICE_TO_TCC_IDENTIFIER: Record<Exclude<SimPermissionService, 'notifications'>, string> = {
  calendar: 'kTCCServiceCalendar',
  camera: 'kTCCServiceCamera',
  contacts: 'kTCCServiceAddressBook',
  faceid: 'kTCCServiceFaceID',
  health: 'kTCCServiceMSO',
  homekit: 'kTCCServiceWillow',
  medialibrary: 'kTCCServiceMediaLibrary',
  microphone: 'kTCCServiceMicrophone',
  motion: 'kTCCServiceMotion',
  photos: 'kTCCServicePhotos',
  reminders: 'kTCCServiceReminders',
  siri: 'kTCCServiceSiri',
  speech: 'kTCCServiceSpeechRecognition',
  usertracking: 'kTCCServiceUserTracking',
};

function toTCCIdentifier(service: Exclude<SimPermissionService, 'notifications'>): string {
  const identifier = SERVICE_TO_TCC_IDENTIFIER[service];
  if (!identifier) {
    throw new Error(
      `'${service}' is not a supported permission. Supported: ${Object.keys(SERVICE_TO_TCC_IDENTIFIER).join(', ')}`,
    );
  }
  return identifier;
}

/**
 * `notifications` isn't a TCC row: SpringBoard keeps it per app in its BulletinBoard store
 * (`Library/BulletinBoard/VersionedSectionInfo.plist`), reads that file only on its own start and
 * rewrites it from memory from time to time (e.g. a few seconds after it starts). So SpringBoard of
 * a booted device is paused while the app's section is written, then restarted with the store kept
 * immutable until the old process is gone. The new SpringBoard loads the change and terminates
 * every running app. A shut down device only gets the file, SpringBoard loads it on boot.
 */
async function setNotificationsAccess(
  this: NativeSimctl,
  udid: string,
  bundleId: string,
  status: 'granted' | 'denied' | 'critical' | 'unset',
): Promise<void> {
  const device = await this._findDevice(udid);
  const storePath = path.join(device.dataPath(), 'Library', 'BulletinBoard', 'VersionedSectionInfo.plist');
  await withStoreLock(storePath, async () => {
    const springBoardPid =
      device.state() === SimDeviceState.Booted ? await pauseSpringBoard.call(this, udid) : undefined;
    let written = false;
    try {
      written = await writeNotificationsSection(storePath, bundleId, status);
    } finally {
      if (springBoardPid && !written) {
        sendSignal(springBoardPid, 'SIGCONT');
      }
    }
    if (!springBoardPid || !written) {
      return;
    }
    await setImmutable(storePath, true);
    try {
      try {
        await stopSpringBoard.call(this, udid);
      } finally {
        sendSignal(springBoardPid, 'SIGCONT');
      }
      await waitForNewSpringBoard.call(this, udid, springBoardPid);
    } finally {
      await setImmutable(storePath, false);
    }
  });
}

/**
 * Runs `update` once every earlier update of the same store has settled: concurrent updates for
 * different apps would otherwise read the same store, and the last write would drop the other app's
 * section. Only the calls made by this process are serialized.
 */
async function withStoreLock(storePath: string, update: () => Promise<void>): Promise<void> {
  const result = (storeUpdates.get(storePath) ?? Promise.resolve()).then(update);
  const settled = result.catch(() => {});
  storeUpdates.set(storePath, settled);
  try {
    await result;
  } finally {
    if (storeUpdates.get(storePath) === settled) {
      storeUpdates.delete(storePath);
    }
  }
}

/**
 * Adds, replaces or (`unset`) removes the app's section. The store is replaced atomically, so a
 * failed write leaves the previous one intact. A device that has never been booted has no store yet:
 * it is created with just this section, and SpringBoard adds the rest on boot.
 *
 * @returns `false` if there was nothing to write (`unset` without a store)
 */
async function writeNotificationsSection(
  storePath: string,
  bundleId: string,
  status: 'granted' | 'denied' | 'critical' | 'unset',
): Promise<boolean> {
  let store: {sectionInfoVersionNumber?: number; sectionInfo?: Record<string, Uint8Array>};
  if (await fs.exists(storePath)) {
    store = (await plist.parsePlistFile(storePath)) as typeof store;
  } else if (status === 'unset') {
    return false;
  } else {
    await fs.mkdir(path.dirname(storePath), {recursive: true});
    store = {sectionInfoVersionNumber: BULLETIN_BOARD_STORE_VERSION};
  }
  const sectionInfo = store.sectionInfo ?? {};
  if (status === 'unset') {
    delete sectionInfo[bundleId];
  } else {
    sectionInfo[bundleId] = buildNotificationsSectionInfo(bundleId, status);
  }
  store.sectionInfo = sectionInfo;
  // In the same directory, so that the rename is atomic.
  const tmpPath = `${storePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, plist.createPlist(store, false), {flag: 'wx'});
    await fs.rename(tmpPath, storePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
  return true;
}

/**
 * Builds the NSKeyedArchiver-encoded `BBSectionInfo` of `bundleId`, the same archive
 * AppleSimulatorUtils writes (SetNotificationsPermission.m). SpringBoard migrates its
 * `allowsNotifications` flag to the current `authorizationStatus` when it loads the section.
 */
function buildNotificationsSectionInfo(bundleId: string, status: 'granted' | 'denied' | 'critical'): Buffer {
  const nil = {UID: 0};
  return plist.createBinaryPlist({
    $version: 100000,
    $objects: [
      '$null',
      {
        suppressFromSettings: false,
        suppressedSettings: 0,
        hideWeeApp: false,
        sectionID: {UID: 2},
        displayName: {UID: 5},
        icon: nil,
        displaysCriticalBulletins: false,
        subsections: nil,
        sectionInfoSettings: {UID: 3},
        $class: {UID: 7},
        sectionCategory: 0,
        subsectionPriority: 0,
        version: {UID: 6},
        managedSectionInfoSettings: nil,
        appName: {UID: 5},
        sectionType: 0,
        factorySectionID: nil,
        dataProviderIDs: nil,
        subsectionID: nil,
        filters: nil,
        pathToWeeAppPluginBundle: nil,
      },
      bundleId,
      {
        pushSettings: 63,
        showsInNotificationCenter: true,
        allowsNotifications: status !== 'denied',
        showsOnExternalDevices: true,
        contentPreviewSetting: 0,
        carPlaySetting: 0,
        $class: {UID: 4},
        showsInLockScreen: true,
        alertType: 1,
        criticalAlertSetting: status === 'critical' ? 2 : 0,
      },
      {$classname: 'BBSectionInfoSettings', $classes: ['BBSectionInfoSettings', 'NSObject']},
      bundleId,
      0,
      {$classname: 'BBSectionInfo', $classes: ['BBSectionInfo', 'NSObject']},
    ],
    $archiver: 'NSKeyedArchiver',
    $top: {root: {UID: 1}},
  });
}

async function setImmutable(filePath: string, immutable: boolean): Promise<void> {
  try {
    await execFileAsync('chflags', [immutable ? 'uchg' : 'nouchg', filePath]);
  } catch {}
}

/**
 * Asks launchd to stop SpringBoard of the given booted device; launchd starts a new one right away.
 */
async function stopSpringBoard(this: NativeSimctl, udid: string): Promise<void> {
  // Bare name: resolved against the guest runtime's own bin dirs, like in listProcesses.
  const proc = await this.spawnProcess(udid, 'launchctl', {arguments: ['launchctl', 'stop', SPRINGBOARD_SERVICE]});
  let stderr = '';
  proc.stdout.resume();
  proc.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk;
  });
  const streamError = Promise.race([once(proc.stdout, 'error'), once(proc.stderr, 'error')]).then(([err]) => {
    throw err;
  });
  const [[code, signal]] = await Promise.race([
    Promise.all([once(proc, 'exit'), once(proc.stderr, 'end')]),
    streamError,
  ]);
  if (code !== 0) {
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    throw new Error(
      `'launchctl stop ${SPRINGBOARD_SERVICE}' failed with ${reason}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
    );
  }
}

/**
 * Pauses the running SpringBoard so that it cannot rewrite the BulletinBoard store. The simulator
 * shares the host kernel, so its processes are signalled directly. SpringBoard can be in the
 * middle of a restart, hence the retries.
 *
 * @returns the paused process id
 */
async function pauseSpringBoard(this: NativeSimctl, udid: string): Promise<number> {
  let pausedPid: number | undefined;
  try {
    await waitForCondition(
      async () => {
        const pid = await findSpringBoardPid.call(this, udid).catch(() => undefined);
        if (pid && sendSignal(pid, 'SIGSTOP')) {
          pausedPid = pid;
        }
        return Boolean(pausedPid);
      },
      {waitMs: SPRINGBOARD_RESTART_TIMEOUT_MS, intervalMs: 300},
    );
  } catch {}
  if (!pausedPid) {
    throw new Error(`${SPRINGBOARD_SERVICE} is not running`);
  }
  return pausedPid;
}

/**
 * @returns `false` if the process no longer exists
 */
function sendSignal(pid: number, name: NodeJS.Signals): boolean {
  try {
    process.kill(pid, name);
    return true;
  } catch (err: any) {
    if (err?.code === 'ESRCH') {
      return false;
    }
    throw err;
  }
}

async function findSpringBoardPid(this: NativeSimctl, udid: string): Promise<number | undefined> {
  return (await this.listProcesses(udid)).find(({name}) => name === SPRINGBOARD_SERVICE)?.pid;
}

async function waitForNewSpringBoard(this: NativeSimctl, udid: string, previousPid: number): Promise<void> {
  try {
    await waitForCondition(
      async () => {
        const pid = await findSpringBoardPid.call(this, udid).catch(() => undefined);
        return Number.isInteger(pid) && pid !== previousPid;
      },
      {waitMs: SPRINGBOARD_RESTART_TIMEOUT_MS, intervalMs: 300},
    );
  } catch {
    throw new Error(`${SPRINGBOARD_SERVICE} did not restart within ${SPRINGBOARD_RESTART_TIMEOUT_MS}ms`);
  }
}
