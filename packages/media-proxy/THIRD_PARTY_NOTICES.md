# Third-party notices

## FFmpeg (planned, not yet bundled)

Prebuilds will ship FFmpeg's libavcodec, libavutil and libswscale as shared libraries, built with
`--disable-gpl --disable-nonfree` and licensed under the GNU LGPL v2.1 or later.

- Source: https://ffmpeg.org/releases/ (exact version, tarball sha256 and `configure` flags will be
  pinned in `scripts/build-ffmpeg.sh` and listed here at release time).
- The libraries are dynamically linked, so they can be replaced with a modified build.
- The unmodified FFmpeg source corresponding to each release is available from the URL above.

## OpenH264 (optional, downloaded at runtime)

Cisco's OpenH264 is BSD-2-Clause. It is not redistributed in this package: the binary is fetched
from Cisco on request (`ensureOpenH264`, planned) to remain under Cisco's AVC/H.264 patent portfolio license.
