/** Raw `SimDeviceState` enum values, as returned by `SimDevice.state`. */
export enum SimDeviceState {
  Creating = 0,
  Shutdown = 1,
  Booting = 2,
  Booted = 3,
  ShuttingDown = 4,
}

/** Device orientations `setOrientation` accepts — the raw GSEvent wire values (see CLAUDE.md). */
export enum DeviceOrientation {
  Portrait = 1,
  PortraitUpsideDown = 2,
  LandscapeRight = 3,
  LandscapeLeft = 4,
}

/** A device in the default device set, as returned by `NativeSimctl.getDevices()`/`createDevice()`. */
export interface SimDeviceInfo {
  /** e.g. `"D768CB90-CBB4-4557-82F6-B89E1CD0E80B"`. */
  udid: string;
  /** Display name, e.g. `"iPhone 17"`. */
  name: string;
  state: SimDeviceState;
  /** e.g. `com.apple.CoreSimulator.SimDeviceType.iPhone-15` — `""` if that device type is no longer installed. */
  deviceTypeIdentifier: string;
  /** e.g. `com.apple.CoreSimulator.SimRuntime.iOS-17-4` — `""` if that runtime is no longer installed. */
  runtimeIdentifier: string;
}

/** A simulator device type this CoreSimulator install supports, as returned by `getSupportedDeviceTypes()`. */
export interface SimDeviceTypeInfo {
  /** e.g. `com.apple.CoreSimulator.SimDeviceType.iPhone-15`. */
  identifier: string;
  /** Display name, e.g. `"iPhone 15"`. */
  name: string;
}

/** A simulator runtime this CoreSimulator install supports, as returned by `getSupportedRuntimes()`. */
export interface SimRuntimeInfo {
  /** e.g. `com.apple.CoreSimulator.SimRuntime.iOS-17-4`. */
  identifier: string;
  /** Display name, e.g. `"iOS 17.4"`. */
  name: string;
  /** e.g. `"17.4"`. */
  versionString: string;
}

/**
 * Raw `SimDeviceBootInfo.status` values — a separate, more granular boot-progress signal than
 * {@link SimDeviceState}, and the one `simctl bootstatus` itself actually monitors (see CLAUDE.md
 * for how this was confirmed: runtime introspection against the loaded framework, and empirical
 * polling during a real boot). `SimDeviceState` reaching `Booted`
 * only means the OS kernel/launchd has started — data migration and system-app (SpringBoard)
 * startup, which these values track, can still take **20+ seconds longer** after that.
 * `simctl bootstatus`'s own output also names a `WaitingOnBackboard` phase whose numeric value
 * wasn't observed in testing (not every boot passes through it) — a `status` outside this enum's
 * values should be treated as "not yet terminal, keep waiting", not as an error.
 */
export enum SimBootStatus {
  Booting = 0,
  WaitingOnDataMigration = 2,
  WaitingOnSystemApp = 4,
  /** The only terminal value observed — `0xFFFFFFFF`. */
  Finished = 0xffffffff,
}

/** What `NativeSimctl.getBootStatus()` resolves with when the device has been booted at least once. */
export interface SimBootInfo {
  /** One of {@link SimBootStatus}'s values, or an unrecognized/undocumented one — see there. */
  status: number;
  /**
   * Whether this boot attempt has fully settled (success or failure). Confirmed empirically to
   * **stay `true` after shutdown**, reflecting the *previous* boot session — this alone does not
   * mean "currently booted"; check `SimDeviceState` too (see `getBootStatus()`).
   */
  isTerminal: boolean;
}

/**
 * Result of `NativeSimctl.getPermission` — mirrors the TCC database's own auth states rather than
 * a plain boolean, since `'unset'` (never prompted/decided) and `'denied'` (explicitly refused)
 * are different states with different UI implications. `'limited'` only applies to `photos`
 * ("selected photos" access).
 */
export type SimPermissionStatus = 'unset' | 'denied' | 'granted' | 'limited';

