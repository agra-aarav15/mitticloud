// MittiAgent runner — one agent "tick": ask Gemini what to do, run one small
// local tool, feed the result back, repeat (max 4 tool rounds), finish with a
// short message for the owner.
//
// SECURITY: the tools are local and sandboxed on the owner's own device —
// the same trust level as the Sandbox and MittiOps (execFile, never a shell;
// safe-path guards on every filesystem access). The model only ever produces
// tool *arguments*; it cannot run arbitrary commands or reach outside the
// agent folders. Nothing here assumes untrusted callers.
//
// Wire protocol with the model (strict JSON, nothing else):
//   {"tool":{"name":"list_files","args":{"path":"."}}}   -> call a tool
//   {"say":"Done — wrote a note about the changes."}     -> finish the tick
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, resolveSafe } from './paths.js';

const execFileP = promisify(execFile);

// --- layout: everything the agent can touch lives under data/agent/ ---
export const AGENT_DIR = path.join(DATA_DIR, 'agent');
export const WORKSPACE_DIR = path.join(AGENT_DIR, 'workspace');
export const NOTES_DIR = path.join(AGENT_DIR, 'notes');
const TMP_DIR = path.join(AGENT_DIR, 'tmp');

// --- limits (mirror the Sandbox: execFile, 5s, 256 KiB — never shell:true) ---
const MAX_TOOL_ROUNDS = 4;
const LLM_TIMEOUT_MS = 30000;
const RUNJS_MAX_CODE = 20000;
const RUNJS_TIMEOUT_MS = 5000;
const MAX_BUFFER = 256 * 1024; // run_js output cap
const FETCH_TIMEOUT_MS = 8000;
const FETCH_MAX_BYTES = 256 * 1024; // fetch_url download cap
const MAX_NOTE_CHARS = 100000;
const TOOL_RESULT_CAP = 8000; // what the model sees per tool result
const ERROR_CAP = 2000;

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function randomId(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const capText = (s, max) =>
  typeof s === 'string' && s.length > max
    ? s.slice(0, max) + '…(truncated)'
    : s;

// --- key resolution: env wins, then data/agent/config.json .key ---

/** The Gemini API key for this tick, or null when none is set. */
export function resolveApiKey(config) {
  const env = process.env.MITTI_GEMINI_KEY;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  const key = config && config.key;
  if (typeof key === 'string' && key.trim() !== '') return key.trim();
  return null;
}

// --- Gemini call (global fetch, free-tier generateContent endpoint) ---

async function callGemini(key, prompt) {
  const res = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Gemini API error (HTTP ${res.status})`);
  }
  const data = await res.json().catch(() => null);
  const candidate = data && data.candidates && data.candidates[0];
  const text =
    candidate && candidate.content && candidate.content.parts && candidate.content.parts[0]
      ? candidate.content.parts[0].text
      : null;
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('Gemini returned an empty reply');
  }
  return text;
}

// --- strict-JSON parsing (tolerates ```json fences and stray prose) ---

function stripJsonFences(text) {
  const t = String(text || '').trim();
  const m = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/i);
  return (m ? m[1] : t).trim();
}

