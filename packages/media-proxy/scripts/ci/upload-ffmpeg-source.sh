#!/usr/bin/env bash
# Attaches the pinned FFmpeg source tarball to a GitHub release (LGPL: the source accompanies the binaries).
# Usage: upload-ffmpeg-source.sh <release tag>   (needs GH_TOKEN)
set -euo pipefail

TAG="${1:?usage: upload-ffmpeg-source.sh <release tag>}"
RECIPE="$(dirname "${BASH_SOURCE[0]}")/build-ffmpeg.sh"

# Read the pins from the build recipe so the two can't drift apart.
pin() { sed -n "s/^$1=\"\${$1:-\(.*\)}\"\$/\1/p" "$RECIPE"; }
VERSION="$(pin FFMPEG_VERSION)"
SHA256="$(pin FFMPEG_SHA256)"
[ -n "$VERSION" ] && [ -n "$SHA256" ] || { echo "could not read the FFmpeg pins from $RECIPE" >&2; exit 1; }

TARBALL="ffmpeg-$VERSION.tar.xz"
WORKDIR="$(mktemp -d)"
curl -fsSL --retry 3 -o "$WORKDIR/$TARBALL" "https://ffmpeg.org/releases/$TARBALL"
ACTUAL="$(sha256sum "$WORKDIR/$TARBALL" | cut -d' ' -f1)"
if [ "$ACTUAL" != "$SHA256" ]; then
  echo "checksum mismatch for $TARBALL: expected $SHA256, got $ACTUAL" >&2
  exit 1
fi

gh release upload "$TAG" "$WORKDIR/$TARBALL" --clobber --repo "$GITHUB_REPOSITORY"
