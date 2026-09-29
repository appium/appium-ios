import {waitForCondition} from 'asyncbox';

import type {NativeSimctl} from '../native-simctl.js';
import {SimDeviceState, type NativeDeviceHandle, type SimBootInfo, type SimDeviceInfo} from '../types.js';
import type {SimDeviceTypeInfo, SimRuntimeInfo} from '../types.js';
import {runCatchingAsync} from '../utils/index.js';

const DEFAULT_BOOT_TIMEOUT_MS = 240_000;

declare module '../native-simctl.js' {
  interface NativeSimctl {
    getDevices(): Promise<SimDeviceInfo[]>;
    getSupportedDeviceTypes(): Promise<SimDeviceTypeInfo[]>;
    getSupportedRuntimes(): Promise<SimRuntimeInfo[]>;
    createDevice(name: string, deviceTypeIdentifier: string, runtimeIdentifier: string): Promise<SimDeviceInfo>;
    deleteDevice(udid: string): Promise<void>;
    bootDevice(udid: string, options?: Record<string, unknown>): Promise<void>;
    getBootStatus(udid: string): Promise<SimBootInfo | null>;
    waitForBoot(udid: string, options?: {timeoutMs?: number}): Promise<void>;
    shutdownDevice(udid: string): Promise<void>;
    shutdownAllDevices(): Promise<void>;
    eraseDevice(udid: string): Promise<void>;
  }
}

/** @returns every device in the default device set. */
export async function getDevices(this: NativeSimctl): Promise<SimDeviceInfo[]> {
  return runCatchingAsync(async () => {
    const deviceSet = await this._deviceSet();
    return (await deviceSet.devices()).map(toDeviceInfo);
  });
}

/** @returns every simulator device type this CoreSimulator install supports (e.g. "iPhone 15"). */
export async function getSupportedDeviceTypes(this: NativeSimctl): Promise<SimDeviceTypeInfo[]> {
  return runCatchingAsync(async () => (await this._serviceContext()).supportedDeviceTypes());
}

/** @returns every simulator runtime this CoreSimulator install supports (e.g. iOS 17.4). */
export async function getSupportedRuntimes(this: NativeSimctl): Promise<SimRuntimeInfo[]> {
  return runCatchingAsync(async () => (await this._serviceContext()).supportedRuntimes());
}

/**
 * Creates a new device in the default device set. Settles into the `Shutdown` state — never
 * observed as `Creating` (see CLAUDE.md).
 *
 * @param name — display name for the new device
 * @param deviceTypeIdentifier — e.g. `com.apple.CoreSimulator.SimDeviceType.iPhone-15`
 * @param runtimeIdentifier — e.g. `com.apple.CoreSimulator.SimRuntime.iOS-17-4`
 * @returns the newly created device
 */
export async function createDevice(
  this: NativeSimctl,
  name: string,
  deviceTypeIdentifier: string,
  runtimeIdentifier: string,
): Promise<SimDeviceInfo> {
  return runCatchingAsync(async () => {
    const deviceSet = await this._deviceSet();
    return toDeviceInfo(await deviceSet.createDevice(deviceTypeIdentifier, runtimeIdentifier, name));
  });
}

/**
 * Deletes the given device from the default device set. Returns before the underlying
 * filesystem cleanup finishes — eventually consistent (see CLAUDE.md).
 *
 * @param udid — UDID of the device to delete
 */
export async function deleteDevice(this: NativeSimctl, udid: string): Promise<void> {
  return runCatchingAsync(async () => {
    const [deviceSet, device] = await Promise.all([this._deviceSet(), this._findDevice(udid)]);
    await deviceSet.deleteDevice(device);
  });
}

/**
 * Boots the given device; resolves only once CoreSimulator's own async completion handler
 * fires (see CLAUDE.md for a rare eventual-consistency caveat on the resulting `state`).
 *
 * @param udid — UDID of the device to boot
 * @param options — passed through to `bootWithOptions:`/`bootAsyncWithOptions:...:`; the
 * option-dictionary keys are currently unverified (see CLAUDE.md)
 */
export async function bootDevice(
  this: NativeSimctl,
  udid: string,
  options: Record<string, unknown> = {},
): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).boot(options));
}

/**
 * Reads the device's current boot-progress status — the same underlying signal `simctl bootstatus`
 * itself monitors (see CLAUDE.md), distinct from and more granular than `SimDeviceState`.
 *
 * @param udid — UDID of the device to read from
 * @returns `null` if the device has never been booted; otherwise its most recent {@link SimBootInfo}.
 * Confirmed empirically to **not** reset after shutdown — a shut-down device that was booted
 * before still reports its last boot's terminal status, so check `getDevices()`'s `state` too if
 * you need to know whether the device is *currently* booted (see {@link waitForBoot}, which does).
 */
export async function getBootStatus(this: NativeSimctl, udid: string): Promise<SimBootInfo | null> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).getBootStatus());
}