function parseModelJson(text) {
  const raw = stripJsonFences(text);
  try {
    return JSON.parse(raw);
  } catch {
    // fall through: try the first {...} block
  }
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s !== -1 && e > s) {
    try {
      return JSON.parse(raw.slice(s, e + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function toDecision(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.say === 'string' && obj.say.trim() !== '') {
    return { say: obj.say.trim() };
  }
  const t = obj.tool;
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    const name = typeof t.name === 'string' ? t.name.trim() : '';
    const args =
      t.args && typeof t.args === 'object' && !Array.isArray(t.args) ? t.args : {};
    if (Object.prototype.hasOwnProperty.call(TOOLS, name)) {
      return { tool: name, args };
    }
  }
  return null;
}

// --- tools (all local and safe) ---

/** Resolve a note name to an absolute path inside NOTES_DIR (rejects '..'). */
function noteAbs(args) {
  const name = args.name;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('name must be a non-empty string');
  }
  if (name.includes('..')) throw new Error('name cannot contain ".."');
  const withExt = /\.md$/i.test(name) ? name : name + '.md';
  return resolveSafe(withExt, NOTES_DIR);
}

/** list_files {path} — shallow listing under data/agent/workspace. */
export async function toolListFiles(args) {
  const rel = args.path === undefined || args.path === null ? '' : args.path;
  if (typeof rel !== 'string') {
    return { ok: false, result: 'Error: path must be a string' };
  }
  if (rel.includes('..')) {
    return { ok: false, result: 'Error: path cannot contain ".."' };
  }
  const abs = resolveSafe(rel, WORKSPACE_DIR);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st) {
    // first look at the workspace root: create it instead of erroring
    if (path.resolve(abs) === path.resolve(WORKSPACE_DIR)) {
      await fsp.mkdir(WORKSPACE_DIR, { recursive: true });
      return { ok: true, result: '(the workspace is empty)' };
    }
    return { ok: false, result: `Error: "${rel || '.'}" does not exist in the workspace` };
  }
  if (!st.isDirectory()) {
    return { ok: false, result: `Error: "${rel}" is a file, not a folder` };
  }
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  if (entries.length === 0) {
    return { ok: true, result: `(the folder "${rel || '.'}" is empty)` };
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  const lines = [];
  for (const d of entries.filter((e) => e.isDirectory()).sort(byName)) {
    lines.push(`dir   ${d.name}/`);
  }
  for (const f of entries.filter((e) => !e.isDirectory()).sort(byName)) {
    const s = await fsp.stat(path.join(abs, f.name)).catch(() => null);
    lines.push(`file  ${f.name}${s ? ` (${s.size} B)` : ''}`);
  }
  return { ok: true, result: lines.join('\n') };
}

/** read_note {name} — read a markdown note from data/agent/notes. */
export async function toolReadNote(args) {
  let abs;
  try {
    abs = noteAbs(args);
  } catch (err) {
    return { ok: false, result: `Error: ${err.message}` };
  }
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) {
    return { ok: false, result: `Error: the note "${args.name}" does not exist` };
  }
  const text = await fsp.readFile(abs, 'utf8');
  return { ok: true, result: text.length > 0 ? text : '(the note is empty)' };
}

/** write_note {name, content} — create or overwrite a markdown note. */
export async function toolWriteNote(args) {
  const content = args.content;
  if (typeof content !== 'string') {
    return { ok: false, result: 'Error: content must be a string' };
  }
  if (content.length > MAX_NOTE_CHARS) {
    return {
      ok: false,
      result: `Error: content is too long (max ${MAX_NOTE_CHARS} characters)`,
    };
  }
  let abs;
  try {
    abs = noteAbs(args);
  } catch (err) {
    return { ok: false, result: `Error: ${err.message}` };
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  // atomic write: temp file + rename (never half-written)
  const tmp = abs + '.tmp-' + randomId(6);
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, abs);
  return {
    ok: true,
    result: `Wrote note "${path.basename(abs)}" (${content.length} characters)`,
  };
}

// run_js shares the Sandbox execution approach: a temp file + execFile node
// (never a shell), 5s timeout, 256 KiB output cap. Timeout / non-zero exit /
// spawn-failure handled exactly like routes/sandbox.js runSnippet().

async function runSnippetFile(file) {
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileP('node', [file], {
      timeout: RUNJS_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      cwd: WORKSPACE_DIR,
    });
    return {
      stdout: stdout || '',
      stderr: stderr || '',
      durationMs: Date.now() - started,
      timedOut: false,
    };
  } catch (err) {
    // Killed by our timeout.
    if (err.killed || err.signal === 'SIGTERM' || err.signal === 'SIGKILL') {
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || '',
        durationMs: Date.now() - started,
        timedOut: true,
      };
    }
    // Non-zero exit (exception, syntax error) is still a valid run.
    if (typeof err.stdout === 'string' || typeof err.stderr === 'string') {
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || '',
        durationMs: Date.now() - started,
        timedOut: false,
      };
    }
    throw err; // spawn failure (ENOENT etc.)
  }
}

