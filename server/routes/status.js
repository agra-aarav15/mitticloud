// GET /api/status -> battery, storage, uptime, version, device, tunnel.
import { Router } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';

import { getBattery, getStorage, isTermux } from '../lib/termux.js';
import { getLanIPs } from '../lib/net.js';
import { isLocked } from '../lib/auth.js';
import { VAULT_DIR } from '../lib/paths.js';

const execFileP = promisify(execFile);
const router = Router();

const PKG = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
);

async function commandExists(cmd, args) {
  try {
    await execFileP(cmd, args, { timeout: 2500 });
    return true;
  } catch (err) {
    // ENOENT: not on PATH. Any other error (bad exit code, timeout) means
    // the command exists but failed -> still counts as installed.
    return err.code !== 'ENOENT';
  }
}

function hasTailscaleIP() {
  // 100.x.x.x on a non-internal interface = tailscale-like overlay network.
  return getLanIPs().some(({ address }) => address.startsWith('100.'));
}

/**
 * REAL tailscale readout from `tailscale status --json` — or installed:false
 * when the machine has none. No invented values: every field comes from the
 * binary's own output.
 */
async function tailscaleInfo() {
  try {
    const { stdout } = await execFileP('tailscale', ['status', '--json'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const j = JSON.parse(stdout);
    const self = j.Self || {};
    const ip = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs[0] || null : null;
    const dnsName =
      typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : null;
    return {
      installed: true,
      running: j.BackendState === 'Running',
      online: self.Online === true,
      ip,
      dnsName,
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { installed: false };
    // installed but not answering (daemon off, permissions) — say exactly that
    return { installed: true, running: false, online: false, ip: null, dnsName: null };
  }
}

async function detectTunnel() {
  if (hasTailscaleIP() || (await commandExists('tailscale', ['version']))) {
    return 'tailscale';
  }
  if (await commandExists('cloudflared', ['--version'])) {
    return 'cloudflared';
  }
  return 'lan';
}

// Same rule as index.js for the port, so these URLs match the banner.
const PORT = Number.parseInt(process.env.PORT || '', 10) || 7333;

/** Reachable LAN URLs, e.g. ["http://192.168.1.20:7333"]. */
function lanUrls() {
  return getLanIPs().map(({ address }) => `http://${address}:${PORT}`);
}

function tunnelHint(mode) {
  if (mode === 'tailscale') {
    return 'Open http://<your-tailscale-ip>:7333 (or your MagicDNS name) from any device on your tailnet.';
  }
  if (mode === 'cloudflared') {
    return 'Run: cloudflared tunnel --url http://localhost:7333 — then open the trycloudflare.com URL it prints.';
  }
  const first = getLanIPs()[0];
  const host = first ? first.address : '<this-phone-LAN-IP>';
  return `Open http://${host}:7333 from any device on the same Wi-Fi.`;
}

router.get('/', async (req, res, next) => {
  try {
    const [termux, battery, storage, mode, tailscale] = await Promise.all([
      isTermux(),
      getBattery(),
      getStorage(VAULT_DIR),
      detectTunnel(),
      tailscaleInfo(),
    ]);
    res.json({
      battery,
      storage,
      uptimeSec: Math.floor(process.uptime()),
      version: PKG.version,
      device: { termux, platform: process.platform, lanUrls: lanUrls() },
      security: { locked: isLocked() },
      tailscale,
      tunnel: { mode, hint: tunnelHint(mode) },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