/**
 * A privacy permission grantable via `NativeSimctl.grantPermission`/`revokePermission`/
 * `resetPermission`. Each is backed by a row in the simulator's own TCC (privacy) database —
 * `location` isn't included since CoreLocation simulation has its own subsystem, not a plain TCC
 * row (see CLAUDE.md).
 */
export type SimPermissionService =
  | 'calendar'
  | 'camera'
  | 'contacts'
  | 'faceid'
  | 'health'
  | 'homekit'
  | 'medialibrary'
  | 'microphone'
  | 'motion'
  | 'photos'
  | 'reminders'
  | 'siri'
  | 'speech'
  | 'usertracking';

/**
 * A device's renderable display, as returned by `NativeSimctl.getDisplays()`.
 */
export interface SimDisplayInfo {
  /** Port UUID identifying this display — pass as `getScreenshot`'s `displayId` option to target it. */
  id: string;
  /** Raw `SimDisplayDescriptorState.displayClass` — 0 is always the primary display. */
  displayClass: number;
  /** Whether this is the primary display (`displayClass === 0`). */
  isMain: boolean;
}

/** Options for `NativeSimctl.getScreenshot`. */
export interface ScreenshotOptions {
  /** Image encoding — defaults to `'png'`. */
  format?: 'png' | 'jpeg';
  /**
   * Which display to capture, by `id` from `getDisplays()`. Defaults to the primary display
   * (falling back to the first renderable display if none is primary, e.g. tvOS).
   */
  displayId?: string;
  /**
   * JPEG quality as a percentage (0 = smallest/most compressed, 100 = largest/least compressed).
   * Only meaningful with `format: 'jpeg'` — ignored for `'png'`, which is always lossless.
   * Defaults to ImageIO's own default (near-lossless) when omitted.
   */
  quality?: number;
}

/** Options for `NativeSimctl.startVideoRecording`. */
export interface VideoRecordingOptions {
  /**
   * Which display to record, by `id` from `getDisplays()`. Defaults to the primary display
   * (falling back to the first renderable display if none is primary, e.g. tvOS).
   */
  displayId?: string;
  /** Video codec — `'h264'` (default) or `'hevc'`. */
  codec?: 'h264' | 'hevc';
  /**
   * For a non-rectangular display (e.g. a Dynamic Island cutout): `'ignored'` (default) saves the
   * unmasked framebuffer, `'black'` renders the mask black, `'alpha'` is not supported and
   * behaves like `'black'`. Only applies when neither `audio` nor `fps` is set — see their doc
   * comments.
   */
  mask?: 'ignored' | 'alpha' | 'black';
  /**
   * Also capture the device's audio into the same file, muxed as a second track. Defaults to
   * `false`. Requires macOS 14.2+ (Core Audio process taps), the host's "System Audio Recording
   * Only" privacy permission (System Settings > Privacy & Security — cannot be granted
   * programmatically; a denial isn't a thrown error, it surfaces as a silent, audio-less/near-
   * silent recording), a default audio output device on the host, and a booted device that has
   * produced audio at least once. See the README's "Screen capture" section for the full
   * requirements list and known failure modes.
   *
   * Like an explicit `fps`, this switches the implementation to this addon's own VideoToolbox +
   * Core Audio encoders instead of CoreSimulator's private recorder, which can't mux audio.
   */
  audio?: boolean;
  /**
   * Max frames/sec to poll the framebuffer at — see {@link VideoStreamOptions} `fps` for the
   * identical semantics. Meaningless against CoreSimulator's private recorder (it captures on its
   * own cadence, not one we poll), so setting `fps` — even without `audio` — switches this
   * recording to the same own-encoder implementation `audio` does. That switch costs `mask`
   * support, which only the private recorder implements.
   */
  fps?: number;
  /** Target average bitrate, in bits/sec. Respected on either implementation. */
  bitrate?: number;
}

/** Options for `NativeSimctl.stopVideoRecording`. */
export interface StopVideoRecordingOptions {
  /**
   * Best-effort: still attempts the native stop, but releases this device's tracked-active-
   * recording bookkeeping regardless of whether that attempt succeeds, instead of leaving it
   * retryable — see the doc comment above `NativeSimctl.stopVideoRecording` for when a caller
   * needs this over a plain retry.
   */
  force?: boolean;
}

