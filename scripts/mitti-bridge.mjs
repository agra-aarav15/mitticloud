#!/usr/bin/env node
// mitti-bridge — move a coding agent's brain into MittiCloud (Cloud Mode).
//
// Zero dependencies, Node >= 20 (global fetch). The MittiCloud phone stores
// a session's context window snapshot, chat history and project files. Push
// them from the laptop, resume them on any device — or start a new chat and
// keep the context:
//
//   node mitti-bridge.mjs new my-project
//   node mitti-bridge.mjs save abc12345 ./CLAUDE.md
//   node mitti-bridge.mjs push abc12345 ./src
//   node mitti-bridge.mjs resume abc12345
//
// Env: MITTI_URL — MittiCloud base URL (default http://localhost:7333)
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.MITTI_URL || 'http://localhost:7333').replace(/\/+$/, '');
const API = BASE + '/api/bridge/sessions';

const MAX_FILE_BYTES = 5 * 1024 * 1024; // server rejects files over 5 MB
const MAX_BATCH_BYTES = 40 * 1024 * 1024; // server cap is 50 MB per request
const MAX_BATCH_FILES = 25;
const MAX_CONTEXT_BYTES = 8 * 1024 * 1024; // server cap for context
const MAX_CHAT_TEXT = 200000; // server cap per chat message
const SKIP_DIRS = new Set(['node_modules', '.git']);

const USAGE = `mitti-bridge — move a coding agent's brain into MittiCloud (Cloud Mode)

The MittiCloud phone stores a session's context window snapshot, chat
history and project files. Push them from the laptop, resume them on any
device — or start a new chat and keep the context.

Usage:
  node mitti-bridge.mjs <command> [arguments]

Commands:
  new <name>
      Create a session; prints its id.

  list
      List all sessions with context size, chat and file counts.

  save <session> <contextFile> [--chat <chatFile>]
      Upload a context file (a CLAUDE.md, AGENTS.md, or any coding agent's
      exported session/JSONL) and optionally a chat log file (a JSON array
      of {role, text}).

  push <session> <folder>
      Upload every file in a folder, recursively. Skips node_modules, .git
      and files over 5 MB (with a notice).

  resume <session>
      Print the saved context, then the chat transcript, so you can prime
      any CLI agent with it.

  chat <session> <role> <text...>
      Append one chat message (role: user, assistant, system, ...).

  new-chat <session>
      Keep the context, clear the chat.

  help
      Show this text.

Environment:
  MITTI_URL    MittiCloud base URL (default http://localhost:7333)

Examples:
  node mitti-bridge.mjs new my-app
  node mitti-bridge.mjs save abc12345 ./CLAUDE.md --chat ./session.json
  node mitti-bridge.mjs push abc12345 ./src
  node mitti-bridge.mjs resume abc12345`;

// --- helpers ---

function humanBytes(n) {
  if (n == null) return '0 B';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + units[i];
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

const sendJson = (method, payload) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

function friendlyFetchError(err) {
  const code = err && err.cause && err.cause.code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || err.name === 'TypeError') {
    return new Error(`Could not reach MittiCloud at ${BASE} — is the server running?`);
  }
  return err;
}

/** Fetch a bridge endpoint; throw a clear Error on non-200. */
async function api(rel, opts = {}) {
  let res;
  try {
    res = await fetch(API + rel, opts);
  } catch (err) {
    throw friendlyFetchError(err);
  }
  const bodyText = await res.text();
  let body = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    // non-JSON body: keep the text for the error message
  }
  if (!res.ok) {
    const msg = (body && body.error) || bodyText.slice(0, 300) || res.statusText;
    const e = new Error(`HTTP ${res.status} — ${msg}`);
    e.status = res.status;
    throw e;
  }
  return body;
}

