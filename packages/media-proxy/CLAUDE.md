# CLAUDE.md — @appium/media-proxy

HEVC (remotexpc) → H.264 / MJPEG transcoder in the common coresim/Android format. N-API addon over
an LGPL-only FFmpeg build; TS wrapper under `src/`.

## Commands

- `npm run build` — `tsc -b` (also runs on `npm install` via `prepare`)
- `npm run build:ffmpeg` — builds the pinned LGPL FFmpeg into `third_party/ffmpeg/<platform>-<arch>` (needed before any native build)
- `npm run build:addon` — `node-gyp rebuild` + copies the FFmpeg libs into `build/Release` (picked up by node-gyp-build)
- `npm run build:prebuilds [-- --arch x64]` — prebuildify + bundles the FFmpeg libs into `prebuilds/<platform>-<arch>` (CI)
- `node scripts/bench.mjs clip.h265` — real-time fps/latency report
- `npm run test:unit` — pure TS, fake native backend, no addon needed
- `npm run test:integration` — needs the addon (`build:addon` first)
- `npm run format:cpp:check` / `lint:cpp` — clang-format / clang-tidy over `src/native`

## Layout

- `src/transcoder.ts` — option validation/defaults, `TimestampConverter` (RTP 32-bit unwrap → µs),
  `Transcoder` (takes an injectable `NativeModule`, which is how unit tests run), `transcode()`.
- `src/native.ts` — lazy memoized loader; throws `MediaProxyUnavailableError` (never at import).
- `src/queue.ts` — bounded queue; on overflow drops until the next keyframe (H.264) like coresim's.
- `src/framing/` — APST (mirrors the Android settings app's streaming-protocol) and MJPEG multipart/HTTP.
- `src/native/` — C++. `pipeline.{h,cc}` is pure FFmpeg (worker thread: HEVC decode → swscale → MJPEG encode,
  bounded input queue that drops to the next keyframe); `addon.cc` is the N-API/ThreadSafeFunction wrapper.
  Native errors set `err.name` to a typed error name; `wrapNativeError` re-types them.
- `scripts/ci/` (CI/build only, never shipped; the package `files` list must not include it): `build-ffmpeg.sh`, `bundle-libs.mjs`, `build-prebuilds.mjs`, `lint-cpp.sh`, `run.mjs` (shared spawn helper).
  Windows builds FFmpeg with MSVC under MSYS2 (arm64: no asm). Everything link-time lives in `binding.gyp` (`ffmpeg_dir`).
- `scripts/install.mjs` — never builds; only notes a missing prebuild (FFmpeg libs can't be built at install time).

## Rules

- `sequence` is assigned in JS; native passes `timestampMicros` (already rebased) through the pipeline.
- Options mirror coresim's `VideoStreamOptions`/`JpegStreamOptions` (names, defaults, `RangeError` rules);
  don't add Android-only options.
- Keep output shapes identical to coresim's `VideoAccessUnit`/`JpegFrame` (video track only).
- Never bundle or link GPL/nonfree FFmpeg components or x264. Only enable the FFmpeg components the pipeline uses.
- JS callbacks are held weakly by the native session; the handle's `callbacks` array owns them (keeps abandoned
  transcoders collectable). Env teardown shuts sessions down via a cleanup hook (releasing a tsfn from a finalizer deadlocks).
- `addon.cc` `Deliver` (thread-safe-function callback) uses raw N-API only: during worker termination calls fail and
  node-addon-api aborts the process building its C++ Error. Never throw or use `Napi::` throwing wrappers there.
- `MEDIA_PROXY_FFMPEG_LOG=<av log level>` turns FFmpeg's logging back on (off by default).
- Input is a live stream: never add unbounded buffering or blocking pushes; tests pace their input.
- No dependency on remotexpc or coresim; inputs are structural types.

## Not released yet

The package is `"private": true` and listed in `lerna.json` `ignoreChanges`, so lerna (and the
`detect-release-packages.mjs` gate built on it) never treats it as changed: merging changes here
triggers no release run, version bump, tag, or prebuild. To start releasing it: drop `"private"`,
remove the `ignoreChanges` entry, add it to `PREBUILT` in `scripts/detect-release-packages.mjs`,
and add a gated `prebuild-media-proxy` job plus artifact merge to `release.yml` (as for tuntap). Also host
the FFmpeg source tarball (see `THIRD_PARTY_NOTICES.md`) next to the release, per FFmpeg's legal checklist.
