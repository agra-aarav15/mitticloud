// Shared path helpers for the MittiCloud server.
// Every route resolves user-supplied relative paths through resolveSafe()
// so nothing outside the vault root can be read or written.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url)); // .../server/lib

export const ROOT_DIR = path.resolve(LIB_DIR, '..', '..'); // project root
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const VAULT_DIR = path.join(ROOT_DIR, 'vault');
export const PHOTOS_DIR = path.join(VAULT_DIR, 'photos');
export const FILES_DIR = path.join(VAULT_DIR, 'files');
export const DATA_DIR = path.join(ROOT_DIR, 'data');

/** Error carrying an HTTP status code (400 by default). */
export class PathError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'PathError';
    this.status = status;
  }
}

/**
 * Resolve `rel` (a user-supplied relative path) inside `root`, refusing
 * anything that escapes the root ('..', absolute paths, other drives).
 * Returns the absolute path. Throws PathError on refusal.
 */
export function resolveSafe(rel, root) {
  const rootAbs = path.resolve(root);
  const raw = rel == null ? '' : String(rel);
  if (raw.includes('\0')) throw new PathError('Invalid path');
  const abs = path.resolve(rootAbs, raw);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new PathError('Path escapes the vault root');
  }
  return abs;
}
