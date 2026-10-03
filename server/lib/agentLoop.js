// The Agent Server loop: the model is the brain, these tools are the hands.
// Tools act for real inside the session's workspace folder (path-jailed via
// resolveSafe). The loop stores every step in the session file as it happens,
// so a phone browser polling the server sees the work progress live and a
// session survives a restart mid-turn.
import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveSafe, PathError } from './paths.js';
import { callBrain } from './agentProviders.js';

const execP = promisify(exec);

const MAX_STEPS = 10; // tool round-trips per user message
const READ_CAP = 64 * 1024; // read_file returns at most this many bytes
const OUT_CAP = 8 * 1024; // command output cap
const CMD_TIMEOUT_MS = 120 * 1000;

// --- tools (provider-neutral declarations) ---

export const TOOL_SPECS = [
  {
    name: 'list_files',
    description:
      'List the files and folders in the workspace, or in a subfolder of it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Subfolder relative to the workspace. Empty means the workspace root.' },
      },
      required: [],
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file from the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace.' },
        content: { type: 'string', description: 'The full new content of the file.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_command',
    description:
      'Run a shell command inside the workspace folder and return its real output. Use it for builds, scripts, git, file inspection — anything a terminal can do. Times out after 120 seconds.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run.' },
      },
      required: ['command'],
    },
  },
];

function capText(s, cap = OUT_CAP) {
  const t = String(s ?? '');
  return t.length > cap ? t.slice(0, cap) + `\n… (output cut at ${cap} bytes)` : t;
}

async function toolListFiles(args, root) {
  const dir = resolveSafe(args.path || '.', root);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const lines = [];
  for (const e of entries.slice(0, 500)) {
    let size = '';
    if (e.isFile()) {
      try {
        size = ` (${(await fs.stat(path.join(dir, e.name))).size} bytes)`;
      } catch {
        // file vanished between readdir and stat — list it anyway
      }
    }
    lines.push(`${e.isDirectory() ? '[dir] ' : '      '}${e.name}${size}`);
  }
  return capText(lines.join('\n') || '(empty folder)');
}

async function toolReadFile(args, root) {
  const file = resolveSafe(args.path, root);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error(`No such file: ${args.path}`);
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(stat.size, READ_CAP));
    await fh.read(buf, 0, buf.length, 0);
    return capText(buf.toString('utf8'), READ_CAP);
  } finally {
    await fh.close();
  }
}

async function toolWriteFile(args, root) {
  if (typeof args.content !== 'string') throw new Error('write_file needs string content');
  const file = resolveSafe(args.path, root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, args.content, 'utf8');
  return `Wrote ${Buffer.byteLength(args.content, 'utf8')} bytes to ${args.path}`;
}

// The agent's shell commands get a scrubbed environment: secrets the server
// holds (lock token, API keys, battery hook) never leak into model-driven
// child processes.
const SCRUB_ENV = /TOKEN|KEY|SECRET|PASSWORD|MITTI_FAKE/i;

async function toolRunCommand(args, root) {
  const command = String(args.command || '').trim();
  if (!command) throw new Error('run_command needs a command');
  const childEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!SCRUB_ENV.test(k)) childEnv[k] = v;
  }
  childEnv.MITTI_AGENT = '1';
  try {
    const { stdout, stderr } = await execP(command, {
      cwd: root,
      timeout: CMD_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: childEnv,
    });
    const out = capText(stdout) + (stderr ? `\n[stderr]\n${capText(stderr)}` : '');
    return out.trim() || '(no output)';
  } catch (err) {
    const stdout = err.stdout ? capText(err.stdout) : '';
    const stderr = err.stderr ? capText(err.stderr) : '';
    const timedOut = err.killed || /timed out/i.test(String(err.message));
    const why = timedOut ? `timed out after ${CMD_TIMEOUT_MS / 1000}s` : `exit code ${err.code ?? '?'}`;
    return `Command failed (${why}).${stdout ? `\n[stdout]\n${stdout}` : ''}${
      stderr ? `\n[stderr]\n${stderr}` : ''
    }`;
  }
}

export async function runTool(name, args, root) {
  try {
    switch (name) {
      case 'list_files':
        return { ok: true, output: await toolListFiles(args || {}, root) };
      case 'read_file':
        return { ok: true, output: await toolReadFile(args || {}, root) };
      case 'write_file':
        return { ok: true, output: await toolWriteFile(args || {}, root) };
      case 'run_command':
        return { ok: true, output: await toolRunCommand(args || {}, root) };
      default:
        return { ok: false, output: `Unknown tool: ${name}` };
    }
  } catch (err) {
    const msg = err instanceof PathError ? err.message : String(err?.message || err);
    return { ok: false, output: `Tool error: ${msg}` };
  }
}

