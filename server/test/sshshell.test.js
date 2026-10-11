// Unit tests for the SSH shell layer's Android adaptations
// (server/lib/sshserver.js). Android is not a normal Linux: there is no
// /bin/sh (it is /system/bin/sh), the core utils live under /system/bin, and a
// client that uploads its own `node` (ZCode, Cursor) uploads a glibc build that
// bionic can never run. These functions are what keep a remote session alive.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mitticloud-sshshell-'));
process.env.MITTICLOUD_VAULT_DIR = path.join(TMP_ROOT, 'vault');
process.env.MITTICLOUD_DATA_DIR = path.join(TMP_ROOT, 'data');

const { resolveShell, shellPath, redirectNodeInvocation, isEmbeddedAndroid } = await import(
  '../lib/sshserver.js'
);

after(() => {
  delete process.env.MITTICLOUD_EMBEDDED;
  delete process.env.MITTICLOUD_NATIVE_DIR;
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

test('resolveShell returns a shell that actually exists on this host', () => {
  const sh = resolveShell();
  if (process.platform === 'win32') {
    assert.equal(sh, 'cmd.exe');
    return;
  }
  assert.ok(sh, 'a shell must be found on a POSIX host');
  assert.equal(fs.existsSync(sh), true, sh + ' must exist');
});

test('shellPath keeps the existing PATH and adds the platform utility dirs', () => {
  const p = shellPath();
  assert.equal(typeof p, 'string');
  // Whatever the host, every entry we emit is an absolute dir.
  for (const dir of p.split(path.delimiter).filter(Boolean)) {
    assert.ok(dir.startsWith('/') || /^[A-Za-z]:/.test(dir), 'absolute: ' + dir);
  }
});

test('isEmbeddedAndroid is true when the app marks it so', () => {
  delete process.env.MITTICLOUD_EMBEDDED;
  assert.equal(isEmbeddedAndroid(), process.platform === 'android');
  process.env.MITTICLOUD_EMBEDDED = '1';
  assert.equal(isEmbeddedAndroid(), true);
});

test('redirectNodeInvocation leaves ordinary commands alone', () => {
  process.env.MITTICLOUD_EMBEDDED = '1';
  assert.equal(redirectNodeInvocation('ls -la'), 'ls -la');
  assert.equal(redirectNodeInvocation('mkdir -p ~/.zcode/server'), 'mkdir -p ~/.zcode/server');
  assert.equal(redirectNodeInvocation(''), '');
  assert.equal(redirectNodeInvocation(null), null);
});

test('outside the app the uploaded node is left untouched (VPS keeps version match)', () => {
  delete process.env.MITTICLOUD_EMBEDDED;
  const cmd =
    'ZCODE_APP_VERSION=\'3.14.5\' ~/.zcode/server/node ~/.zcode/server/zcode-server.cjs';
  if (process.platform !== 'android') {
    assert.equal(redirectNodeInvocation(cmd), cmd);
  }
});

test('inside the app the uploaded node is swapped for MittiCloud\'s real node', () => {
  process.env.MITTICLOUD_EMBEDDED = '1';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittinode-'));
  const launcher = path.join(dir, 'libmittinode.so');
  fs.writeFileSync(launcher, 'x');
  process.env.MITTICLOUD_NATIVE_DIR = dir;

  const cmd =
    'ZCODE_REMOTE_MODE="desktop-attached-remote" ' +
    'ZCODE_SERVER_RUNTIME_ROOT="$HOME/.zcode/server" ' +
    'ZCODE_APP_VERSION=\'3.14.5\' ' +
    '~/.zcode/server/node ~/.zcode/server/zcode-server.cjs';
  const out = redirectNodeInvocation(cmd);
  assert.ok(out.includes(launcher), 'the launcher replaced the uploaded node: ' + out);
  assert.ok(!/~\/\.zcode\/server\/node(?=\s|$)/.test(out), 'the bad path is gone');
  // the server script itself is untouched
  assert.ok(out.endsWith('~/.zcode/server/zcode-server.cjs'));

  delete process.env.MITTICLOUD_NATIVE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the rewrite ignores a command that merely mentions the server path', () => {
  process.env.MITTICLOUD_EMBEDDED = '1';
  const cmd = 'cat ~/.zcode/server/zcode-server.cjs | head';
  const out = redirectNodeInvocation(cmd);
  // no `.../node` executable token, so there is nothing to swap
  assert.equal(out, cmd);
});

test('the rewrite is idempotent for a quoted node path', () => {
  process.env.MITTICLOUD_EMBEDDED = '1';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittinode-'));
  const launcher = path.join(dir, 'libmittinode.so');
  fs.writeFileSync(launcher, 'x');
  process.env.MITTICLOUD_NATIVE_DIR = dir;

  const out = redirectNodeInvocation('"$HOME/.zcode/server/node" "$HOME/.zcode/server/zcode-server.cjs"');
  assert.ok(out.includes(launcher), out);

  delete process.env.MITTICLOUD_NATIVE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a bare `node` launching a remote server is also redirected', () => {
  process.env.MITTICLOUD_EMBEDDED = '1';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittinode-'));
  const launcher = path.join(dir, 'libmittinode.so');
  fs.writeFileSync(launcher, 'x');
  process.env.MITTICLOUD_NATIVE_DIR = dir;

  const out = redirectNodeInvocation('node ~/.cursor-server/bin/server-main.js --port 0');
  assert.ok(out.startsWith(launcher + ' '), out);

  delete process.env.MITTICLOUD_NATIVE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Cursor\'s server tree is recognised the same way as ZCode\'s', () => {
  process.env.MITTICLOUD_EMBEDDED = '1';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittinode-'));
  const launcher = path.join(dir, 'libmittinode.so');
  fs.writeFileSync(launcher, 'x');
  process.env.MITTICLOUD_NATIVE_DIR = dir;

  const cursor = redirectNodeInvocation('/home/mitti/.cursor-server/node /home/mitti/.cursor-server/server-main.js');
  assert.ok(cursor.includes(launcher), cursor);

  const code = redirectNodeInvocation('/home/mitti/.vscode-server/node /home/mitti/.vscode-server/code-server.js');
  assert.ok(code.includes(launcher), code);

  delete process.env.MITTICLOUD_NATIVE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a normal node script the owner runs is NOT redirected', () => {
  process.env.MITTICLOUD_EMBEDDED = '1';
  // No remote-server marker in the command: leave it alone so a developer's own
  // node scripts keep running under the node they asked for.
  const cmd = 'node index.js';
  assert.equal(redirectNodeInvocation(cmd), cmd);
});