/** Options for `NativeSimctl.startVideoStream`. */
export interface VideoStreamOptions {
  /**
   * Which display to stream, by `id` from `getDisplays()`. Defaults to the primary display
   * (falling back to the first renderable display if none is primary, e.g. tvOS).
   */
  displayId?: string;
  /** Video codec — `'h264'` (default) or `'hevc'`. */
  codec?: 'h264' | 'hevc';
  /**
   * Max frames/sec to poll the framebuffer at — an unchanged frame is never re-encoded, so this
   * is an upper bound, not a guarantee. Must be >= 1. Defaults to 60.
   */
  fps?: number;
  /** Target average bitrate, in bits/sec. Defaults to 4,000,000 (4 Mbps). */
  bitrate?: number;
  /**
   * Also stream the device's audio, interleaved into the same `accessUnits()` sequence. Defaults
   * to `false`. Same requirements and failure modes as {@link VideoRecordingOptions.audio} — see
   * its doc comment and the README's "Screen capture" section.
   */
  audio?: boolean;
}

/** Options for `NativeSimctl.startJpegStream`. */
export interface JpegStreamOptions {
  /**
   * Which display to stream, by `id` from `getDisplays()`. Defaults to the primary display
   * (falling back to the first renderable display if none is primary, e.g. tvOS).
   */
  displayId?: string;
  /**
   * Max frames/sec to poll the framebuffer at — an unchanged frame is never re-encoded, so this
   * is an upper bound, not a guarantee. Must be >= 1. Defaults to 60.
   */
  fps?: number;
  /**
   * JPEG quality as a percentage (0 = smallest/most compressed, 100 = largest/least compressed).
   * Defaults to 80 — noticeably smaller than {@link ScreenshotOptions.quality}'s own (near-
   * lossless) default, more suitable for a continuous live stream than a one-off screenshot.
   */
  quality?: number;
  /**
   * Frame scale as a percentage of the original display resolution — 100 (default) performs no
   * scaling; must be greater than 0 and no greater than 100.
   */
  scale?: number;
}

/**
 * One JPEG-encoded frame from `JpegStream.frames()`. Unlike {@link VideoAccessUnit}, every frame
 * is independently decodable — there's no keyframe/interframe distinction — so consumers (e.g. an
 * MJPEG multipart HTTP stream built from this sequence) can start from, or drop, any frame freely.
 */
export interface JpegFrame {
  data: Buffer;
  /** Monotonically increasing, starting at 0. */
  sequence: number;
  /** Microseconds since the stream started. */
  timestampMicros: number;
}

/**
 * One encoded unit from `VideoStream.accessUnits()`, discriminated by `track`: a video unit
 * (Annex-B NAL units — a keyframe's `data` has parameter sets, SPS/PPS or VPS/SPS/PPS for HEVC,
 * prepended, so it's self-decodable alone) or, when {@link VideoStreamOptions.audio} was set, an
 * interleaved audio unit (an ADTS-framed AAC-LC packet — the 7-byte ADTS header carries sample
 * rate/channel count itself, so no separate decoder-config exchange is needed; always
 * independently decodable, so `isKeyFrame` is always `true`). Without `audio`, every unit has
 * `track: 'video'`.
 */
export interface VideoAccessUnit {
  track: 'video' | 'audio';
  data: Buffer;
  isKeyFrame: boolean;
  /** Monotonically increasing per track, starting at 0 — independent between `'video'` and `'audio'`. */
  sequence: number;
  /** Microseconds since the stream started, on one shared clock across both tracks. */
  timestampMicros: number;
}

