#!/usr/bin/env bash
# battery.sh -- print the phone's battery status as normalized one-line JSON.
#
# Output shape (this exact format is what watchdog.sh parses):
#   real :  { "level": 85, "charging": true, "temperature": 28.4, "mocked": false }
#   mock :  { "level": -1, "charging": false, "temperature": null, "mocked": true }
#
# Pure grep/sed -- no jq, no python. Safe to run on desktop (returns the mock).
# Exit code is always 0 unless something catastrophic happens.

set -u

mock() {
  echo '{ "level": -1, "charging": false, "temperature": null, "mocked": true }'
}

if ! command -v termux-battery-status >/dev/null 2>&1; then
  mock
  exit 0
fi

# timeout guard: termux-battery-status can hang if the Termux:API app is
# installed but unresponsive. `timeout` ships with coreutils (Termux has it;
# other platforms usually do too).
if command -v timeout >/dev/null 2>&1; then
  raw="$(timeout 10 termux-battery-status 2>/dev/null || true)"
else
  raw="$(termux-battery-status 2>/dev/null || true)"
fi

if [ -z "$raw" ]; then
  mock
  exit 0
fi

# --- level: "level": <int> ---
level="$(printf '%s' "$raw" \
  | grep -oE '"level"[[:space:]]*:[[:space:]]*-?[0-9]+' | head -n 1 \
  | grep -oE -e '-?[0-9]+$' || true)"
if [ -z "$level" ]; then
  level=-1
fi

# --- temperature: "temperature": <float> or null ---
temp="$(printf '%s' "$raw" \
  | grep -oE '"temperature"[[:space:]]*:[[:space:]]*-?[0-9]+(\.[0-9]+)?' | head -n 1 \
  | grep -oE -e '-?[0-9]+(\.[0-9]+)?$' || true)"
if [ -z "$temp" ]; then
  temp="null"
fi

# --- charging: boolean ---
# Newer Termux:API versions emit "charging": true|false directly. Older ones
# don't -- fall back to "status":"CHARGING" or a plugged-in "plugged" value.
charging="false"
if printf '%s' "$raw" | grep -qE '"charging"[[:space:]]*:[[:space:]]*true'; then
  charging="true"
elif printf '%s' "$raw" | grep -qE '"status"[[:space:]]*:[[:space:]]*"CHARGING"'; then
  charging="true"
elif printf '%s' "$raw" | grep -qE '"plugged"[[:space:]]*:[[:space:]]*"PLUGGED'; then
  charging="true"
fi

echo "{ \"level\": $level, \"charging\": $charging, \"temperature\": $temp, \"mocked\": false }"
exit 0
