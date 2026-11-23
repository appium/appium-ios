#!/usr/bin/env bash
# Usage: watch.sh <udid> <label-list>
udid="$1"; list="$2"

bootout_all() {
  while read -r label; do
    [[ -n $label ]] && xcrun simctl spawn "$udid" launchctl bootout "system/$label" >/dev/null 2>&1
  done < "$list"
  xcrun simctl spawn "$udid" killall diagnosticd >/dev/null 2>&1
}

for _ in $(seq 1 450); do   # up to 15 min for the device to boot
  if xcrun simctl spawn "$udid" launchctl list >/dev/null 2>&1; then
    sleep 20; bootout_all; echo "pass 1 done"
    sleep 40; bootout_all; echo "pass 2 done"
    exit 0
  fi
  sleep 2
done
echo "device $udid never booted"
