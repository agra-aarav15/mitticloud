#!/data/data/com.termux/files/usr/bin/bash
# MittiCloud boot script -- meant to live in ~/.termux/boot/mitticloud-boot.sh
# (scripts/install.sh copies it there, makes it executable, and rewrites the
# MITTI_ROOT= line below to your absolute project root).

MITTI_ROOT="@MITTI_ROOT@"

# Fallback: if the placeholder was never rewritten (e.g. manual copy),
# resolve the project root relative to this script (scripts/boot.sh -> ..).
if [ "$MITTI_ROOT" = "@MITTI_ROOT@" ] || [ ! -d "$MITTI_ROOT" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
  MITTI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

# Keep Termux awake so Android does not freeze us in the background.
termux-wake-lock 2>/dev/null || true

cd "$MITTI_ROOT" || exit 1
mkdir -p data

# Start the server and the watchdog, detached from this script.
nohup node server/index.js >> data/server.log 2>&1 &
nohup bash scripts/watchdog.sh >> data/watchdog.log 2>&1 &
