import assert from 'node:assert';
import {execFile} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {waitForCondition} from 'asyncbox';

import {
  DeviceOrientation,
  NativeSimctl,
  NativeSimError,
  NativeSimOperationError,
  NativeSimUnavailableError,
  SimDeviceState,
  type SimDeviceInfo,
} from '../../src/index.js';
import {
  createSelfSignedCert,
  createTestPhoto,
  createTestVideo,
  getUIKitCatalogPath,
  hasFfmpeg,
  UICATALOG_BUNDLE_ID,
} from '../fixtures.js';

const execFileAsync = promisify(execFile);

const IS_CI = Boolean(process.env.CI);
// This suite otherwise shares a single boot cycle per Xcode version (see integration-test.yml) —
// shutdownAllDevices() needs its own second throwaway device booted/deleted just to exercise it,
// which would materially add to CI's already-expensive real-boot cost for one extra assertion.
const SKIP_EXPENSIVE_IN_CI = IS_CI
  ? 'too expensive for CI: requires booting a second throwaway device beyond this suite’s shared one'
  : false;

/**
 * `deleteDevice:error:` returns success synchronously but the actual removal (filesystem cleanup)
 * happens on a background queue — empirically confirmed to settle within ~500ms, but polled with
 * headroom here rather than assuming a fixed delay.
 */
async function waitUntilDeleted(sim: NativeSimctl, udid: string): Promise<void> {
  await waitForCondition(async () => !(await sim.getDevices()).some((d) => d.udid === udid), {
    waitMs: 5000,
    intervalMs: 250,
    error: 'expected the throwaway device to disappear',
  });
}

/** iOS-only checks (app install, openUrl) need a real browser/app-install surface tvOS/watchOS/visionOS don't have. */
function isIOSRuntime(runtimeIdentifier: string): boolean {
  return runtimeIdentifier.includes('.SimRuntime.iOS-');
}

/**
 * The Core Audio process tap needs at least one guest process already registered with the host's
 * audio HAL — right after boot this can transiently be empty. Polls `fn` via waitForCondition
 * instead of treating that as a hard failure; any other error passes through immediately for the
 * caller's own isAudioCaptureUnavailable()/t.skip() handling.
 *
 * If the whole wait budget is spent still seeing that error, waitForCondition would otherwise
 * throw its own generic timeout Error — losing the real NativeSimOperationError and turning what
 * should be a graceful isAudioCaptureUnavailable()/t.skip() into a hard test failure. The last
 * real error is tracked and re-thrown instead.
 */
async function retryUntilAudioProcessesFound<T>(fn: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  let lastError: unknown;
  try {
    await waitForCondition(
      async () => {
        try {
          result = await fn();
          return true;
        } catch (err) {
          const noProcessesYet =
            err instanceof NativeSimOperationError && err.domain === 'io.appium.coresim.AudioTap' && err.code === 2;
          if (!noProcessesYet) {
            throw err;
          }
          lastError = err;
          return false;
        }
      },
      {waitMs: 20000, intervalMs: 1000},
    );
  } catch (err) {
    throw lastError ?? err;
  }
  return result as T;
}

/**
 * Whether `err` means the audio-capture side of `audio: true` isn't usable here — host macOS
 * predates 14.2, or no guest process ever registered with CoreAudio — rather than a real bug.
 * Doesn't cover a TCC denial, which isn't a thrown error at all (see CLAUDE.md); these tests only
 * assert the pipeline produces a structurally valid track, never that it's actually audible.
 */
function isAudioCaptureUnavailable(err: unknown): boolean {
  return (
    err instanceof NativeSimUnavailableError ||
    (err instanceof NativeSimOperationError && err.domain === 'io.appium.coresim.AudioTap')
  );
}

/**
 * Reads a permission's current grant state straight out of the simulator's own TCC.db — the same
 * database grantPermission/revokePermission/resetPermission write to (see CLAUDE.md) — so these
 * tests verify the actual persisted effect, not just that the call didn't throw.
 *
 * @returns `true`/`false` if a row exists, `undefined` if the permission is unset (no row, e.g.
 * after resetPermission)
 */
async function readTCCGranted(udid: string, tccService: string, bundleId: string): Promise<boolean | undefined> {
  const dbPath = path.join(
    os.homedir(),
    'Library',
    'Developer',
    'CoreSimulator',
    'Devices',
    udid,
    'data',
    'Library',
    'TCC',
    'TCC.db',
  );
  const query = async (sql: string) => {
    const {stdout} = await execFileAsync('sqlite3', ['-line', dbPath, sql]);
    return Number(stdout.split('=')[1]?.trim() ?? '0');
  };
  const rowExists =
    (await query(
      `SELECT count(*) FROM access WHERE service='${tccService}' AND client='${bundleId}' AND client_type=0`,
    )) > 0;
  if (!rowExists) {
    return undefined;
  }
  return (
    (await query(
      `SELECT count(*) FROM access WHERE service='${tccService}' AND client='${bundleId}' AND client_type=0 AND auth_value=2`,
    )) > 0
  );
}

/** The host-side path to a device's own copy of backboardd's preference file (see sim_orientation.mm). */
function backboardPlistPath(udid: string): string {
  return path.join(
    os.homedir(),
    'Library',
    'Developer',
    'CoreSimulator',
    'Devices',
    udid,
    'data',
    'Library',
    'Preferences',
    'com.apple.backboardd.plist',
  );
}

/**
 * Overwrites `plistPath`'s `BKDigitizerPersistentServiceProperties` with a single fresh entry
 * reporting `graphicsOrientation` — a way to simulate a rotation for getOrientation/video_encoder.mm
 * to pick up without relying on setOrientation, whose mach delivery no-ops for a device created and
 * booted in-process (see the "accepts setOrientation" test).
 */
async function injectGraphicsOrientation(plistPath: string, graphicsOrientation: number): Promise<void> {
  await execFileAsync('/usr/libexec/PlistBuddy', [
    '-c',
    'Delete :BKDigitizerPersistentServiceProperties',
    plistPath,
  ]).catch(() => {});
  for (const command of [
    'Add :BKDigitizerPersistentServiceProperties array',
    'Add :BKDigitizerPersistentServiceProperties:0 dict',
    'Add :BKDigitizerPersistentServiceProperties:0:props dict',
    `Add :BKDigitizerPersistentServiceProperties:0:props:GraphicsOrientation integer ${graphicsOrientation}`,
  ]) {
    await execFileAsync('/usr/libexec/PlistBuddy', ['-c', command, plistPath]);
  }
  await fs.promises.utimes(plistPath, new Date(), new Date());
}

/**
 * Xcode 27's DeviceHub, when running, syncs the host pasteboard into every booted device by default,
 * overwriting what the pasteboard test sets. It reads this per-device preference at boot, so call before boot.
 */
async function disableDeviceHubPasteboardSync(udid: string): Promise<void> {
  const prefsDir = path.join(
    os.homedir(),
    'Library',
    'Containers',
    'com.apple.dt.Devices',
    'Data',
    'Library',
    'Preferences',
  );
  // No sandbox container means DeviceHub never ran on this machine, so nothing can sync into the device
  if (!fs.existsSync(prefsDir)) {
    return;
  }
  await execFileAsync('defaults', [
    'write',
    path.join(prefsDir, 'com.apple.dt.Devices.plist'),
    'DevicePreferences',
    '-dict-add',
    udid,
    '<dict><key>pasteboardSyncEnabled</key><false/></dict>',
  ]);
}

interface RuntimeFixture {
  runtimeIdentifier: string;
  runtimeName: string;
  runtimeVersion: string;
  deviceTypeIdentifier: string;
}

