// Deep self-health checks behind GET /api/health?deep=1 (routes/health.js).
// Verifies the vault actually accepts writes (probe file), that every
// data/*.json still parses (catches half-written or hand-broken state) and
// reports memory. Pure checks — never mutate anything but the probe file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DATA_DIR, VAULT_DIR } from './paths.js';

const MB = 1024 * 1024;

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
 * Run all checks. Returns { mem, vaultWritable, dataOk, checks } where
 * checks is [{name, ok}] — one entry per check, UI-friendly.
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
