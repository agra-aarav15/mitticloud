#!/usr/bin/env bash
# MittiCloud installer for Termux (Android).
#
#   Normal use (inside Termux):   bash scripts/install.sh
#   Desktop dry-run (dev only):   MITTI_FORCE=1 bash scripts/install.sh
#
# What it does: installs Node.js, creates vault/ + data/, installs server
# dependencies, takes a wake-lock, and wires up boot auto-start if the
# Termux:Boot app is installed.

set -euo pipefail

# ------------------------------------------------------------- resolve root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
MITTI_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$MITTI_ROOT/package.json" ]; then
  echo "ERROR: could not find the MittiCloud project root (looked at: $MITTI_ROOT)."
  echo "       Run this from inside the cloned repo:  bash scripts/install.sh"
  exit 1
fi

line() { echo "------------------------------------------------------------"; }

# ------------------------------------------------------------ termux check
is_termux=false
case "${PREFIX:-}" in
  *com.termux*) is_termux=true ;;
  *) command -v termux-info >/dev/null 2>&1 && is_termux=true ;;
esac

if [ "$is_termux" = true ]; then
  line
  echo "Termux detected. Installing MittiCloud..."
elif [ "${MITTI_FORCE:-0}" = "1" ]; then
  line
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "!!  WARNING: MITTI_FORCE=1 -- this is NOT Termux.          !!"
  echo "!!  Continuing anyway for a desktop dry-run.               !!"
  echo "!!  Termux-only steps (wake-lock, boot, battery, API)      !!"
  echo "!!  will be skipped or degrade to mocks.                   !!"
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
else
  line
  echo "ERROR: this installer is meant to run inside Termux on Android."
  echo "       Open the Termux app and run:  bash scripts/install.sh"
  echo "       (Desktop devs: dry-run with  MITTI_FORCE=1 bash scripts/install.sh )"
  exit 1
fi

line
echo "Project root: $MITTI_ROOT"
echo ""

# ------------------------------------------------------------ storage note
if [ ! -d "$HOME/storage" ]; then
  echo "NOTE: ~/storage is missing."
  echo "      If you want Termux to reach your gallery/downloads later,"
  echo "      run:  termux-setup-storage   (then tap 'Allow')."
  echo "      This is optional -- MittiCloud works fine without it."
  echo ""
fi

# ---------------------------------------------------------------- packages
if command -v pkg >/dev/null 2>&1; then
  echo "[1/6] Updating packages (this can take a minute)..."
  if ! pkg update -y; then
    echo "      pkg update returned an error -- trying to continue anyway."
  fi
  echo "[2/6] Installing nodejs-lts and git..."
  pkg install -y nodejs-lts git
else
  echo "[1/6] 'pkg' not found -- skipping package install (desktop dry-run?)."
  echo "[2/6] Skipped."
fi

if ! command -v node >/dev/null 2>&1; then
  echo "WARNING: 'node' is still not on PATH. MittiCloud needs Node >= 20."
  echo "         Check the pkg output above for errors."
fi

# ------------------------------------------------------------- directories
echo "[3/6] Creating vault/ and data/ directories..."
mkdir -p "$MITTI_ROOT/vault/photos" "$MITTI_ROOT/vault/files" "$MITTI_ROOT/data"

# ------------------------------------------------------------ dependencies
echo "[4/6] Installing server dependencies (npm install --omit=dev)..."
( cd "$MITTI_ROOT" && npm install --omit=dev )

# ---------------------------------------------------------------- wake-lock
echo "[5/6] Acquiring wake-lock (keeps Termux awake)..."
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock || echo "      (wake-lock failed -- continuing; run 'termux-wake-lock' anytime)"
else
  echo "      termux-wake-lock not found (Termux:API not installed?) -- skipping."
fi

# ------------------------------------------------------------ boot autostart
echo "[6/6] Setting up boot auto-start..."
BOOT_DIR="$HOME/.termux/boot"
if [ -d "$BOOT_DIR" ]; then
  BOOT_DST="$BOOT_DIR/mitticloud-boot.sh"
  cp "$SCRIPT_DIR/boot.sh" "$BOOT_DST"
  chmod +x "$BOOT_DST"
  # Rewrite the MITTI_ROOT= line in the copy to this absolute project root.
  # Escape sed metacharacters (backslash, ampersand, the | delimiter) first,
  # so unusual clone paths cannot break the substitution.
  __escaped="$(printf '%s' "$MITTI_ROOT" | sed -e 's/[&|\\]/\\&/g')"
  sed -i "s|^MITTI_ROOT=.*|MITTI_ROOT=\"${__escaped}\"|" "$BOOT_DST"
  echo "      Auto-start installed: $BOOT_DST"
else
  echo "      Install the Termux:Boot app from F-Droid, open it once, then re-run install.sh to enable auto-start."
fi

# ------------------------------------------------------- LAN IP (best effort)
detect_lan_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 addr show 2>/dev/null \
      | grep -oE 'inet ([0-9]{1,3}\.){3}[0-9]{1,3}' \
      | sed 's/inet[[:space:]]*//' \
      | grep -vE '^(127\.|100\.|169\.254\.)' | head -n 1 || true)"
  fi
  if [ -z "$ip" ] && command -v ifconfig >/dev/null 2>&1; then
    ip="$(ifconfig 2>/dev/null \
      | grep -oE 'inet (addr:)?([0-9]{1,3}\.){3}[0-9]{1,3}' \
      | sed -E 's/inet[[:space:]]*(addr:)?[[:space:]]*//' \
      | grep -vE '^(127\.|100\.|169\.254\.)' | head -n 1 || true)"
  fi
  if [ -z "$ip" ] && command -v termux-wifi-connectioninfo >/dev/null 2>&1; then
    ip="$(termux-wifi-connectioninfo 2>/dev/null \
      | grep -oE '"ip"[[:space:]]*:[[:space:]]*"[0-9.]+"' | head -n 1 \
      | sed 's/[^0-9.]//g' || true)"
  fi
  printf '%s' "$ip"
}

LAN_IP="$(detect_lan_ip)"
if [ -n "$LAN_IP" ]; then
  LAN_URL="http://${LAN_IP}:7333"
else
  LAN_URL="http://<phone-LAN-IP>:7333"
fi

# -------------------------------------------------------------- success box
line
echo ""
echo "  +------------------------------------------------------+"
echo "  |  MittiCloud installed. Your drawer-phone is a cloud. |"
echo "  +------------------------------------------------------+"
echo ""
echo "  Start it now:"
echo "      cd $MITTI_ROOT"
echo "      node server/index.js        (or: npm start)"
echo ""
echo "  Dashboard:"
echo "      On this phone : http://localhost:7333"
echo "      Same Wi-Fi    : $LAN_URL"
if [ -z "$LAN_IP" ]; then
  echo "      (LAN IP could not be auto-detected -- check your router's"
  echo "       device list, or run:  ifconfig | grep inet)"
fi
echo ""
echo "  THE ONE BATTERY SETTING THAT MATTERS:"
echo "      Android Settings > Apps > Termux > Battery > Unrestricted"
echo "      Then keep the phone plugged in. Full notes:"
echo "      docs/PHONE-SETUP.md (Step 4)"
echo ""
line
