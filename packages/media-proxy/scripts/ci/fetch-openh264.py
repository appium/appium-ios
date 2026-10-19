#!/usr/bin/env python3
"""CI only: fetches Cisco's OpenH264 for this runner into $MEDIA_PROXY_OPENH264_PATH (checked against a pinned SHA-256)."""
import bz2
import hashlib
import os
import platform
import sys
import urllib.request

BASE_URL = "https://ciscobinary.openh264.org"
# keyed by (system, machine): remote file name (without .bz2) and the SHA-256 of the .bz2
ASSETS = {
    ("Darwin", "arm64"): ("libopenh264-2.6.0-mac-arm64.dylib", "6db362ee5abdab572311aeadb96d3f44b0617d9a4a4b9f4db4cb5ac4d968da71"),
    ("Darwin", "x86_64"): ("libopenh264-2.6.0-mac-x64.dylib", "38b2ed6d1d45b6a3e408c734173f2d67ab44a10d0e154ff3489b89877cd60e7e"),
    ("Linux", "aarch64"): ("libopenh264-2.6.0-linux-arm64.8.so", "a78aea7970150f46bcd3bb7994c9e6dd90bd7a9ea785920f5a73f6964e3fcda7"),
    ("Linux", "x86_64"): ("libopenh264-2.6.0-linux64.8.so", "27ab53323c110b76214c1c72222f459d17febbcd1e252136cadc292b0308d75b"),
    ("Windows", "ARM64"): ("openh264-2.6.0-win-arm64.dll", "6b57d3ecd06bd80b5f3ee1abbb31d48798ca6d89ef1bc98cf2e6d1ebddf5cf45"),
    ("Windows", "AMD64"): ("openh264-2.6.0-win64.dll", "dab5f2a872777f9a58b69bfa9fbcf20d9f82f2d6ec91383fd70bff49bd34ac9f"),
}

def fetch(target: str) -> None:
    if os.path.exists(target):
        return
    name, sha256 = ASSETS[(platform.system(), platform.machine())]
    data = urllib.request.urlopen(f"{BASE_URL}/{name}.bz2", timeout=120).read()
    if hashlib.sha256(data).hexdigest() != sha256:
        raise SystemExit(f"{name}.bz2 failed its SHA-256 check")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "wb") as out:
        out.write(bz2.decompress(data))
    os.chmod(target, 0o755)


def main() -> None:
    target = os.environ.get("MEDIA_PROXY_OPENH264_PATH")
    if not target:
        raise SystemExit("MEDIA_PROXY_OPENH264_PATH is not set")
    if (platform.system(), platform.machine()) not in ASSETS:
        raise SystemExit(f"No OpenH264 build for {platform.system()} {platform.machine()}")
    fetch(target)


if __name__ == "__main__":
    main()