/**
 * Options for `NativeSimctl.spawnProcess`, passed through to CoreSimulator's
 * `spawnWithPath:options:terminationQueue:terminationHandler:error:`. Only keys confirmed
 * empirically (see CLAUDE.md) are typed here. CoreSimulator also recognizes
 * `binpref`/`wait_for_debugger`/`enableCheckedAllocations`/`stdin`/`stdout`/`stderr`, but the
 * latter three's expected value shape (`NSFileHandle`/XPC file descriptor/`NSNumber`, never a path
 * string) isn't yet confirmed safe — passing the wrong type crashes the whole process instead of
 * throwing a catchable error (see CLAUDE.md) — so they're deliberately omitted here.
 */
export interface SpawnOptions {
  /** Fully replaces argv, including argv[0] — `path` only selects the executable. */
  arguments?: string[];
  /** Merged additively into the spawned process's environment. */
  environment?: Record<string, string>;
}

/** One running process/launchd job inside a device, as reported by `NativeSimctl.listProcesses`. */
export interface SimProcessInfo {
  /** The process's real host OS pid (the simulator shares the host kernel). */
  pid: number;
  /** The launchd job's group, parsed from a label like `UIKitApplication:com.apple.app[...]` — `null` if the label has no group prefix. */
  group: string | null;
  /** The launchd job's name — a bundle identifier for an app process. */
  name: string;
}

/** The `alert` field of {@link ApnsPayload}, when it's a dictionary rather than a plain string. */
export interface ApnsAlert {
  title?: string;
  subtitle?: string;
  body?: string;
  'title-loc-key'?: string;
  'title-loc-args'?: string[];
  'subtitle-loc-key'?: string;
  'subtitle-loc-args'?: string[];
  'loc-key'?: string;
  'loc-args'?: string[];
  'action-loc-key'?: string;
  'launch-image'?: string;
}

/** The `sound` field of {@link ApnsPayload}, when it's a dictionary rather than a plain string. */
export interface ApnsSound {
  critical?: 0 | 1;
  name?: string;
  volume?: number;
}

/**
 * The `aps` dictionary of a simulated push notification payload — see Apple's
 * {@link https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification | Generating a Remote Notification}.
 * Only the commonly used fields are typed; `[key: string]: unknown` covers newer/less common ones
 * (e.g. Live Activity fields like `event`/`content-state`/`attributes-type`) without blocking them.
 */
export interface ApnsPayload {
  alert?: string | ApnsAlert;
  badge?: number;
  sound?: string | ApnsSound;
  'thread-id'?: string;
  category?: string;
  'content-available'?: 0 | 1;
  'mutable-content'?: 0 | 1;
  'target-content-id'?: string;
  'interruption-level'?: 'passive' | 'active' | 'time-sensitive' | 'critical';
  'relevance-score'?: number;
  'filter-criteria'?: string;
  [key: string]: unknown;
}

/**
 * Payload for `NativeSimctl.pushNotification` — an `aps` key with valid Apple Push Notification
 * content is required; a top-level `"Simulator Target Bundle"` key is not (the separate `bundleId`
 * argument covers it). Additional top-level keys are allowed — APNs delivers them to the app as
 * custom data alongside `aps`.
 */
export interface PushNotificationPayload {
  aps: ApnsPayload;
  [key: string]: unknown;
}

// Shape of the native addon's exports (see src/coresim.mm) — internal to native-simctl.ts, never
// exported from index.ts. Consumers only ever see NativeSimctl and the public types above.

/**
 * What `NativeDeviceHandle.spawn()` resolves with once the process has started — `stdoutFd`/
 * `stderrFd` are raw, already-`dup()`'d file descriptors (see coresim.mm) ready to be wrapped in a
 * `net.Socket({fd, readable: true, writable: false})` (not `fs.createReadStream`, which would
 * block a shared libuv threadpool worker for as long as the pipe stays quiet — see
 * commands/spawn.ts); `pid` is a real host OS process id, killable directly.
 */
export interface NativeSpawnResult {
  pid: number;
  stdoutFd: number;
  stderrFd: number;
}

/**
 * Decoded wait(2)-style exit status (see CLAUDE.md for how the raw status was confirmed),
 * mirroring Node's own `ChildProcess` `'exit'` event — exactly one of `code`/`signal` is set.
 */
export type NativeSpawnExitCallback = (code: number | null, signal: number | null) => void;