// --- message shaping per provider kind ---

function buildGeminiContents(messages) {
  const contents = [];
  for (const m of messages) {
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.text || '' }] });
    } else if (m.role === 'assistant') {
      const parts = [];
      if (m.text) parts.push({ text: m.text });
      for (const c of m.toolCalls || []) {
        parts.push({ functionCall: { name: c.name, args: c.args || {} } });
      }
      if (parts.length) contents.push({ role: 'model', parts });
    } else if (m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.name,
              response: { result: m.text || '' },
            },
          },
        ],
      });
    }
  }
  return contents;
}

function buildOpenAIMessages(messages) {
  const out = [];
  let toolIdx = 0; // per-assistant-message counter for synthesized ids
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text || '' });
    } else if (m.role === 'assistant') {
      if (m.toolCalls && m.toolCalls.length) {
        out.push({
          role: 'assistant',
          content: m.text || null,
          tool_calls: m.toolCalls.map((c, i) => ({
            id: c.id || `call_${i}`,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
          })),
        });
        toolIdx = 0;
      } else {
        out.push({ role: 'assistant', content: m.text || '' });
      }
    } else if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId || `call_${toolIdx++}`,
        content: m.text || '',
      });
    }
  }
  return out;
}

/**
 * One agent turn: send the conversation to the brain, execute tool calls,
 * repeat until the model answers in plain text (or MAX_STEPS is hit).
 * Mutates session.messages and calls persist(session) after every step.
 */
export async function runTurn(session, persist, deps = {}) {
  const root = session.workspaceAbs;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const callBrainImpl = deps.callBrainImpl || callBrain;
  const systemText = deps.systemText || systemPrompt(session);

  for (let step = 0; step < MAX_STEPS; step++) {
    const contents = buildGeminiContents(session.messages);
    const oaMessages = buildOpenAIMessages(session.messages);
    let res;
    try {
      res = await callBrainImpl(
        session,
        systemText,
        contents,
        oaMessages,
        TOOL_SPECS,
        fetchImpl
      );
    } catch (err) {
      session.messages.push({
        role: 'assistant',
        text: `Brain error: ${String(err?.message || err)}`,
        error: true,
        ts: new Date().toISOString(),
      });
      persist(session);
      return;
    }

    const calls = Array.isArray(res.calls) ? res.calls : [];
    session.messages.push({
      role: 'assistant',
      text: res.text || '',
      ...(calls.length
        ? {
            toolCalls: calls.map((c) => ({
              name: c.name,
              args: c.args || {},
              ...(c.id ? { id: c.id } : {}),
            })),
          }
        : {}),
      ts: new Date().toISOString(),
    });
    persist(session);

    if (!calls.length) return; // plain answer — turn done

    for (const call of calls) {
      const result = await runTool(call.name, call.args, root);
      session.messages.push({
        role: 'tool',
        name: call.name,
        text: result.output,
        ok: result.ok,
        ...(call.id ? { toolCallId: call.id } : {}),
        ts: new Date().toISOString(),
      });
    }
    persist(session);
  }

  session.messages.push({
    role: 'assistant',
    text: `I stopped after ${MAX_STEPS} tool steps to stay safe. Ask me to continue if there is more to do.`,
    ts: new Date().toISOString(),
  });
  persist(session);
}

export function systemPrompt(session) {
  return [
    'You are the MittiCloud Agent — a real assistant running 24/7 on the owner\'s device, inside the MittiCloud app. You are not a demo: your tools act for real on this machine.',
    `Workspace (your jail): ${session.workspaceAbs}`,
    'File tools are locked to that folder. Shell commands also start there. Work inside it; if the user asks for something that must touch outside, do it carefully and say plainly what you are doing.',
    'Rules:',
    '- When the user asks for something you can do with tools, DO it — do not just describe it.',
    '- To know what is in the workspace, you MUST call list_files. NEVER invent or guess file names, folder contents, or command output — if you have not seen it through a tool, you do not know it.',
    '- Show the commands you ran. Quote real output only.',
    '- If something fails, say what failed, then try a fix.',
    '- Keep answers short and in plain words.',
    `Device: ${process.platform}. Today: ${new Date().toISOString().slice(0, 10)}.`,
  ].join('\n');
}
