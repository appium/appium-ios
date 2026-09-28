import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';

import {util} from '@appium/support';

import {
  appInfo,
  getAppContainer,
  installApp,
  installedApps,
  isAppInstalled,
  launchApp,
  removeApp,
  terminateApp,
} from './commands/app.js';
import {enrollBiometric, isBiometricEnrolled, sendBiometricMatch} from './commands/biometric.js';
import {
  getDarwinNotificationState,
  postDarwinNotification,
  setDarwinNotificationState,
} from './commands/darwin-notification.js';
import {clearLocation, getEnv, openUrl, pushNotification, setLocation} from './commands/interaction.js';
import {startJpegStream} from './commands/jpeg-stream.js';
import {addCertificate, addRootCertificate, resetKeychain} from './commands/keychain.js';
import {
  bootDevice,
  createDevice,
  deleteDevice,
  eraseDevice,
  getBootStatus,
  getDevices,
  getSupportedDeviceTypes,
  getSupportedRuntimes,
  shutdownAllDevices,
  shutdownDevice,
  waitForBoot,
} from './commands/lifecycle.js';
import {addMedia, addPhoto, addVideo} from './commands/media.js';
import {shake} from './commands/misc.js';
import {getPasteboard, setPasteboard} from './commands/pasteboard.js';
import {getPermission, grantPermission, resetPermission, revokePermission} from './commands/permissions.js';
import {getRuntimeRootPath, listProcesses} from './commands/process.js';
import {getDisplays, getScreenshot} from './commands/screenshot.js';
import {spawnProcess} from './commands/spawn.js';
import {
  getAppearance,
  getContentSize,
  getIncreaseContrast,
  getOrientation,
  setAppearance,
  setContentSize,
  setIncreaseContrast,
  setOrientation,
} from './commands/ui.js';
import {isVideoRecording, startVideoRecording, stopVideoRecording} from './commands/video-recording.js';
import {startVideoStream} from './commands/video-stream.js';
import {getWebInspectorSocket} from './commands/webinspector.js';
// Bare re-imports so `declare module './native-simctl.js'` augmentations in the command modules
// (which add their methods to NativeSimctl's type) reach downstream consumers' emitted .d.ts
// import graph — the named imports above alone aren't part of NativeSimctl's emitted type
// surface, so `tsc` would otherwise drop them from the declaration output.
import './commands/app.js';
import './commands/biometric.js';
import './commands/darwin-notification.js';
import './commands/interaction.js';
import './commands/jpeg-stream.js';
import './commands/keychain.js';
import './commands/lifecycle.js';
import './commands/media.js';
import './commands/misc.js';
import './commands/pasteboard.js';
import './commands/permissions.js';
import './commands/process.js';
import './commands/screenshot.js';
import './commands/spawn.js';
import './commands/ui.js';
import './commands/video-recording.js';
import './commands/video-stream.js';
import './commands/webinspector.js';
import {NativeSimUnavailableError} from './errors.js';
import type {
  NativeCoreSimModule,
  NativeDeviceHandle,
  NativeDeviceSetHandle,
  NativeServiceContextHandle,
} from './types.js';
import {getPkgRoot, PACKAGE_NAME, runCatchingAsync} from './utils/index.js';

const require = createRequire(import.meta.url);

/**
 * Drives `CoreSimulator.framework` directly — no `simctl`/`xcrun` subprocess — for the operations
 * `node-simctl`'s `Simctl` class exposes over the CLI. Devices are addressed by UDID; each call
 * re-resolves the native handle from the live device set, so a device deleted by another process
 * surfaces as a normal "not found" error rather than stale state.
 *
 * Every method that can trigger a CoreSimulator dispatch is `async`: the native layer runs the
 * underlying call on a libuv threadpool thread (see coresim.mm/async_bridge.h), so a slow
 * install/erase/create/etc. never blocks Node's event loop.
 *
 * The public command surface (everything except the constructor, `frameworkVersion`, and the
 * `_`-prefixed internal helpers below) lives in `src/commands/*.ts`, grouped by topic and mixed
 * into this class via `Object.assign(NativeSimctl.prototype, ...)` at the bottom of this file —
 * mirroring how `@appium/base-driver`'s `BaseDriver` composes its own command surface from
 * `basedriver/commands/*.ts`. Each command module also declares a `declare module
 * './native-simctl.js'` augmentation so `NativeSimctl`'s emitted type includes methods it doesn't
 * textually define.
 */
