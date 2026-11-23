#!/usr/bin/env bash
# Usage: watch.sh <udid> <label-list>
udid="$1"; list="$2"

bootout_all() {
  while read -r label; do
    [[ -n $label ]] && xcrun simctl spawn "$udid" launchctl bootout "system/$label" >/dev/null 2>&1
  done < "$list"
  xcrun simctl spawn "$udid" killall diagnosticd >/dev/null 2>&1
}

# Without -b this only waits (also for a device that is not booted yet) until boot completes
xcrun simctl bootstatus "$udid" >/dev/null 2>&1
bootout_all; echo "pass 1 done"
sleep 40; bootout_all; echo "pass 2 done"   # catch respawns
