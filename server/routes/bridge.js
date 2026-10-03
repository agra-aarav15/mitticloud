// MittiCloud Bridge — Cloud Mode storage for CLI coding agents.
// The phone holds a coding agent's brain: one folder per session with the
// context window snapshot, the chat history and the project files, so any
// session can be resumed from any device — or started again as a new chat.
//
//   POST   /                 create a session {name}
//   GET    /                 list sessions (live stats per session)
//   PUT    /:id/context      save context (string or arbitrary JSON, cap 8MB)
//   GET    /:id/context      read the saved context back raw (text/plain)
//   POST   /:id/chat         append {role, text} (last 500 messages kept)
//   GET    /:id/chat         {messages: [...]}
//   POST   /:id/new-chat     keep context.json, reset chat.json ("new chat")
//   POST   /:id/files        upload {files: [{path, contentBase64}]}
//   GET    /:id/files        list files; ?path=rel -> {path, contentBase64}
//   DELETE /:id              remove the session folder + registry entry
//
// Storage: registry data/bridge.json + per-session data/bridge/<id>/ holding
// context.json, chat.json and files/. Session ids are 8 hex chars
// (crypto.randomBytes(4)). Writes are atomic (temp file + rename), the same
// pattern as lib/store.js. Every user path is sanitized (no "..", no leading
// "/") and re-checked with resolveSafe so nothing escapes the session folder.
//
// MOUNT NOTE for server/index.js: mount this router BEFORE the global
// express.json({ limit: '1mb' }) — the bridge carries its own parser so
// context/file payloads above 1MB can pass (see limit below).
import express, { Router } from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { DATA_DIR, resolveSafe, PathError } from '../lib/paths.js';

const router = Router();

// Bigger bodies than the app default: 50MB of files base64-encodes to ~67MB,
// so 80MB leaves headroom for JSON overhead.
router.use(express.json({ limit: '80mb' }));

const BRIDGE_DIR = path.join(DATA_DIR, 'bridge');
const REGISTRY_FILE = path.join(DATA_DIR, 'bridge.json');

const MAX_NAME = 120; // characters
const MAX_CONTEXT = 8 * 1024 * 1024; // bytes per saved context
const MAX_FILE = 5 * 1024 * 1024; // bytes per uploaded file (decoded)
const MAX_REQUEST = 50 * 1024 * 1024; // bytes per files request (decoded)
const MAX_CHAT_MESSAGES = 500; // oldest messages dropped beyond this
const MAX_CHAT_TEXT = 200000; // characters per chat message
const MAX_RELPATH = 400; // characters per stored file path
const SESSION_ID_RE = /^[0-9a-f]{8}$/;

const nowIso = () => new Date().toISOString();

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

// --- registry + session files (atomic writes: temp file + rename) ---

async function writeTextAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, text);
  await fsp.rename(tmp, file);
}

const writeJsonAtomic = (file, value) =>
  writeTextAtomic(file, JSON.stringify(value, null, 2) + '\n');

/** Read data/bridge.json. Missing/corrupt -> { sessions: [] }. */
async function loadRegistry() {
  try {
    const data = JSON.parse(await fsp.readFile(REGISTRY_FILE, 'utf8'));
    return Array.isArray(data.sessions) ? data : { sessions: [] };
  } catch {
    return { sessions: [] };
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const sessionDir = (id) => path.join(BRIDGE_DIR, id);
const contextFile = (id) => path.join(sessionDir(id), 'context.json');
const chatFile = (id) => path.join(sessionDir(id), 'chat.json');
const filesRoot = (id) => path.join(sessionDir(id), 'files');

/** Resolve a registry entry to a real session (id shape + folder on disk). */
async function findSession(reg, id) {
  if (!SESSION_ID_RE.test(id)) return null;
  const entry = reg.sessions.find((s) => s.id === id);
  if (!entry) return null;
  try {
    if (!(await fsp.stat(sessionDir(id))).isDirectory()) return null;
  } catch {
    return null;
  }
  return entry;
}

const notFound = (res) => res.status(404).json({ error: 'Session not found' });

// --- live stats (a handful of sessions on a phone: cheap to recompute) ---

async function contextBytes(id) {
  try {
    return (await fsp.stat(contextFile(id))).size;
  } catch {
    return 0;
  }
}

async function chatCount(id) {
  const data = await readJson(chatFile(id), { messages: [] });
  return Array.isArray(data && data.messages) ? data.messages.length : 0;
}

async function countFiles(dir) {
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // files/ not created yet
  }
  let n = 0;
  for (const ent of dirents) {
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) n += await countFiles(path.join(dir, ent.name));
    else if (ent.isFile()) n += 1;
  }
  return n;
}

// --- routes ---

