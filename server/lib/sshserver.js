// Embedded SSH server — the door ZCode's "Remote connection → SSH" method uses.
//
// ZCode's SSH method is plain SSH: host, port, username, password (or key), a
// shell, and read/write on the project folder. This module serves SSH itself
// (pure JS, no OS setup) so a phone or VPS is connectable with nothing else
// installed. It is OFF by default and never binds a privileged port.
//
// Auth: username MITTI_SSH_USER (default "mitti"); password = the MittiCloud
// SSH password, or any key in data/ssh/authorized_keys. A cloud with no password
// and no authorized keys refuses every login — there is no anonymous door.
// Channels: SFTP and a shell/exec channel. The shell starts inside the vault
// folder and runs only for an authenticated login. ZCode needs the shell to run
// the agent on the project.
import ssh2 from 'ssh2';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DATA_DIR, VAULT_DIR, resolveSafe } from './paths.js';
import { getToken, isLocked } from './auth.js';
import { nodeRuntime } from './apprunner.js';

export const SSH_DIR = path.join(DATA_DIR, 'ssh');
const HOST_KEY_FILE = path.join(SSH_DIR, 'host_key');
const AUTH_KEYS_FILE = path.join(SSH_DIR, 'authorized_keys');
const DEFAULT_PORT = 8022; // unprivileged: Android/Termux cannot bind 22 without root
const DEFAULT_USER = 'mitti';

let server = null;
let state = { listening: false, port: null, host: null, error: null };

// Every shell/exec child a session is running. Turning SSH off must take them
// with it — an orphaned shell keeps running (and on Windows keeps its cwd
// handle), long after the door is closed.
const shellChildren = new Set();

/** Remember a session child until it exits on its own. */
function trackChild(child) {
  shellChildren.add(child);
  child.once('close', () => shellChildren.delete(child));
  child.once('error', () => shellChildren.delete(child));
  return child;
}

/**
 * Read the stored host key, or create and persist one. RSA-2048 in PKCS#1 PEM:
 * ssh2 1.17 parses RSA PKCS#1 but rejects ed25519 PKCS#8 (verified), and RSA is
 * the host-key type every SSH client accepts.
 */
export function loadOrCreateHostKey() {
  if (fs.existsSync(HOST_KEY_FILE)) return fs.readFileSync(HOST_KEY_FILE, 'utf8');
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  fs.mkdirSync(SSH_DIR, { recursive: true });
  fs.writeFileSync(HOST_KEY_FILE, privateKey, { mode: 0o600 });
  return privateKey;
}

/** Fingerprint of the host key — what a client shows when it first connects. */
export function hostFingerprint() {
  const key = crypto.createPublicKey(loadOrCreateHostKey());
  const der = key.export({ type: 'spki', format: 'der' });
  return 'SHA256:' + crypto.createHash('sha256').update(der).digest('base64').replace(/=+$/, '');
}

export function sshPort() {
  const n = Number.parseInt(process.env.MITTI_SSH_PORT || '', 10);
  // refuse privileged ports outright, even when asked
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : DEFAULT_PORT;
}

export function sshUser() {
  return (process.env.MITTI_SSH_USER || '').trim() || DEFAULT_USER;
}

