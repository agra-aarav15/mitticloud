// The PTY helper must never be a single point of failure: on devices where the
// shipped libmittish.so cannot exec (linker warnings, instant exit 1 — the
// failure ZCode reported), an interactive session must still come up on the
// pipe path. This test plants a garbage "helper" in MITTICLOUD_NATIVE_DIR, so
// spawn fails at once, and then proves a real ssh2 client still gets a working
// shell — and that the helper's failure was recorded for diagnosis.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mitticloud-sshfallback-'));
process.env.MITTICLOUD_VAULT_DIR = path.join(TMP_ROOT, 'vault');
process.env.MITTICLOUD_DATA_DIR = path.join(TMP_ROOT, 'data');
process.env.MITTI_TOKEN = 'fallback-test-token';
process.env.MITTI_SSH_PORT = '18099';
// a file that exists but can never execute: ptyHelper() returns it, spawn dies
process.env.MITTICLOUD_NATIVE_DIR = TMP_ROOT;
fs.writeFileSync(path.join(TMP_ROOT, 'libmittish.so'), 'not an executable');

const { startSsh, stopSsh, SSH_DIR } = await import('../lib/sshserver.js');

before(() => {
  startSsh({ host: '127.0.0.1', port: 18099 });
});

after(async () => {
  stopSsh();
  // the fallback shell's cwd lives inside TMP_ROOT; on Windows its handle
  // outlives the kill by a beat, so retry the removal like deleteApp does
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
});

function connect() {
  return new Promise((resolve, reject) => {
    const conn = new ssh2.Client();
    conn.once('ready', () => resolve(conn));
    conn.once('error', reject);
    conn.connect({
      host: '127.0.0.1',
      port: 18099,
      username: 'mitti',
      password: 'fallback-test-token',
      readyTimeout: 5000,
    });
  });
}

test('a dead PTY helper falls back to pipes: the interactive shell still works', async () => {
  const conn = await connect();
  const stream = await new Promise((resolve, reject) => {
    conn.once('error', reject);
    conn.shell({ term: 'xterm-256color', rows: 24, cols: 80 }, (err, ch) =>
      err ? reject(err) : resolve(ch)
    );
  });

  let out = '';
  stream.on('data', (d) => {
    out += d.toString();
  });
  const closed = new Promise((resolve) => stream.once('close', resolve));

  // give the (failing) helper its grace period, then drive the fallback shell
  stream.write('echo FALLBACK_OK\r\n');
  const deadline = Date.now() + 10000;
  while (!out.includes('FALLBACK_OK') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (!out.includes('\r\n') && Date.now() + 4000 < deadline) stream.write('echo FALLBACK_OK\r\n');
  }
  assert.match(out, /FALLBACK_OK/);
  // the session is alive: the channel has not closed on us
  assert.equal(await Promise.race([closed, Promise.resolve(false)]), false);

  stream.close();
  conn.end();

  // and the helper's failure was recorded, bounded, for the next diagnosis
  const log = path.join(SSH_DIR, 'pty-errors.log');
  assert.equal(fs.existsSync(log), true);
  assert.match(fs.readFileSync(log, 'utf8'), /helper died at startup/);
});
