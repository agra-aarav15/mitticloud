// MittiHost runtime — the cfn flow, in-app.
//
// 1. TEST ON LAN: the site is already reachable at http://<lan-ip>:7333 —
//    this router just tells the user the real URLs.
// 2. GO PUBLIC WITH CLOUDFLARE: two paths, like his cfn deploy —
//      quick  -> `cloudflared tunnel --url http://localhost:PORT`
//                (no account needed, temporary trycloudflare.com URL)
//      token  -> `cloudflared tunnel run --token <t>`
//                (his own hostname from the Cloudflare dashboard, built for 24/7)
// 3. PROVE IT: a zero-dependency load test that throws `visitors` concurrent
//    browsers at the server and reports real requests/sec + latency. Honest
//    label: measured on loopback from this device.
import { Router } from 'express';
import http from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { getLanIPs } from '../lib/net.js';
import { DATA_DIR } from '../lib/paths.js';
import {
  loadToken,
  saveToken,
  clearToken,
  accountsList,
  collectFiles,
  deploySite,
} from '../lib/cfpages.js';

const router = Router();

const PORT = Number.parseInt(process.env.PORT || '', 10) || 7333;

// --- tunnel state (one at a time) ---

let tunnel = null; // { mode:'quick'|'token', child, url, startedAt, log:[] }

const LOG_CAP = 40;

function pushLog(line) {
  if (!tunnel) return;
  tunnel.log.push(line);
  if (tunnel.log.length > LOG_CAP) tunnel.log.shift();
  const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (m && tunnel.mode === 'quick') tunnel.url = m[0];
}

function tunnelStatus() {
  if (!tunnel) return { running: false, mode: null, url: null, log: [] };
  const alive = tunnel.child.exitCode === null && !tunnel.failed;
  return {
    running: alive,
    mode: tunnel.mode,
    url: tunnel.url || null,
    startedAt: tunnel.startedAt,
    log: tunnel.log.slice(-12),
    ...(tunnel.failed ? { failed: tunnel.failed } : {}),
    ...(tunnel.child.exitCode !== null && !tunnel.failed
      ? { exitCode: tunnel.child.exitCode }
      : {}),
  };
}

function startCloudflared(bin, args, mode) {
  // the bin string becomes a process name — refuse anything process-like
  if (!/^[a-z0-9_\-.:\\\/() ]+$/i.test(bin)) {
    throw Object.assign(new Error('cloudflared path looks wrong — use a plain path or "cloudflared"'), { status: 400 });
  }
  let child;
  try {
    child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    // missing binary throws synchronously — surface it as a failed tunnel,
    // not a 500 the UI cannot render
    tunnel = { mode, child: { exitCode: 1 }, url: null, startedAt: new Date().toISOString(), log: [], failed: err.message };
    return null;
  }
  tunnel = { mode, child, url: null, startedAt: new Date().toISOString(), log: [], failed: null };
  const onData = (buf) =>
    String(buf)
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .forEach(pushLog);
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  // a failed spawn fires 'error' but never 'exit' — without this the tunnel
  // reports "running" forever while nothing exists
  child.on('error', (err) => {
    if (tunnel) tunnel.failed = err.message;
    pushLog(`[cloudflared could not start: ${err.message}]`);
  });
  child.on('exit', (code) => pushLog(`[cloudflared exited with code ${code}]`));
  return child;
}

// --- routes ---

router.get('/lan', (req, res) => {
  const urls = getLanIPs().map(({ address }) => `http://${address}:${PORT}`);
  res.json({ port: PORT, urls, hostname: os.hostname() });
});

router.get('/tunnel', (req, res) => {
  res.json(tunnelStatus());
});

router.post('/tunnel/quick', async (req, res, next) => {
  try {
    if (tunnel && tunnel.child.exitCode === null) {
      return res.status(409).json({ error: 'A tunnel is already running', ...tunnelStatus() });
    }
    const bin = String((req.body || {}).bin || 'cloudflared').trim() || 'cloudflared';
    startCloudflared(bin, ['tunnel', '--url', `http://localhost:${PORT}`], 'quick');
    // the trycloudflare URL lands in stderr within a few seconds — give it a beat
    await new Promise((r) => setTimeout(r, 4000));
    res.json(tunnelStatus());
  } catch (err) {
    next(err);
  }
});

