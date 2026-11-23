#!/usr/bin/env bash
# Usage: slim.sh <platform> <model> <version>
# Best effort: never fails the job.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
platform="$1"; model="$2"; version="$3"
runtime="com.apple.CoreSimulator.SimRuntime.${platform}-${version//./-}"

udid="$(xcrun simctl list devices available -j | jq -r --arg rt "$runtime" --arg name "$model" \
  '.devices[$rt] // [] | map(select(.name == $name)) | first | .udid // empty')"
if [[ -z $udid ]]; then
  echo "::warning::slim-simulator: no '$model' ($runtime) found, skipping"
  exit 0
fi

# Jobs listed here are never started by launchd_sim (effective only until the device is erased)
dir="$HOME/Library/Developer/CoreSimulator/Devices/$udid/data/var/db/com.apple.xpc.launchd"
mkdir -p "$dir"
python3 - "$here/disable-list.txt" "$dir/disabled.plist" <<'PY'
import plistlib, sys
labels = [l.strip() for l in open(sys.argv[1]) if l.strip()]
with open(sys.argv[2], "wb") as f:
    plistlib.dump({l: True for l in labels}, f)
PY

sudo launchctl unload -w /System/Library/LaunchDaemons/com.apple.diagnosticd.plist >/dev/null 2>&1 || true

# The device is booted later by another step (simulator-action / xcodebuild): wait for it, then
# boot out what the plist did not stop. Second pass catches respawns.
nohup bash "$here/watch.sh" "$udid" "$here/disable-list.txt" > "${RUNNER_TEMP:-/tmp}/slim-simulator.log" 2>&1 &
disown
echo "slim-simulator: preseeded $udid ($model $version), watcher started"
