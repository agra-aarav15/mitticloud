// Client keys — per-app access tokens so OTHER apps (AI clients, scripts,
// the MCP endpoint) can talk to this cloud. The full key is shown exactly
// once at creation; only a sha256 hash is stored. No API ever returns a
// key again, and backups skip the file — same law as agent-keys.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { DATA_DIR } from './paths.js';

const KEYS_FILE = path.join(DATA_DIR, 'client-keys.json');
const MAX_KEYS = 20;
const MAX_NAME = 60;

function atomicWrite(obj) {
  fs.mkdirSync(path.dirname(KEYS_FILE), { recursive: true });
  const tmp = KEYS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, KEYS_FILE);
}

function loadAll() {
  try {
    const j = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    return Array.isArray(j) ? j.filter((k) => k && k.id && k.hash) : [];
  } catch {
    return [];
  }
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Create a key for a named client. Returns { key } with the FULL key —
 *  the only time it exists outside the caller's config file. */
export function createKey(name) {
  const clean = String(name || '').trim().slice(0, MAX_NAME);
  if (!clean) throw Object.assign(new Error('Give the key a name — which app is it for?'), { status: 400 });
  const keys = loadAll();
  if (keys.length >= MAX_KEYS) {
    throw Object.assign(new Error(`Key limit reached (${MAX_KEYS}) — revoke one first`), { status: 400 });
  }
  const key = 'mitti_' + crypto.randomBytes(24).toString('base64url');
  const record = {
    id: crypto.randomBytes(4).toString('hex'),
    name: clean,
    hash: sha(key),
    createdAt: new Date().toISOString(),
    lastUsed: null,
  };
  keys.push(record);
  atomicWrite(keys);
  return { key, record: redact(record) };
}

/** Keys for display: never the hash, never the key. */
export function listKeys() {
  return loadAll().map(redact);
}

export function revokeKey(id) {
  const keys = loadAll();
  const next = keys.filter((k) => k.id !== String(id));
  if (next.length === keys.length) {
    throw Object.assign(new Error('No such key'), { status: 404 });
  }
  atomicWrite(next);
  return { revoked: true };
}

/** True if this exact key string matches a stored hash. Bumps lastUsed
 *  (throttled to one write per minute per key) and returns the redacted
 *  record the call was authorized for. */
export function verifyKey(candidate) {
  const key = String(candidate || '');
  if (!key.startsWith('mitti_')) return null;
  const hash = sha(key);
  const keys = loadAll();
  const rec = keys.find((k) => k.hash === hash);
  if (!rec) return null;
  const now = Date.now();
  const last = rec.lastUsed ? Date.parse(rec.lastUsed) : 0;
  if (now - last > 60 * 1000) {
    rec.lastUsed = new Date().toISOString();
    atomicWrite(keys);
  }
  return redact(rec);
}

function redact(rec) {
  return { id: rec.id, name: rec.name, createdAt: rec.createdAt, lastUsed: rec.lastUsed || null };
}
