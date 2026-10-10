// MCP core — the Model Context Protocol surface of MittiCloud, shared by BOTH
// transports: POST /mcp (HTTP, for remote AI apps over tunnel/Tailscale) and
// scripts/mitti-mcp.mjs (stdio proxy that forwards to /mcp, for AI apps on
// this machine). Pure JSON-RPC 2.0, zero dependencies.
//
// Auth happens BEFORE this module: the caller passes the verified client-key
// record in. Tools only do what the phone's owner granted a key for — file
// tools are jailed to vault/files through the same resolveSafe() as the
// editor, writes are atomic, caps match the editor's.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { FILES_DIR, PHOTOS_DIR, DATA_DIR, resolveSafe, PathError } from './paths.js';
import {
  listApps,
  startApp,
  stopApp,
  appState,
  getRecord,
  installLog,
  AppError,
} from './apprunner.js';
import { get as storeGet } from './store.js';

const VERSION = '0.15.0';
const READ_CAP = 100 * 1024; // read_file returns at most 100 KB of text
const WRITE_CAP = 200 * 1024; // same ceiling as the editor's save
const CONTEXT_CAP = 20 * 1024; // memory_context returns at most 20 KB

// --- tool definitions (MCP inputSchema = JSON Schema) ---

const TOOLS = [
  {
    name: 'server_status',
    description:
      'MittiCloud pocket cloud status: version, uptime, free memory, hosted sites and live apps with their states and ports.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_files',
    description: 'List a folder in the cloud drive (vault/files). Empty dir = the root.',
    inputSchema: {
      type: 'object',
      properties: { dir: { type: 'string', description: 'folder path relative to the drive root' } },
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file from the cloud drive (max 100 KB). Binary files are refused.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'file path relative to the drive root' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite a text file in the cloud drive (max 200 KB). Parent folders must exist.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path relative to the drive root' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_photos',
    description: 'Count the photos backed up to this cloud and their total size.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_sites',
    description: 'List the static websites hosted on this cloud.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_apps',
    description: 'List the live node apps hosted on this cloud with their state, port and entry file.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'start_app',
    description: 'Start a hosted node app by name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'stop_app',
    description: 'Stop a running hosted app by name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'app_logs',
    description: 'Read the recent output of a hosted app (its stdout/stderr ring buffer).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        lines: { type: 'number', description: 'how many recent lines (default 40, max 200)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'memory_context',
    description:
      'Read a project memory saved by a laptop pairing session (mitti-bridge) — the context window snapshot, capped at 20 KB.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'memory name (or 8-char id)' } },
      required: ['name'],
    },
  },
]

// --- helpers ---

function humanBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(1)} ${units[i]}`;
}

function looksBinary(buf) {
  const head = buf.subarray(0, 8000);
  if (head.includes(0)) return true;
  let controls = 0;
  for (const b of head) {
    if (b < 9 || (b > 13 && b < 32)) controls++;
  }
  return head.length > 0 && controls / head.length > 0.06;
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text: String(text) }], ...(isError ? { isError: true } : {}) };
}

function readSitesRegistry() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sites.json'), 'utf8'));
    return Array.isArray(j) ? j : Array.isArray(j.sites) ? j.sites : [];
  } catch {
    return [];
  }
}

// --- tool implementations (each returns a result object; throw Error for
//     honest tool errors — they come back as isError, not protocol failures) ---

const IMPL = {
  server_status() {
    const started = storeGet('lastStartedAt', null);
    const upMs = started ? Date.now() - Date.parse(started) : process.uptime() * 1000;
    const upH = Math.floor(upMs / 3600000);
    const upM = Math.round((upMs % 3600000) / 60000);
    const sites = readSitesRegistry();
    const apps = safeListApps();
    const running = apps.filter((a) => a.state === 'running');
    const lines = [
      `MittiCloud v${VERSION}`,
      `uptime: ${upH}h ${upM}m`,
      `free memory: ${humanBytes(os.freemem())}`,
      `sites: ${sites.length} hosted (${sites.map((s) => s.name).join(', ') || 'none'})`,
      `apps: ${apps.length} (${running.length} running${
        running.length ? ' — ' + running.map((a) => `${a.name}:${a.port}`).join(', ') : ''
      })`,
    ];
    return textResult(lines.join('\n'));
  },

  list_files(args) {
    const rel = String(args?.dir ?? '');
    const abs = resolveSafe(rel, FILES_DIR);
    const ents = fs.readdirSync(abs, { withFileTypes: true });
    const rows = ents.map((e) => {
      let size = '';
      if (e.isFile()) {
        try {
          size = ` ${humanBytes(fs.statSync(path.join(abs, e.name)).size)}`;
        } catch {
          /* raced away */
        }
      }
      return `${e.isDirectory() ? 'dir ' : 'file'} ${e.name}${size}`;
    });
    return textResult(rows.length ? rows.join('\n') : '(empty folder)');
  },

  read_file(args) {
    const rel = String(args?.path ?? '');
    if (!rel) throw new Error('path is required');
    const abs = resolveSafe(rel, FILES_DIR);
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new Error(`Not a file: ${rel}`);
    if (st.size > READ_CAP * 4) throw new Error(`Too large to read over MCP (over ${humanBytes(READ_CAP * 4)})`);
    const buf = fs.readFileSync(abs);
    if (looksBinary(buf)) throw new Error('Binary file — MCP reads text only');
    let text = buf.toString('utf8');
    let note = '';
    if (buf.length > READ_CAP) {
      text = text.slice(0, READ_CAP);
      note = `\n... (truncated at ${humanBytes(READ_CAP)} of ${humanBytes(buf.length)})`;
    }
    return textResult(text + note);
  },

  write_file(args) {
    const rel = String(args?.path ?? '');
    const content = typeof args?.content === 'string' ? args.content : '';
    if (!rel) throw new Error('path is required');
    if (Buffer.byteLength(content, 'utf8') > WRITE_CAP) {
      throw new Error(`Content over the ${humanBytes(WRITE_CAP)} MCP write cap`);
    }
    const abs = resolveSafe(rel, FILES_DIR);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      throw new Error(`That path is a folder: ${rel}`);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = abs + '.mitti-mcp-tmp';
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, abs);
    return textResult(`Wrote ${rel} (${humanBytes(Buffer.byteLength(content, 'utf8'))})`);
  },

  list_photos() {
    let count = 0;
    let bytes = 0;
    try {
      for (const e of fs.readdirSync(PHOTOS_DIR, { withFileTypes: true })) {
        if (e.isFile()) {
          count++;
          try {
            bytes += fs.statSync(path.join(PHOTOS_DIR, e.name)).size;
          } catch {
            /* raced */
          }
        }
      }
    } catch {
      /* no photos dir yet */
    }
    return textResult(`${count} photos backed up, ${humanBytes(bytes)} total`);
  },

  list_sites() {
    const sites = readSitesRegistry();
    if (!sites.length) return textResult('No sites hosted yet.');
    return textResult(
      sites.map((s) => `${s.name} — http://<this-cloud>/s/${s.name}/`).join('\n')
    );
  },

  list_apps() {
    const apps = safeListApps();
    if (!apps.length) return textResult('No apps hosted yet.');
    return textResult(
      apps
        .map((a) => {
          const st = appState(a.name) || {};
          const port = st.port || a.port;
          return `${a.name} — ${a.state || st.state || 'stopped'}${port ? ` on port ${port}` : ''}${
            a.entry ? ` (entry: ${a.entry})` : ''
          }`;
        })
        .join('\n')
    );
  },

  async start_app(args) {
    const name = String(args?.name ?? '');
    const r = await startApp(name);
    return textResult(`${name} is ${r.port ? `running on port ${r.port}` : 'starting'}`);
  },

  stop_app(args) {
    const name = String(args?.name ?? '');
    stopApp(name);
    return textResult(`${name} stopped`);
  },

  app_logs(args) {
    const name = String(args?.name ?? '');
    // a name nobody deployed is honest 404; an installed-but-never-started
    // app simply has no output yet
    if (!getRecord(name)) throw Object.assign(new Error('No such app'), { status: 404 });
    const cap = Math.max(1, Math.min(200, Number(args?.lines) || 40));
    const st = appState(name);
    const install = installLog(name);
    const lines = [
      ...(install ? ['--- npm install ---', ...String(install).split('\n')] : []),
      ...st.logs,
    ];
    return textResult(lines.slice(-cap).join('\n') || '(no output yet)');
  },

  memory_context(args) {
    const wanted = String(args?.name ?? '').trim().toLowerCase();
    if (!wanted) throw new Error('name is required');
    let reg = [];
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'bridge.json'), 'utf8'));
      reg = Array.isArray(j) ? j : Array.isArray(j.sessions) ? j.sessions : [];
    } catch {
      throw new Error('No project memories exist yet');
    }
    const entry = reg.find(
      (s) =>
        String(s?.id || '').toLowerCase() === wanted ||
        String(s?.name || '').toLowerCase() === wanted
    );
    if (!entry) throw new Error(`No memory named "${wanted}" — try memory_context after listing them via the Remote tab`);
    let text;
    try {
      text = fs.readFileSync(path.join(DATA_DIR, 'bridge', entry.id, 'context.json'), 'utf8');
    } catch {
      throw new Error(`Memory "${entry.name}" has no context saved yet`);
    }
    const note =
      text.length > CONTEXT_CAP ? `\n... (truncated at ${humanBytes(CONTEXT_CAP)} of ${humanBytes(text.length)})` : '';
    return textResult(`# ${entry.name}\n\n` + text.slice(0, CONTEXT_CAP) + note);
  },
};

function safeListApps() {
  try {
    return listApps();
  } catch {
    return [];
  }
}

// --- JSON-RPC handling ---

/** Handle one JSON-RPC request object; returns a response object, or null
 *  for notifications (they get no reply). `client` is the redacted key record. */
export async function handleRpc(body, client) {
  if (!body || typeof body !== 'object' || body.jsonrpc !== '2.0') {
    return err(-32600, 'Not a JSON-RPC 2.0 request');
  }
  const { id, method, params } = body;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'mitticloud', title: 'MittiCloud', version: VERSION },
        instructions:
          'Tools for a personal pocket cloud (files, photos, hosted sites and live node apps). File paths are relative to the cloud drive root.',
      },
    };
  }
  if (method === 'notifications/initialized') return null; // notification
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return rpcErr(id, -32602, `Unknown tool: ${name}`);
    try {
      const result = await IMPL[name](params?.arguments || {});
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      const status = err?.status || (err instanceof AppError ? 400 : undefined);
      const msg =
        status === 404
          ? `No such app: ${params?.arguments?.name || '?'}`
          : err instanceof PathError
            ? `Refused: ${err.message}`
            : err?.message || 'Tool failed';
      return { jsonrpc: '2.0', id, result: textResult(msg, true) };
    }
  }
  return rpcErr(id, -32601, `Method not supported: ${method}`);
}

function rpcErr(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function err(code, message) {
  return rpcErr(null, code, message);
}