router.get('/', async (req, res, next) => {
  try {
    const reg = await loadRegistry();
    const sessions = [];
    for (const entry of reg.sessions) {
      try {
        if (!(await fsp.stat(sessionDir(entry.id))).isDirectory()) continue;
      } catch {
        continue; // folder gone: session no longer exists
      }
      const [ctxBytes, chats, fileCount] = await Promise.all([
        contextBytes(entry.id),
        chatCount(entry.id),
        countFiles(filesRoot(entry.id)),
      ]);
      sessions.push({
        id: entry.id,
        name: entry.name,
        contextBytes: ctxBytes,
        chatCount: chats,
        fileCount,
        updatedAt: entry.updatedAt || entry.createdAt,
      });
    }
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ error: 'name must be a non-empty string' });
    }
    if (name.length > MAX_NAME) {
      return res.status(400).json({ error: `name is too long (max ${MAX_NAME} characters)` });
    }
    const id = crypto.randomBytes(4).toString('hex');
    const createdAt = nowIso();
    await fsp.mkdir(sessionDir(id), { recursive: true });
    const reg = await loadRegistry();
    reg.sessions.push({ id, name, createdAt, updatedAt: createdAt });
    await writeJsonAtomic(REGISTRY_FILE, reg);
    res.status(201).json({ id, name, createdAt });
  } catch (err) {
    next(err);
  }
});

