# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm install                      # installs deps; compiles the native addon via node-gyp-build if no prebuild exists
npm run build                    # TypeScript compile
npm run build:addon              # rebuild the native addon from source (node-gyp)
npm run build:addon:xcodebuild   # rebuild via xcodebuild with -Wall -Wextra -Werror (needs full Xcode, not just CLTs)
npm run build:prebuilds          # produce N-API prebuilds under prebuilds/

npm run lint / lint:fix          # oxlint for TS/JS
npm run format:cpp / lint:cpp    # clang-format / clang-tidy for the native code (not installed by npm install)

npm test                         # unit + integration
npm run test:unit                # no simulator required
npm run test:integration         # needs a real simulator
```

## Project structure

```
src/
  coresim.mm       # N-API glue: NativeDevice/NativeDeviceSet/NativeServiceContext ObjectWrap classes
  native/          # Objective-C++ helpers: dynamic ObjC dispatch, exception safety, async bridging,
                    # error conversion, JS<->NSObject value conversion, and a TCC.db (privacy) accessor
  native-simctl.ts # NativeSimctl core (construction, service-context/device lookup)
  commands/        # NativeSimctl's public methods, grouped by topic, mixed into the class
  utils/           # small dependency-free helpers shared by native-simctl.ts and commands/*.ts
  types.ts         # public types + internal shapes describing the native addon's exports
  errors.ts        # typed error classes + mapping from raw addon errors
  index.ts         # package entry

test/
  unit/            # no simulator required
  integration/     # exercises real devices; one throwaway device per simulator runtime