/** Raw shape of an access unit as the native addon delivers it — see {@link VideoAccessUnit}. */
export interface NativeVideoAccessUnit {
  track: 'video' | 'audio';
  data: Buffer;
  isKeyFrame: boolean;
  sequence: number;
  timestampMicros: number;
}

export type NativeVideoAccessUnitCallback = (unit: NativeVideoAccessUnit) => void;
export type NativeVideoErrorCallback = (err: Error) => void;

/**
 * A live encoder session, wrapped by `coresim.mm`'s `NativeVideoStream` (video only) or
 * `NativeAVStream` (`audio: true` — see {@link VideoStreamOptions}) — either way, what
 * `NativeDeviceHandle.startVideoStream()` resolves to; the two native wrapper classes expose the
 * identical shape below, so callers never need to know which one they got.
 */
export interface NativeVideoStreamHandle {
  stop(): Promise<void>;
  /** Forces the next encoded video frame to be a keyframe — trivial in-memory flag, so synchronous. */
  requestKeyFrame(): void;
}

/** Raw shape of a JPEG frame as the native addon delivers it — see {@link JpegFrame}. */
export interface NativeJpegFrame {
  data: Buffer;
  sequence: number;
  timestampMicros: number;
}

export type NativeJpegFrameCallback = (frame: NativeJpegFrame) => void;

/** A live `coresim::JpegStreamSession`, wrapped by `coresim.mm`'s `NativeJpegStream`. */
export interface NativeJpegStreamHandle {
  stop(): Promise<void>;
}

/**
 * A live recording, wrapped by `coresim.mm`'s `NativePrivateRecordingHandle` (video only,
 * addressing CoreSimulator's own internally-tracked private recorder) or `NativeAVRecording`
 * (`audio: true` — see {@link VideoRecordingOptions}, a real local resource with no server-side
 * counterpart) — either way, what `NativeDeviceHandle.startVideoRecording()` resolves to.
 */
export interface NativeVideoRecordingHandle {
  /** Resolves once the output file has been finalized on disk and is safe to read. */
  stop(): Promise<void>;
}