/**
 * Waits for the given device's boot to fully settle — matching `simctl bootstatus`'s own notion of
 * "done" (`SimBootInfo.isTerminal`), not just `SimDeviceState` reaching `Booted`, which happens
 * *tens of seconds* earlier while data migration/system-app startup are still in progress (see
 * CLAUDE.md). Returns immediately if the device is already fully booted (its very first status
 * check already sees `isTerminal`).
 *
 * @param udid — UDID of the device to monitor
 * @param options.timeoutMs — how long to wait before giving up (default 4 minutes, matching
 * `simctl bootstatus`'s own default timeout)
 * @throws if the device isn't currently `Booting` or `Booted` — there's nothing to monitor
 * @throws if the device stops booting (e.g. is shut down) before it finishes
 * @throws if `timeoutMs` elapses before boot settles
 */
export async function waitForBoot(this: NativeSimctl, udid: string, options: {timeoutMs?: number} = {}): Promise<void> {
  const {timeoutMs = DEFAULT_BOOT_TIMEOUT_MS} = options;
  return runCatchingAsync(async () => {
    const initialState = (await this._findDevice(udid)).state();
    if (initialState !== SimDeviceState.Booting && initialState !== SimDeviceState.Booted) {
      throw new Error(`Device '${udid}' is not booting or booted (state: ${initialState})`);
    }
    // Re-resolves the device handle on every check (never caches it across the wait), matching
    // every other method here — a device deleted mid-wait then surfaces as a normal "not found"
    // error instead of a stale native reference failing in some less obvious way.
    await waitForCondition(
      async () => {
        const device = await this._findDevice(udid);
        const stateBefore = device.state();
        if (stateBefore !== SimDeviceState.Booting && stateBefore !== SimDeviceState.Booted) {
          // getBootStatus()'s isTerminal is confirmed to never reset on shutdown, so it would
          // still read true from a *previous* boot session here if the device stopped booting
          // partway through this wait (e.g. shut down by another caller) — checking current state
          // too prevents reporting that stale old boot as this wait having succeeded.
          throw new Error(`Device '${udid}' stopped booting before it finished (state: ${stateBefore})`);
        }
        const bootInfo = await device.getBootStatus();
        // getBootStatus() is itself an async native call — the device can stop booting while it's
        // in flight, which would otherwise let a stale isTerminal from the check above pass this
        // predicate. Rechecking afterward, and requiring Booted specifically (not just Booting):
        // isTerminal only ever turns true once state has already reached Booted (see CLAUDE.md —
        // SimDeviceState reaches Booted well before boot info settles), so Booting + isTerminal can
        // only mean a stale status from a previous boot session, never real completion.
        const stateAfter = device.state();
        if (stateAfter !== SimDeviceState.Booting && stateAfter !== SimDeviceState.Booted) {
          throw new Error(`Device '${udid}' stopped booting before it finished (state: ${stateAfter})`);
        }
        return stateAfter === SimDeviceState.Booted && bootInfo?.isTerminal === true;
      },
      {
        waitMs: timeoutMs,
        intervalMs: 500,
        error: `Device '${udid}' did not finish booting within ${timeoutMs}ms`,
      },
    );
  });
}

/**
 * @param udid — UDID of the device to shut down
 * @throws if the device is already `Shutdown` — this is not an idempotent no-op
 */
export async function shutdownDevice(this: NativeSimctl, udid: string): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).shutdown());
}

/**
 * Best-effort shutdown of every device in the default device set that isn't already `Shutdown` —
 * the native equivalent of `xcrun simctl shutdown all`. A fan-out over {@link shutdownDevice}
 * rather than `SimDeviceSet`'s own bulk method, whose completion-block signature couldn't be
 * confirmed safely (see commit message). Per-device failures are swallowed.
 */
export async function shutdownAllDevices(this: NativeSimctl): Promise<void> {
  return runCatchingAsync(async () => {
    const deviceSet = await this._deviceSet();
    const devices = await deviceSet.devices();
    await Promise.all(
      devices
        .filter((device) => device.state() !== SimDeviceState.Shutdown)
        .map((device) => device.shutdown().catch(() => {})),
    );
  });
}

/**
 * Resets the given device's content and settings. Requires it to already be `Shutdown` — call
 * {@link shutdownDevice} first if it's booted (see CLAUDE.md).
 *
 * @param udid — UDID of the device to erase
 * @throws if the device isn't currently `Shutdown`
 */
export async function eraseDevice(this: NativeSimctl, udid: string): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).erase());
}

function toDeviceInfo(device: NativeDeviceHandle): SimDeviceInfo {
  return {
    udid: device.udid(),
    name: device.name(),
    state: device.state() as SimDeviceState,
    deviceTypeIdentifier: device.deviceTypeIdentifier(),
    runtimeIdentifier: device.runtimeIdentifier(),
  };
}
