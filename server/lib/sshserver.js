// Embedded SSH server — the door ZCode's "Remote connection → SSH" method uses.
//
// ZCode's SSH method is plain SSH: host, port, username, password (or key), a
// shell, and read/write on the project folder. This module serves SSH itself
// (pure JS, no OS setup) so a phone or VPS is connectable with nothing else
// installed. It is OFF by default and never binds a privileged port.
//
// Auth: username MITTI_SSH_USER (default "mitti"); password = the MittiCloud
// lock token, or any key in data/ssh/authorized_keys. An unlocked cloud with no
// authorized keys refuses every login — there is no anonymous door.
// Channels: SFTP only, jailed to the vault. No interactive shell (out of scope).
import ssh2 from 'ssh2';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { DATA_DIR, VAULT_DIR, resolveSafe } from './paths.js';
import { getToken, isLocked } from './auth.js';

export const SSH_DIR = path.join(DATA_DIR, 'ssh');
const HOST_KEY_FILE = path.join(SSH_DIR, 'host_key');
const AUTH_KEYS_FILE = path.join(SSH_DIR, 'authorized_keys');
const DEFAULT_PORT = 8022; // unprivileged: Android/Termux cannot bind 22 without root
const DEFAULT_USER = 'mitti';

let server = null;
let state = { listening: false, port: null, host: null, error: null };

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
    if (!isLocked()) return false; // no lock token set: nothing to authenticate with
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
        session.on('exec', (acceptExec, reject) => {
          reject();
        });
        session.on('shell', (acceptShell, reject) => reject());
      });
    });
  });
  server.on('error', (err) => {
    state = { listening: false, port, host, error: err.message };
  });
  server.listen(port, host, () => {
    state = { listening: true, port, host, error: null };
  });
  return state;
}

export function stopSsh() {
  if (!server) return;
  server.close();
  server = null;
  state = { listening: false, port: null, host: null, error: null };
}

export function sshState() {
  return { ...state, running: Boolean(server) };
}