/** run_js {code} — run a short Node.js snippet (temp file + execFile node). */
export async function toolRunJs(args) {
  const code = args.code;
  if (typeof code !== 'string' || code.trim() === '') {
    return { ok: false, result: 'Error: code must be a non-empty string' };
  }
  if (code.length > RUNJS_MAX_CODE) {
    return {
      ok: false,
      result: `Error: code is too long (max ${RUNJS_MAX_CODE} characters)`,
    };
  }
  await fsp.mkdir(WORKSPACE_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  const file = path.join(TMP_DIR, `run-${randomId(10)}.js`);
  await fsp.writeFile(file, code, 'utf8');
  try {
    const r = await runSnippetFile(file);
    const parts = [];
    if (r.timedOut) {
      parts.push(`Timed out after ${RUNJS_TIMEOUT_MS / 1000}s — the process was killed.`);
    } else {
      parts.push(`Finished in ${r.durationMs} ms.`);
    }
    if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
    if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
    if (!r.stdout && !r.stderr && !r.timedOut) parts.push('(no output)');
    return { ok: !r.timedOut, result: parts.join('\n') };
  } catch (err) {
    return {
      ok: false,
      result: `Error: could not start Node.js (${err && err.message ? err.message : err})`,
    };
  } finally {
    await fsp.rm(file, { force: true }).catch(() => {});
  }
}

/** Cap a download at maxBytes by streaming, then hand back plain text. */
async function readBodyCapped(res, maxBytes) {
  if (!res.body) return '';
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buf);
    total += buf.length;
    if (total >= maxBytes) break;
  }
  await res.body.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
}

/** fetch_url {url} — GET a page as plain text (http/https, 8s, 256 KiB cap). */
export async function toolFetchUrl(args) {
  const url = args.url;
  if (typeof url !== 'string' || url.trim() === '') {
    return { ok: false, result: 'Error: url must be a non-empty string' };
  }
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, result: 'Error: url is not a valid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, result: 'Error: only http and https URLs are allowed' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, result: 'Error: URLs with a username or password are not allowed' };
  }
  let res;
  try {
    res = await fetch(parsed, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'MittiAgent/1.0 (MittiCloud)',
        Accept: 'text/plain, text/*;q=0.9, */*;q=0.8',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return timedOut
      ? { ok: false, result: `Error: the request timed out after ${FETCH_TIMEOUT_MS / 1000}s` }
      : { ok: false, result: `Error: the request failed (${err && err.message ? err.message : err})` };
  }
  if (!res.ok) {
    return { ok: false, result: `Error: the server answered HTTP ${res.status}` };
  }
  const text = await readBodyCapped(res, FETCH_MAX_BYTES);
  if (text.trim() === '') return { ok: true, result: '(the page was empty)' };
  return { ok: true, result: text };
}

const TOOLS = {
  list_files: toolListFiles,
  read_note: toolReadNote,
  write_note: toolWriteNote,
  run_js: toolRunJs,
  fetch_url: toolFetchUrl,
};

async function runTool(name, args) {
  try {
    return await TOOLS[name](args || {});
  } catch (err) {
    return {
      ok: false,
      result: `Error: ${err && err.message ? err.message : String(err)}`,
    };
  }
}

// --- the tick itself ---

