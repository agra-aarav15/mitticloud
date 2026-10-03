// Agent Server storage: sessions + provider keys, filesystem-as-database.
// Sessions live in DATA_DIR/agent-sessions/<id>.json (one file per session,
// atomic temp+rename writes). Provider API keys live in DATA_DIR/agent-keys.json
// and NEVER leave the server: no route returns a key, backups skip the file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './paths.js';

const SESSIONS_DIR = path.join(DATA_DIR, 'agent-sessions');
const KEYS_FILE = path.join(DATA_DIR, 'agent-keys.json');

export function ensureDirs() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// --- sessions ---

export function newId() {
  return crypto.randomBytes(8).toString('hex');
}

export function saveSession(session) {
  ensureDirs();
  atomicWrite(path.join(SESSIONS_DIR, session.id + '.json'), session);
}

/** One session or null, exactly as stored. */
export function loadSession(id) {
  if (!/^[a-f0-9]{8,32}$/.test(String(id))) return null;
  try {
    const s = JSON.parse(
      fs.readFileSync(path.join(SESSIONS_DIR, id + '.json'), 'utf8')
    );
    if (!s || typeof s !== 'object' || s.id !== id) return null;
    return s;
  } catch {
    return null;
  }
}

/**
 * Called once at server boot: no turn can survive a restart, so any session
 * still flagged `running` is marked over with an honest note. Without this,
 * a crashed server would leave sessions looking busy forever.
 */
export function bootSweep() {
  ensureDirs();
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return 0;
  }
  let fixed = 0;
  for (const f of files) {
    try {
      const file = path.join(SESSIONS_DIR, f);
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (s && s.running === true) {
        s.running = false;
        s.error =
          'The server restarted while the agent was working. Send the message again.';
        atomicWrite(file, s);
        fixed++;
      }
    } catch {
      // unreadable — leave it alone
    }
  }
  return fixed;
}

export function deleteSession(id) {
  if (!/^[a-f0-9]{8,32}$/.test(String(id))) return false;
  try {
    fs.unlinkSync(path.join(SESSIONS_DIR, id + '.json'));
    return true;
  } catch {
    return false;
  }
}

/** All sessions, newest activity first (summaries only — no messages). */
export function listSessions() {
  ensureDirs();
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const s = JSON.parse(
        fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')
      );
      if (s && typeof s.id === 'string') {
        out.push({
          id: s.id,
          title: typeof s.title === 'string' ? s.title : 'Untitled',
          providerId: s.providerId,
          workspace: s.workspace,
          running: s.running === true,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messageCount: Array.isArray(s.messages) ? s.messages.length : 0,
        });
      }
    } catch {
      // unreadable file — skip it, never break the list
    }
  }
  out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return out;
}

// --- provider keys (write-only from the API's point of view) ---

export function loadKeys() {
  try {
    const k = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    return k && typeof k === 'object' && !Array.isArray(k) ? k : {};
  } catch {
    return {};
  }
}

export function getKey(providerId) {
  const k = loadKeys()[providerId];
  return typeof k === 'string' && k.length > 0 ? k : null;
}

export function setKey(providerId, key) {
  const k = loadKeys();
  if (key === null) delete k[providerId];
  else k[providerId] = key;
  atomicWrite(KEYS_FILE, k);
}

/** Which providers have a key configured (booleans only, values never leak). */
export function keyStatus() {
  const k = loadKeys();
  const out = {};
  for (const [id, v] of Object.entries(k)) out[id] = typeof v === 'string' && v.length > 0;
  return out;
}
