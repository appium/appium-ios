import path from 'node:path';

import {logger} from '@appium/support';

import type {NativeSimctl} from '../native-simctl.js';
import type {NativeVideoRecordingHandle, StopVideoRecordingOptions, VideoRecordingOptions} from '../types.js';
import {runCatchingAsync, toTypedError} from '../utils/index.js';

declare module '../native-simctl.js' {
  interface NativeSimctl {
    startVideoRecording(udid: string, outputFile: string, options?: VideoRecordingOptions): Promise<void>;
    stopVideoRecording(udid: string, options?: StopVideoRecordingOptions): Promise<void>;
    isVideoRecording(udid: string): Promise<boolean>;
  }
}

const log = logger.getLogger('CoreSim');

// One device's recording lifecycle: `start` is the in-flight (or already-settled)
// startVideoRecording call, resolving to the live native handle — with both `options.audio` and
// `options.fps` unset, this addresses CoreSimulator's own internally-tracked private recorder (no
// real local resource, same as before this field existed); with either set, it's a real local
// resource (this addon's own encoders) with no server-side counterpart, so a handle is the only
// way to stop it either way. `stop`, once set, is the in-flight native stop call shared by every
// concurrent stopVideoRecording for this same recording — see stopVideoRecording for why a second
// one must reuse it rather than issuing its own.
interface RecordingState {
  readonly start: Promise<NativeVideoRecordingHandle>;
  stop?: Promise<void>;
}

// Tracks which devices currently have an active recording — module-level since the constraint (at
// most one per device) is CoreSimulator's own, not per-NativeSimctl-instance.
const activeRecordings = new Map<string, RecordingState>();

/**
 * Starts recording the device's display (and, with `options.audio`, its audio too, muxed as a
 * second track) to `outputFile` — the native equivalent of `simctl io <udid> recordVideo` when
 * both `audio` and `fps` are unset. Resolves once the first frame has actually been recorded, so
 * it's always safe to call {@link stopVideoRecording} immediately after. Only one recording may be
 * active per device at a time; starting a second one while the first is still running rejects.
 *
 * Without `audio`/`fps`, rejects with `NativeSimUnavailableError` if this CoreSimulator predates
 * the private capture API — confirmed missing on Xcode 16.4's, present on Xcode 26.5+ (Apple
 * documents no exact version floor). With either set, see {@link VideoRecordingOptions.audio}'s
 * own doc comment for the host-permission requirement that applies specifically to `audio`; a
 * failure *after* this call has already resolved (e.g. the audio tap's guest process set vanishing
 * mid-recording) doesn't reject it — it's logged here instead — call {@link stopVideoRecording} to
 * observe it as a rejection and release the recording's resources.
 *
 * @param udid — UDID of the device to record; must be booted
 * @param outputFile — filesystem path to write the video to; resolved against `process.cwd()` if
 *   relative, since the native layer requires an absolute path
 * @param options — `displayId`, `codec`, `mask`, `audio`, `fps`, `bitrate` — see {@link VideoRecordingOptions}
 * @throws {Error} if a recording is already in progress for this device
 */
export async function startVideoRecording(
  this: NativeSimctl,
  udid: string,
  outputFile: string,
  options: VideoRecordingOptions = {},
): Promise<void> {
  // Mirrors startVideoStream's identical validation — both reach the same native encoder path,
  // which otherwise silently truncates an out-of-range value instead of rejecting it.
  if (options.fps !== undefined && (!Number.isFinite(options.fps) || options.fps < 1)) {
    throw new RangeError(`fps must be a finite number >= 1, got ${options.fps}`);
  }
  if (
    options.bitrate !== undefined &&
    (!Number.isFinite(options.bitrate) || options.bitrate <= 0 || options.bitrate > 2 ** 31 - 1)
  ) {
    throw new RangeError(`bitrate must be a positive number no greater than ${2 ** 31 - 1}, got ${options.bitrate}`);
  }
  const key = udid.toLowerCase();
  if (activeRecordings.has(key)) {
    throw new Error(`A video recording is already in progress for device '${udid}'`);
  }
  const absoluteOutputFile = path.resolve(outputFile);
  const startPromise = runCatchingAsync(async () =>
    (await this._findDevice(udid)).startVideoRecording(absoluteOutputFile, options, (err) => {
      // Only ever invoked on the `audio`/`fps` (own-encoder) path — see its own doc comment above.
      // No live consumer to report to (this call already resolved), so logged instead of lost.
      log.error(`Unhandled video recording error for device '${udid}': ${toTypedError(err).stack ?? err}`);
    }),
  );
  // Marked before the native call resolves, not after, so a concurrent startVideoRecording for the
  // same device is rejected immediately instead of racing this one — rolled back below on failure.
  const state: RecordingState = {start: startPromise};
  activeRecordings.set(key, state);
  try {
    await startPromise;
  } catch (e) {
    // Only clear our own entry — a concurrent stopVideoRecording (see below) may already have.
    if (activeRecordings.get(key) === state) {
      activeRecordings.delete(key);
    }
    throw e;
  }
}

