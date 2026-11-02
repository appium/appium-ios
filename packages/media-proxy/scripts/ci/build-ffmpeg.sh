#!/usr/bin/env bash
# Builds the minimal LGPL-only FFmpeg shared libs into third_party/ffmpeg/<platform>-<arch> (or $FFMPEG_PREFIX).
# Env: TARGET_ARCH (x64|arm64). On Windows run under MSYS2 with MSVC on PATH.
set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-8.1.3}"
FFMPEG_SHA256="${FFMPEG_SHA256:-7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3}"

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
case "$(uname -s)" in
  Darwin) PLATFORM=darwin ;;
  Linux) PLATFORM=linux ;;
  MINGW* | MSYS* | CYGWIN*) PLATFORM=win32 ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
norm_arch() {
  case "$1" in
    x86_64 | amd64 | x64) echo x64 ;;
    arm64 | aarch64) echo arm64 ;;
    *) echo "unsupported arch: $1" >&2; exit 1 ;;
  esac
}
HOST_ARCH="$(norm_arch "$(uname -m)")"
ARCH="$(norm_arch "${TARGET_ARCH:-$(uname -m)}")"

PREFIX="${FFMPEG_PREFIX:-$PKG_DIR/third_party/ffmpeg/$PLATFORM-$ARCH}"
WORK="${FFMPEG_WORKDIR:-$PKG_DIR/third_party/.build/$PLATFORM-$ARCH}"
JOBS="${JOBS:-$( (nproc || sysctl -n hw.ncpu) 2>/dev/null || echo 4)}"
TARBALL="ffmpeg-$FFMPEG_VERSION.tar.xz"

# Part of the marker, so editing this recipe (flags, patches) rebuilds even without a version bump.
if command -v sha256sum >/dev/null; then
  RECIPE_HASH="$(sha256sum "${BASH_SOURCE[0]}" | cut -c1-12)"
else
  RECIPE_HASH="$(shasum -a 256 "${BASH_SOURCE[0]}" | cut -c1-12)"
fi
MARKER="$PREFIX/.built-$FFMPEG_VERSION-$RECIPE_HASH"
if [ -f "$MARKER" ] && [ -z "${FORCE:-}" ]; then
  echo "FFmpeg $FFMPEG_VERSION already built in $PREFIX (FORCE=1 to rebuild)"
  exit 0
fi

mkdir -p "$WORK"
cd "$WORK"
if [ ! -f "$TARBALL" ]; then
  curl -fsSL --retry 3 -o "$TARBALL" "https://ffmpeg.org/releases/$TARBALL"
fi
if command -v sha256sum >/dev/null; then
  ACTUAL="$(sha256sum "$TARBALL" | cut -d' ' -f1)"
else
  ACTUAL="$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)"
fi
if [ "$ACTUAL" != "$FFMPEG_SHA256" ]; then
  echo "checksum mismatch for $TARBALL: expected $FFMPEG_SHA256, got $ACTUAL" >&2
  rm -f "$TARBALL"
  exit 1
fi
rm -rf "ffmpeg-$FFMPEG_VERSION"
tar xf "$TARBALL"
cd "ffmpeg-$FFMPEG_VERSION"

# Only what the transcoder needs: HEVC decode, MJPEG encode, swscale, AAC (ELD in, LC out). No GPL/nonfree parts.
ARGS=(
  --prefix="$PREFIX"
  --disable-everything --disable-autodetect --disable-programs --disable-doc --disable-debug
  --disable-network --disable-avdevice --disable-avformat --disable-avfilter --disable-swresample
  --disable-gpl --disable-nonfree --disable-version3
  --enable-shared --disable-static --enable-pic
  # Private library names (libavcodec-appium...): never shadowed by, or confused with, another FFmpeg in the process.
  --build-suffix=-appium
  --enable-avcodec --enable-avutil --enable-swscale
  --enable-decoder=hevc,aac --enable-parser=hevc
  --enable-encoder=mjpeg,aac
)

case "$PLATFORM" in
  darwin)
    # Dylibs resolve siblings via the addon's rpath (@loader_path).
    ARGS+=(--install-name-dir='@rpath' --extra-ldflags="-mmacosx-version-min=12.0" --extra-cflags="-mmacosx-version-min=12.0")
    if [ "$ARCH" != "$HOST_ARCH" ]; then
      CLANG_ARCH=$([ "$ARCH" = x64 ] && echo x86_64 || echo arm64)
      ARGS+=(--enable-cross-compile --target-os=darwin --arch="$CLANG_ARCH"
        --extra-cflags="-arch $CLANG_ARCH" --extra-ldflags="-arch $CLANG_ARCH")
    fi
    ;;
  linux)
    # '$$ORIGIN': make turns $$ into $, and the quotes keep the shell from expanding it.
    ARGS+=(--extra-ldflags="-Wl,-rpath,'\$\$ORIGIN'")
    ;;
  win32)
    # MSVC toolchain (cl/link on PATH, e.g. from vcvars) driven from MSYS2.
    ARGS+=(--toolchain=msvc)
    if [ "$ARCH" = arm64 ]; then
      # No NEON asm: it needs armasm64/gas-preprocessor, which the MSVC toolchain here lacks.
      ARGS+=(--enable-cross-compile --target-os=win32 --arch=aarch64 --disable-asm)
    fi
    ;;
esac
if [ "$ARCH" = "x64" ] && ! command -v nasm >/dev/null; then
  echo "nasm is required to build the x86-64 assembly optimizations (brew/apt/choco install nasm)" >&2
  exit 1
fi

# A stale install (older recipe or version) must not leak into the new one.
rm -rf "$PREFIX/include" "$PREFIX/lib" "$PREFIX/bin" "$PREFIX/share"

./configure "${ARGS[@]}"
make -j"$JOBS"
make install
cp COPYING.LGPLv2.1 "$PREFIX/"
if [ "$PLATFORM" = linux ]; then
  readelf -d "$PREFIX/lib/libavcodec-appium.so" | grep -E 'RUNPATH|RPATH' | grep -q 'ORIGIN' \
    || { echo "libavcodec-appium.so has no \$ORIGIN rpath" >&2; exit 1; }
fi
if [ "$PLATFORM" = win32 ]; then
  # MSVC builds install the import libs (avcodec.lib, ...) next to the DLLs; link.exe looks in lib/.
  for f in "$PREFIX"/bin/*.lib; do cp "$f" "$PREFIX/lib/"; done
fi
rm -f "$PREFIX"/.built-*
echo "$FFMPEG_VERSION" >"$MARKER"
{
  echo "FFmpeg $FFMPEG_VERSION (LGPL-2.1+, --disable-gpl --disable-nonfree), source: https://ffmpeg.org/releases/$TARBALL"
  echo "sha256 $FFMPEG_SHA256"
  printf 'configure --prefix=<prefix>'
  printf ' %q' "${ARGS[@]:1}"
  echo
} >"$PREFIX/.built-info"
echo "FFmpeg $FFMPEG_VERSION installed in $PREFIX"