export class NativeSimctl {
  private cachedServiceContext: Promise<NativeServiceContextHandle> | undefined;

  /**
   * @param developerDir — defaults to `xcode-select -p` (the active Xcode's Developer dir).
   * @param deviceSetPath — defaults to the default device set
   * (`~/Library/Developer/CoreSimulator/Devices`), same as `simctl --set <path>`. Constructing a
   * NativeSimctl must never throw — the platform check and the native sharedServiceContext call
   * both happen lazily in the `_serviceContext` getter below, so only a method that actually needs
   * the simulator (getDevices(), createDevice(), ...) can raise.
   */
  constructor(
    private readonly developerDir?: string,
    private readonly deviceSetPath?: string,
  ) {}

  /** @returns `CFBundleVersion` of the loaded `CoreSimulator.framework` (e.g. `"1171.6"`). */
  static async frameworkVersion(): Promise<string> {
    return runCatchingAsync(() => loadNative().frameworkVersion());
  }

  /**
   * @internal Not part of the public API — exposed (not `private`) only so `src/commands/*.ts`
   * mixins can call it. Resolves and memoizes the native `SimServiceContext` on first access —
   * never in the constructor. `loadNative()` must run (and throw its typed platform error) before
   * `defaultDeveloperDir()` ever shells out to `xcode-select`, which doesn't exist off macOS — so
   * the fallback is resolved as an argument to the native call, not eagerly, preserving that
   * evaluation order. Caching the in-flight promise (not just its resolved value) means concurrent
   * callers before the first resolution still only trigger one `sharedServiceContext` call. On
   * rejection the cache is cleared again — a Promise is truthy even once rejected, so leaving a
   * failed one cached would otherwise make every later call reuse that same stale rejection
   * forever instead of retrying once the underlying condition clears.
   */
  async _serviceContext(): Promise<NativeServiceContextHandle> {
    if (!this.cachedServiceContext) {
      this.cachedServiceContext = runCatchingAsync(() =>
        loadNative().sharedServiceContext(this.developerDir ?? defaultDeveloperDir()),
      ).catch((err: unknown) => {
        this.cachedServiceContext = undefined;
        throw err;
      });
    }
    return this.cachedServiceContext;
  }

  /** @internal Not part of the public API — exposed only so `src/commands/*.ts` mixins can call it. */
  async _deviceSet(): Promise<NativeDeviceSetHandle> {
    const context = await this._serviceContext();
    const deviceSetPath = this.deviceSetPath;
    return runCatchingAsync(() =>
      deviceSetPath ? context.deviceSetWithPath(deviceSetPath) : context.defaultDeviceSet(),
    );
  }

  /** @internal Not part of the public API — exposed only so `src/commands/*.ts` mixins can call it. */
  async _findDevice(udid: string): Promise<NativeDeviceHandle> {
    return runCatchingAsync(async () => {
      const deviceSet = await this._deviceSet();
      const device = (await deviceSet.devices()).find(
        (candidate) => candidate.udid().toLowerCase() === udid.toLowerCase(),
      );
      if (!device) {
        throw new Error(`No simulator device found with udid '${udid}'`);
      }
      return device;
    });
  }
}

