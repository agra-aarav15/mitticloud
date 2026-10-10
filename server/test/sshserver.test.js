// The embedded SSH server, tested with a real ssh2 client over a real socket.
// Vault and data are redirected to a temp folder before any server import.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mitticloud-ssh-'));
process.env.MITTICLOUD_VAULT_DIR = path.join(TMP_ROOT, 'vault');
process.env.MITTICLOUD_DATA_DIR = path.join(TMP_ROOT, 'data');
process.env.MITTI_TOKEN = 'correct-horse-battery';
process.env.MITTI_SSH_PORT = '18022';

const { default: ssh2 } = await import('ssh2');
const { startSsh, stopSsh, sshState, hostFingerprint, sshPort } = await import('../lib/sshserver.js');
const { VAULT_DIR } = await import('../lib/paths.js');

const PORT = 18022;

function connect({ username = 'mitti', password, timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const c = new ssh2.Client();
    c.on('ready', () => resolve({ ok: true, client: c }));
    c.on('error', (e) => resolve({ ok: false, error: e.message }));
    c.connect({
      host: '127.0.0.1',
      port: PORT,
      username,
      password,
      hostVerifier: () => true,
      readyTimeout: timeoutMs,
    });
  });
}

before(async () => {
  fs.mkdirSync(path.join(VAULT_DIR, 'files'), { recursive: true });
  fs.writeFileSync(path.join(VAULT_DIR, 'files', 'note.txt'), 'hello from the vault');
  startSsh({ host: '127.0.0.1', port: PORT });
  await new Promise((r) => setTimeout(r, 300));
});

after(() => stopSsh());

test('the server listens on the configured unprivileged port and reports it', () => {
  assert.equal(sshState().listening, true);
  assert.equal(sshState().port, PORT);
});

test('privileged ports are refused even when asked for', () => {
  process.env.MITTI_SSH_PORT = '22';
  assert.equal(sshPort(), 8022);
  process.env.MITTI_SSH_PORT = '18022';
});

test('the host fingerprint is a stable SHA256 value', () => {
  const a = hostFingerprint();
  const b = hostFingerprint();
  assert.match(a, /^SHA256:[A-Za-z0-9+/]+$/);
  assert.equal(a, b);
});

test('the lock token logs in as the default user', async () => {
  const r = await connect({ password: 'correct-horse-battery' });
  assert.equal(r.ok, true, r.error);
  r.client.end();
});

test('a wrong password is refused', async () => {
  const r = await connect({ password: 'wrong' });
  assert.equal(r.ok, false);
  r.client?.end();
});

test('a wrong username is refused even with the right password', async () => {
  const r = await connect({ username: 'root', password: 'correct-horse-battery' });
  assert.equal(r.ok, false);
  r.client?.end();
});

test('SFTP lists and reads a file inside the vault, and cannot leave it', async () => {
  const r = await connect({ password: 'correct-horse-battery' });
  assert.equal(r.ok, true, r.error);
  const sftp = await new Promise((resolve, reject) =>
    r.client.sftp((err, s) => (err ? reject(err) : resolve(s)))
  );
  const names = await new Promise((resolve, reject) =>
    sftp.readdir('/files', (err, list) => (err ? reject(err) : resolve(list.map((e) => e.filename))))
  );
  assert.ok(names.includes('note.txt'), 'note.txt is listed');
  const body = await new Promise((resolve, reject) => {
    sftp.readFile('/files/note.txt', (err, buf) => (err ? reject(err) : resolve(buf.toString())));
  });
  assert.equal(body, 'hello from the vault');
  const escaped = await new Promise((resolve) => {
    sftp.readFile('/../../etc/passwd', (err) => resolve(Boolean(err)));
  });
  assert.equal(escaped, true, 'reading outside the vault fails');
  r.client.end();
});

test('SFTP refuses writes', async () => {
  const r = await connect({ password: 'correct-horse-battery' });
  const sftp = await new Promise((resolve, reject) =>
    r.client.sftp((err, s) => (err ? reject(err) : resolve(s)))
  );
  const failed = await new Promise((resolve) => {
    sftp.writeFile('/files/evil.txt', 'nope', (err) => resolve(Boolean(err)));
  });
  assert.equal(failed, true);
  assert.equal(fs.existsSync(path.join(VAULT_DIR, 'files', 'evil.txt')), false);
  r.client.end();
});

// --- the HTTP routes that expose and control the SSH door ---
const { app } = await import('../index.js');

async function apiCall(method, route, body, { token = 'correct-horse-battery' } = {}) {
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  try {
    const headers = body ? { 'Content-Type': 'application/json' } : {};
    if (token) headers['x-mitti-token'] = token;
    const res = await fetch(`http://127.0.0.1:${srv.address().port}${route}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  } finally {
    srv.close();
  }
}

test('GET /api/remote/ssh reports the real listening state and never the token', async () => {
  const { status, json } = await apiCall('GET', '/api/remote/ssh');
  assert.equal(status, 200);
  assert.equal(json.enabled, true, 'the server started by the suite is enabled');
  assert.equal(json.port, PORT);
  assert.equal(json.username, 'mitti');
  assert.match(json.fingerprint, /^SHA256:/);
  assert.equal(JSON.stringify(json).includes('correct-horse-battery'), false, 'token never returned');
});

test('a write without the lock token is refused, and the server keeps running', async () => {
  const { status } = await apiCall('POST', '/api/remote/ssh/disable', {}, { token: '' });
  assert.equal(status, 401);
  assert.equal(sshState().running, true);
});

test('POST /api/remote/ssh/disable stops the server and the port closes', async () => {
  const { status, json } = await apiCall('POST', '/api/remote/ssh/disable', {});
  assert.equal(status, 200);
  assert.equal(json.enabled, false);
  await new Promise((r) => setTimeout(r, 200));
  const { json: after } = await apiCall('GET', '/api/remote/ssh');
  assert.equal(after.enabled, false);
});

test('POST /api/remote/ssh/enable starts it again and the SSH port answers', async () => {
  const { status, json } = await apiCall('POST', '/api/remote/ssh/enable', {});
  assert.equal(status, 200);
  assert.equal(json.enabled, true);
  await new Promise((r) => setTimeout(r, 300));
  const r = await connect({ password: 'correct-horse-battery' });
  assert.equal(r.ok, true, r.error);
  r.client.end();
});