/**
 * One (runtime, compatible device type) pair per distinct simulator runtime actually installed —
 * borrowed from an existing device rather than guessed out of supportedDeviceTypes() (which
 * includes watchOS/tvOS/visionOS types that aren't compatible with an iOS runtime), so
 * createDevice is guaranteed to succeed against every entry this returns.
 */
async function availableRuntimeFixtures(sim: NativeSimctl): Promise<RuntimeFixture[]> {
  const [runtimes, devices] = await Promise.all([sim.getSupportedRuntimes(), sim.getDevices()]);
  const runtimeById = new Map(runtimes.map((r) => [r.identifier, r]));
  const deviceTypeByRuntime = new Map<string, string>();
  for (const device of devices) {
    if (device.runtimeIdentifier && device.deviceTypeIdentifier && !deviceTypeByRuntime.has(device.runtimeIdentifier)) {
      deviceTypeByRuntime.set(device.runtimeIdentifier, device.deviceTypeIdentifier);
    }
  }
  return [...deviceTypeByRuntime.entries()].map(([runtimeIdentifier, deviceTypeIdentifier]) => {
    const runtime = runtimeById.get(runtimeIdentifier);
    return {
      runtimeIdentifier,
      runtimeName: runtime?.name ?? runtimeIdentifier,
      runtimeVersion: runtime?.versionString ?? '0',
      deviceTypeIdentifier,
    };
  });
}

/**
 * Parses width/height out of a JPEG's SOF marker — avoids a temp file/subprocess just to check a
 * frame's actual pixel dimensions (e.g. for asserting `startJpegStream`'s `scale` option).
 */
function jpegDimensions(data: Buffer): {width: number; height: number} {
  let offset = 2; // skip the SOI marker (0xffd8)
  while (offset < data.length) {
    if (data[offset] !== 0xff) {
      throw new Error(`expected a JPEG marker at offset ${offset}`);
    }
    const marker = data[offset + 1];
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return {height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7)};
    }
    offset += 2 + data.readUInt16BE(offset + 2);
  }
  throw new Error('no SOF marker found in JPEG data');
}

/** Numeric dot-separated version comparison, e.g. `"26.4"` vs `"16.4.1"`. */
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * `"18.5"` for the iOS Simulator SDK the active Xcode actually ships, or `null` if unparseable.
 * Xcode's own version stopped tracking the iOS version it bundles around Xcode 16 (16.4 ships the
 * 18.5 SDK, not "16.x") — this reads the real bundled version instead of assuming they match.
 */
async function activeSimulatorSdkVersion(): Promise<string | null> {
  const {stdout} = await execFileAsync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version']);
  const match = /^(\d+)\.(\d+)/.exec(stdout.trim());
  return match ? `${match[1]}.${match[2]}` : null;
}

// CI runner images pre-install several simulator runtimes as shared, Xcode-independent volumes
// (simctl list runtimes shows iOS 26.2/26.4/26.5 regardless of the active Xcode) — fixtures[0]
// would pick an arbitrary one instead of the runtime the job's matrix entry actually asked for.
// Prefer the runtime matching the active Xcode's own bundled SDK version; fall back to the newest
// installed only if that exact runtime isn't present.
async function selectTarget(fixtures: RuntimeFixture[]): Promise<RuntimeFixture[]> {
  if (fixtures.length === 0) {
    return [];
  }
  const sdkVersion = await activeSimulatorSdkVersion();
  const exactMatch = sdkVersion
    ? fixtures.find((f) => f.runtimeVersion === sdkVersion || f.runtimeVersion.startsWith(`${sdkVersion}.`))
    : undefined;
  return [exactMatch ?? [...fixtures].sort((a, b) => compareVersions(b.runtimeVersion, a.runtimeVersion))[0]];
}

// Resolved via top-level await (before any describe/it registers) since node:test builds its test
// tree synchronously — the per-runtime describe blocks below need the fixture list up front.
const sim = new NativeSimctl();
const fixtures = await availableRuntimeFixtures(sim);
// Only one runtime is exercised — the CI job matrix already varies Xcode/CoreSimulator version,
// which is the axis that matters here; see selectTarget for why it's not just fixtures[0].
const targets = await selectTarget(fixtures);
// One throwaway cert shared across every runtime's keychain checks — its content is irrelevant,
// so there's no reason to mint a fresh one per runtime.
const certPath = await createSelfSignedCert();

/**
 * Mutating coverage against the real CoreSimulator device set, run against one throwaway device
 * per simulator runtime — created/booted once and shared by every check against it, never a
 * developer's pre-existing simulators. Read-only checks live under test/unit instead.
 */
