import type {NativeSimctl} from '../native-simctl.js';
import {SimDeviceState, type SimPermissionService, type SimPermissionStatus} from '../types.js';
import {BulletinBoardStore, runCatchingAsync, SpringBoard, type NotificationsStatus} from '../utils/index.js';

const NOTIFICATIONS_SERVICE = 'notifications';

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
 * `notifications` isn't a TCC row: it is written to SpringBoard's BulletinBoard store instead. On a
 * booted device SpringBoard is restarted to load it, which terminates every running app; a shut down
 * device picks it up on its next boot.
 *
 * @param udid — UDID of the target device
 * @param service — permission to grant, e.g. `"camera"`, `"contacts"`, `"photos"`, `"notifications"`
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
 * Revokes a previously granted privacy permission from the given app. For `notifications`, a booted
 * device's SpringBoard is restarted, see {@link grantPermission}.
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
 * Resets a privacy permission for the given app to its default (unprompted) state. For
 * `notifications`, the app's section is removed from SpringBoard's store and a booted device's
 * SpringBoard is restarted, see {@link grantPermission}.
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
 * @throws {Error} for `notifications`: reading it isn't supported
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
 * `notifications` isn't a TCC row: SpringBoard keeps it per app in its BulletinBoard store, reads
 * that file only on its own start and rewrites it from memory from time to time (e.g. a few seconds
 * after it starts). So SpringBoard of a booted device is paused while the app's section is written,
 * then restarted with the store kept immutable until the old process is gone. The new SpringBoard
 * loads the change and terminates every running app. A shut down device only gets the file,
 * SpringBoard loads it on boot.
 */
async function setNotificationsAccess(
  this: NativeSimctl,
  udid: string,
  bundleId: string,
  status: NotificationsStatus,
): Promise<void> {
  const device = await this._findDevice(udid);
  const store = new BulletinBoardStore(device.dataPath(), this._options.bulletinBoardVersions);
  await store.withLock(async () => {
    const springBoard = device.state() === SimDeviceState.Booted ? new SpringBoard(this, udid) : undefined;
    await springBoard?.pause();
    let written = false;
    try {
      written = await store.setNotificationsStatus(bundleId, status);
    } finally {
      if (!written) {
        springBoard?.resume();
      }
    }
    if (!springBoard || !written) {
      return;
    }
    await store.setImmutable(true);
    try {
      await springBoard.restart();
    } finally {
      await store.setImmutable(false);
    }
  });
}