/**
 * Stops a recording previously started by {@link startVideoRecording} on the same device.
 * Resolves once the video file has been finalized on disk and is safe to read. If `start` is still
 * in flight (e.g. a concurrent caller stopping as soon as {@link isVideoRecording} turns `true`),
 * waits for it to settle first — issuing the native stop call any earlier is a silent CoreSimulator
 * race (see CLAUDE.md).
 *
 * Safe to call concurrently or to retry after a failure: every concurrent call for the same
 * recording shares a single in-flight native stop call rather than each issuing its own (which
 * could otherwise stop whatever *new* recording has since started on this device instead), and a
 * failed stop — even one that failed before ever reaching the native recorder, e.g. a transient
 * device-lookup error — leaves the recording tracked as still active so a retry can reach the
 * native call rather than the caller losing the ability to stop it at all.
 *
 * That retryability is a liability if nothing ever *does* retry — e.g. a best-effort teardown path
 * that must not throw, so it logs a failed stop and moves on — since without `options.force` there
 * is no other way to release the entry, permanently blocking a new `startVideoRecording` for this
 * device. Pass `options.force: true` in that situation: it still attempts the native stop (so the
 * encoder/file gets a chance to finalize cleanly) but releases the entry unconditionally afterward
 * and never rejects, even if that attempt failed — understand that this can leave a native
 * resource dangling if the stop genuinely never lands.
 *
 * @param udid — UDID of the device to stop recording
 * @param options — `force` (see above)
 * @throws {Error} if no recording is currently in progress for this device
 */
export async function stopVideoRecording(
  this: NativeSimctl,
  udid: string,
  options: StopVideoRecordingOptions = {},
): Promise<void> {
  const key = udid.toLowerCase();
  const state = activeRecordings.get(key);
  if (!state) {
    throw new Error(`No video recording is in progress for device '${udid}'`);
  }
  let handle: NativeVideoRecordingHandle;
  try {
    handle = await state.start;
  } catch {
    // start itself failed — its own catch already cleaned up activeRecordings; nothing to stop.
    throw new Error(`No video recording is in progress for device '${udid}'`);
  }
  const stopPromise = (state.stop ??= runCatchingAsync(async () => {
    await handle.stop();
  }));
  try {
    await stopPromise;
  } catch (e) {
    // Only clear our own attempt, and only if it's still the current one — a future (non-forced)
    // call must be able to retry the native stop rather than replaying this same rejection
    // forever, but must not clobber a newer attempt another concurrent caller may have already
    // started instead.
    if (state.stop === stopPromise) {
      state.stop = undefined;
    }
    if (!options.force) {
      throw e;
    }
    log.warn(
      `Force-releasing video recording bookkeeping for device '${udid}' despite a failed native stop: ` +
        `${toTypedError(e).stack ?? e}`,
    );
  }
  if (activeRecordings.get(key) === state) {
    activeRecordings.delete(key);
  }
}

/**
 * Whether a recording started by {@link startVideoRecording} is currently active for this device.
 * Pure local state — no CoreSimulator dispatch — so this never rejects with a native error.
 *
 * @param udid — UDID of the device to check
 */
export async function isVideoRecording(this: NativeSimctl, udid: string): Promise<boolean> {
  return activeRecordings.has(udid.toLowerCase());
}