router.put('/:id/context', async (req, res, next) => {
  try {
    const reg = await loadRegistry();
    const entry = await findSession(reg, req.params.id);
    if (!entry) return notFound(res);

    const body = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(body, 'context')) {
      return res.status(400).json({ error: 'Missing "context" in request body' });
    }
    const value = body.context;
    if (value === null || value === undefined) {
      return res.status(400).json({ error: 'context must be a string or a JSON value' });
    }
    // Strings are stored raw (a CLAUDE.md, AGENTS.md, exported session...);
    // any other JSON value is stored pretty-printed.
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_CONTEXT) {
      return res.status(400).json({
        error: `context is too large (${humanBytes(bytes)}; max ${humanBytes(MAX_CONTEXT)})`,
      });
    }
    await writeTextAtomic(contextFile(entry.id), text);
    entry.updatedAt = nowIso();
    await writeJsonAtomic(REGISTRY_FILE, reg);
    res.json({ ok: true, id: entry.id, bytes });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/context', async (req, res, next) => {
  try {
    const reg = await loadRegistry();
    const entry = await findSession(reg, req.params.id);
    if (!entry) return notFound(res);
    let text;
    try {
      text = await fsp.readFile(contextFile(entry.id), 'utf8');
    } catch {
      return res.status(404).json({ error: 'No context saved for this session yet' });
    }
    res.type('text/plain; charset=utf-8').send(text);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/chat', async (req, res, next) => {
  try {
    const reg = await loadRegistry();
    const entry = await findSession(reg, req.params.id);
    if (!entry) return notFound(res);

    const body = req.body || {};
    const role = typeof body.role === 'string' ? body.role.trim() : '';
    const text = body.text;
    if (!role) {
      return res.status(400).json({ error: 'role must be a non-empty string (user, assistant, system, ...)' });
    }
    if (typeof text !== 'string' || text === '') {
      return res.status(400).json({ error: 'text must be a non-empty string' });
    }
    if (text.length > MAX_CHAT_TEXT) {
      return res.status(400).json({ error: `text is too long (max ${MAX_CHAT_TEXT} characters)` });
    }
    const data = await readJson(chatFile(entry.id), { messages: [] });
    const messages = Array.isArray(data && data.messages) ? data.messages : [];
    messages.push({ role, text, at: nowIso() });
    const kept = messages.slice(-MAX_CHAT_MESSAGES); // drop the oldest beyond the cap
    await writeJsonAtomic(chatFile(entry.id), { messages: kept });
    entry.updatedAt = nowIso();
    await writeJsonAtomic(REGISTRY_FILE, reg);
    res.status(201).json({ ok: true, count: kept.length });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/chat', async (req, res, next) => {
  try {
    const reg = await loadRegistry();
    const entry = await findSession(reg, req.params.id);
    if (!entry) return notFound(res);
    const data = await readJson(chatFile(entry.id), { messages: [] });
    const messages = Array.isArray(data && data.messages) ? data.messages : [];
    res.json({ messages });
  } catch (err) {
    next(err);
  }
});

// "Or if I want to start a new chat": the brain (context.json) is kept,
// only the conversation is cleared.
router.post('/:id/new-chat', async (req, res, next) => {
  try {
    const reg = await loadRegistry();
    const entry = await findSession(reg, req.params.id);
    if (!entry) return notFound(res);
    await writeJsonAtomic(chatFile(entry.id), { messages: [] });
    entry.updatedAt = nowIso();
    await writeJsonAtomic(REGISTRY_FILE, reg);
    res.json({ ok: true, id: entry.id, contextKept: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Validate one user-supplied relative path for a stored file. Backslashes
 * become slashes, empty and "." segments are dropped, "..", absolute paths
 * and drive letters are refused. Returns the normalized posix rel path.
 */
function sanitizeRel(raw) {
  const p = String(raw == null ? '' : raw).replace(/\\/g, '/').trim();
  if (!p || p.includes('\0')) throw new PathError('Invalid file path');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) {
    throw new PathError(`File path must be relative (no leading "/" or drive): ${p.slice(0, 120)}`);
  }
  const parts = p.split('/').filter((s) => s !== '' && s !== '.');
  if (parts.length === 0) throw new PathError('Invalid file path');
  if (parts.some((s) => s === '..')) {
    throw new PathError(`File path must not contain "..": ${p.slice(0, 120)}`);
  }
  const rel = parts.join('/');
  if (rel.length > MAX_RELPATH) {
    throw new PathError(`File path is too long (max ${MAX_RELPATH} characters)`);
  }
  return rel;
}

router.post('/:id/files', async (req, res, next) => {
  try {
    const reg = await loadRegistry();
    const entry = await findSession(reg, req.params.id);
    if (!entry) return notFound(res);

    const files = (req.body || {}).files;
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'files must be a non-empty array of {path, contentBase64}' });
    }
    // Validate everything before writing anything: one bad file rejects the
    // whole request instead of leaving a partial upload behind.
    const decoded = [];
    let total = 0;
    for (const f of files) {
      const rel = sanitizeRel(f && f.path);
      const b64 = f && f.contentBase64;
      if (typeof b64 !== 'string') {
        return res.status(400).json({ error: `contentBase64 must be a string for ${rel}` });
      }
      const buf = Buffer.from(b64, 'base64');
      if (buf.length > MAX_FILE) {
        return res.status(400).json({
          error: `${rel} is too large (${humanBytes(buf.length)}; max ${humanBytes(MAX_FILE)} per file)`,
        });
      }
      total += buf.length;
      if (total > MAX_REQUEST) {
        return res.status(400).json({
          error: `Request too large (max ${humanBytes(MAX_REQUEST)} of files per request)`,
        });
      }
      decoded.push({ rel, buf });
    }
    for (const { rel, buf } of decoded) {
      // resolveSafe is the second guard after sanitizeRel: nothing escapes
      // the session's files/ folder.
      const abs = resolveSafe(rel, filesRoot(entry.id));
      try {
        await fsp.mkdir(path.dirname(abs), { recursive: true });
      } catch (err) {
        if (err.code === 'ENOTDIR' || err.code === 'EEXIST') {
          throw new PathError(`Cannot write ${rel}: a file occupies its parent folder`);
        }
        throw err;
      }
      try {
        await fsp.writeFile(abs, buf);
      } catch (err) {
        if (err.code === 'EISDIR') throw new PathError(`Cannot write ${rel}: it is a folder`);
        throw err;
      }
    }
    entry.updatedAt = nowIso();
    await writeJsonAtomic(REGISTRY_FILE, reg);
    res.status(201).json({ ok: true, saved: decoded.length });
  } catch (err) {
    next(err);
  }
});

async function walkFiles(dir, prefix, out) {
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return; // files/ not created yet -> empty listing
  }
  for (const ent of dirents) {
    if (ent.isSymbolicLink()) continue; // never follow links out of the session
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      await walkFiles(path.join(dir, ent.name), rel, out);
    } else if (ent.isFile()) {
      try {
        const st = await fsp.stat(path.join(dir, ent.name));
        out.push({ path: rel, size: st.size });
      } catch {
        // raced with a delete
      }
    }
  }
}

router.get('/:id/files', async (req, res, next) => {
  try {
    const reg = await loadRegistry();
    const entry = await findSession(reg, req.params.id);
    if (!entry) return notFound(res);
    const root = filesRoot(entry.id);

    if (typeof req.query.path === 'string' && req.query.path.trim() !== '') {
      const rel = sanitizeRel(req.query.path);
      const abs = resolveSafe(rel, root);
      let buf;
      try {
        buf = await fsp.readFile(abs);
      } catch (err) {
        if (err.code === 'EISDIR') throw new PathError(`Not a file: ${rel}`);
        if (err.code === 'ENOENT') {
          const e = new Error(`File not found: ${rel}`);
          e.status = 404;
          throw e;
        }
        throw err;
      }
      return res.json({ path: rel, contentBase64: buf.toString('base64') });
    }

    const files = [];
    await walkFiles(root, '', files);
    files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    res.json({ files });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const reg = await loadRegistry();
    const entry = await findSession(reg, req.params.id);
    if (!entry) return notFound(res);
    await fsp.rm(sessionDir(entry.id), { recursive: true, force: true });
    reg.sessions = reg.sessions.filter((s) => s.id !== entry.id);
    await writeJsonAtomic(REGISTRY_FILE, reg);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