function systemPrompt(instruction) {
  return [
    'You are MittiAgent, a small background helper that runs on the owner\'s Android phone (MittiCloud).',
    'You work quietly on one instruction, using a few tools, then stop.',
    '',
    'STANDING INSTRUCTION FROM THE OWNER:',
    instruction,
    '',
    'Tools you may call:',
    '- list_files {"path": "sub/folder"} — shallow listing of the agent workspace folder.',
    '- read_note {"name": "note-name"} — read a markdown note from the notes folder.',
    '- write_note {"name": "note-name", "content": "..."} — create or overwrite a markdown note.',
    '- run_js {"code": "..."} — run a short Node.js snippet (5s limit) in the workspace. console.log is captured.',
    '- fetch_url {"url": "https://..."} — fetch a web page as plain text (http/https only, 8s limit).',
    '',
    'Reply with STRICT JSON only — no prose, no markdown. Exactly one of:',
    '{"tool":{"name":"<tool name>","args":{...}}}',
    '{"say":"<short final message for the owner>"}',
    `After each tool result you may call another tool (at most ${MAX_TOOL_ROUNDS} tool calls in total) or finish with {"say":...}.`,
    'The final message must be short, plain and useful, in simple English, with no emojis.',
  ].join('\n');
}

function buildPrompt(instruction, transcript, mustFinish) {
  const parts = [systemPrompt(instruction)];
  if (transcript.length > 0) {
    parts.push('CONVERSATION SO FAR:');
    for (const t of transcript) {
      const who =
        t.role === 'model' ? 'YOU REPLIED' : t.role === 'tool' ? 'TOOL RESULT' : 'SYSTEM NOTE';
      parts.push(`${who}:\n${t.text}`);
    }
  }
  parts.push(
    mustFinish
      ? 'You have no tool calls left. Reply now with {"say":"..."} — strict JSON, nothing else.'
      : 'Begin now. Reply with strict JSON only.'
  );
  return parts.join('\n\n');
}

/**
 * Run one agent tick: Gemini decides which tool to call (if any), tools run
 * locally, the model finishes with a short "say" message.
 * Returns { ok, say, toolCalls, ms } or { ok:false, error, toolCalls, ms },
 * or { needsKey:true, hint } when no Gemini key is configured.
 */
export async function runAgentTick(config) {
  const started = Date.now();
  const instruction =
    config && typeof config.instruction === 'string' ? config.instruction.trim() : '';
  if (instruction === '') {
    return { ok: false, toolCalls: 0, ms: 0, error: 'Set a standing instruction first' };
  }
  const key = resolveApiKey(config);
  if (!key) {
    return { needsKey: true, hint: 'Get a free key at aistudio.google.com' };
  }

  const transcript = [];
  let toolCalls = 0;
  const maxCalls = MAX_TOOL_ROUNDS + 1; // tool rounds + one forced final answer

  for (let call = 0; call < maxCalls; call++) {
    const mustFinish = toolCalls >= MAX_TOOL_ROUNDS || call === maxCalls - 1;
    let text;
    try {
      text = await callGemini(key, buildPrompt(instruction, transcript, mustFinish));
    } catch (err) {
      return {
        ok: false,
        toolCalls,
        ms: Date.now() - started,
        error: capText(`Gemini call failed: ${err && err.message ? err.message : err}`, ERROR_CAP),
      };
    }

    const decision = toDecision(parseModelJson(text));
    if (!decision) {
      // Nudge the model back to the strict-JSON contract (still bounded).
      transcript.push({ role: 'model', text: capText(text, TOOL_RESULT_CAP) });
      transcript.push({
        role: 'system',
        text: 'That was not valid JSON. Reply with strict JSON only: {"tool":{"name":"...","args":{...}}} or {"say":"..."}',
      });
      continue;
    }

    if (decision.say) {
      return { ok: true, say: decision.say, toolCalls, ms: Date.now() - started };
    }

    toolCalls += 1;
    const outcome = await runTool(decision.tool, decision.args);
    transcript.push({
      role: 'model',
      text: JSON.stringify({ tool: { name: decision.tool, args: decision.args } }),
    });
    transcript.push({
      role: 'tool',
      text: `TOOL RESULT (${decision.tool}):\n${capText(outcome.result, TOOL_RESULT_CAP)}`,
    });
  }

  return {
    ok: false,
    toolCalls,
    ms: Date.now() - started,
    error: 'The agent used all its tool rounds without a final answer',
  };
}
