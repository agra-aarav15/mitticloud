// Deep self-health checks behind GET /api/health?deep=1 (routes/health.js).
// Verifies the vault actually accepts writes (probe file), that every
// data/*.json still parses (catches half-written or hand-broken state),
// that every hosted site actually answers (the portfolio-404 lesson: a site
// can exist on disk and still be dead to the world), and how old the last
// settings backup is. Pure checks — never mutate anything but the probe file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DATA_DIR, VAULT_DIR } from './paths.js';

const MB = 1024 * 1024;
const SITES_FILE = path.join(DATA_DIR, 'sites.json');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

/** Write + delete a probe file in the vault. True when both succeed. */
export function checkVaultWritable() {
  const probe = path.join(VAULT_DIR, `.mitti-probe-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(VAULT_DIR, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    try {
      fs.unlinkSync(probe); // never leave the probe behind on partial failure
    } catch {
      // nothing more we can do
    }
    return false;
  }
}

/** True when every *.json file directly in data/ parses. */
export function checkDataFiles() {
  try {
    for (const ent of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      JSON.parse(fs.readFileSync(path.join(DATA_DIR, ent.name), 'utf8'));
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Open every hosted site and record whether it really answers. `origin` is
 * the server's own base URL (the route builds it from the request, so any
 * port works — including ephemeral test ports). A site counts as up only on
 * a 2xx/3xx answer: a 404 is exactly the failure this check exists to catch.
 */
export async function checkSites(origin) {
  let sites = [];
  try {
    const j = JSON.parse(fs.readFileSync(SITES_FILE, 'utf8'));
    // the registry file is a bare array; accept the wrapped shape too
    sites = Array.isArray(j) ? j : Array.isArray(j.sites) ? j.sites : [];
  } catch {
    return { total: 0, up: 0, results: [], ok: true };
  }
  const results = await Promise.all(
    sites.map(async (s) => {
      const url = `${origin}/s/${encodeURIComponent(s.name)}/`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
        res.body?.cancel?.().catch(() => {});
        return { name: s.name, status: res.status, up: res.status >= 200 && res.status < 400 };
      } catch (err) {
        return { name: s.name, status: null, up: false, error: err.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
      }
    })
  );
  return {
    total: results.length,
    up: results.filter((r) => r.up).length,
    results,
    ok: results.every((r) => r.up),
  };
}

/** Age of the newest settings snapshot in data/backups/<date>/. */
export function checkBackupAge() {
  try {
    const days = fs
      .readdirSync(BACKUPS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    if (!days.length) return { count: 0, ageMs: null, at: null, ok: false };
    let newest = { mtimeMs: 0, files: 0 };
    for (const ent of fs.readdirSync(path.join(BACKUPS_DIR, days[days.length - 1]))) {
      const st = fs.statSync(path.join(BACKUPS_DIR, days[days.length - 1], ent));
      newest.files++;
      if (st.mtimeMs > newest.mtimeMs) newest = { mtimeMs: st.mtimeMs, files: newest.files };
    }
    const ageMs = Math.max(0, Date.now() - newest.mtimeMs);
    return {
      count: days.length,
      ageMs,
      at: new Date(newest.mtimeMs).toISOString(),
      ok: ageMs < 7 * 24 * 3600 * 1000,
    };
  } catch {
    return { count: 0, ageMs: null, at: null, ok: false };
  }
}
/**
 * Run the synchronous checks. Returns { mem, vaultWritable, dataOk, checks }.
 * (Site liveness + backup age are async — the health route adds them.)
 */
export function runSelfCheck() {
  const mem = {
    freeMB: Math.round(os.freemem() / MB),
    totalMB: Math.round(os.totalmem() / MB),
  };
  const vaultWritable = checkVaultWritable();
  const dataOk = checkDataFiles();
  const checks = [
    { name: 'vault-writable', ok: vaultWritable },
    { name: 'data-json', ok: dataOk },
  ];
  return { mem, vaultWritable, dataOk, checks };
}
