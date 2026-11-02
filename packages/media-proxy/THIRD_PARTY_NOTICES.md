# Third-party notices

## FFmpeg

Prebuilds ship FFmpeg's libavcodec, libavutil and libswscale as shared libraries, built with
`--disable-gpl --disable-nonfree --disable-version3` (HEVC and AAC decoders, MJPEG and AAC encoders, and swscale only; the AAC encoder is FFmpeg's own, not FDK)
and licensed under the GNU LGPL v2.1 or later.

- Version: 8.1.3, source https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz
  (sha256 `7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3`).
- The libraries are built with `--build-suffix=-appium` (e.g. `libavcodec-appium.so.62`) so they can't be
  confused with, or replaced by, another FFmpeg loaded in the same process.
- The licence text ships beside the libraries as `ffmpeg-LICENSE-LGPL-2.1.txt`.
- The recipe is `scripts/ci/build-ffmpeg.sh` (in the repository, not in the npm package); each prebuild also carries `ffmpeg-build-info.txt` with the
  exact `configure` line. FFmpeg is built unmodified.
- The libraries are dynamically linked and sit next to the addon, so they can be replaced with a
  modified build of the same version (rebuild with the script above and copy the libraries over).

## Platform frameworks

H.264 encoding on macOS calls Apple's VideoToolbox system framework, and on Windows the Media Foundation H.264
encoder installed with the OS. Nothing from either is bundled or redistributed.

## OpenH264 (optional, installed by the client at runtime)

Cisco's OpenH264 is BSD-2-Clause. It is not redistributed in this package: the client package fetches the binary
from Cisco (see the README) to remain under Cisco's AVC/H.264 patent portfolio license. Only its BSD-2-Clause
headers (`src/native/vendor/openh264`, v2.6.0) are included here; the library is loaded with `dlopen`/`LoadLibrary`
from `$MEDIA_PROXY_OPENH264_PATH`.
