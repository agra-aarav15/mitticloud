#!/usr/bin/env bash
# MittiCloud watchdog -- keeps the server alive.
#
# Every 60 seconds:
#   - checks GET /api/health; if it fails, restarts the server the same way
#     boot.sh does (nohup node server/index.js >> data/server.log 2>&1 &)
#   - reads the battery via scripts/battery.sh; if level < 20% and not
#     charging, fires a Termux notification (best-effort)
#   - appends one status line to data/watchdog.log
#
# No `set -e` on purpose: this loop must survive failed checks forever.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
MITTI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PORT="${PORT:-7333}"
INTERVAL="${WATCHDOG_INTERVAL:-60}"

cd "$MITTI_ROOT" || exit 1
mkdir -p data

now() { date '+%Y-%m-%d %H:%M:%S'; }

health_ok() {
  if command -v curl >/dev/null 2>&1; then
    curl -sf --max-time 10 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1
  else
    # curl missing (rare in Termux) -- fall back to Node's built-in fetch.
    node -e "fetch('http://127.0.0.1:${PORT}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
  fi
}

node_process_running() {
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -f "node server/index.js" >/dev/null 2>&1
  elif command -v ps >/dev/null 2>&1; then
    # Termux ships toybox ps (-ef works); some environments only have pgrep.
    ps -ef 2>/dev/null | grep -F "node server/index.js" | grep -vF grep >/dev/null 2>&1
  else
    return 1
  fi
}

start_server() {
  nohup node server/index.js >> data/server.log 2>&1 &
}

while true; do
  if health_ok; then
    state="up"
  else
    state="down"
    echo "$(now) server down -- restarting"
    if node_process_running; then
      echo "$(now) node process exists but is not answering yet; waiting one more cycle"
    else
      start_server
      sleep 15   # let node boot before the next health check
    fi
  fi

  # ---- battery check (best-effort, via battery.sh) ----
  battery_json="$(bash "$MITTI_ROOT/scripts/battery.sh" 2>/dev/null || true)"
  [ -z "$battery_json" ] && battery_json='{ "level": -1, "charging": false, "temperature": null, "mocked": true }'

  level="$(printf '%s' "$battery_json" \
    | grep -oE '"level"[[:space:]]*:[[:space:]]*-?[0-9]+' | head -n 1 \
    | grep -oE -e '-?[0-9]+$' || true)"
  charging="$(printf '%s' "$battery_json" \
    | grep -oE '"charging"[[:space:]]*:[[:space:]]*(true|false)' | head -n 1 \
    | grep -oE -e '(true|false)$' || true)"
  level="${level:--1}"
  charging="${charging:-false}"

  if [ "$level" -ge 0 ] && [ "$level" -lt 20 ] && [ "$charging" != "true" ]; then
    if command -v termux-notification >/dev/null 2>&1; then
      termux-notification --title "MittiCloud" \
        --content "Battery below 20% -- plug in the charger." >/dev/null 2>&1 || true
    fi
  fi

  battery_disp="${level}%"
  [ "$level" -lt 0 ] && battery_disp="unknown"

  echo "$(now) battery=${battery_disp} charging=${charging} server=${state}" >> data/watchdog.log

  sleep "$INTERVAL"
done