/** Public keys the owner allowed (one OpenSSH key per line). */
export function authorizedKeys() {
  try {
    return fs
      .readFileSync(AUTH_KEYS_FILE, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

function keyMatches(presented) {
  // compare the presented key's base64 body with each authorized line's body
  const body = (line) => line.split(/\s+/)[1] || '';
  const want = presented.data ? presented.data.toString('base64') : '';
  return authorizedKeys().some((line) => want && body(line) === want);
}

/** Decide one login attempt. Pure enough to test without a socket. */
export function checkLogin(ctx) {
  if (ctx.username !== sshUser()) return false;
  if (ctx.method === 'password') {
    if (!isLocked()) return false; // no SSH password set: nothing to authenticate with
    const token = getToken();
    if (!token || typeof ctx.password !== 'string') return false;
    const a = Buffer.from(ctx.password);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  if (ctx.method === 'publickey') return keyMatches(ctx.key);
  return false;
}

// Resolve an SFTP path into the vault. Refuses anything that leaves VAULT_DIR.
function vaultPath(p) {
  const rel = String(p || '/').replace(/^\/+/, '');
  return resolveSafe(rel, VAULT_DIR);
}

function handleSftp(accept) {
  const sftp = accept();
  sftp.on('REALPATH', (reqid, p) => {
    sftp.name(reqid, [{ filename: '/' + path.posix.normalize(String(p || '/')).replace(/^\/+/, ''), longname: '', attrs: {} }]);
  });
  sftp.on('STAT', (reqid, p) => statFile.call(sftp, reqid, p));
  sftp.on('LSTAT', (reqid, p) => statFile.call(sftp, reqid, p));
  sftp.on('OPENDIR', async (reqid, p) => {
    try {
      const dir = vaultPath(p);
      const ents = await fsp.readdir(dir, { withFileTypes: true });
      const id = 'd' + (++handleSeq);
      dirs.set(id, ents);
      sftp.handle(reqid, Buffer.from(id));
    } catch {
      sftp.status(reqid, 2); // NO_SUCH_FILE
    }
  });
  sftp.on('READDIR', (reqid, handle) => {
    const key = handle.toString();
    const ents = dirs.get(key);
    if (!ents) return sftp.status(reqid, 1); // SSH_FX_EOF (5 is OP_UNSUPPORTED)
    dirs.delete(key);
    sftp.name(
      reqid,
      ents.map((e) => ({ filename: e.name, longname: e.name, attrs: entryAttrs(e) }))
    );
  });
  sftp.on('CLOSE', (reqid) => sftp.status(reqid, 0));
  sftp.on('OPEN', async (reqid, p, flags) => {
    // SFTP_OPEN write bits (WRITE 0x2, CREAT 0x8, TRUNC 0x10, APPEND 0x4): refuse all writes
    if (flags & (0x2 | 0x4 | 0x8 | 0x10)) return sftp.status(reqid, 4);
    try {
      const fh = await fsp.open(vaultPath(p), 'r');
      const id = 'h' + (++handleSeq);
      openFiles.set(id, fh);
      sftp.handle(reqid, Buffer.from(id));
    } catch {
      sftp.status(reqid, 2);
    }
  });
  sftp.on('READ', async (reqid, handle, offset, length) => {
    const fh = openFiles.get(handle.toString());
    if (!fh) return sftp.status(reqid, 4); // FAILURE
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, Number(offset));
    if (bytesRead === 0) return sftp.status(reqid, 1); // EOF
    sftp.data(reqid, buf.subarray(0, bytesRead));
  });
  sftp.on('REMOVE', (reqid) => sftp.status(reqid, 4)); // writes are refused over SFTP
  sftp.on('WRITE', (reqid) => sftp.status(reqid, 4));
  sftp.on('MKDIR', (reqid) => sftp.status(reqid, 4));
  sftp.on('RMDIR', (reqid) => sftp.status(reqid, 4));
  sftp.on('RENAME', (reqid) => sftp.status(reqid, 4));
}

const dirs = new Map();
const openFiles = new Map();
let handleSeq = 0;

// Real metadata for one directory entry, so clients can size and date it.
function entryAttrs(e) {
  try {
    const st = fs.statSync(path.join(e.parentPath || e.path || '', e.name));
    return {
      mode: st.mode,
      size: st.size,
      atime: Math.floor(st.atimeMs / 1000),
      mtime: Math.floor(st.mtimeMs / 1000),
    };
  } catch {
    return { mode: 0o100644, size: 0, atime: 0, mtime: 0 };
  }
}

async function statFile(reqid, p) {
  try {
    const st = await fsp.stat(vaultPath(p));
    this.attrs(reqid, {
      mode: st.mode,
      uid: 0,
      gid: 0,
      size: st.size,
      atime: Math.floor(st.atimeMs / 1000),
      mtime: Math.floor(st.mtimeMs / 1000),
    });
  } catch {
    this.status(reqid, 2); // NO_SUCH_FILE
  }
}

// True when this server runs inside the Android app (the APK sets this before
// node starts). Android is not a normal Linux: there is no /bin/sh and the
// core utils live under /system/bin, so the shell layer has to adapt.
export function isEmbeddedAndroid() {
  return process.platform === 'android' || process.env.MITTICLOUD_EMBEDDED === '1';
}

// The shell a login runs. Resolve a real one instead of assuming /bin/sh, which
// does not exist on Android (it is /system/bin/sh) — a wrong path here makes
// every exec request fail with ENOENT and breaks the whole SSH channel.
export function resolveShell() {
  if (process.platform === 'win32') return 'cmd.exe';
  const candidates = [
    process.env.MITTICLOUD_SHELL,
    process.env.SHELL,
    isEmbeddedAndroid() ? '/system/bin/sh' : null,
    '/bin/sh',
    '/usr/bin/sh',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* keep looking */
    }
  }
  return null; // let spawn surface the honest ENOENT rather than lying
}

// PATH for the child. Android core utils (mkdir, cat, tar, ls) are under
// /system/bin, and nodejs-mobile's own PATH can be empty, so a login otherwise
// cannot run the commands a client's deploy script issues.
export function shellPath() {
  const parts = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const dirs = isEmbeddedAndroid()
    ? ['/system/bin', '/system/xbin', '/vendor/bin', '/product/bin']
    : ['/usr/local/bin', '/usr/bin', '/bin'];
  for (const d of dirs) {
    try {
      if (fs.existsSync(d) && !parts.includes(d)) parts.push(d);
    } catch {
      /* ignore */
    }
  }
  return parts.join(path.delimiter);
}

// Markers in a command that mean "this is a remote coding-agent server this
// client uploaded". ZCode ships zcode-server.cjs; Cursor ships a cursor-server
// tree running server-main.js; VS Code-style servers run code-server.
const REMOTE_SERVER_RE = /zcode-server\.cjs|cursor-server|\.cursor-server|server-main\.js|code-server/;

// Only zcode-server needs the node:sqlite stand-in (it is the one that requires
// the Node 22 builtin at load time). Cursor/code-server must NOT get the flag.
const ZCODE_SERVER_RE = /zcode-server\.cjs/;

// The shim that lets zcode-server's `require("node:sqlite")` resolve on the
// Node 18 the APK ships (see lib/mitti-node22-shim.cjs for the full story).
// Lives beside this module, so it travels into the APK with the rest of server/.
export const NODE22_SHIM = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mitti-node22-shim.cjs');
const SHIM_FLAG = `--require=${NODE22_SHIM}`;

/**
 * Rewrite a client's command so it runs on THIS machine's node.
 *
 * ZCode and Cursor deploy their own `node` into a hidden server folder and then
 * run it (`~/.zcode/server/node ~/.zcode/server/zcode-server.cjs`). That binary
 * is a glibc Linux build; Android uses bionic, so it can never run there — the
 * session dies with "Permission denied" (the sandbox refuses to exec it) or a
 * missing-loader error. MittiCloud already ships a real Android node, so when a
 * login asks to run that uploaded server, run ours instead. On a normal Linux
 * host the uploaded node is version-matched and is left untouched.
 *
 * ZCode's server is built for Node 22 and `require`s `node:sqlite`, which Node
 * 18 lacks, so a stand-in is loaded via --require (zcode-server only, at the
 * front of the command so it also reaches a shell-wrapped launch). The flag is
 * added before the node token so node sees it regardless of the client's args.
 */
export function redirectNodeInvocation(command) {
  if (!command || typeof command !== 'string') return command;
  if (!isEmbeddedAndroid()) return command;
  if (!REMOTE_SERVER_RE.test(command)) return command;
  const exe = nodeRuntime();
  // Swap the node executable token: a bare `node`/`node.exe`, or any path that
  // ends in one. Separators may be / or \ and the token may be quoted; the
  // surrounding env assignments and quoting are preserved.
  const swapped = command.replace(
    /(^|[\s"'=])((?:[^\s"'=]*[/\\])?node(?:\.exe)?)(?=[\s"']|$)/g,
    (whole, pre, tok) => (/^(?:[^\s"'=]*[/\\])?node(?:\.exe)?$/.test(tok) ? `${pre}${exe}` : whole)
  );
  if (!ZCODE_SERVER_RE.test(swapped) || swapped.includes('mitti-node22-shim')) return swapped;
  // Insert the shim flag right after the node executable — quoted or bare — so
  // `node --require=... server.cjs` and `env FOO=1 node --require=... x.cjs`
  // both keep working. \1 back-references the optional surrounding quote pair.
  const escaped = exe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return swapped.replace(new RegExp(`("?)${escaped}\\1(?=\\s|$)`, 'g'), `$& ${SHIM_FLAG}`);
}

// The program a login runs: the platform shell, with an optional one-off command.
function shellArgs(command) {
  const sh = resolveShell();
  if (process.platform === 'win32') {
    return { cmd: sh, args: command ? ['/d', '/c', command] : ['/d', '/q'] };
  }
  return { cmd: sh, args: command ? ['-c', command] : [] };
}

// The PTY proxy, when the APK shipped one. A full interactive shell needs a real
// terminal; MittiCloud's APK builds `libmittish.so` (a PTY proxy) and points
// MITTICLOUD_NATIVE_DIR at it. Absent on a desktop/VPS, where a PTY is not
// available — the shell still runs, just without isatty() and job control.
export function ptyHelper() {
  const dir = process.env.MITTICLOUD_NATIVE_DIR;
  if (!dir) return null;
  const helper = path.join(dir, 'libmittish.so');
  try {
    if (fs.statSync(helper).isFile()) return helper;
  } catch {
    /* fall through */
  }
  return null;
}

// The shell starts inside the vault. A missing cwd makes every spawn fail with
// ENOENT, so make sure the folder exists even when nothing created it yet.
function shellCwd() {
  try {
    fs.mkdirSync(VAULT_DIR, { recursive: true });
  } catch {
    /* best effort — spawn surfaces a truly unusable cwd honestly */
  }
  return VAULT_DIR;
}

// Run one shell or exec request as a child process, with its stdio on the channel.
// `pty` is the client's terminal request (term/rows/cols) for an interactive
// shell. Returns a { resize(rows, cols) } handle so window-change requests can
// reflow the terminal.
function runChild(channel, { command = null, pty = null } = {}) {
  const rewritten = redirectNodeInvocation(command);
  const baseEnv = { ...process.env, HOME: VAULT_DIR, PATH: shellPath() };
  const helper = pty ? ptyHelper() : null;

  if (pty && helper) {
    // A helper that fails synchronously (bad binary, odd platform) must not take
    // the session with it — pipes still give a working shell.
    try {
      return runWithPty(channel, { helper, command: rewritten, pty, env: baseEnv });
    } catch (err) {
      notePtyFailure([], err);
      return runWithPipes(channel, { command: rewritten, pty, env: baseEnv });
    }
  }
  return runWithPipes(channel, { command: rewritten, pty, env: baseEnv });
}

// Plain pipes: no terminal, so no isatty() and no job control, but every shell
// and every client works. Also the fallback when the PTY helper dies at startup.
function runWithPipes(channel, { command, pty, env }) {
  const sh = shellArgs(command);
  const runEnv = { ...env, TERM: pty ? pty.term || 'xterm-256color' : 'dumb' };
  if (!sh.cmd) {
    // No usable shell on this machine — say so plainly instead of a bare ENOENT.
    channel.stderr.write('mitticloud: no shell found to run this command\n');
    channel.exit(127);
    channel.end();
    return { resize() {} };
  }
  const child = trackChild(
    spawn(sh.cmd, sh.args, { cwd: shellCwd(), env: runEnv, stdio: ['pipe', 'pipe', 'pipe'] })
  );
  let alive = true;
  const toClient = (buf) => {
    if (alive) channel.write(buf);
  };
  const toClientErr = (buf) => {
    if (alive) channel.stderr.write(buf);
  };
  child.stdout.on('data', toClient);
  child.stderr.on('data', toClientErr);
  channel.on('data', (d) => {
    if (alive) child.stdin.write(d);
  });
  channel.on('end', () => child.stdin.end());
  child.on('error', () => {
    if (!alive) return;
    alive = false;
    channel.exit(127);
    channel.end();
  });
  child.on('close', (code) => {
    if (!alive) return;
    alive = false;
    channel.exit(code ?? 0);
    channel.end();
  });
  channel.on('close', () => {
    alive = false;
    child.kill();
  });
  return { resize() {} }; // no terminal to resize on the pipe path
}

// Some devices ship a PTY helper the kernel refuses to exec (linker warnings,
// then an instant exit 1). Without a grace period that one bad binary kills
// every interactive session, so a helper that dies this early having produced
// nothing is treated as absent: its stderr is kept for diagnostics and the same
// request restarts on pipes.
const PTY_GRACE_MS = 1500;
const PTY_ERR_LOG = path.join(SSH_DIR, 'pty-errors.log');

/** Append one helper-failure report, keeping the log bounded. */
function notePtyFailure(stderrChunks, err) {
  const body = Buffer.concat(stderrChunks).toString('utf8').slice(0, 4000);
  const line = `${new Date().toISOString()} helper died at startup${err ? ` (${err.message})` : ''}\n${body}\n---\n`;
  try {
    fs.mkdirSync(SSH_DIR, { recursive: true });
    if (fs.existsSync(PTY_ERR_LOG) && fs.statSync(PTY_ERR_LOG).size > 131072) {
      fs.writeFileSync(PTY_ERR_LOG, fs.readFileSync(PTY_ERR_LOG).subarray(-65536));
    }
    fs.appendFileSync(PTY_ERR_LOG, line);
  } catch {
    /* diagnostics must never break a session */
  }
}

/**
 * Interactive shell over the PTY proxy. The helper runs the real shell on a PTY
 * and pipes bytes to us, so isatty() is true, line editing works, and the client
 * can resize. Resizes go to the helper on fd 3 as "R <rows> <cols>\n".
 */
function runWithPty(channel, { helper, command, pty, env }) {
  const handle = { resize() {} };
  const sh = resolveShell();
  if (!sh) {
    channel.stderr.write('mitticloud: no shell found to run this command\n');
    channel.exit(127);
    channel.end();
    return handle;
  }
  const rows0 = Number(pty.rows) > 0 ? Number(pty.rows) : 24;
  const cols0 = Number(pty.cols) > 0 ? Number(pty.cols) : 80;
  const runEnv = {
    ...env,
    TERM: pty.term || 'xterm-256color',
    MITTI_PTY_ROWS: String(rows0),
    MITTI_PTY_COLS: String(cols0),
  };

  // fd 3 is the resize control pipe the helper reads.
  const child = trackChild(
    spawn(helper, [sh, ...(command ? ['-c', command] : [])], {
      cwd: shellCwd(),
      env: runEnv,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    })
  );
  const ctl = child.stdio[3];
  let ctlOpen = Boolean(ctl);
  let alive = true;
  let channelGone = false;
  let produced = 0;
  const startedAt = Date.now();
  const stderrChunks = [];

  const toClient = (buf) => {
    if (!alive) return;
    produced += buf.length;
    channel.write(buf);
  };
  // The helper's own stderr carries only its diagnostics (linker warnings, exec
  // failures) — the shell runs on the helper's PTY and arrives on stdout — so it
  // is captured for the log instead of being shown to the client.
  child.stdout.on('data', toClient);
  child.stderr.on('data', (buf) => {
    if (stderrChunks.length < 16) stderrChunks.push(buf);
  });
  const fellBack = (err) => {
    alive = false;
    notePtyFailure(stderrChunks, err);
    handle.resize = runWithPipes(channel, { command, pty, env }).resize;
  };
  const diedTooSoon = () => !channelGone && produced === 0 && Date.now() - startedAt < PTY_GRACE_MS;
  child.on('error', (err) => {
    if (!alive) return;
    if (diedTooSoon()) return fellBack(err);
    alive = false;
    notePtyFailure(stderrChunks, err);
    channel.stderr.write('mitticloud: could not start the terminal helper\n');
    channel.exit(127);
    channel.end();
  });
  channel.on('data', (d) => {
    if (alive) child.stdin.write(d);
  });
  channel.on('end', () => child.stdin.end());
  channel.on('close', () => {
    channelGone = true;
    alive = false;
    child.kill();
  });
  child.on('close', (code) => {
    if (ctlOpen) {
      ctlOpen = false;
      try {
        ctl.end();
      } catch {
        /* already gone */
      }
    }
    if (!alive) return;
    if (diedTooSoon()) return fellBack(null);
    alive = false;
    channel.exit(code ?? 0);
    channel.end();
  });

  handle.resize = (rows, cols) => {
    if (!ctlOpen || !ctl) return;
    const r = Number(rows) > 0 ? Math.floor(Number(rows)) : rows0;
    const c = Number(cols) > 0 ? Math.floor(Number(cols)) : cols0;
    try {
      ctl.write(`R ${r} ${c}\n`);
    } catch {
      ctlOpen = false;
    }
  };
  return handle;
}

/** Start the SSH server. Idempotent. Returns the current state. */
export function startSsh({ host = '127.0.0.1', port = sshPort() } = {}) {
  if (server) return state;
  const hostKey = loadOrCreateHostKey();
  server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (checkLogin(ctx)) ctx.accept();
      else ctx.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => handleSftp(acceptSftp));
        session.on('exec', (acceptExec, _reject, info) => {
          runChild(acceptExec(), { command: info.command });
        });
        // An interactive shell: remember the client's terminal request so the
        // PTY helper starts at the right size, and reflow on window-change.
        let pty = null;
        let shellRunner = null;
        session.on('pty', (acceptPty, _reject, info) => {
          pty = info || {};
          if (acceptPty) acceptPty();
        });
        session.on('window-change', (_accept, _reject, info) => {
          if (pty && info) {
            pty.rows = info.rows;
            pty.cols = info.cols;
          }
          if (shellRunner) shellRunner.resize(info?.rows, info?.cols);
        });
        session.on('shell', (acceptShell) => {
          shellRunner = runChild(acceptShell(), { pty });
        });
      });
    });
  });
  server.on('error', (err) => {
    state = { listening: false, port, host, error: err.message };
  });
  state = { listening: false, port, host, error: null };
  server.listen(port, host, () => {
    state = { listening: true, port, host, error: null };
  });
  return state;
}

export function stopSsh() {
  if (server) {
    server.close();
    server = null;
    state = { listening: false, port: null, host: null, error: null };
  }
  for (const child of shellChildren) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  shellChildren.clear();
}

export function sshState() {
  return { ...state, running: Boolean(server) };
}
