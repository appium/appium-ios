# @appium/media-proxy

Cross-platform media transcoder that turns a device's native screen stream into the common format
already produced by `@appium/coresim` (simulators) and the Android settings app:

- **H.264**: Annex-B, 4-byte start codes, one picture per unit, no B-frames, SPS/PPS inline on every
  keyframe.
- **MJPEG**: one standalone JPEG per frame.
- **Audio** (optional, with H.264): the device's AAC-ELD re-encoded to ADTS-framed AAC-LC units, interleaved into the same
  sequence like coresim's `audio` option.

The primary input is the HEVC stream of `appium-ios-remotexpc`'s `ScreenStreamCapture`
(iOS 27+ real devices). Supported platforms: darwin, linux, win32 on x64 and arm64.

> **Status:** HEVC → MJPEG works on every platform (bundled LGPL FFmpeg, software decode). H.264 output works on
> macOS (VideoToolbox) and Windows (Media Foundation); everywhere else (and when those fail to open) it falls back to
> Cisco's OpenH264 once [installed by the client](#software-h264-openh264), and throws `MediaProxyEncoderUnavailableError` if it
> is not installed. Hardware encoders for Linux are still to come. The package is not released.

The input is treated as a **live stream**: the native side buffers at most 8 access units and, when
it falls behind, drops to the next keyframe instead of adding latency. Feeding a file faster than
real time therefore drops frames; pace it like a device does. After such a drop the pipeline waits for
the next keyframe (the device offers no way to request one), so a source that sends keyframes rarely
freezes until the next one.

## Usage

```ts
import {transcode, serveMjpeg} from '@appium/media-proxy';

const capture = await ScreenStreamCapture.start(display, {displayId: 1});

// H.264 (same shape as coresim's VideoAccessUnit)
for await (const unit of transcode(capture.accessUnits(), {codec: 'h264', fps: 60})) {}

// MJPEG over HTTP (multipart/x-mixed-replace)
const frames = transcode(capture.accessUnits(), {codec: 'mjpeg', quality: 80});
const server = await serveMjpeg(frames, {port: 0});
console.log(server.url);
```

