# @appium/media-proxy

Cross-platform media transcoder that turns a device's native screen stream into the common format
already produced by `@appium/coresim` (simulators) and the Android settings app:

- **H.264**: Annex-B, 4-byte start codes, one picture per unit, no B-frames, SPS/PPS inline on every
  keyframe.
- **MJPEG**: one standalone JPEG per frame.

The primary input is the HEVC stream of `appium-ios-remotexpc`'s `ScreenStreamCapture`
(iOS 27+ real devices). Supported platforms: darwin, linux, win32 on x64 and arm64.

> **Status:** HEVC → MJPEG works on a bundled LGPL FFmpeg (software decode). H.264 output is not
> built yet: `codec: 'h264'` throws `MediaProxyEncoderUnavailableError`. The package is not released.

The input is treated as a **live stream**: the native side buffers at most 8 access units and, when
it falls behind, drops to the next keyframe instead of adding latency. Feeding a file faster than
real time therefore drops frames; pace it like a device does.

## Usage

```ts
import {transcode, serveMjpeg} from '@appium/media-proxy';

const capture = await ScreenStreamCapture.start(display, {displayId: 1});

// H.264 (same shape as coresim's VideoAccessUnit) - not available yet
// for await (const unit of transcode(capture.accessUnits(), {codec: 'h264', fps: 60})) {}

// MJPEG over HTTP (multipart/x-mixed-replace)
const frames = transcode(capture.accessUnits(), {codec: 'mjpeg', quality: 80});
const server = await serveMjpeg(frames, {port: 0});
console.log(server.url);
```

Lower level: `createTranscoder(opts)` returns a `Transcoder` with `push()`, `units()`, `end()`
(flush, then finish) and `close()` (stop now).

## Building from source

The addon links a minimal LGPL FFmpeg (HEVC decoder, MJPEG encoder, swscale) pinned in
`scripts/ci/build-ffmpeg.sh`; there is no system FFmpeg dependency.

```sh
npm run build:ffmpeg   # once per platform/arch (needs nasm on x64; Windows: MSVC under MSYS2)
npm run build:addon    # links it and copies the libs next to the addon
npm run test:integration
node scripts/bench.mjs clip.h265 --seconds 10   # real-time fps / latency report
```

`npm run build:prebuilds` produces `prebuilds/<platform>-<arch>/` with the addon plus the FFmpeg
libs it needs (and `ffmpeg-build-info.txt`, the exact `configure` line).

| Option               | Default   | Notes                                                 |
| -------------------- | --------- | ----------------------------------------------------- |
| `codec`              | required  | `'h264'` or `'mjpeg'`                                 |
| `fps`                | 60        | Finite, >= 1. Upper bound; the input is variable-rate |
| `bitrate` (h264)     | 4,000,000 | bits/sec, > 0 and <= 2^31-1                           |
| `quality` (mjpeg)    | 80        | 0-100                                                 |
| `scale` (mjpeg)      | 100       | Percent of the source resolution, > 0 and <= 100      |

Options, defaults and validation (`RangeError`) match coresim's `VideoStreamOptions` and
`JpegStreamOptions`. Android-only options (`resolution`, `localPort`, audio, ...) are not supported.

### Framing helpers

- `encodeApstFrame` / `ApstParser`: the Android settings app's "APST" wire protocol, so one client
  can consume both platforms.
- `formatMjpegPart` / `serveMjpeg`: MJPEG over HTTP; each client keeps only its newest unsent frame.
  `server.done` rejects if the frame source fails; clients connecting after the source ended get `410`.

## Licensing

The package is Apache-2.0. The native addon links FFmpeg built **LGPL-only** (no `--enable-gpl`, no
`--enable-nonfree`), shipped as shared libraries next to the addon so it can be relinked. See
`THIRD_PARTY_NOTICES.md`. x264 is never bundled. A software H.264 fallback (planned) will use Cisco's OpenH264,
which must be downloaded at runtime (not redistributed) to be covered by Cisco's patent grant.

Note that HEVC and H.264 are patent-encumbered formats; hardware codecs rely on the platform's
licenses, while software decode/encode carries none from this package.