/** GET an endpoint and return the raw text; null on 404, throw otherwise. */
async function apiText(rel) {
  let res;
  try {
    res = await fetch(API + rel);
  } catch (err) {
    throw friendlyFetchError(err);
  }
  if (res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).error || text;
    } catch {
      // keep raw text
    }
    const e = new Error(`HTTP ${res.status} — ${String(msg).slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  return text;
}

function needArgs(args, usage) {
  if (args.length < 1 || !args[0]) {
    console.error('Usage: node mitti-bridge.mjs ' + usage);
    process.exit(1);
  }
}

// --- commands ---

async function cmdNew(args) {
  const name = args.join(' ').trim();
  if (!name) {
    console.error('Usage: node mitti-bridge.mjs new <name>');
    process.exit(1);
  }
  const s = await api('', sendJson('POST', { name }));
  console.log('Session created: ' + s.name);
  console.log('id: ' + s.id);
  console.log(`Resume it anywhere with: node mitti-bridge.mjs resume ${s.id}`);
}

async function cmdList() {
  const { sessions } = await api('');
  if (!sessions.length) {
    console.log(`No sessions yet at ${BASE}.`);
    console.log('Create one: node mitti-bridge.mjs new <name>');
    return;
  }
  console.log(`${sessions.length} session(s) at ${BASE}\n`);
  for (const s of sessions) {
    const name = String(s.name).length > 32 ? String(s.name).slice(0, 31) + '...' : String(s.name);
    console.log(
      `${s.id}  ${name.padEnd(33)}  ctx ${humanBytes(s.contextBytes).padStart(8)}` +
        `  ${String(s.chatCount).padStart(4)} chats  ${String(s.fileCount).padStart(4)} files  ${timeAgo(s.updatedAt)}`
    );
  }
}

async function cmdSave(args) {
  let chatFileArg = null;
  const chatIdx = args.indexOf('--chat');
  if (chatIdx !== -1) {
    chatFileArg = args[chatIdx + 1];
    args.splice(chatIdx, 2);
    if (!chatFileArg) {
      console.error('--chat needs a file path');
      process.exit(1);
    }
  }
  const [session, contextFile] = args;
  if (!session || !contextFile) {
    console.error('Usage: node mitti-bridge.mjs save <session> <contextFile> [--chat <chatFile>]');
    process.exit(1);
  }
  const ctxText = fs.readFileSync(contextFile, 'utf8');
  const bytes = Buffer.byteLength(ctxText, 'utf8');
  if (bytes > MAX_CONTEXT_BYTES) {
    throw new Error(
      `${contextFile} is ${humanBytes(bytes)} — the server caps context at ${humanBytes(MAX_CONTEXT_BYTES)}`
    );
  }
  await api(`/${encodeURIComponent(session)}/context`, sendJson('PUT', { context: ctxText }));
  console.log(`Context saved: ${contextFile} (${humanBytes(bytes)}) -> session ${session}`);

  if (chatFileArg) {
    const raw = fs.readFileSync(chatFileArg, 'utf8');
    let list;
    try {
      list = JSON.parse(raw);
    } catch {
      throw new Error(`${chatFileArg} is not valid JSON (expected an array of {role, text})`);
    }
    if (!Array.isArray(list)) {
      throw new Error(`${chatFileArg} must be a JSON array of {role, text}`);
    }
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m || typeof m.role !== 'string' || !m.role || typeof m.text !== 'string' || !m.text) {
        console.log(`skip (not {role, text}): entry ${i}`);
        continue;
      }
      if (m.text.length > MAX_CHAT_TEXT) {
        console.log(`skip (text over ${MAX_CHAT_TEXT} chars): entry ${i}`);
        continue;
      }
      await api(`/${encodeURIComponent(session)}/chat`, sendJson('POST', { role: m.role, text: m.text }));
      n++;
    }
    console.log(`Chat appended: ${n} message(s) from ${chatFileArg}`);
  }
}

function collectFiles(rootDir) {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(full);
      } else if (ent.isFile()) {
        out.push(full);
      }
    }
  };
  walk(rootDir);
  return out;
}

async function cmdPush(args) {
  const [session, folder] = args;
  if (!session || !folder) {
    console.error('Usage: node mitti-bridge.mjs push <session> <folder>');
    process.exit(1);
  }
  const root = path.resolve(folder);
  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch {
    throw new Error(`Folder not found: ${root}`);
  }
  if (!rootStat.isDirectory()) throw new Error(`Not a folder: ${root}`);

  let skippedBig = 0;
  let skippedDirs = 0;
  const picked = [];
  const scan = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) {
          skippedDirs++;
          continue;
        }
        scan(full);
      } else if (ent.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        const size = fs.statSync(full).size;
        if (size > MAX_FILE_BYTES) {
          skippedBig++;
          console.log(`skip (over 5 MB): ${rel}`);
          continue;
        }
        picked.push({ rel, size });
      }
    }
  };
  scan(root);

  let uploaded = 0;
  let batch = [];
  let batchBytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    const files = [];
    for (const item of batch) {
      const abs = path.join(root, ...item.rel.split('/'));
      files.push({ path: item.rel, contentBase64: fs.readFileSync(abs).toString('base64') });
    }
    await api(`/${encodeURIComponent(session)}/files`, sendJson('POST', { files }));
    uploaded += batch.length;
    console.log(`uploaded ${uploaded}/${picked.length} files`);
    batch = [];
    batchBytes = 0;
  };
  for (const item of picked) {
    if (batch.length >= MAX_BATCH_FILES || batchBytes + item.size > MAX_BATCH_BYTES) {
      await flush();
    }
    batch.push(item);
    batchBytes += item.size;
  }
  await flush();

  console.log(`Done: ${uploaded} file(s) pushed to session ${session} from ${root}`);
  if (skippedBig) console.log(`Skipped ${skippedBig} file(s) over 5 MB`);
  if (skippedDirs) console.log(`Skipped ${skippedDirs} folder(s) (node_modules, .git)`);
}

async function cmdResume(args) {
  needArgs(args, 'resume <session>');
  const session = args[0];
  const context = await apiText(`/${encodeURIComponent(session)}/context`);
  if (context != null) {
    console.log('=== CONTEXT ===');
    console.log(context.trimEnd());
    console.log('');
  } else {
    console.log('(no context saved for this session yet)');
    console.log('');
  }
  const { messages } = await api(`/${encodeURIComponent(session)}/chat`);
  if (messages.length) {
    console.log(`=== CHAT (${messages.length}) ===`);
    for (const m of messages) {
      console.log(`[${m.role}] ${String(m.text)}`);
    }
    console.log('');
  } else {
    console.log('(no chat messages)');
    console.log('');
  }
  console.log(
    `Paste this into your agent to continue, or start a new chat: node mitti-bridge.mjs new-chat ${session}`
  );
}

async function cmdChat(args) {
  const [session, role, ...rest] = args;
  const text = rest.join(' ').trim();
  if (!session || !role || !text) {
    console.error('Usage: node mitti-bridge.mjs chat <session> <role> <text...>');
    process.exit(1);
  }
  await api(`/${encodeURIComponent(session)}/chat`, sendJson('POST', { role, text }));
  console.log(`Chat message added (${role}) to session ${session}`);
}

async function cmdNewChat(args) {
  needArgs(args, 'new-chat <session>');
  const session = args[0];
  await api(`/${encodeURIComponent(session)}/new-chat`, sendJson('POST', {}));
  console.log(`New chat started for session ${session} — context kept, chat cleared.`);
}

// --- dispatch ---

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) {
    console.log(USAGE);
    process.exit(1);
  }
  switch (cmd) {
    case 'new':
      return cmdNew(args);
    case 'list':
      return cmdList();
    case 'save':
      return cmdSave(args);
    case 'push':
      return cmdPush(args);
    case 'resume':
      return cmdResume(args);
    case 'chat':
      return cmdChat(args);
    case 'new-chat':
      return cmdNewChat(args);
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error: ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
