# @appium/media-proxy

Cross-platform media transcoder that turns a device's native screen stream into the common format
already produced by `@appium/coresim` (simulators) and the Android settings app:

- **H.264**: Annex-B, 4-byte start codes, one picture per unit, no B-frames, SPS/PPS inline on every
  keyframe (plus an `isConfig` unit at start and after a resolution change).
- **MJPEG**: one standalone JPEG per frame.

The primary input is the HEVC stream of `appium-ios-remotexpc`'s `ScreenStreamCapture`
(iOS 27+ real devices). Supported platforms: darwin, linux, win32 on x64 and arm64.

> **Status:** the TypeScript API, APST/MJPEG framing helpers, CI and packaging are in place. The
> FFmpeg-backed native pipeline is still being built, so `createTranscoder()` currently throws
> `MediaProxyEncoderUnavailableError`.

## Usage

```ts
import {transcode, serveMjpeg} from '@appium/media-proxy';

const capture = await ScreenStreamCapture.start(display, {displayId: 1});

// H.264 (same shape as coresim's VideoAccessUnit, plus `isConfig`)
for await (const unit of transcode(capture.accessUnits(), {output: {codec: 'h264', fps: 60}})) {
  // unit.data is Annex-B, unit.isKeyFrame, unit.timestampMicros, ...
}

// MJPEG over HTTP (multipart/x-mixed-replace)
const frames = transcode(capture.accessUnits(), {output: {codec: 'mjpeg', quality: 80}});
const server = await serveMjpeg(frames, {port: 0});
console.log(server.url);
```

Lower level: `createTranscoder(opts)` returns a `Transcoder` with `push()`, `units()`,
`requestKeyFrame()`, `stats`, `encoderName` and `close()`.

| Option                         | Default   | Notes                                           |
| ------------------------------ | --------- | ----------------------------------------------- |
| `output.fps`                   | 60        | Upper bound; the input is variable-rate        |
| `output.bitrate` (h264)        | 4,000,000 | bits/sec                                        |
| `output.quality` (mjpeg)       | 80        | 1-100                                           |
| `output.scale`                 | 100       | Percent of the source resolution, (0, 100]      |
| `input.clockRate`              | 90000     | Ticks/sec of `timestamp`, or `'receivedAt'`     |
| `hardwareAcceleration`         | `'auto'`  | `'auto'` \| `'off'` \| `'required'`             |

### Framing helpers

- `encodeApstFrame` / `ApstParser`: the Android settings app's "APST" wire protocol, so one client
  can consume both platforms.
- `formatMjpegPart` / `serveMjpeg`: MJPEG over HTTP; each client keeps only its newest unsent frame.

## Licensing

The package is Apache-2.0. The native addon links FFmpeg built **LGPL-only** (no `--enable-gpl`, no
`--enable-nonfree`), shipped as shared libraries next to the addon so it can be relinked. See
`THIRD_PARTY_NOTICES.md`. x264 is never bundled. A software H.264 fallback (planned) uses Cisco's OpenH264,
which must be downloaded at runtime (not redistributed) to be covered by Cisco's patent grant.

Note that HEVC and H.264 are patent-encumbered formats; hardware codecs rely on the platform's
licenses, while software decode/encode carries none from this package.
