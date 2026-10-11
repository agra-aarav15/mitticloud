// SSH access token (the SSH password).
//
// The one token that guards MittiCloud is the SSH password (sshserver.js). The
// web app, the file, photo and host APIs stay open with no token. Sources, in order:
//   1. env MITTI_TOKEN — wins whenever it is set (non-empty), e.g. on a VPS
//   2. data/settings.json { lockToken: "<secret>" } — set via PUT /api/lock
// An empty token means SSH needs no password.
//
// The token itself NEVER appears in an API response.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { DATA_DIR } from './paths.js';

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** Read data/settings.json as an object. Missing/corrupt file -> {}. */
export function readSettings() {
  ensureDataDir();
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/** Atomically replace the whole settings file (temp file + rename). */
function writeSettings(obj) {
  ensureDataDir();
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, SETTINGS_FILE);
}

/** Set (or clear with '') the settings lockToken; returns the settings file. */
export function setLockToken(token) {
  const settings = readSettings();
  settings.lockToken = typeof token === 'string' ? token : '';
  writeSettings(settings);
  return settings;
}

/** Where the active token comes from: 'env', 'settings' or null (unlocked). */
export function tokenSource() {
  const env = process.env.MITTI_TOKEN;
  if (typeof env === 'string' && env !== '') return 'env';
  const t = readSettings().lockToken;
  return typeof t === 'string' && t !== '' ? 'settings' : null;
}

/** The active token, or '' when unlocked. Env wins over settings.json. */
export function getToken() {
  const env = process.env.MITTI_TOKEN;
  if (typeof env === 'string' && env !== '') return env;
  const t = readSettings().lockToken;
  return typeof t === 'string' ? t : '';
}

/** True when writes need a token. */
export function isLocked() {
  return getToken() !== '';
}

/**
 * Check a request's token against the active one.
 * Accepts the `x-mitti-token` header or a `?token=` query param.
 * Comparison is timing-safe; never matches when unlocked (no token set).
 */
export function verify(req) {
  const expected = getToken();
  if (expected === '') return false;
  let given = req.get ? req.get('x-mitti-token') : undefined;
  if (given == null || given === '') given = req.query?.token;
  if (typeof given !== 'string' || given === '') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