describe('NativeSimctl integration', () => {
  if (targets.length === 0) {
    it('skips: no simulator runtime with an installed device type is available', () => {});
  }

  after(async () => {
    await fs.promises.rm(certPath, {force: true});
  });

  for (const fixture of targets) {
    describe(`runtime ${fixture.runtimeName} (${fixture.runtimeIdentifier})`, () => {
      let device: SimDeviceInfo | undefined;

      before(async () => {
        device = await sim.createDevice(
          `coresim-test-${Date.now()}`,
          fixture.deviceTypeIdentifier,
          fixture.runtimeIdentifier,
        );
        // createDevice's own async work always resolves the device out of the transient Creating
        // state before the promise settles.
        assert.strictEqual(device.state, SimDeviceState.Shutdown);
        await disableDeviceHubPasteboardSync(device.udid);
        await sim.bootDevice(device.udid);
        // SimDeviceState reaching Booted only means the OS kernel/launchd has started — data
        // migration and system-app (SpringBoard) startup can still take tens of seconds longer
        // (see CLAUDE.md), and unlike getEnv() (a plain host-filesystem read), not every endpoint
        // is necessarily as graceful about running against a not-yet-fully-settled simulator.
        // Waiting here, once, up front means every check below runs against a genuinely booted
        // device instead of each one having to reason about this itself. The library's own default
        // (240s) isn't always enough on a loaded CI runner — observed exceeded for iOS 26.5 in CI.
        await sim.waitForBoot(device.udid, IS_CI ? {timeoutMs: 480_000} : undefined);
      });

      after(async () => {
        if (!device) {
          return;
        }
        // The eraseDevice test (last, below) leaves the device already Shutdown — shutdownDevice()
        // on an already-Shutdown device rejects ("Unable to shutdown device in current state:
        // Shutdown") rather than being a no-op, confirmed empirically — so only call it if needed,
        // never rebooting the device just to re-shut it down.
        const current = (await sim.getDevices()).find((d) => d.udid === device!.udid);
        if (current?.state === SimDeviceState.Booted) {
          await sim.shutdownDevice(device.udid);
        }
        await sim.deleteDevice(device.udid);
        await waitUntilDeleted(sim, device.udid);
      });

      it('boots via the async native path', async () => {
        // No polling needed here: the before() hook's waitForBoot() already requires state to be
        // Booting/Booted at entry and only returns once boot has fully settled, and state has
        // never been observed to regress back out of Booted while that settling happens.
        const found = (await sim.getDevices()).find((d) => d.udid === device!.udid);
        assert.strictEqual(found?.state, SimDeviceState.Booted);
      });

      it('renames the booted device and restores its name', async () => {
        const nameOf = async () => (await sim.getDevices()).find((d) => d.udid === device!.udid)?.name;
        const original = await nameOf();
        await sim.renameDevice(device!.udid, `${original}-renamed`);
        try {
          assert.strictEqual(await nameOf(), `${original}-renamed`);
        } finally {
          await sim.renameDevice(device!.udid, original!);
        }
        assert.strictEqual(await nameOf(), original);
      });

      it('reads getenv from the booted device', async () => {
        const home = await sim.getEnv(device!.udid, 'HOME');
        assert.match(home, /CoreSimulator\/Devices/);
      });

      it('configures the booted device (location, Darwin notification)', async () => {
        await sim.setLocation(device!.udid, 37.7749, -122.4194);
        await sim.clearLocation(device!.udid);
        await sim.postDarwinNotification(device!.udid, 'io.appium.coresim.test');
      });

      it('gets and sets Darwin notification state', async () => {
        const name = 'io.appium.coresim.test.state';
        assert.strictEqual(await sim.getDarwinNotificationState(device!.udid, name), 0n);
        await sim.setDarwinNotificationState(device!.udid, name, 1n);
        assert.strictEqual(await sim.getDarwinNotificationState(device!.udid, name), 1n);
      });

      it('round-trips Darwin notification state beyond Number.MAX_SAFE_INTEGER', async () => {
        // 2^53 + 1 — the smallest integer a JS `number` can no longer represent exactly, so a
        // successful round trip here proves the value survives as a real bigint, not a double.
        const name = 'io.appium.coresim.test.state.large';
        const large = 2n ** 53n + 1n;
        assert.ok(large > BigInt(Number.MAX_SAFE_INTEGER));
        await sim.setDarwinNotificationState(device!.udid, name, large);
        assert.strictEqual(await sim.getDarwinNotificationState(device!.udid, name), large);
      });

      it('rejects setDarwinNotificationState with an out-of-range bigint', async () => {
        const name = 'io.appium.coresim.test.state.invalid';
        await assert.rejects(() => sim.setDarwinNotificationState(device!.udid, name, -1n));
        await assert.rejects(() => sim.setDarwinNotificationState(device!.udid, name, 2n ** 64n));
      });

      it('enrolls/un-enrolls biometrics, sends matches, and rejects an unknown biometric name', async () => {
        assert.strictEqual(await sim.isBiometricEnrolled(device!.udid), false);

        await sim.enrollBiometric(device!.udid, true);
        assert.strictEqual(await sim.isBiometricEnrolled(device!.udid), true);

        await sim.sendBiometricMatch(device!.udid, true, 'touchId');
        await sim.sendBiometricMatch(device!.udid, false, 'faceId');

        await sim.enrollBiometric(device!.udid, false);
        assert.strictEqual(await sim.isBiometricEnrolled(device!.udid), false);

        await assert.rejects(() => sim.sendBiometricMatch(device!.udid, true, 'notARealBiometric' as never));
      });

      it('performs a shake gesture', async () => {
        await sim.shake(device!.udid);
      });

      it('gets and sets UI appearance, increase contrast, and content size', async () => {
        await sim.getAppearance(device!.udid);
        await sim.setAppearance(device!.udid, 2);
        assert.strictEqual(await sim.getAppearance(device!.udid), 2);

        await sim.getIncreaseContrast(device!.udid);
        await sim.setIncreaseContrast(device!.udid, false);

        await sim.getContentSize(device!.udid);
        await sim.setContentSize(device!.udid, 3);
        assert.strictEqual(await sim.getContentSize(device!.udid), 3);
      });

      it('adds a certificate to the keychain (path and Buffer, as trusted root) and resets it', async () => {
        await sim.addCertificate(device!.udid, certPath);
        await sim.addRootCertificate(device!.udid, await fs.promises.readFile(certPath));
        await sim.resetKeychain(device!.udid);
      });

      it('delivers a simulated push notification', async (t) => {
        // Confirmed to work regardless of whether the target bundle is actually installed — except
        // on iOS 27, where CoreSimulator's push daemon currently rejects every target, installed
        // and launched or not, with "Source is not authorized" (UNErrorDomain code 2003) — and
        // only after sitting on the call for several minutes first (observed up to ~7 minutes in
        // CI). Reproduced identically via `xcrun simctl push` directly (present since the 27.0
        // beta and still present in the GM release), so this is a platform-side bug, not something
        // this addon (or this test) can work around. The long hang before the eventual rejection
        // is itself part of that bug, so it's bounded here rather than spent for real each run.
        const PUSH_TIMEOUT_MS = 30000;
        const pushed = sim.pushNotification(device!.udid, 'io.appium.coresim.doesnotexist', {aps: {alert: 'hi'}}).then(
          () => 'delivered' as const,
          (err) => {
            if (err instanceof NativeSimOperationError && err.domain === 'UNErrorDomain' && err.code === 2003) {
              return 'unauthorized' as const;
            }
            throw err;
          },
        );
        // Left running in the background on a timeout, rather than awaited — its own rejection
        // handler above already keeps it from surfacing as an unhandled rejection later.
        pushed.catch(() => {});
        const timedOut = new Promise<'timed-out'>((resolve) =>
          setTimeout(() => resolve('timed-out'), PUSH_TIMEOUT_MS).unref(),
        );
        const result = await Promise.race([pushed, timedOut]);
        if (result === 'unauthorized' || result === 'timed-out') {
          return t.skip(
            `iOS 27: CoreSimulator's push daemon currently rejects every target ("Source is not authorized"), often only after several minutes`,
          );
        }
      });

      it('grants, revokes, and resets a privacy permission, verified against the simulator TCC database', async () => {
        const bundleId = 'io.appium.coresim.doesnotexist';

        await sim.grantPermission(device!.udid, 'camera', bundleId);
        assert.strictEqual(await readTCCGranted(device!.udid, 'kTCCServiceCamera', bundleId), true);

        await sim.revokePermission(device!.udid, 'camera', bundleId);
        assert.strictEqual(await readTCCGranted(device!.udid, 'kTCCServiceCamera', bundleId), false);

        await sim.resetPermission(device!.udid, 'camera', bundleId);
        assert.strictEqual(await readTCCGranted(device!.udid, 'kTCCServiceCamera', bundleId), undefined);
      });

      it('reads a privacy permission status through the same grant/revoke/reset lifecycle', async () => {
        const bundleId = 'io.appium.coresim.doesnotexist';

        assert.strictEqual(await sim.getPermission(device!.udid, 'contacts', bundleId), 'unset');

        await sim.grantPermission(device!.udid, 'contacts', bundleId);
        assert.strictEqual(await sim.getPermission(device!.udid, 'contacts', bundleId), 'granted');

        await sim.revokePermission(device!.udid, 'contacts', bundleId);
        assert.strictEqual(await sim.getPermission(device!.udid, 'contacts', bundleId), 'denied');

        await sim.resetPermission(device!.udid, 'contacts', bundleId);
        assert.strictEqual(await sim.getPermission(device!.udid, 'contacts', bundleId), 'unset');
      });

      it('grants, revokes, and resets faceid and usertracking, two services with no dedicated setter', async () => {
        const bundleId = 'io.appium.coresim.doesnotexist';

        for (const service of ['faceid', 'usertracking'] as const) {
          await sim.grantPermission(device!.udid, service, bundleId);
          assert.strictEqual(await sim.getPermission(device!.udid, service, bundleId), 'granted');

          await sim.revokePermission(device!.udid, service, bundleId);
          assert.strictEqual(await sim.getPermission(device!.udid, service, bundleId), 'denied');

          await sim.resetPermission(device!.udid, service, bundleId);
          assert.strictEqual(await sim.getPermission(device!.udid, service, bundleId), 'unset');
        }
      });

      it('grants "limited" (selected photos) access, exclusively for the photos service', async () => {
        const bundleId = 'io.appium.coresim.doesnotexist';

        await sim.grantPermission(device!.udid, 'photos', bundleId, 'limited');
        assert.strictEqual(await sim.getPermission(device!.udid, 'photos', bundleId), 'limited');
        await sim.resetPermission(device!.udid, 'photos', bundleId);

        await assert.rejects(
          () => sim.grantPermission(device!.udid, 'camera', bundleId, 'limited'),
          /'limited' is only a valid status for the 'photos' service/,
        );
      });

      it('adds media to the Photos library', async () => {
        const photoPath = await createTestPhoto();
        try {
          await sim.addPhoto(device!.udid, photoPath);
          await sim.addMedia(device!.udid, [photoPath]);
        } finally {
          await fs.promises.rm(photoPath, {force: true});
        }

        if (!(await hasFfmpeg())) {
          return;
        }
        const videoPath = await createTestVideo();
        try {
          await sim.addVideo(device!.udid, videoPath);
        } finally {
          await fs.promises.rm(videoPath, {force: true});
        }
      });

      it('sets and gets the device pasteboard, whichever of the two native mechanisms this CoreSimulator has', async (t) => {
        // Exercises whichever path this runner's CoreSimulator supports (legacy or modern — see
        // CLAUDE.md) without hardcoding which; a real t.skip(), not a silent early return, if
        // neither is present.
        const expected = 'coresim-pasteboard-test';
        try {
          await sim.setPasteboard(device!.udid, expected);
        } catch (err) {
          if (err instanceof NativeSimUnavailableError) {
            return t.skip(`pasteboard sync unavailable on this CoreSimulator: ${err.message}`);
          }
          throw err;
        }
        // The modern path's push has no completion callback and only sleeps a fixed, undocumented
        // settle margin before returning (see sim_pasteboard.mm) — poll instead of trusting a
        // single read right after, since that margin has been observed too short on slower CI
        // runners.
        let actual = '';
        await waitForCondition(
          async () => {
            actual = await sim.getPasteboard(device!.udid);
            return actual === expected;
          },
          {waitMs: 10000, intervalMs: 500, error: `expected the device pasteboard to eventually read '${expected}'`},
        );
        assert.strictEqual(actual, expected);
      });

      it('locates the booted device WebInspector socket and can connect to it', async () => {
        const socketPath = await sim.getWebInspectorSocket(device!.udid);
        assert.match(socketPath, /com\.apple\.webinspectord_sim\.socket$/);
        assert.ok(fs.existsSync(socketPath), `expected a real socket file at ${socketPath}`);
        await new Promise<void>((resolve, reject) => {
          const socket = net.connect(socketPath);
          socket.once('connect', () => {
            socket.end();
            resolve();
          });
          socket.once('error', reject);
        });
      });

      it('captures a screenshot of the booted device (PNG default, JPEG, and by displayId)', async (t) => {
        let png: Buffer;
        try {
          png = await sim.getScreenshot(device!.udid);
        } catch (err) {
          if (err instanceof NativeSimUnavailableError) {
            return t.skip(`screenshot capture unavailable on this CoreSimulator: ${err.message}`);
          }
          throw err;
        }
        assert.deepStrictEqual(png.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

        const jpeg = await sim.getScreenshot(device!.udid, {format: 'jpeg'});
        assert.deepStrictEqual(jpeg.subarray(0, 3), Buffer.from([0xff, 0xd8, 0xff]));

        const displays = await sim.getDisplays(device!.udid);
        // Mirrors CaptureScreenshot's own fallback (see sim_screenshot.mm): not every runtime has a
        // displayClass-0 display (e.g. tvOS's TVOut-only setup), so falling back to the first
        // renderable display is the correct behavior, not a bug to work around here.
        const targetDisplay = displays.find((d) => d.isMain) ?? displays[0];
        assert.ok(targetDisplay, 'expected at least one renderable display');
        const byId = await sim.getScreenshot(device!.udid, {displayId: targetDisplay.id});
        assert.deepStrictEqual(byId.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

        await assert.rejects(sim.getScreenshot(device!.udid, {displayId: 'not-a-real-display-id'}));

        const lowQuality = await sim.getScreenshot(device!.udid, {format: 'jpeg', quality: 10});
        const highQuality = await sim.getScreenshot(device!.udid, {format: 'jpeg', quality: 95});
        assert.ok(lowQuality.length < highQuality.length, 'lower JPEG quality should encode smaller');
        await assert.rejects(sim.getScreenshot(device!.udid, {format: 'jpeg', quality: 101}), RangeError);
      });

      it('records a video of the booted device, enforcing one recording at a time', async (t) => {
        const outputFile = path.join(os.tmpdir(), `coresim-video-test-${Date.now()}-${process.pid}.mp4`);
        try {
          assert.strictEqual(await sim.isVideoRecording(device!.udid), false);
          try {
            await sim.startVideoRecording(device!.udid, outputFile);
          } catch (err) {
            if (err instanceof NativeSimUnavailableError) {
              return t.skip(`video recording unavailable on this CoreSimulator: ${err.message}`);
            }
            throw err;
          }
          assert.strictEqual(await sim.isVideoRecording(device!.udid), true);
          try {
            // A second concurrent recording for the same device must reject rather than silently
            // replacing the first one (see commands/video-recording.ts).
            await assert.rejects(sim.startVideoRecording(device!.udid, outputFile), /already in progress/);
          } finally {
            await sim.stopVideoRecording(device!.udid);
          }
          assert.strictEqual(await sim.isVideoRecording(device!.udid), false);

          const stats = await fs.promises.stat(outputFile);
          assert.ok(stats.size > 0, 'expected a non-empty recorded video file');

          // Nothing left running — a second stop must reject, not silently succeed.
          await assert.rejects(sim.stopVideoRecording(device!.udid), /No video recording is in progress/);

          if (await hasFfmpeg()) {
            const {stdout} = await execFileAsync('ffprobe', [
              '-v',
              'error',
              '-select_streams',
              'v:0',
              '-show_entries',
              'stream=codec_name',
              '-of',
              'default=noprint_wrappers=1:nokey=1',
              outputFile,
            ]);
            const codec = stdout.trim();
            // CoreSimulator's own default (see sim_video_recording.h) — distinct from simctl's own
            // CLI-level default of hevc, which is simctl always passing the codec key explicitly.
            assert.strictEqual(codec, 'h264');
          }
        } finally {
          await fs.promises.rm(outputFile, {force: true});
        }
      });

      it('records a video with an explicit codec, mask, and displayId', async (t) => {
        if (!(await hasFfmpeg())) {
          return t.skip('ffmpeg/ffprobe not installed');
        }
        const displays = await sim.getDisplays(device!.udid);
        const targetDisplay = displays.find((d) => d.isMain) ?? displays[0];
        assert.ok(targetDisplay, 'expected at least one renderable display');

        const outputFile = path.join(os.tmpdir(), `coresim-video-test-hevc-${Date.now()}-${process.pid}.mp4`);
        try {
          try {
            await sim.startVideoRecording(device!.udid, outputFile, {
              codec: 'hevc',
              mask: 'black',
              displayId: targetDisplay.id,
            });
          } catch (err) {
            if (err instanceof NativeSimUnavailableError) {
              return t.skip(`video recording unavailable on this CoreSimulator: ${err.message}`);
            }
            throw err;
          }
          await sim.stopVideoRecording(device!.udid);

          const {stdout} = await execFileAsync('ffprobe', [
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=codec_name',
            '-of',
            'default=noprint_wrappers=1:nokey=1',
            outputFile,
          ]);
          assert.strictEqual(stdout.trim(), 'hevc');
        } finally {
          await fs.promises.rm(outputFile, {force: true});
        }
      });

      it('keeps a recording track at a fixed size across a mid-recording rotation', async (t) => {
        // Regression test: an AVAssetWriter track's dimensions are fixed once the first frame is
        // appended — a rotated frame must be letterboxed into that original size, not resized to
        // it, or playback comes out squashed rather than erroring (see CLAUDE.md). Only the fps
        // (AVRecordingSession/av_recording.mm) path uses AVAssetWriter — startVideoStream has no
        // such constraint and keeps swapping dimensions on rotation, unaffected by this.
        if (!(await hasFfmpeg())) {
          return t.skip('ffmpeg/ffprobe not installed');
        }
        const outputFile = path.join(os.tmpdir(), `coresim-video-test-rotate-${Date.now()}-${process.pid}.mp4`);
        const plistPath = backboardPlistPath(device!.udid);
        const originalPlist = await fs.promises.readFile(plistPath).catch(() => null);
        try {
          try {
            await sim.startVideoRecording(device!.udid, outputFile, {fps: 10});
          } catch (err) {
            if (err instanceof NativeSimUnavailableError) {
              return t.skip(`video recording unavailable on this CoreSimulator: ${err.message}`);
            }
            throw err;
          }
          // Let the writer establish its track at the native (portrait) dimensions first.
          await new Promise((resolve) => setTimeout(resolve, 1000));
          // setOrientation's mach delivery no-ops for this suite's in-process device (see the
          // "accepts setOrientation" test) — inject the rotation instead, the same way the
          // getOrientation staleness test does, so the encoder's poll (every 3s) picks it up.
          await injectGraphicsOrientation(plistPath, 3);
          await new Promise((resolve) => setTimeout(resolve, 4000));
          await sim.stopVideoRecording(device!.udid);

          const {stdout} = await execFileAsync('ffprobe', [
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_entries',
            'frame=width,height',
            '-of',
            'csv=p=0',
            outputFile,
          ]);
          // A keyframe's row has trailing side-data fields (e.g. an SEI message) csv=p=0 still
          // includes despite the explicit show_entries — keep only the width,height prefix.
          const dimensions = new Set(
            stdout
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => line.split(',').slice(0, 2).join('x')),
          );
          assert.strictEqual(dimensions.size, 1, `expected one fixed frame size throughout, got: ${[...dimensions]}`);
        } finally {
          await fs.promises.rm(outputFile, {force: true});
          if (originalPlist) {
            await fs.promises.writeFile(plistPath, originalPlist);
          }
        }
      });

      it('records a video with audio, muxed as a second AAC track', async (t) => {
        if (IS_CI) {
          return t.skip('audio capture can block for ~180s (MACH_RCV_TIMED_OUT) on some CI runners — see CLAUDE.md');
        }
        if (!(await hasFfmpeg())) {
          return t.skip('ffmpeg/ffprobe not installed');
        }
        const outputFile = path.join(os.tmpdir(), `coresim-video-audio-test-${Date.now()}-${process.pid}.mp4`);
        try {
          try {
            await retryUntilAudioProcessesFound(() => sim.startVideoRecording(device!.udid, outputFile, {audio: true}));
          } catch (err) {
            if (isAudioCaptureUnavailable(err)) {
              return t.skip(`audio capture unavailable on this host: ${(err as Error).message}`);
            }
            throw err;
          }
          // Give real PCM time to flow before stopping, so the audio track ends up with actual
          // samples rather than being added to the writer but never written to.
          await new Promise((resolve) => setTimeout(resolve, 1000));
          await sim.stopVideoRecording(device!.udid);

          const {stdout: streamsOutput} = await execFileAsync('ffprobe', [
            '-v',
            'error',
            '-show_entries',
            'stream=codec_type,codec_name',
            '-of',
            'csv=p=0',
            outputFile,
          ]);
          const streams = streamsOutput.trim().split('\n');
          // `audio` bypasses the private recorder — this addon's own encoder always defaults to
          // h264, unlike the private recorder's own default asserted above.
          assert.ok(streams.includes('h264,video'), `expected an h264 video stream, got: ${streams}`);
          assert.ok(streams.includes('aac,audio'), `expected an AAC audio stream, got: ${streams}`);

          // Decodes both tracks end-to-end, not just that ffprobe can enumerate the streams.
          await execFileAsync('ffmpeg', ['-v', 'error', '-i', outputFile, '-f', 'null', '-']);
        } finally {
          await fs.promises.rm(outputFile, {force: true});
        }
      });

      it('streams video in real time via VideoToolbox, yielding decodable access units', async (t) => {
        let stream: Awaited<ReturnType<typeof sim.startVideoStream>>;
        try {
          stream = await sim.startVideoStream(device!.udid, {fps: 10});
        } catch (err) {
          if (err instanceof NativeSimUnavailableError) {
            return t.skip(`video streaming unavailable on this CoreSimulator: ${err.message}`);
          }
          throw err;
        }

        // Toggling appearance repaints the screen, forcing frames beyond the initial keyframe.
        let dark = 0;
        const wiggle = setInterval(() => {
          dark = 1 - dark;
          sim.setAppearance(device!.udid, dark).catch(() => {});
        }, 150);

        const controller = new AbortController();
        const units: Array<{data: Buffer; isKeyFrame: boolean; sequence: number}> = [];
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
          for await (const unit of stream.accessUnits(controller.signal)) {
            units.push(unit);
            if (units.length >= 2) {
              controller.abort();
              break;
            }
          }
        } finally {
          clearTimeout(timeout);
          clearInterval(wiggle);
          await stream.stop();
          await stream.stop(); // idempotent
        }

        assert.ok(units.length > 0, 'expected at least one access unit');
        assert.strictEqual(units[0].isKeyFrame, true, 'the first access unit must be a keyframe');
        assert.deepStrictEqual(
          units.map((u) => u.sequence),
          units.map((_, i) => i),
        );

        if (await hasFfmpeg()) {
          const raw = Buffer.concat(units.map((u) => u.data));
          const rawPath = path.join(os.tmpdir(), `coresim-stream-test-${Date.now()}-${process.pid}.h264`);
          await fs.promises.writeFile(rawPath, raw);
          try {
            const {stdout} = await execFileAsync('ffprobe', [
              '-v',
              'error',
              '-select_streams',
              'v:0',
              '-show_entries',
              'stream=codec_name',
              '-of',
              'default=noprint_wrappers=1:nokey=1',
              rawPath,
            ]);
            assert.strictEqual(stdout.trim(), 'h264');
            // Decodes with no errors — validates the Annex-B framing/parameter sets are correct.
            await execFileAsync('ffmpeg', ['-v', 'error', '-i', rawPath, '-f', 'null', '-']);
          } finally {
            await fs.promises.rm(rawPath, {force: true});
          }
        }
      });

      it('keeps streaming past an orientation poll tick without crashing', async (t) => {
        // Rotation content correctness was verified manually — this suite's shared device can't
        // reliably rotate (see "accepts setOrientation" above). Crash-safety only: run past the
        // poll timer's first tick (every 3s) and confirm the stream is still healthy after.
        let stream: Awaited<ReturnType<typeof sim.startVideoStream>>;
        try {
          stream = await sim.startVideoStream(device!.udid, {fps: 5});
        } catch (err) {
          if (err instanceof NativeSimUnavailableError) {
            return t.skip(`video streaming unavailable on this CoreSimulator: ${err.message}`);
          }
          throw err;
        }
        try {
          await sim.setOrientation(device!.udid, DeviceOrientation.LandscapeLeft);
          await new Promise((resolve) => setTimeout(resolve, 6000));
          await sim.setOrientation(device!.udid, DeviceOrientation.Portrait);

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          try {
            for await (const unit of stream.accessUnits(controller.signal)) {
              assert.ok(unit.data.length > 0);
              break;
            }
          } finally {
            clearTimeout(timeout);
          }
        } finally {
          await stream.stop();
        }
      });

      it('does not crash on exit after stop() while the stream wrapper is still referenced', async (t) => {
        const childScript = fileURLToPath(new URL('./av-abort-delivery-child.js', import.meta.url));
        try {
          // Some CI hosts/older Xcode runtimes are just slow at this (observed: 44s for an
          // otherwise-instant stream test on an Xcode 16.4/iOS 18.5 leg) — generous headroom here
          // since a slow-but-working host would otherwise get SIGTERM'd by this timeout and
          // misreported as a crash below.
          await execFileAsync(process.execPath, [childScript, device!.udid], {timeout: IS_CI ? 120000 : 20000});
        } catch (err) {
          const execErr = err as {code?: number | string; signal?: string | null; killed?: boolean; stderr?: string};
          if (execErr.code === 2) {
            return t.skip('video streaming unavailable on this CoreSimulator');
          }
          if (execErr.killed && execErr.signal === 'SIGTERM') {
            // Our own timeout above killed it — a slow host, not evidence of the crash this test
            // guards against (that reproduces as SIGABRT, near-instantly once it happens).
            return t.skip(`child process did not finish within the timeout — too slow to test here, not a crash`);
          }
          throw new Error(
            `child process exited abnormally (code=${execErr.code}, signal=${execErr.signal}) — see CLAUDE.md's ` +
              `TsfnReleaseGuard note if this is a crash, not just a timeout:\n${execErr.stderr}`,
            {cause: err},
          );
        }
      });

      it('streams HEVC by codec option and rejects an unknown displayId synchronously', async (t) => {
        const displays = await sim.getDisplays(device!.udid);
        const targetDisplay = displays.find((d) => d.isMain) ?? displays[0];
        assert.ok(targetDisplay, 'expected at least one renderable display');

        let stream: Awaited<ReturnType<typeof sim.startVideoStream>>;
        try {
          stream = await sim.startVideoStream(device!.udid, {codec: 'hevc', displayId: targetDisplay.id, fps: 10});
        } catch (err) {
          if (err instanceof NativeSimUnavailableError) {
            return t.skip(`video streaming unavailable on this CoreSimulator: ${err.message}`);
          }
          throw err;
        }
        assert.strictEqual(stream.codec, 'hevc');
        await stream.stop();

        await assert.rejects(sim.startVideoStream(device!.udid, {displayId: 'not-a-real-display-id'}));
      });

      it('streams video and audio interleaved via a Core Audio process tap', async (t) => {
        if (IS_CI) {
          return t.skip('audio capture can block for ~180s (MACH_RCV_TIMED_OUT) on some CI runners — see CLAUDE.md');
        }
        let stream: Awaited<ReturnType<typeof sim.startVideoStream>>;
        try {
          stream = await retryUntilAudioProcessesFound(() =>
            sim.startVideoStream(device!.udid, {fps: 10, audio: true}),
          );
        } catch (err) {
          if (isAudioCaptureUnavailable(err)) {
            return t.skip(`audio capture unavailable on this host: ${(err as Error).message}`);
          }
          throw err;
        }

        // Toggling appearance repaints the screen, forcing video frames beyond the initial keyframe.
        let dark = 0;
        const wiggle = setInterval(() => {
          dark = 1 - dark;
          sim.setAppearance(device!.udid, dark).catch(() => {});
        }, 150);

        const controller = new AbortController();
        const units: Array<{track: 'video' | 'audio'; data: Buffer; isKeyFrame: boolean; sequence: number}> = [];
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
          for await (const unit of stream.accessUnits(controller.signal)) {
            units.push(unit);
            const sawBothTracks = units.some((u) => u.track === 'video') && units.some((u) => u.track === 'audio');
            if (sawBothTracks || units.length >= 200) {
              controller.abort();
              break;
            }
          }
        } finally {
          clearTimeout(timeout);
          clearInterval(wiggle);
          await stream.stop();
        }

        const videoUnits = units.filter((u) => u.track === 'video');
        const audioUnits = units.filter((u) => u.track === 'audio');
        assert.ok(videoUnits.length > 0, 'expected at least one video access unit');
        assert.ok(audioUnits.length > 0, 'expected at least one audio access unit');
        assert.strictEqual(videoUnits[0].isKeyFrame, true, 'the first video access unit must be a keyframe');
        assert.ok(
          audioUnits.every((u) => u.isKeyFrame),
          'every audio access unit should report isKeyFrame (always independently decodable)',
        );
        assert.ok(
          audioUnits.every((u) => u.data.length > 0),
          'expected non-empty audio packets',
        );
        // Sequence numbers are independent per track (see VideoAccessUnit's own doc comment) — each
        // must still be its own strictly increasing run within the interleaved delivery order.
        assert.deepStrictEqual(
          videoUnits.map((u) => u.sequence),
          videoUnits.map((_, i) => i),
        );
        assert.deepStrictEqual(
          audioUnits.map((u) => u.sequence),
          audioUnits.map((_, i) => i),
        );
      });

      it('streams JPEG frames in real time, each independently decodable', async (t) => {
        let stream: Awaited<ReturnType<typeof sim.startJpegStream>>;
        try {
          stream = await sim.startJpegStream(device!.udid, {fps: 10});
        } catch (err) {
          if (err instanceof NativeSimUnavailableError) {
            return t.skip(`JPEG streaming unavailable on this CoreSimulator: ${err.message}`);
          }
          throw err;
        }

        // Toggling appearance repaints the screen, forcing frames beyond the initial one.
        let dark = 0;
        const wiggle = setInterval(() => {
          dark = 1 - dark;
          sim.setAppearance(device!.udid, dark).catch(() => {});
        }, 150);

        const controller = new AbortController();
        const frames: Array<{data: Buffer; sequence: number}> = [];
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
          for await (const frame of stream.frames(controller.signal)) {
            frames.push(frame);
            if (frames.length >= 2) {
              controller.abort();
              break;
            }
          }
        } finally {
          clearTimeout(timeout);
          clearInterval(wiggle);
          await stream.stop();
          await stream.stop(); // idempotent
        }

        assert.ok(frames.length > 0, 'expected at least one JPEG frame');
        for (const frame of frames) {
          assert.deepStrictEqual(frame.data.subarray(0, 3), Buffer.from([0xff, 0xd8, 0xff]));
        }
        assert.deepStrictEqual(
          frames.map((f) => f.sequence),
          frames.map((_, i) => i),
        );

        await assert.rejects(sim.startJpegStream(device!.udid, {displayId: 'not-a-real-display-id'}));
      });

      it('respects displayId and quality on a JPEG stream', async (t) => {
        const displays = await sim.getDisplays(device!.udid);
        const targetDisplay = displays.find((d) => d.isMain) ?? displays[0];
        assert.ok(targetDisplay, 'expected at least one renderable display');

        async function firstFrame(quality: number): Promise<Buffer> {
          const stream = await sim.startJpegStream(device!.udid, {displayId: targetDisplay.id, fps: 10, quality});
          try {
            const {value} = await stream.frames().next();
            assert.ok(value, 'expected a frame');
            return value.data;
          } finally {
            await stream.stop();
          }
        }

        let lowQuality: Buffer;
        try {
          lowQuality = await firstFrame(10);
        } catch (err) {
          if (err instanceof NativeSimUnavailableError) {
            return t.skip(`JPEG streaming unavailable on this CoreSimulator: ${err.message}`);
          }
          throw err;
        }
        const highQuality = await firstFrame(95);
        assert.ok(lowQuality.length < highQuality.length, 'lower JPEG quality should encode smaller');
      });

      it('scales down JPEG stream frames by the given percentage', async (t) => {
        async function firstFrameDimensions(scale?: number): Promise<{width: number; height: number}> {
          const stream = await sim.startJpegStream(device!.udid, {fps: 10, scale});
          try {
            const {value} = await stream.frames().next();
            assert.ok(value, 'expected a frame');
            return jpegDimensions(value.data);
          } finally {
            await stream.stop();
          }
        }

        let full: {width: number; height: number};
        try {
          full = await firstFrameDimensions();
        } catch (err) {
          if (err instanceof NativeSimUnavailableError) {
            return t.skip(`JPEG streaming unavailable on this CoreSimulator: ${err.message}`);
          }
          throw err;
        }
        const half = await firstFrameDimensions(50);
        // The scale transform rounds each dimension independently, so allow a ±1px fudge factor.
        assert.ok(Math.abs(half.width - full.width / 2) <= 1, `expected width ~${full.width / 2}, got ${half.width}`);
        assert.ok(
          Math.abs(half.height - full.height / 2) <= 1,
          `expected height ~${full.height / 2}, got ${half.height}`,
        );

        await assert.rejects(sim.startJpegStream(device!.udid, {scale: 0}), RangeError);
        await assert.rejects(sim.startJpegStream(device!.udid, {scale: 101}), RangeError);
      });

      it('does not crash on exit after stop() while the JPEG stream wrapper is still referenced', async (t) => {
        const childScript = fileURLToPath(new URL('./jpeg-abort-delivery-child.js', import.meta.url));
        try {
          // See the identical video-stream regression test's own comment on this generous timeout.
          await execFileAsync(process.execPath, [childScript, device!.udid], {timeout: IS_CI ? 120000 : 20000});
        } catch (err) {
          const execErr = err as {code?: number | string; signal?: string | null; killed?: boolean; stderr?: string};
          if (execErr.code === 2) {
            return t.skip('JPEG streaming unavailable on this CoreSimulator');
          }
          if (execErr.killed && execErr.signal === 'SIGTERM') {
            return t.skip(`child process did not finish within the timeout — too slow to test here, not a crash`);
          }
          throw new Error(
            `child process exited abnormally (code=${execErr.code}, signal=${execErr.signal}) — see CLAUDE.md's ` +
              `TsfnReleaseGuard note if this is a crash, not just a timeout:\n${execErr.stderr}`,
            {cause: err},
          );
        }
      });

      if (isIOSRuntime(fixture.runtimeIdentifier)) {
        it('opens a URL', async () => {
          // openURL can transiently ETIMEDOUT for a few seconds right after boot even once
          // waitForBoot() is terminal (observed in CI) — retry instead of failing on one timeout.
          await waitForCondition(
            async () => {
              try {
                await sim.openUrl(device!.udid, 'https://appium.io');
                return true;
              } catch (err) {
                if (err instanceof NativeSimOperationError && err.domain === 'NSPOSIXErrorDomain' && err.code === 60) {
                  return false;
                }
                throw err;
              }
            },
            {waitMs: 30000, intervalMs: 2000, error: 'expected openUrl to eventually succeed once the device settled'},
          );
        });

        it('accepts setOrientation for every orientation value without throwing', async () => {
          // Not asserted against an actual screenshot rotation — this suite's throwaway device is
          // created and booted in-process, which CoreSimulator silently no-ops mach delivery for
          // (see CLAUDE.md). Confirmed manually, in a fresh process, that this actually rotates.
          for (const orientation of [
            DeviceOrientation.LandscapeLeft,
            DeviceOrientation.LandscapeRight,
            DeviceOrientation.PortraitUpsideDown,
            DeviceOrientation.Portrait,
          ]) {
            await sim.setOrientation(device!.udid, orientation);
          }
        });

        it('detects the device orientation via getOrientation', async () => {
          // Not subject to the LookupMachPort staleness above (reads backboardd's own preference
          // file directly instead) — reliably reads portrait, the default for an untouched boot.
          assert.strictEqual(await sim.getOrientation(device!.udid), DeviceOrientation.Portrait);
        });

        it('ignores a getOrientation entry that predates the current boot', async () => {
          // Regression test: a reboot can leave the previous boot's entry in backboardd's
          // preference file until it rewrites it, sometimes several seconds later — getOrientation
          // must not report that stale entry as current (see CLAUDE.md). setOrientation can't set up
          // this scenario for real (its mach delivery no-ops for this suite's in-process device —
          // see the test above), so the stale entry is injected directly instead.
          const plistPath = backboardPlistPath(device!.udid);
          const original = await fs.promises.readFile(plistPath).catch(() => null);
          try {
            await injectGraphicsOrientation(plistPath, 2);
            await fs.promises.utimes(plistPath, new Date(0), new Date(0));
            assert.strictEqual(await sim.getOrientation(device!.udid), DeviceOrientation.Portrait);

            // Control: the same entry IS honored once it's no longer backdated — proves the
            // assertion above exercises the staleness gate, not an unrelated parse failure.
            await fs.promises.utimes(plistPath, new Date(), new Date());
            assert.strictEqual(await sim.getOrientation(device!.udid), DeviceOrientation.PortraitUpsideDown);
          } finally {
            if (original) {
              await fs.promises.writeFile(plistPath, original);
            }
          }
        });

        it('installs, inspects, launches, terminates, and removes an app', async () => {
          const appPath = await getUIKitCatalogPath();
          await sim.installApp(device!.udid, appPath);
          assert.ok(await sim.isAppInstalled(device!.udid, UICATALOG_BUNDLE_ID));

          const info = await sim.appInfo(device!.udid, UICATALOG_BUNDLE_ID);
          assert.strictEqual(info.CFBundleIdentifier, UICATALOG_BUNDLE_ID);
          assert.ok(UICATALOG_BUNDLE_ID in (await sim.installedApps(device!.udid)));

          const appContainer = await sim.getAppContainer(device!.udid, UICATALOG_BUNDLE_ID);
          assert.strictEqual(appContainer, info.Path);
          const dataContainer = await sim.getAppContainer(device!.udid, UICATALOG_BUNDLE_ID, 'data');
          assert.match(dataContainer, /\/Containers\/Data\/Application\//);
          await assert.rejects(sim.getAppContainer(device!.udid, UICATALOG_BUNDLE_ID, 'groups'), NativeSimError);
          await assert.rejects(
            sim.getAppContainer(device!.udid, UICATALOG_BUNDLE_ID, 'group.does.not.exist'),
            NativeSimError,
          );

          const pid = await sim.launchApp(device!.udid, UICATALOG_BUNDLE_ID);
          assert.ok(pid > 0);

          const processes = await sim.listProcesses(device!.udid);
          const launched = processes.find((p) => p.name === UICATALOG_BUNDLE_ID);
          assert.deepStrictEqual(launched, {pid, group: 'UIKitApplication', name: UICATALOG_BUNDLE_ID});

          await sim.terminateApp(device!.udid, UICATALOG_BUNDLE_ID);

          await sim.removeApp(device!.udid, UICATALOG_BUNDLE_ID);
          assert.strictEqual(await sim.isAppInstalled(device!.udid, UICATALOG_BUNDLE_ID), false);
        });
      }

      it('spawns a process with live stdout and reports a clean exit', async () => {
        // /bin/echo isn't shipped inside the Simulator runtime (spawnProcess confines `path`
        // there, see CLAUDE.md) - /bin/df is, and reliably prints a fixed 'Filesystem' header.
        const proc = await sim.spawnProcess(device!.udid, '/bin/df', {arguments: ['/bin/df', '-h']});
        assert.ok(proc.running);
        let stdout = '';
        proc.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        // 'exit' (fired via the native ThreadSafeFunction/GCD termination handler) and the stdout
        // stream's own 'end' (driven independently by libuv polling the dup()'d fd) are decoupled
        // signals — 'exit' can fire before the stream has finished (or even started) delivering
        // its buffered data (observed in CI: stdout was still '' when 'exit' had already fired).
        // Wait for both before asserting on accumulated output.
        const [[code, signal]] = await Promise.all([once(proc, 'exit'), once(proc.stdout, 'end')]);
        // A single deepStrictEqual (rather than two separate asserts) so a failure always reports
        // both values together — exactly one of the two should ever be non-null, and seeing only
        // the first assertion's failure hides whether the other one is a plain miss or a genuine
        // signal.
        assert.deepStrictEqual({code, signal}, {code: 0, signal: null});
        assert.strictEqual(proc.running, false);
        assert.match(stdout, /Filesystem/);
      });

      it('kills a long-running spawned process', async () => {
        // /bin/sleep isn't shipped inside the Simulator runtime either - log stream runs until
        // killed, giving the same "runs until killed" shape (and is the actual real-world use
        // case that surfaced the runtime-confinement/standalone-default work in the first place).
        const proc = await sim.spawnProcess(device!.udid, '/usr/bin/log', {
          arguments: ['/usr/bin/log', 'stream'],
        });
        assert.ok(proc.running);
        const exitPromise = once(proc, 'exit');
        assert.ok(proc.kill());
        const [code, signal] = await exitPromise;
        assert.strictEqual(code, null);
        assert.strictEqual(signal, 'SIGTERM');
      });

      it('resolves a leading-slash path relative to the Simulator runtime, not the host root', async () => {
        // A leading '/' must not escape to the host's own filesystem root - /bin/df exists inside
        // the Simulator runtime but not at the host's literal /bin/df-under-runtime-root path, so
        // a successful run here proves the resolution, not just that /bin/df exists on the host.
        const proc = await sim.spawnProcess(device!.udid, '/bin/df', {arguments: ['/bin/df', '-h']});
        proc.stdout.resume(); // must be flowing for 'end' to ever fire - this test ignores content
        const [[code, signal]] = await Promise.all([once(proc, 'exit'), once(proc.stdout, 'end')]);
        assert.deepStrictEqual({code, signal}, {code: 0, signal: null});
      });

      it('rejects a path that escapes the Simulator runtime via ..', async () => {
        await assert.rejects(
          () =>
            sim.spawnProcess(device!.udid, '../../../../../../etc/passwd', {
              arguments: ['../../../../../../etc/passwd'],
            }),
          /resolves outside the Simulator runtime/,
        );
      });

      it("resolves a bare command name against the runtime's standard bin dirs", async () => {
        // No '/' in 'df' - proves this goes through bare-name search (usr/bin, bin, ...) rather
        // than the literal-path join used by the other spawnProcess tests above.
        const proc = await sim.spawnProcess(device!.udid, 'df', {arguments: ['df', '-h']});
        let stdout = '';
        proc.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        const [[code, signal]] = await Promise.all([once(proc, 'exit'), once(proc.stdout, 'end')]);
        assert.deepStrictEqual({code, signal}, {code: 0, signal: null});
        assert.match(stdout, /Filesystem/);
      });

      it('rejects a bare command name that matches no binary in the runtime', async () => {
        await assert.rejects(
          () => sim.spawnProcess(device!.udid, 'this-binary-does-not-exist'),
          /not found in the Simulator runtime's standard bin directories/,
        );
      });

      it('reports settled boot status, and a further waitForBoot call is immediate', async () => {
        // The before() hook already waited for full settlement, so both checks here should be
        // near-instant — this exercises the "already booted" fast path specifically.
        const status = await sim.getBootStatus(device!.udid);
        assert.strictEqual(status?.isTerminal, true);

        // A generous bound, not a tight one: this only needs to distinguish "resolved on its
        // first check" from "actually polled through multiple 500ms rounds" (see waitForBoot) —
        // 10s comfortably fits a loaded CI runner while still failing on a real polling loop.
        const start = Date.now();
        await sim.waitForBoot(device!.udid);
        assert.ok(Date.now() - start < 10000, 'expected waitForBoot to return near-instantly once already settled');
      });

      it('rejects waitForBoot for a device that is not booting or booted', async () => {
        // A fresh device is Shutdown and was never booted — cheap to create (no boot involved),
        // so this doesn't need the shared per-runtime device or a second real boot.
        const fresh = await sim.createDevice(
          `coresim-test-notrunning-${Date.now()}`,
          fixture.deviceTypeIdentifier,
          fixture.runtimeIdentifier,
        );
        try {
          assert.strictEqual(await sim.getBootStatus(fresh.udid), null);
          await assert.rejects(() => sim.waitForBoot(fresh.udid));
        } finally {
          await sim.deleteDevice(fresh.udid);
        }
      });

      // Last: eraseDevice requires Shutdown (see CLAUDE.md), and leaves the device that way — no
      // later test here can assume Booted again. The outer after() hook tolerates this without
      // rebooting the device just to shut it down a second time.
      it('erases the device once shut down', async () => {
        await sim.shutdownDevice(device!.udid);
        await sim.eraseDevice(device!.udid);
        assert.strictEqual(
          (await sim.getDevices()).find((d) => d.udid === device!.udid)?.state,
          SimDeviceState.Shutdown,
        );
      });

      // Also last (after the shared `device` above is already Shutdown, so this can't disturb any
      // other test in this file): shutdownAllDevices() operates on the *entire* default device
      // set, not just devices this suite created, so it's exercised here against its own dedicated
      // throwaway device. It would still shut down any other simulator a developer happens to have
      // booted locally at the same time — an inherent, documented characteristic of the native
      // operation being tested (see lifecycle.ts), not a test bug.
      it('shuts down every booted device in the default set', {skip: SKIP_EXPENSIVE_IN_CI}, async () => {
        const extra = await sim.createDevice(
          `coresim-test-shutdownall-${Date.now()}`,
          fixture.deviceTypeIdentifier,
          fixture.runtimeIdentifier,
        );
        try {
          await sim.bootDevice(extra.udid);
          await sim.waitForBoot(extra.udid);
          await sim.shutdownAllDevices();
          assert.strictEqual(
            (await sim.getDevices()).find((d) => d.udid === extra.udid)?.state,
            SimDeviceState.Shutdown,
          );
        } finally {
          // Mirrors the outer after() hook above: an earlier failure (boot, waitForBoot, the
          // assertion) can leave `extra` still Booted, and shutdownDevice() on an already-Shutdown
          // device rejects rather than no-oping — checking first keeps that from masking the real
          // failure. deleteDevice's removal is async (see waitUntilDeleted), so poll for it too.
          const current = (await sim.getDevices()).find((d) => d.udid === extra.udid);
          if (current?.state === SimDeviceState.Booted) {
            await sim.shutdownDevice(extra.udid);
          }
          await sim.deleteDevice(extra.udid);
          await waitUntilDeleted(sim, extra.udid);
        }
      });
    });
  }
});