router.post('/tunnel/token', async (req, res, next) => {
  try {
    if (tunnel && tunnel.child.exitCode === null) {
      return res.status(409).json({ error: 'A tunnel is already running', ...tunnelStatus() });
    }
    const token = String((req.body || {}).token || '').trim();
    if (!token) return res.status(400).json({ error: 'Paste the tunnel token from the Cloudflare dashboard' });
    if (token.length > 2000) return res.status(400).json({ error: 'That token is too long' });
    const bin = String((req.body || {}).bin || 'cloudflared').trim() || 'cloudflared';
    startCloudflared(bin, ['tunnel', 'run', '--token', token], 'token');
    await new Promise((r) => setTimeout(r, 4000));
    const st = tunnelStatus();
    res.json({
      ...st,
      note: 'Token tunnel: your own hostname from the Cloudflare dashboard stays mapped to this phone. The URL is whatever you configured there — this is the 24/7 mode.',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/tunnel/stop', (req, res) => {
  if (!tunnel || tunnel.child.exitCode !== null) {
    return res.json({ ok: true, ...tunnelStatus() });
  }
  try {
    tunnel.child.kill();
  } catch {
    // already gone
  }
  res.json({ ok: true, ...tunnelStatus() });
});

// --- Cloudflare Pages: publish a hosted site to the user's own domain ---
// (the cfn experience: site on Cloudflare, free forever, never sleeps)

const SITE_NAME_RE = /^[a-z0-9-]{1,32}$/;

router.get('/cf/status', async (req, res, next) => {
  try {
    const token = loadToken();
    if (!token) return res.json({ connected: false });
    try {
      const accounts = await accountsList(globalThis.fetch, token);
      res.json({ connected: true, accounts });
    } catch (err) {
      res.json({ connected: false, error: err.message });
    }
  } catch (err) {
    next(err);
  }
});

router.put('/cf/token', async (req, res, next) => {
  try {
    const token = String((req.body || {}).token || '').trim();
    if (!token) return res.status(400).json({ error: 'Paste the Cloudflare API token' });
    if (token.length > 300) return res.status(400).json({ error: 'That token is too long' });
    let accounts;
    try {
      accounts = await accountsList(globalThis.fetch, token);
    } catch (err) {
      return res.status(400).json({
        error:
          'Cloudflare rejected the token (' +
          err.message +
          '). It needs the "Cloudflare Pages: Edit" permission.',
      });
    }
    if (!accounts.length) {
      return res.status(400).json({ error: 'That token sees no Cloudflare accounts' });
    }
    saveToken(token);
    res.json({ ok: true, accounts });
  } catch (err) {
    next(err);
  }
});

router.delete('/cf/token', (req, res) => {
  clearToken();
  res.json({ ok: true, connected: false });
});

// one publish at a time
let cfPublishing = false;

router.post('/cf/publish', async (req, res, next) => {
  try {
    if (cfPublishing) return res.status(409).json({ error: 'A publish is already running' });
    const token = loadToken();
    if (!token) return res.status(400).json({ error: 'Save a Cloudflare API token first' });
    const site = String((req.body || {}).site || '').trim();
    if (!SITE_NAME_RE.test(site)) return res.status(400).json({ error: 'Pick one of your hosted sites' });
    const accountId = String((req.body || {}).accountId || '').trim();
    if (!/^[a-f0-9]{16,64}$/i.test(accountId)) {
      return res.status(400).json({ error: 'Pick the Cloudflare account to publish under' });
    }
    const siteDir = path.join(DATA_DIR, 'sites', site);
    if (!fs.existsSync(siteDir)) {
      return res.status(404).json({ error: 'No hosted site called ' + site });
    }
    const files = collectFiles(siteDir);

    cfPublishing = true;
    try {
      const out = await deploySite(globalThis.fetch, token, accountId, 'mitticloud-' + site, files);
      res.json({ ok: true, site, ms: null, ...out });
    } finally {
      cfPublishing = false;
    }
  } catch (err) {
    cfPublishing = false;
    next(err);
  }
});

// --- load test: real concurrent requests, zero dependencies ---

let loadRunning = false;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx] * 10) / 10;
}

function oneRequest(url, timeoutMs) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const req = http.get(url, { timeout: timeoutMs }, (r) => {
      r.resume(); // drain
      r.on('end', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        resolve({ ok: r.statusCode >= 200 && r.statusCode < 400, ms });
      });
      r.on('error', () => resolve({ ok: false, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, ms: Number(process.hrtime.bigint() - started) / 1e6 });
    });
    req.on('error', () => resolve({ ok: false, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
  });
}

router.post('/loadtest', async (req, res, next) => {
  try {
    if (loadRunning) return res.status(409).json({ error: 'A load test is already running' });
    const body = req.body || {};
    const visitors = Math.min(500, Math.max(1, Number(body.visitors) || 200));
    const seconds = Math.min(60, Math.max(3, Number(body.seconds) || 15));
    let targetPath = String(body.path || '/');
    if (!targetPath.startsWith('/')) targetPath = '/' + targetPath;

    loadRunning = true;
    try {
      const url = `http://127.0.0.1:${PORT}${targetPath}`;
      const end = Date.now() + seconds * 1000;
      let requests = 0;
      let errors = 0;
      const latencies = [];

      async function worker() {
        while (Date.now() < end) {
          const r = await oneRequest(url, 10 * 1000);
          requests++;
          if (!r.ok) errors++;
          if (latencies.length < 50000) latencies.push(r.ms);
        }
      }
      await Promise.all(Array.from({ length: visitors }, worker));

      latencies.sort((a, b) => a - b);
      res.json({
        visitors,
        seconds,
        path: targetPath,
        requests,
        errors,
        rps: Math.round((requests / seconds) * 10) / 10,
        p50Ms: percentile(latencies, 50),
        p95Ms: percentile(latencies, 95),
        note:
          'Measured on loopback from this device — real visitors over Wi-Fi add their own latency, but the phone handled every one of these requests itself.',
      });
    } finally {
      loadRunning = false;
    }
  } catch (err) {
    next(err);
  }
});

export default router;
