// Build an in-memory ZIP of a whole directory tree, for the folder-download
// routes (/api/files/archive, /api/photos/archive). Walks the tree (skipping
// symlinks), enforces a total uncompressed size cap, then hands off to the
// zero-dependency zip engine in zip.js.
import fsp from 'node:fs/promises';
import path from 'node:path';

import { zipWrite } from './zip.js';

/** Recursively list files under `dirAbs` (symlinks skipped, sorted for stable output). */
async function listFiles(dirAbs) {
  const files = [];
  const stack = [dirAbs];
  while (stack.length > 0) {
    const cur = stack.pop();
    let dirents;
    try {
      dirents = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue; // missing/unreadable subtree -> just skip it
    }
    for (const ent of dirents) {
      if (ent.isSymbolicLink()) continue; // never follow links out of the tree
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) files.push(full);
    }
  }
  files.sort();
  return files;
}

/**
 * Build a ZIP of `dirAbs`; entry names are relative to it.
 * Throws an Error with .status = 413 when the total uncompressed size
 * exceeds `maxBytes`.
 * @returns {Promise<{buffer: Buffer, count: number}>}
 */
export async function buildDirZip(dirAbs, { maxBytes = Infinity } = {}) {
  const files = await listFiles(dirAbs);
  const entries = [];
  let total = 0;
  for (const abs of files) {
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isFile()) continue; // raced with a delete
    total += st.size;
    if (total > maxBytes) {
      const e = new Error('Archive too large');
      e.status = 413;
      throw e;
    }
    entries.push({
      path: path.relative(dirAbs, abs).split(path.sep).join('/'),
      data: await fsp.readFile(abs),
      mtime: st.mtime,
    });
  }
  return { buffer: zipWrite(entries), count: entries.length };
}
