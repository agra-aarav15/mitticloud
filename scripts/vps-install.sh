#!/usr/bin/env bash
# MittiCloud one-line installer for a Linux VPS (Ubuntu/Debian).
#
#   curl -fsSL https://raw.githubusercontent.com/agra-aarav15/mitticloud/main/scripts/vps-install.sh | sudo bash
#
# Idempotent: safe to re-run. It installs Node.js 20+, a `mitti` system user,
# clones MittiCloud into /opt/mitticloud, installs production dependencies,
# and runs it as a systemd service that restarts on failure.
#
# Environment overrides:
#   MITTI_REPO=<git url>        default https://github.com/agra-aarav15/mitticloud.git
#   MITTI_DIR=<path>            default /opt/mitticloud
#   MITTI_PORT=<port>           default 7333 (the dashboard)
#   MITTI_DRYRUN=1              print every step, change nothing (no root or systemd needed)

set -euo pipefail

REPO="${MITTI_REPO:-https://github.com/agra-aarav15/mitticloud.git}"
DIR="${MITTI_DIR:-/opt/mitticloud}"
PORT="${MITTI_PORT:-7333}"
DRY="${MITTI_DRYRUN:-0}"
USER_NAME="mitti"
UNIT="/etc/systemd/system/mitticloud.service"
# Linux packages put node here (NodeSource and apt both do); never the host's path.
NODE_BIN="/usr/bin/node"

say() { printf '==> %s\n' "$*"; }
run() {
  if [ "$DRY" = "1" ]; then
    printf '    [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

if [ "$DRY" != "1" ] && [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root (sudo bash) — it creates a user and a systemd service." >&2
  exit 1
fi

say "Checking Node.js (needs 20 or newer)"
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
fi
if [ "$NODE_MAJOR" -lt 20 ]; then
  say "Installing Node.js 20 from NodeSource"
  run bash -c 'curl -fsSL https://deb.nodesource.com/setup_20.x | bash -'
  run apt-get install -y nodejs
fi

say "Installing git"
run apt-get install -y git

say "Creating the $USER_NAME system user"
if [ "$DRY" = "1" ] || ! id "$USER_NAME" >/dev/null 2>&1; then
  run useradd --system --home-dir "$DIR" --shell /usr/sbin/nologin "$USER_NAME"
fi

say "Fetching MittiCloud into $DIR"
if [ "$DRY" = "1" ]; then
  printf '    [dry-run] git clone or pull %s into %s\n' "$REPO" "$DIR"
elif [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone --depth 1 "$REPO" "$DIR"
fi

say "Installing production dependencies"
run bash -c "cd '$DIR' && npm install --omit=dev --no-audit --no-fund"

say "Creating vault and data folders owned by $USER_NAME"
run mkdir -p "$DIR/vault/photos" "$DIR/vault/files" "$DIR/data"
run chown -R "$USER_NAME":"$USER_NAME" "$DIR"

say "Writing the systemd unit $UNIT"
UNIT_BODY="[Unit]
Description=MittiCloud — free personal cloud
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$DIR
Environment=PORT=$PORT
ExecStart=$NODE_BIN $DIR/server/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
"
if [ "$DRY" = "1" ]; then
  printf '%s\n' "$UNIT_BODY" | sed 's/^/    | /'
else
  printf '%s' "$UNIT_BODY" > "$UNIT"
  systemctl daemon-reload
  systemctl enable --now mitticloud.service
fi

say "Opening the port in ufw, only if ufw is installed and active"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  run ufw allow "$PORT"/tcp
else
  say "ufw is not active; open TCP $PORT in your provider's firewall if you need it"
fi

say "Done. Dashboard: http://<this-server-ip>:$PORT"
say "Lock it: set MITTI_TOKEN in the unit (Environment=MITTI_TOKEN=...) before exposing it."
