// Daily settings backup — snapshot every data/*.json into
// data/backups/<YYYY-MM-DD>/ so a bad API call or hand edit can be undone.
// Keeps the 7 most recent date folders, deletes older ones. initBackup()
// snapshots once on boot and then every 6h, so the newest folder is always
// less than a day old (a phone can be off at any given "daily" time).
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './paths.js';

const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const KEEP_FOLDERS = 7;
const INTERVAL_MS = 6 * 60 * 60 * 1000; // 4 runs a day
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
// API keys live on the device and never get copied into backups.
const SKIP_FILES = new Set(['agent-keys.json']);

/** Copy every data/*.json into data/backups/<YYYY-MM-DD>/ (best effort). */
export function runBackupNow() {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const folder = path.join(BACKUPS_DIR, new Date().toISOString().slice(0, 10)); // YYYY-MM-DD
  fs.mkdirSync(folder, { recursive: true });
  for (const ent of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
    if (SKIP_FILES.has(ent.name)) continue;
    fs.copyFileSync(path.join(DATA_DIR, ent.name), path.join(folder, ent.name));
  }
  pruneOldFolders();
  return folder;
}

/** Keep only the KEEP_FOLDERS newest YYYY-MM-DD folders (sorted by name). */
function pruneOldFolders() {
  const dirs = fs
    .readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && DATE_DIR_RE.test(e.name))
    .map((e) => e.name)
    .sort();
  for (const name of dirs.slice(0, Math.max(0, dirs.length - KEEP_FOLDERS))) {
    fs.rmSync(path.join(BACKUPS_DIR, name), { recursive: true, force: true });
  }
}

/** Boot hook: one snapshot now, then every 6h. Never crashes the server. */
export function initBackup() {
  try {
    runBackupNow();
  } catch (err) {
    console.error('[mitticloud] settings backup failed:', err.message);
  }
  const timer = setInterval(() => {
    try {
      runBackupNow();
    } catch (err) {
      console.error('[mitticloud] settings backup failed:', err.message);
    }
  }, INTERVAL_MS);
  timer.unref?.();
  return timer;
}