scripts/install.mjs # install-time no-op off macOS, so `npm install` never fails on other platforms
```

## Architecture

This is a Node.js native addon that binds `CoreSimulator.framework` directly — the same private
framework `simctl` and Xcode are themselves built on — instead of shelling out to the `simctl` CLI.
Native functionality is macOS-only; the package itself installs anywhere (no `os`/`cpu` restriction),
and any method that actually needs the simulator throws a typed `NativeSimUnavailableError` on other
platforms instead of attempting to load a nonexistent addon.

**Dynamic dispatch, not headers.** `CoreSimulator.framework` ships no public headers, so every class
and selector is resolved at runtime (`NSClassFromString`/`respondsToSelector:`) rather than linked
statically, and every call is exception-guarded (`@try`/`@catch` around each dispatch) so a missing
selector or a native exception surfaces as a catchable, typed JS error instead of crashing the
process. This is the load-bearing safety net for the whole addon — any new native call must go
through it.

**Native layer** (`src/coresim.mm`, `src/native/`): an ARC-enabled Objective-C++ N-API addon. Every
method that can trigger a CoreSimulator dispatch runs off the main thread and resolves/rejects a
Promise, so a slow operation never blocks Node's event loop. `spawnProcess` is the one exception to
the simple one-shot-resolve pattern, since a spawned process's exit can arrive long after the initial
promise (carrying the pid) already resolved.

**TypeScript layer** (`src/`): `NativeSimctl`'s public method surface lives in `src/commands/*.ts`,
grouped by topic and mixed into the class (mirroring `@appium/base-driver`'s command-mixin pattern)
rather than defined directly on the class body. Devices are addressed by UDID; every method
re-resolves the native device handle from the live device set rather than caching it, so a device
deleted elsewhere surfaces as a normal "not found" error. The public surface intentionally mirrors
`node-simctl`'s own `Simctl` API shape, plus a few additions (`getBootStatus`/`waitForBoot`, a
streaming `spawnProcess`) that only make sense once you're not just wrapping a CLI.

**Tests and CI**: unit tests cover everything read-only; integration tests cover the mutating device
lifecycle against one throwaway device on a real simulator, validated in CI across a matrix of
Xcode/CoreSimulator versions (a different Xcode ships a different CoreSimulator build — the axis
that actually matters here). The native addon build treats compiler warnings as errors on every
toolchain (`make` and `xcodebuild`).

## Things worth knowing before changing native code

- **CoreSimulator's own state transitions are eventually consistent.** A `deleteDevice`/`boot` call
  can resolve before `devices()` reflects the new state — code that needs to observe a transition
  should poll for it rather than assume it's immediate.
- **`SimDeviceState` reaching `Booted` is not the same as "the simulator is actually ready".** It only
  means the OS kernel has started; data migration and system-app startup can take much longer. Use
  `getBootStatus()`/`waitForBoot()` (a separate, more granular signal — the same one `simctl
  bootstatus` itself polls) when a check needs a genuinely settled simulator.
- **A wrong-shaped argument to some native calls crashes the whole process, not just the call.**
  Exceptions raised on a thread other than the one that made the call can't be caught by the usual
  `@try`/`@catch` guard. `spawnProcess`'s `stdout`/`stderr` handling is the known instance of this —
  it's why the addon always manages those pipes itself rather than accepting them as options. Also
  confirmed the hard way: passing the pipe's `NSFileHandle` object itself (not just a wrong type)
  crashed the process on some CoreSimulator versions via `-[NSConcreteFileHandle intValue]:
  unrecognized selector` — the internal handler wants a raw fd number (`NSNumber`).
- **`spawnProcess`'s `path` is always resolved against the Simulator's own runtime root and
  confined there** (`ResolveRuntimeBinaryPath` in coresim.mm) — it cannot be used to spawn an
  arbitrary host executable. A leading `/` is tolerated (still joined under the runtime root, not
  the host's own `/`); a `path` that would resolve outside it (e.g. via `..`) throws, checked via
  `-stringByStandardizingPath` rather than a naive string search. Deliberately breaking: earlier
  versions took `path` as a literal, unconfined path.
- **A bare `path` (no `/`) is resolved by searching a fixed list of standard bin dirs under the
  runtime root** (`ResolveBareCommand` in coresim.mm: `usr/bin`, `bin`, `usr/sbin`, `sbin`,
  `usr/local/bin`), mirroring `simctl spawn`'s own bare-name resolution. This is a guess, not a
  real `$PATH` search — there's no way to read the guest's actual `$PATH` before a process exists
  to read it from — so a binary outside those dirs must still be spawned by its full path.
- **`spawnProcess` always sets the spawn options' `"standalone"` key to `false`**
  (`kSimDeviceSpawnStandalone`, confirmed via `strings` on the framework binary — no public header
  exists), not caller-configurable — since `path` always resolves inside the guest runtime
  (above), every spawn needs to stay attached to the guest's launchd bootstrap namespace to
  function / have its effects observed there. Known risk accepted deliberately: some CoreSimulator
  versions (Xcode 26.4+) instead require a *standalone* spawn for a non-system binary to load its
  dyld shared cache correctly, aborting a non-standalone one with SIGABRT trying to load even
  `libSystem.B.dylib` — reproduced only on hosted CI (never locally), diagnosed from the child's
  own crash report, and only previously worked around (not root-caused) by defaulting to
  standalone. If this resurfaces for a runtime binary, it needs a real fix here, not a caller
  escape hatch.
- **Privacy permissions (`grantPermission`/`revokePermission`/`resetPermission`) are implemented by
  writing directly to the simulator's own TCC (privacy) SQLite database**, not by calling
  CoreSimulator's private privacy API — that API requires a process entitlement no ordinary npm
  package can obtain. `location` isn't supported this way since it isn't a plain TCC row.
- **`notifications` isn't a TCC row either** — SpringBoard keeps it in
  `Library/BulletinBoard/VersionedSectionInfo.plist`, reads that file only on its own start and
  rewrites it from memory (notably a few seconds after each start). So the permission commands pause
  SpringBoard (`SIGSTOP`) while writing the app's section, then `launchctl stop` it with the file kept
  `uchg`-immutable until the old process is gone. Confirmed empirically on fresh iOS 18.2/26.5
  devices: without the pause, a write racing SpringBoard's own post-start rewrite was lost in 2–3 of
  20 operations. A shut down device only gets the file, and SpringBoard loads it on boot without a
  restart; a missing store (a never-booted device) is created with just the app's section and
  `sectionInfoVersionNumber` 2, and SpringBoard adds the rest on first boot (confirmed on iOS
  18.5/26.5). The store is replaced via a temp file + `rename`, and every update of one store —
  pause, read, write, restart — is serialized within the process (`withStoreLock`), not across
  processes. Its status can't be read back (`getPermission` rejects).
- **Several CoreSimulator operations reject if the device isn't in the exact state they expect**
  (e.g. erasing requires `Shutdown`; shutting down an already-`Shutdown` device also rejects) rather
  than being idempotent no-ops — callers need to check state first.
- **Pasteboard sync (`getPasteboard`/`setPasteboard`) needs no special entitlement** — see
  `sim_pasteboard.mm` for the two private mechanisms it picks between and how.
- **Screenshot capture (`getScreenshot`) reads the device's live framebuffer `IOSurface` in-process**
  — no entitlement, no temp file, no `simctl` subprocess — see `sim_screenshot.mm` for how the main
  display's IO port is found and rendered to PNG.
- **Video recording (`startVideoRecording`/`stopVideoRecording`) drives a private CoreSimulator
  API, reverse-engineered via `strings` on `simctl` — no public header exists.** The receiver is a
  separate "capture service" descriptor (protocol `SimScreenCaptureService`), found by scanning
  `-[device io] ioPorts` for whichever one responds to `startRecordingFromScreen:...`
  (`ResolveVideoCaptureService`) — distinct from the display descriptor `getScreenshot` reads.
  `outputFile` must be an `NSString*` absolute path (an `NSURL*` hangs the completion handler
  forever); `maskPolicy` `0`/`1`/`2` map to ignored/alpha/black, alpha indistinguishable from black.
  Calling `stop` before `start`'s completion handler has fired is a silent race —
  `video-recording.ts` avoids it by never resolving `start` early. Throws
  `NativeSimUnavailableError` if the port is missing entirely, a genuine CoreSimulator-version
  floor (confirmed on Xcode 16.4) with no userland workaround.
- **Video streaming (`startVideoStream`) uses no private API** — `startRecordingFromScreen:` only
  writes to a file with no per-frame callback. `sim_video_stream.mm` instead polls the same display
  `IOSurface` `getScreenshot` reads on a GCD timer, skips unchanged frames (`IOSurfaceGetSeed()`),
  and encodes changed ones via a real `VTCompressionSession` (public VideoToolbox) into Annex-B
  H.264/HEVC. Teardown needs two paths: `Impl::Stop()` (external callers) `dispatch_sync`s onto the
  encoder queue to drain any in-flight `Tick()`; `Impl::StopFromQueue()` is the same minus that
  barrier, for when `Tick()` itself triggers teardown (already on that queue — `dispatch_sync`ing
  there would deadlock). `onEnd`, fired once from whichever path wins, is the only safe point to
  release the N-API `ThreadSafeFunction`s. Independent of `startVideoRecording` — any number of
  streams and one recording can run concurrently.
- **JPEG streaming (`startJpegStream`) reuses `startVideoStream`'s IOSurface-poll/GCD-timer/seed-
  check skeleton but drops everything codec-specific.** `sim_jpeg_stream.mm` JPEG-encodes each
  changed frame synchronously, on the polling queue itself, via the same ImageIO `CGImageDestination`
  path `getScreenshot`'s `format: 'jpeg'` uses — except through one persistent `CIContext` (created
  once, not per frame/call) instead of `CaptureScreenshot`'s deliberately one-shot context (see
  `sim_screenshot.mm`'s own comment). Since every JPEG frame is independently decodable, there's no
  keyframe/resync concept, and — unlike `VideoStreamSession`, whose `VTCompressionSession` callback
  can fire on another thread — no cross-thread "error reported elsewhere, picked up next tick"
  handoff either: an encode failure is just an `NSError**` out-param, handled inline. Shares the
  same `TsfnReleaseGuard`/`ActiveSessionRegistry`/exit-cleanup wiring in `coresim.mm` as
  `startVideoStream`. Produces a plain frame sequence, not a video bitstream — building an MJPEG
  (`multipart/x-mixed-replace`) HTTP stream out of it is left entirely to the caller.
- **A live `startVideoStream` needs two separate defenses against `worker.terminate()`.** An
  `env.AddCleanupHook` in `coresim.mm` stops every registered `VideoStreamSession` before Node
  force-releases the Environment's TSFNs — but a callback *already queued* on a TSFN (frames piled
  up while the JS thread was blocked) can still fire mid-teardown, where calling into JS throws;
  node-addon-api's own `WrapVoidCallback` re-throwing that as a JS exception then aborts the whole
  process on a torn-down env. So each TSFN callback body also wraps its `jsCallback.Call(...)` in
  its own `try { ... } catch (...) {}` — dropping a frame nothing can receive is safe, letting the
  exception escape isn't.
- **`Napi::ThreadSafeFunction::Release()`/`Abort()` must never both run for the same TSFN.** They're
  two mutually exclusive modes of one underlying destroy call — Node's own docs call using either a
  second time (including calling the other one afterward) undefined behavior, since the handle may
  already be gone. `VideoStreamSession`/`AVStreamSession` release their `accessUnitTsfn`/`errorTsfn`
  normally via `onEnd` on `stop()` — but a session stays in `ActiveSessionRegistry` (and thus
  reachable by `CleanupActiveSessions`'s exit-time `AbortDelivery()`, see above) until its JS
  wrapper is `Finalize()`d, not until `stop()` completes. A caller that `stop()`s a stream, keeps
  the returned handle referenced, then lets the process exit hits exactly this race. `coresim.mm`'s
  `TsfnReleaseGuard`/`ReleaseTsfnOnce` make whichever of the two wins first the only one that
  actually runs — any new TSFN pair with both a normal-release and an abort path needs the same
  guard, not just a `running_`/state-flag check (insufficient — see the guard's own comment for
  why).
- **A `VideoStream` can't actually be garbage-collected while running — not a bug.** Its
  `onAccessUnit`/`onError` callbacks close over the `VideoStream` itself, and a live
  `Napi::ThreadSafeFunction` holds a persistent V8 reference to them until `.Release()`d (only via
  `stop()`/`onEnd`), rooting the whole chain and keeping the event loop alive. An abandoned, never-
  `stop()`'d stream just runs forever, same as any other unclosed live resource in this addon.
- **`startVideoRecording`/`startVideoStream`'s `audio` option (or an explicit `fps` on
  `startVideoRecording`) routes through this addon's own encoders, since CoreSimulator has no audio
  capture API at all.** `sim_audio_tap.mm` isolates one device's audio via a public Core Audio
  **process tap** (`CATapDescription`/`AudioHardwareCreateProcessTap`, macOS 14.2+) scoped to that
  device's guest PIDs, wrapped in a private aggregate device; `audio_encoder.mm` encodes to AAC-LC;
  `av_recording.mm`/`av_stream.mm` mux/interleave it with `video_encoder.mm`'s VideoToolbox output.
  **Needs the host's "System Audio Recording Only" TCC permission** (`kTCCServiceAudioCapture`) —
  keyed to the *host* process's code identity (not the guest's TCC.db), has no query API, and a
  denial isn't a catchable error — it's silent all-zero PCM. The host's own TCC.db can't be read to
  detect this either: opening it needs Full Disk Access, an equally ungrantable permission. CI seeds
  the grant directly since GitHub-hosted runners ship with SIP disabled (`scripts/ci/grant-audio-
  capture.sh`, `integration-test.yml`'s `grant-audio-capture` input) — the integration tests still
  only assert the audio track/units are structurally valid, never audible. A host with no default
  audio output device at all is checked for and rejected in milliseconds, but that's not the only
  slow-host failure mode: on some CI runners (confirmed on the `26.5`/`27.0` matrix legs, not
  `16.4`) `AudioDeviceStart` blocks for ~180s before failing with `MACH_RCV_TIMED_OUT` (a Mach IPC
  timeout talking to `coreaudiod`) even though a default device exists — not predictable or
  avoidable from our side, so the audio-capture integration tests currently skip outright in CI
  (`IS_CI` in `coresim-integration.spec.ts`) rather than pay that cost on every run; they still run
  normally locally.
- **`getAppContainer` is a pure TS convenience wrapper over `appInfo`'s existing `Path`/
  `DataContainer`/`GroupContainers` fields** (see `commands/app.ts`) — no new native call, since
  `propertiesOfApplication:` already reports every container path `simctl get_app_container` does.
- **Biometric enrollment/matching (`enrollBiometric`/`sendBiometricMatch`/`isBiometricEnrolled`) and
  `shake` are pure TS wrappers over the existing Darwin notification primitives** (see
  `commands/biometric.ts`/`commands/misc.ts`) — the same mechanism Simulator.app's own Features menu
  drives, so no new native code was needed for them.
- **`getWebInspectorSocket` has no CoreSimulator dispatch at all** — `SimDevice`/`SimDeviceSet`
  expose no PID/socket accessor for a device's own `launchd_sim`. Instead it's `libproc`/`sysctl`
  process introspection (see `native/sim_process.mm`), the same mechanism `lsof -aUc launchd_sim`
  uses: match the target UDID against `launchd_sim`'s argv, then scan its fds for a Unix socket
  ending in `com.apple.webinspectord_sim.socket`. Returns just the path; no entitlement needed.
- **A non-default device set (`simctl --set <path>`'s equivalent) is opt-in per `NativeSimctl`
  instance** — pass `deviceSetPath` as the constructor's second argument; every device lookup then
  resolves against `-[SimServiceContext deviceSetWithPath:error:]` instead of
  `defaultDeviceSetWithError:`. Unset, behavior is unchanged (the default device set).
- **`listProcesses` must spawn the guest runtime's own `launchctl`, not the host's
  `/bin/launchctl`** — the host binary exits 5 (wrong launchd). It spawns it by bare name
  (`spawnProcess`'s own PATH-like resolution, above, finds it under the runtime root), the same
  way `simctl spawn` would resolve it against the guest's `$PATH`. The runtime root itself is also
  exposed publicly as `getRuntimeRootPath`, for callers that need the raw path directly.
- **`setOrientation` rotates the device via a raw GSEvent mach message to SpringBoard's
  `PurpleWorkspacePort`** (`SetDeviceOrientation` in `sim_device.mm`) — the same mechanism
  Simulator.app's Hardware > Rotate menu uses, recovered from Xcode's private `SimulatorApp/
  GSEvent.h` (`CoreSimulator.framework` itself has no orientation API). A
  `GSEventTypeDeviceOrientationChanged` message (`50 | 0x20000`) is hand-built into a 112-byte
  buffer (mach header + record: type at `0x18`, size at `0x48`, orientation at `0x4C`) and sent via
  `mach_msg` to the port `LookupMachPort` resolves for `"PurpleWorkspacePort"`. Confirmed working
  end-to-end (screenshot dimensions swap on rotation) on Xcode 27/iOS 27. A newer `dtuhidd`/
  CoreDevice XPC mechanism exists too (gated on the runtime reporting device-motion capability) but
  had no visible effect here despite the daemon answering a liveness probe — Purple is what
  actually works, with far less machinery.
- **A `SimDevice` object created (pre-boot) by this process can silently stop delivering
  `LookupMachPort` mach messages once the device boots — for the rest of that process's life —
  even though the lookup keeps returning a valid, sendable port.** Confirmed via a minimal repro:
  create + boot + send → no effect; a fresh process touching the same UDID after boot works every
  time. Re-fetching via `-[SimDeviceSet devices]` doesn't help — CoreSimulator memoizes `SimDevice`
  by UDID, so it's the same object. Not root-caused (closed-source). Affects `setOrientation` and
  plausibly `getPasteboard`/`setPasteboard` (the only other `LookupMachPort` consumer).
- **`getOrientation` reads live off `com.apple.backboardd`'s own preference file, directly from the
  host side** (`sim_orientation.mm`, `DeviceDataPath`'s `Library/Preferences/com.apple.backboardd.plist`
  — same "read the guest's own file, no entitlement" pattern as `tcc_privacy.mm`) — a real,
  empirically-confirmed signal, unlike the two `dtuhidd` XPC read paths, both dead on Xcode 27/iOS 27
  (a CoreMotion-based fallback checked too, also unavailable here). Its `GraphicsOrientation` swaps
  landscape left/right vs. our own `DeviceOrientation` values (confirmed empirically) — see
  `TranslateGraphicsOrientation`. Defaults to portrait if never rotated this boot, or on error.
  A rebooted device's file can still hold the *previous* boot's last entry for a few seconds until
  backboardd rewrites it (confirmed empirically) — guarded by comparing the file's mtime against
  `SimDevice.lastBootedAt`; a file older than the current boot is treated as empty rather than
  trusted.
- **`startVideoStream`/`startVideoRecording({fps})` correct a rotated frame's orientation** — the
  captured surface itself never reflects a live rotation (see above). `video_encoder.mm` polls
  `getOrientation` every 3s (not on every tick, to keep `Tick()` itself cheap) and rotates via CoreImage before
  encoding, rebuilding the `VTCompressionSession` at the rotated dimensions.
  `RotationDegreesForOrientation`'s angles were verified empirically, not derived from enum names.
  A block capturing a lambda's locals must not be written inline inside `SafeInvoke([&] {...})` if
  it outlives the function — crashed once with a delayed `SIGSEGV`; declare it as a normal local
  first instead.
- **`startVideoRecording({fps})`'s rotated frames are letterboxed into the recording's original
  frame size, not resized to match** (`VideoEncoderOptions::fixedFrameSize`, forced on in
  `av_recording.mm` only) — unlike `startVideoStream`, its `AVAssetWriterInput` track's dimensions
  are fixed once the first sample is appended; a later, differently-sized sample is silently
  accepted but plays back squashed rather than rejected (confirmed empirically — reproduced on
  iPhone 16 Pro/iOS 26.5). `RotatedPixelBuffer` scales the rotated content to fit the frozen canvas
  and composites it over black. In `fixedFrameSize` mode, `Tick()` clears `hasEncodedSinceSetup_`
  whenever the polled orientation or raw surface size actually changes, forcing the next tick to
  encode regardless of `IOSurfaceGetSeed()` — otherwise a rotation on an otherwise-unchanging screen
  (the raw surface's seed doesn't bump on its own) could go uncorrected indefinitely, since the
  seed-equality skip has no other way to know a re-render is owed.
- **A writer-level append failure in `av_recording.mm` now also stops `videoEncoder_`, not just the
  audio side** — dispatched async (see its own comment for why) rather than inline. That async
  `Stop()` can still flush a frame into a callback afterward, so `AVRecordingSession::Impl` is
  `enable_shared_from_this`; its collaborators' callbacks capture a `weak_ptr`, locked at call time —
  a strong self-capture stored in a member `Impl` itself owns (`videoEncoder_`, `audioTap_`) would
  leak via a reference cycle instead.

## Known gaps

- No handling of a CoreSimulator/Xcode version mismatch requiring an upgrade (the way `simctl`'s own
  wrapper does).
- `spawnProcess` has no writable `stdin`.
- `getOrientation` can lag a real rotation by up to 3s in a running video stream/recording (the
  background poll interval — see detailed bullet above), and reads portrait for a device that's
  never rotated this boot, indistinguishable from one that genuinely has.
- A device created and booted in-process can silently drop `LookupMachPort` messages
  (`setOrientation`, pasteboard) for that process's lifetime (see detailed bullet above).
