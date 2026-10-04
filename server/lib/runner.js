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

/** True when the preset's binary answers on this device. */
export async function presetInstalled(preset) {
  if (!preset || !preset.bin) return false;
  try {
    await execFileP(preset.bin, ['--version'], { timeout: 5000 });
    return true;
  } catch (err) {
    // ENOENT = not installed; any other error still means the binary exists
    return err.code !== 'ENOENT';
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
    child = spawnImpl(argv[0], argv.slice(1), {
      cwd: session.workspaceAbs,
      windowsHide: true,
    });
  } else {
    child = spawnImpl(tokens[0], tokens.slice(1), {
      cwd: session.workspaceAbs,
      windowsHide: true,
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
  const grow = (chunk) => {
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
    const finish = (code, killed) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      msg.streaming = false;
      msg.ms = Date.now() - startedAt;
      if (msg.text.length >= OUT_CAP) {
        msg.text += '\n… (output cut at 64 KB)';
      }
      if (killed) {
        msg.text += '\n[stopped after 10 minutes]';
      } else if (code !== 0) {
        msg.text += `\n[CLI exited with code ${code}]`;
      }
      msg.ok = code === 0 && !killed;
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
    child.on('error', (err) => {
      msg.text = `Could not start the CLI: ${err.message}` + (msg.text ? '\n' + msg.text : '');
      finish(1, false);
    });
    child.on('close', (code) => finish(code, false));
  });
}