Object.assign(NativeSimctl.prototype, {
  // lifecycle
  getDevices,
  getSupportedDeviceTypes,
  getSupportedRuntimes,
  createDevice,
  deleteDevice,
  bootDevice,
  getBootStatus,
  waitForBoot,
  shutdownDevice,
  shutdownAllDevices,
  eraseDevice,

  // app
  installApp,
  removeApp,
  launchApp,
  terminateApp,
  isAppInstalled,
  appInfo,
  installedApps,
  getAppContainer,

  // media
  addMedia,
  addPhoto,
  addVideo,

  // biometric
  isBiometricEnrolled,
  enrollBiometric,
  sendBiometricMatch,

  // misc
  shake,

  // interaction
  getEnv,
  openUrl,
  setLocation,
  clearLocation,
  pushNotification,

  // keychain
  addCertificate,
  addRootCertificate,
  resetKeychain,

  // ui
  getAppearance,
  setAppearance,
  getIncreaseContrast,
  setIncreaseContrast,
  getContentSize,
  setContentSize,
  setOrientation,
  getOrientation,

  // permissions
  grantPermission,
  revokePermission,
  resetPermission,
  getPermission,

  // process
  listProcesses,
  getRuntimeRootPath,

  // darwin notification
  getDarwinNotificationState,
  setDarwinNotificationState,
  postDarwinNotification,

  // pasteboard
  getPasteboard,
  setPasteboard,

  // screenshot
  getScreenshot,
  getDisplays,

  // video recording
  startVideoRecording,
  stopVideoRecording,
  isVideoRecording,
  startVideoStream,
  startJpegStream,

  // webinspector
  getWebInspectorSocket,

  // spawn
  spawnProcess,
});

// Loaded lazily (not at module import time) so merely depending on/importing @appium/coresim —
// e.g. for its error classes or types — works on any platform; only actually using it (booting a
// simulator, etc.) requires macOS, where CoreSimulator.framework exists. `npm install` never
// attempts to build the addon on other platforms either (see scripts/install.mjs). Any macOS arch
// works — node-gyp-build falls back to compiling from source on an arch with no matching
// prebuild (e.g. an Intel Mac, since only darwin-arm64 is prebuilt today). util.memoize only
// caches a normal return, never a throw (see @appium/support's util.js), so the platform check
// below re-runs — and re-throws — on every call until it actually succeeds once.
const loadNative = util.memoize(function loadNative(): NativeCoreSimModule {
  if (process.platform !== 'darwin') {
    throw new NativeSimUnavailableError(
      `${PACKAGE_NAME} requires macOS — CoreSimulator.framework does not exist on ${process.platform}`,
      'platform',
      process.platform,
      'n/a',
    );
  }
  const native = require('node-gyp-build')(getPkgRoot()) as NativeCoreSimModule;
  // A forgotten (never explicitly stopped) AV recording/stream otherwise silently loses data —
  // or just leaks a live encoder — the instant a caller force-exits via `process.exit()`, since
  // Node's own cleanup hooks (coresim.mm's CleanupActiveSessions, registered against the exact
  // same condition) are confirmed to NOT run in that path, only on a natural empty-event-loop
  // exit or a Worker's own termination. `process.on('exit', ...)` does fire for `process.exit()`
  // too, and (per Node's own contract) may run synchronous code — flushActiveSessions() qualifies:
  // it's a single blocking native call, not new async JS work. Registered once, lazily, here
  // rather than at module import time, so merely importing this package on a non-macOS platform
  // never touches `process` for something it'll never need.
  process.on('exit', () => native.flushActiveSessions());
  return native;
});

const DEFAULT_DEVELOPER_DIR_TIMEOUT_MS = 15_000;

function defaultDeveloperDir(): string {
  try {
    return execFileSync('xcode-select', ['-p'], {
      encoding: 'utf8',
      timeout: DEFAULT_DEVELOPER_DIR_TIMEOUT_MS,
    }).trim();
  } catch (err) {
    // A non-zero exit (e.g. CLT installed but no Xcode selected) already carries a clear stderr
    // message from xcode-select itself; only ENOENT (the binary isn't on PATH at all) and
    // ETIMEDOUT need a friendlier message than Node's raw "spawnSync xcode-select ENOENT/ETIMEDOUT".
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error('xcode-select not found on PATH — install Xcode or the Xcode Command Line Tools', {
        cause: err,
      });
    }
    if ((err as NodeJS.ErrnoException)?.code === 'ETIMEDOUT') {
      throw new Error(`xcode-select -p did not respond within ${DEFAULT_DEVELOPER_DIR_TIMEOUT_MS}ms`, {cause: err});
    }
    throw err;
  }
}
