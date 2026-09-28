#!/usr/bin/env bash
# Seeds a path-based kTCCServiceAudioCapture ("System Audio Recording Only") grant for the given
# binary into the host's TCC databases, so CI exercises the real (not permission-denied) audio-
# capture path (see CLAUDE.md, sim_audio_tap.mm).
#
# Only works where SIP is disabled (GitHub-hosted macOS images have been since macos-13) — that's
# what normally makes TCC.db unwritable even as root. Mirrors appium-mac2-driver's
# scripts/ci/grant-accessibility.sh, except the grant targets the Node.js binary itself (the
# addon runs in-process, not via a signed .app bundle).
#
# Seeds both TCC databases (system-wide and per-user) since which one macOS actually consults for
# this service isn't documented — harmless either way.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <absolute-path-to-node-binary>" >&2
  exit 1
fi

target_path="$1"

if [[ ! -f "$target_path" ]]; then
  echo "::warning::grant-audio-capture.sh: no file at '$target_path', skipping grant" >&2
  exit 0
fi

# Escaped for the single-quoted SQL literal below (doubling any embedded quote) — the calling
# runner isn't guaranteed to be one of GitHub's own hosted images.
escaped_path="${target_path//\'/\'\'}"

seed_db() {
  local db="$1"
  if [[ ! -f "$db" ]]; then
    return 0
  fi
  # tccd itself has this database open and can hold a brief lock — busy_timeout makes sqlite3
  # wait for it instead of failing immediately with "database is locked"; the outer retry loop is
  # extra insurance for a lock that outlasts even that.
  local attempt
  for attempt in 1 2 3; do
    if sudo sqlite3 -cmd 'PRAGMA busy_timeout=5000' "$db" <<SQL
INSERT OR REPLACE INTO access
  (service, client, client_type, auth_value, auth_reason, auth_version,
   indirect_object_identifier, flags, last_modified)
VALUES
  ('kTCCServiceAudioCapture', '${escaped_path}', 1, 2, 3, 1,
   'UNUSED', 0, CAST(strftime('%s', 'now') AS INTEGER));
SQL
    then
      return 0
    fi
    echo "::warning::grant-audio-capture.sh: sqlite3 write to '$db' failed (attempt $attempt/3), retrying" >&2
    sleep 2
  done
  echo "::warning::grant-audio-capture.sh: giving up writing to '$db' after 3 attempts — audio-capture tests will fall back to t.skip()" >&2
  return 1
}

granted=true
seed_db "/Library/Application Support/com.apple.TCC/TCC.db" || granted=false
seed_db "$HOME/Library/Application Support/com.apple.TCC/TCC.db" || granted=false

sudo launchctl kickstart -k system/com.apple.tccd 2>/dev/null || sudo pkill -HUP tccd || true
pkill -HUP tccd 2>/dev/null || true # the per-user tccd instance, distinct from the system one above

if [[ "$granted" == true ]]; then
  echo "Granted kTCCServiceAudioCapture to $target_path"
else
  echo "::warning::grant-audio-capture.sh: at least one TCC database write failed — audio-capture tests will fall back to t.skip()" >&2
fi
