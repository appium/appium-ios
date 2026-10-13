# CLAUDE.md — @appium/media-proxy

HEVC (remotexpc) → H.264 / MJPEG transcoder in the common coresim/Android format. N-API addon over
an LGPL-only FFmpeg build; TS wrapper under `src/`.

## Commands

- `npm run build` — `tsc -b` (also runs on `npm install` via `prepare`)
- `npm run build:addon` — `node-gyp rebuild` (local addon in `build/Release`, picked up by node-gyp-build)
- `npm run build:prebuilds` — `prebuildify --napi --strip` (CI)
- `npm run test:unit` — pure TS, fake native backend, no addon needed
- `npm run test:integration` — needs the addon (`build:addon` first)
- `npm run format:cpp:check` / `lint:cpp` — clang-format / clang-tidy over `src/native`

## Layout

- `src/transcoder.ts` — option validation/defaults, `TimestampConverter` (RTP 32-bit unwrap → µs),
  `Transcoder` (takes an injectable `NativeModule`, which is how unit tests run), `transcode()`.
- `src/native.ts` — lazy memoized loader; throws `MediaProxyUnavailableError` (never at import).
- `src/queue.ts` — bounded queue; on overflow drops until the next keyframe (H.264) like coresim's.
- `src/framing/` — APST (mirrors the Android settings app's streaming-protocol) and MJPEG multipart/HTTP.
- `src/native/` — C++. Native errors set `err.name` to a typed error name; `wrapNativeError` re-types them.
- `scripts/install.mjs` — never builds; only notes a missing prebuild (FFmpeg libs can't be built at install time).

## Rules

- `sequence` is assigned in JS; native passes `timestampMicros` (already rebased) through the pipeline.
- Keep output shapes identical to coresim's `VideoAccessUnit`/`JpegFrame` (+ `isConfig`).
- Never bundle or link GPL/nonfree FFmpeg components or x264.
- No dependency on remotexpc or coresim; inputs are structural types.
