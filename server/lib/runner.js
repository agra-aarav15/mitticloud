// The CLI agent runner — a REAL lightweight agent CLI runs on this device,
// and MittiCloud is its 24/7 body: it feeds the chat lines in, streams the
// CLI's real output back into the session, kills runaway runs, and restarts
// nothing silently (a dead run is marked dead).
//
// Command templates carry a {prompt} token, which becomes ONE safe argv
// element (never pasted into a shell). Templates without {prompt} get the
// message on stdin. Both modes work with any CLI the user has.
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileP = promisify(execFile);
const IS_WIN = process.platform === 'win32';

// Windows argv quoting (CommandLineToArgvW rules): backslash runs before a
// quote double up, quotes get escaped, the whole thing gets wrapped when it
// holds whitespace. Without this, a prompt with spaces shatters into
// separate arguments once a shell is involved.
export function winArg(arg) {
  const s = String(arg);
  if (s !== '' && !/[\s"]/.test(s)) return s;
  let out = '"';
  let backslashes = 0;
  for (const ch of s) {
    if (ch === '\\') {
      backslashes += 1;
    } else if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      out += '\\'.repeat(backslashes) + ch;
      backslashes = 0;
    }
  }
  return out + '\\'.repeat(backslashes * 2) + '"';
}

// cmd.exe has its OWN escaping: a backslash means nothing to it (it would be
// passed straight through), and a literal quote is written as a doubled "".
// Getting this wrong is how a prompt turns into "The system cannot find the
// path specified." — cmd reads the stray quote as a start of a new command.
export function cmdArg(arg) {
  const s = String(arg);
  if (s === '') return '""';
  const wrapped = /[\s"]/.test(s);
  const body = s.replace(/"/g, '""');
  return wrapped ? `"${body}"` : body;
}

/**
 * What to actually spawn on this platform. npm-adjacent CLIs on Windows are
 * .cmd shims, which Node (>=18.20, CVE-2024-27980) refuses to CreateProcess
 * directly (spawn EINVAL) — only cmd.exe can run them. /d /s /c with the tail
 * verbatim keeps {prompt} as ONE argument; the prompt is only ever quoted,
 * never evaluated as shell syntax.
 */
export function spawnRequestFor(file, args) {
  if (!IS_WIN) return { file, args };
  const tail = [file, ...args].map(cmdArg).join(' ');
  return {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', tail],
    windowsVerbatimArguments: true,
  };
}

export const CLI_PRESETS = [
  {
    id: 'opencode',
    label: 'OpenCode',
    pkg: 'opencode-ai',
    bin: 'opencode',
    cmd: 'opencode run {prompt}',
    install: 'npm i -g opencode-ai',
    note: 'Real coding agent. Free models through OpenCode Zen — run `opencode` once on this device to sign in and pick a model.',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    pkg: '@google/gemini-cli',
    bin: 'gemini',
    cmd: 'gemini -p {prompt}',
    install: 'npm i -g @google/gemini-cli',
    note: 'Google\'s coding CLI on its free tier — run `gemini` once on this device to sign in with your Google account.',
  },
  {
    id: 'custom',
    label: 'Custom CLI',
    pkg: null,
    bin: null,
    cmd: '',
    install: null,
    note: 'Any command with {prompt} in it — the prompt is passed as one safe argument, never through a shell.',
  },
];

export function presetById(id) {
  return CLI_PRESETS.find((p) => p.id === id) || null;
}

/** True when the preset's binary answers on this device. Strict: only a
 *  real exit-0 counts — EINVAL/ENOENT/shell noise are all "not installed". */
export async function presetInstalled(preset) {
  if (!preset || !preset.bin) return false;
  try {
    if (IS_WIN) {
      await execFileP(
        'cmd.exe',
        ['/d', '/s', '/c', `${cmdArg(preset.bin)} --version`],
        { timeout: 10000, windowsHide: true, windowsVerbatimArguments: true }
      );
    } else {
      await execFileP(preset.bin, ['--version'], { timeout: 5000 });
    }
    return true;
  } catch {
    return false;
  }
}

export async function cliPresetsStatus() {
  return Promise.all(
    CLI_PRESETS.map(async (p) => ({
      id: p.id,
      label: p.label,
      cmd: p.cmd,
      install: p.install,
      note: p.note,
      hasInstaller: Boolean(p.install),
      installed: await presetInstalled(p),
    }))
  );
}

const SCRUB_ENV = /TOKEN|KEY|SECRET|PASSWORD|MITTI_FAKE/i;
const OUT_CAP = 64 * 1024;
const TIMEOUT_MS = 10 * 60 * 1000;
// A CLI that produces NOTHING for this long is stuck (waiting for a TTY or a
// login), not thinking — say so instead of hanging the chat forever.
const NO_OUTPUT_MS = 90 * 1000;

function templateArgs(template) {
  // split on whitespace; {prompt} stays a token — replaced later, as one argv
  return String(template || '').trim().split(/\s+/).filter(Boolean);
}

/**
 * One CLI turn for a session. Mutates session.messages like runTurn does and
 * calls persist() as output grows, so the phone UI sees the CLI work live.
 * spawnImpl is injectable for tests.
 */
export async function runCliTurn(session, persist, deps = {}) {
  const spawnImpl = deps.spawnImpl || spawn;
  const noOutputMs = deps.noOutputMs || NO_OUTPUT_MS;
  const template = String(session.cliCmd || '');
  const tokens = templateArgs(template);
  if (!tokens.length) {
    session.messages.push({
      role: 'assistant',
      engine: 'cli',
      text: 'No CLI command set for this session. Edit the session brain and give it a command with {prompt} in it.',
      error: true,
      ts: new Date().toISOString(),
    });
    persist(session);
    return;
  }

  const userText = session.messages[session.messages.length - 1]?.text || '';
  let child;
  if (tokens.includes('{prompt}')) {
    const argv = tokens.map((t) => (t === '{prompt}' ? userText : t));
    const r = spawnRequestFor(argv[0], argv.slice(1));
    // stdin closed: the prompt is fully on the command line, so a CLI that
    // would otherwise wait for terminal input gets EOF instead of hanging
    child = spawnImpl(r.file, r.args, {
      cwd: session.workspaceAbs,
      windowsHide: true,
      windowsVerbatimArguments: Boolean(r.windowsVerbatimArguments),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    const r = spawnRequestFor(tokens[0], tokens.slice(1));
    child = spawnImpl(r.file, r.args, {
      cwd: session.workspaceAbs,
      windowsHide: true,
      windowsVerbatimArguments: Boolean(r.windowsVerbatimArguments),
    });
    child.stdin.write(userText + '\n');
    child.stdin.end();
  }

  const startedAt = Date.now();
  const msg = {
    role: 'assistant',
    engine: 'cli',
    text: '',
    streaming: true,
    ts: new Date().toISOString(),
  };
  session.messages.push(msg);
  persist(session);

let lastPersist = 0;
  let gotOutput = false;
  const grow = (chunk) => {
    gotOutput = true;
    if (msg.text.length < OUT_CAP) msg.text += chunk.toString('utf8');
    const now = Date.now();
    if (now - lastPersist > 600) {
      lastPersist = now;
      persist(session);
    }
  };
  child.stdout.on('data', grow);
  child.stderr.on('data', grow);

  await new Promise((resolve) => {
    let finished = false;
    const finish = (code, killed, reason) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(noOutput);
      msg.streaming = false;
      msg.ms = Date.now() - startedAt;
      if (msg.text.length >= OUT_CAP) {
        msg.text += '\n... (output cut at 64 KB)';
      }
      if (reason === 'silent') {
        const bin = templateArgs(session.cliCmd)[0] || 'the CLI';
        msg.text +=
          `\n[No output for 90 seconds — stopped. \`${bin}\` looks stuck: either it is not signed in, ` +
          `or it is waiting for something only a terminal can give. Run \`${bin}\` once in Termux to sign in, ` +
          `then send again — or point this session at a command it can run headless.]`;
      } else if (killed) {
        msg.text += '\n[stopped after 10 minutes]';
      } else if (code !== 0) {
        msg.text += `\n[CLI exited with code ${code}]`;
        if (/auth|login|sign in|unauthor|api key|credential|ineligible|not found/i.test(msg.text)) {
          const bin = templateArgs(session.cliCmd)[0] || 'the CLI';
          msg.text += `\n[That reads like sign-in: run \`${bin}\` once on this device to log in, then send again.]`;
        }
      } else if (!gotOutput) {
        msg.text +=
          '\n[The CLI exited cleanly but printed nothing — nothing to show for this turn.]';
      }
      msg.ok = code === 0 && !killed && reason !== 'silent';
      persist(session);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(null, true);
    }, TIMEOUT_MS);
    // stall watchdog: no bytes at all -> an honest, actionable stop
    const noOutput = setTimeout(() => {
      if (finished || gotOutput) return;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(null, true, 'silent');
    }, noOutputMs);
    noOutput.unref?.();
    child.on('error', (err) => {
      msg.text = `Could not start the CLI: ${err.message}` + (msg.text ? '\n' + msg.text : '');
      finish(1, false);
    });
    child.on('close', (code) => finish(code, false));
  });
}
