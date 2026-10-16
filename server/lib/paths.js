// Shared path helpers for the MittiCloud server.
// Every route resolves user-supplied relative paths through resolveSafe()
// so nothing outside the vault root can be read or written.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url)); // .../server/lib

export const ROOT_DIR = path.resolve(LIB_DIR, '..', '..'); // project root
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
// Tests set MITTICLOUD_VAULT_DIR / MITTICLOUD_DATA_DIR (before importing this
// module) to run against throwaway temp folders instead of the real vault.
const VAULT_DIR_OVERRIDE = process.env.MITTICLOUD_VAULT_DIR
  ? path.resolve(process.env.MITTICLOUD_VAULT_DIR)
  : null;
const DATA_DIR_OVERRIDE = process.env.MITTICLOUD_DATA_DIR
  ? path.resolve(process.env.MITTICLOUD_DATA_DIR)
  : null;
export const VAULT_DIR = VAULT_DIR_OVERRIDE || path.join(ROOT_DIR, 'vault');
export const PHOTOS_DIR = path.join(VAULT_DIR, 'photos');
export const FILES_DIR = path.join(VAULT_DIR, 'files');
export const DATA_DIR = DATA_DIR_OVERRIDE || path.join(ROOT_DIR, 'data');

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

// True when this server runs inside the Android app (the APK sets this before
// node starts). Android is not a normal Linux: there is no /bin/sh and the
// core utils live under /system/bin, so the shell layer has to adapt.
export function isEmbeddedAndroid() {
  return process.platform === 'android' || process.env.MITTICLOUD_EMBEDDED === '1';
}

// A writable temp dir for children on embedded Android. There is no /tmp on
// Android, so a child's os.tmpdir() falls back to the literal "/tmp" — which
// the app cannot write — and anything needing a socket or scratch file dies
// (measured: ZCode's agent crash-looped 114 times on
// `listen EACCES /tmp/znr-*.sock`). data/tmp is app-private and always
// writable. Returns null on a desktop, where the host tmpdir is left alone,
// and when the folder cannot be created the caller must not set TMPDIR at all
// (an unusable TMPDIR is worse than none: libuv trusts it blindly).
export function shellTmpDir() {
  if (!isEmbeddedAndroid()) return null;
  const dir = path.join(DATA_DIR, 'tmp');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  return dir;
}