Audio: pass `audio: true` and the audio source as the fourth argument (see [Audio](#audio)).

Lower level: `createTranscoder(opts)` returns a `Transcoder` with `push()`, `units()`, `end()`
(flush, then finish) and `close()` (stop consuming and discard output now; the promise resolves once the
native side has drained its few queued units and freed the codecs). Always call one of them.

## Building from source

The addon links a minimal LGPL FFmpeg (HEVC and AAC decoders, MJPEG and AAC encoders, swscale) pinned in
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
| `audio` (h264)       | false     | Also transcode the device audio, see [Audio](#audio)  |
| `audioSpecificConfig` (h264) | 480-sample ELD | `AudioSpecificConfig` of the pushed audio  |

Options, defaults and validation (`RangeError`) match coresim's `VideoStreamOptions` and
`JpegStreamOptions`. Android-only options (`resolution`, `localPort`, ...) are not supported.

## Audio

```ts
const audio = await AudioStreamCapture.start(display);
for await (const unit of transcode(capture.accessUnits(), {codec: 'h264', audio: true}, signal, audio.accessUnits())) {
  // unit.track is 'video' or 'audio'; audio units are ADTS AAC-LC (48 kHz stereo, 128 kbps), isKeyFrame always true
}
```

With `createTranscoder` call `pushAudio({data, timestamp, receivedAt})` next to `push()`. `sequence` counts per track;
`timestampMicros` is on one clock. Each track is rebased with its own RTP clock (90 kHz video, 48 kHz audio) and the tracks
are offset by when their first unit arrived (`receivedAt`, the `performance.now()` remotexpc stamps; the push time
otherwise), since remotexpc exposes no RTCP sender report to map the two clocks. The audio source ends with the video and a
failing audio source fails the stream. Audio is never dropped by a video resync.

The native `aac` decoder reads the device's AAC-ELD with its **480-sample** frames, which is why the default
`AudioSpecificConfig` differs from the one the device advertises (see remotexpc `aac-eld.ts`). A gap of lost packets up to
1 s is filled with silence so audio keeps its place on the clock; a longer one restarts the audio timeline. Added latency is
one AAC frame (1024 samples, ~21 ms) plus the ELD unit being waited for (≤ 10 ms). AAC is patent-encumbered like HEVC/H.264.

### Framing helpers

- `encodeApstFrame` / `ApstParser`: the Android settings app's "APST" wire protocol, so one client
  can consume both platforms.
- `formatMjpegPart` / `serveMjpeg`: MJPEG over HTTP; each client keeps only its newest unsent frame.
  `server.done` rejects if the frame source fails; clients connecting after the source ended get `410`.

## Software H.264 (OpenH264)

Without a hardware encoder (Linux, some VMs), H.264 uses Cisco's OpenH264. This package never bundles or
downloads it: **the client package (e.g. the driver) installs it and points `MEDIA_PROXY_OPENH264_PATH` at it**.
Without it, `createTranscoder({codec: 'h264'})` throws `MediaProxyEncoderUnavailableError`.

Each end user must fetch Cisco's signed binary from Cisco under
[Cisco's binary license](https://www.openh264.org/BINARY_LICENSE.txt) (that is what the patent grant covers), so do it on the
user's machine, on request, not at publish time:

1. Download `https://ciscobinary.openh264.org/<file>.bz2` for the platform (exactly **2.6.0**: the addon is built against
   that major.minor and refuses any other).
2. Verify the SHA-256 of the `.bz2`, then decompress it (`bunzip2`; Python's `bz2` works on Windows).
3. Store the library where it survives reinstalls, by convention
   `<APPIUM_HOME or ~/.appium>/media-proxy/openh264/2.6.0/<library>`.
4. Set `MEDIA_PROXY_OPENH264_PATH` to its full path in the process that uses this package, before the first H.264
   transcoder is created (it is read when an encoder opens).

| Platform      | File (`.bz2`)                         | Library name        | SHA-256 of the `.bz2`                                              |
| ------------- | ------------------------------------- | ------------------- | ------------------------------------------------------------------ |
| darwin-arm64  | `libopenh264-2.6.0-mac-arm64.dylib`   | `libopenh264.dylib` | `6db362ee5abdab572311aeadb96d3f44b0617d9a4a4b9f4db4cb5ac4d968da71` |
| darwin-x64    | `libopenh264-2.6.0-mac-x64.dylib`     | `libopenh264.dylib` | `38b2ed6d1d45b6a3e408c734173f2d67ab44a10d0e154ff3489b89877cd60e7e` |
| linux-arm64   | `libopenh264-2.6.0-linux-arm64.8.so`  | `libopenh264.so`    | `a78aea7970150f46bcd3bb7994c9e6dd90bd7a9ea785920f5a73f6964e3fcda7` |
| linux-x64     | `libopenh264-2.6.0-linux64.8.so`      | `libopenh264.so`    | `27ab53323c110b76214c1c72222f459d17febbcd1e252136cadc292b0308d75b` |
| win32-arm64   | `openh264-2.6.0-win-arm64.dll`        | `openh264.dll`      | `6b57d3ecd06bd80b5f3ee1abbb31d48798ca6d89ef1bc98cf2e6d1ebddf5cf45` |
| win32-x64     | `openh264-2.6.0-win64.dll`            | `openh264.dll`      | `dab5f2a872777f9a58b69bfa9fbcf20d9f82f2d6ec91383fd70bff49bd34ac9f` |

On Windows keep the `.dll` extension (the loader appends one otherwise). `scripts/ci/fetch-openh264.py` is the CI's
version of these steps. Set `MEDIA_PROXY_H264_ENCODER=libopenh264` (or `h264_videotoolbox`, `h264_mf`) to force one
encoder for diagnostics. OpenH264 output is multi-slice (one slice per core, up to 4; a frame too short for that falls back to one slice), tagged BT.709 limited range like the other encoders, and needs frames of at least 16×16.

## Performance

`node scripts/bench.mjs clip.h265 --codec h264 --seconds 60` paces a clip at 60 fps and reports output fps, added latency
(push to output) and RSS growth. On an M-series Mac with a 1170×2532 scrolling-UI clip (numbers vary ±30% between runs):

| Output                    | p50     | p95      | Notes                                                                      |
| ------------------------- | ------- | -------- | -------------------------------------------------------------------------- |
| MJPEG                     | ~5 ms   | ~6 ms    | software JPEG                                                              |
| H.264 VideoToolbox        | ~8 ms   | ~11 ms   | low-latency rate control; the first few frames after start-up may be dropped |
| H.264 OpenH264 (software) | ~15 ms  | ~20 ms   | needs ~4 cores; fast-changing content (video, games) can fall behind 60 fps  |

Audio (ELD → AAC-LC): p50 ~22 ms, p95 ~24 ms from the last input unit of a frame; negligible CPU.

RSS stays flat over a 60 s soak. The pipeline itself (decode, colour conversion) costs under 2 ms per frame, so latency is
the encoder's.

## Licensing

The package is Apache-2.0. The native addon links FFmpeg built **LGPL-only** (no `--enable-gpl`, no
`--enable-nonfree`), shipped as shared libraries next to the addon so it can be relinked. See
`THIRD_PARTY_NOTICES.md`. x264 is never bundled. H.264 uses the platform's encoder (VideoToolbox on macOS, Media Foundation on Windows: both system components). The software fallback uses Cisco's OpenH264,
which the client downloads at runtime (not redistributed by this package) to be covered by Cisco's patent grant.

Note that HEVC, H.264 and AAC are patent-encumbered formats; hardware codecs rely on the platform's
licenses, while software decode/encode carries none from this package.