/** A `SimDevice`, wrapped by `coresim.mm`'s `NativeDevice` — what `NativeSimctl`'s `_findDevice()` resolves to. */
export interface NativeDeviceHandle {
  // Trivial in-memory accessors — kept synchronous on the native side (see coresim.mm), never a
  // CoreSimulator dispatch that could block.
  udid(): string;
  name(): string;
  state(): number;
  deviceTypeIdentifier(): string;
  runtimeIdentifier(): string;
  runtimeRootPath(): string;
  boot(options?: Record<string, unknown>): Promise<void>;
  getBootStatus(): Promise<SimBootInfo | null>;
  shutdown(): Promise<void>;
  erase(): Promise<void>;
  getenv(name: string): Promise<string>;
  installApp(path: string, options?: Record<string, unknown>): Promise<void>;
  uninstallApp(bundleId: string, options?: Record<string, unknown>): Promise<void>;
  launchApp(bundleId: string, options?: Record<string, unknown>): Promise<number>;
  terminateApp(bundleId: string): Promise<void>;
  propertiesOfApplication(bundleId: string): Promise<Record<string, unknown>>;
  installedApps(): Promise<Record<string, unknown>>;
  openUrl(url: string): Promise<void>;
  setLocation(latitude: number, longitude: number): Promise<void>;
  clearLocation(): Promise<void>;
  setOrientation(orientation: number): Promise<void>;
  getOrientation(): Promise<number>;
  sendPushNotification(bundleId: string, payload: PushNotificationPayload): Promise<void>;
  addCertificate(path: string, trustAsRoot: boolean): Promise<void>;
  resetKeychain(): Promise<void>;
  getUIAppearance(): Promise<number>;
  setUIAppearance(style: number): Promise<void>;
  getIncreaseContrast(): Promise<number>;
  setIncreaseContrast(enabled: boolean): Promise<void>;
  getContentSize(): Promise<number>;
  setContentSize(category: number): Promise<void>;
  grantPermission(service: string, bundleId: string, status?: 'granted' | 'limited'): Promise<void>;
  revokePermission(service: string, bundleId: string): Promise<void>;
  resetPermission(service: string, bundleId: string): Promise<void>;
  getPermission(service: string, bundleId: string): Promise<SimPermissionStatus>;
  darwinNotificationGetState(name: string): Promise<bigint>;
  darwinNotificationSetState(name: string, state: bigint): Promise<void>;
  postDarwinNotification(name: string): Promise<void>;
  addMedia(filePaths: string[]): Promise<void>;
  addPhoto(filePath: string): Promise<void>;
  addVideo(filePath: string): Promise<void>;
  getPasteboard(): Promise<string>;
  setPasteboard(content: string): Promise<void>;
  getWebInspectorSocket(): Promise<string>;
  screenshot(options?: {format?: 'png' | 'jpeg'; displayId?: string; quality?: number}): Promise<Buffer>;
  getDisplays(): Promise<SimDisplayInfo[]>;
  // `mask` only applies without `audio`/`fps`; `bitrate` applies either way — see
  // VideoRecordingOptions's own doc comments for why. `onError` is only ever invoked on the
  // `audio`/`fps` (own-encoder) path — a live mid-recording failure, which the private recorder
  // has no channel to report.
  startVideoRecording(
    outputFile: string,
    options:
      | {
          displayId?: string;
          codec?: 'h264' | 'hevc';
          mask?: 'ignored' | 'alpha' | 'black';
          audio?: boolean;
          fps?: number;
          bitrate?: number;
        }
      | undefined,
    onError: NativeVideoErrorCallback,
  ): Promise<NativeVideoRecordingHandle>;
  startVideoStream(
    options: {displayId?: string; codec?: 'h264' | 'hevc'; fps?: number; bitrate?: number; audio?: boolean} | undefined,
    onAccessUnit: NativeVideoAccessUnitCallback,
    onError: NativeVideoErrorCallback,
  ): Promise<NativeVideoStreamHandle>;
  startJpegStream(
    options: {displayId?: string; fps?: number; quality?: number; scale?: number} | undefined,
    onFrame: NativeJpegFrameCallback,
    onError: NativeVideoErrorCallback,
  ): Promise<NativeJpegStreamHandle>;
  spawn(path: string, options: SpawnOptions | undefined, onExit: NativeSpawnExitCallback): Promise<NativeSpawnResult>;
}

/** A `SimDeviceSet`, wrapped by `coresim.mm`'s `NativeDeviceSet`. */
export interface NativeDeviceSetHandle {
  devices(): Promise<NativeDeviceHandle[]>;
  createDevice(deviceTypeIdentifier: string, runtimeIdentifier: string, name: string): Promise<NativeDeviceHandle>;
  deleteDevice(device: NativeDeviceHandle): Promise<void>;
}

/** A `SimServiceContext`, wrapped by `coresim.mm`'s `NativeServiceContext`. */
export interface NativeServiceContextHandle {
  defaultDeviceSet(): Promise<NativeDeviceSetHandle>;
  deviceSetWithPath(path: string): Promise<NativeDeviceSetHandle>;
  supportedDeviceTypes(): Promise<SimDeviceTypeInfo[]>;
  supportedRuntimes(): Promise<SimRuntimeInfo[]>;
}

/** The addon's module-level exports (`coresim.mm`'s `Init`) — the return value of `require('node-gyp-build')(...)`. */
export interface NativeCoreSimModule {
  sharedServiceContext(developerDir: string): Promise<NativeServiceContextHandle>;
  frameworkVersion(): Promise<string>;
  /**
   * Synchronously (not a Promise) stops every still-live video/AV stream or AV recording, blocking
   * until each has released its resources. Meant to be called from a `process.on('exit', ...)`
   * listener (see native-simctl.ts) — cleanup hooks alone don't run under `process.exit()` on the
   * main process/thread, only on a natural empty-event-loop exit or a Worker's own termination.
   */
  flushActiveSessions(): void;
}
