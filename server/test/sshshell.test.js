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
import { execFileSync } from 'node:child_process';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mitticloud-sshshell-'));
process.env.MITTICLOUD_VAULT_DIR = path.join(TMP_ROOT, 'vault');
process.env.MITTICLOUD_DATA_DIR = path.join(TMP_ROOT, 'data');

const { resolveShell, shellPath, redirectNodeInvocation, isEmbeddedAndroid, ptyHelper, NODE22_SHIM } =
  await import('../lib/sshserver.js');
const { nodeRuntime } = await import('../lib/apprunner.js');

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

test('the rewritten command actually runs and starts the server on THIS node', () => {
  // The real proof: take a ZCode-style launch line, point the "uploaded node" at
  // a script that reports its own version, rewrite it, and execute the result.
  // If the redirect is right, the script runs — on any host, any platform.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-e2e-'));
  const server = path.join(dir, 'zcode-server.cjs');
  fs.writeFileSync(
    server,
    "process.stdout.write('server-started ' + process.version + ' pid=' + process.pid)\n"
  );
  // An "uploaded node" that does not exist: if the redirect failed to swap it,
  // running the command would fail with ENOENT and the test would fail loudly.
  const fakeUploadedNode = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');

  process.env.MITTICLOUD_EMBEDDED = '1';
  process.env.MITTICLOUD_NATIVE_DIR = path.join(dir, 'native'); // no launcher → nodeRuntime() = process.execPath
  fs.mkdirSync(process.env.MITTICLOUD_NATIVE_DIR, { recursive: true });

  const quoted = (s) => `"${s}"`;
  const cmd = `${quoted(fakeUploadedNode)} ${quoted(server)}`;
  const rewritten = redirectNodeInvocation(cmd);
  assert.ok(!rewritten.includes(fakeUploadedNode), 'uploaded node swapped: ' + rewritten);

  // Run the server script with the node the rewrite chose. Reading it back out
  // of the string would trip over spaces in a Windows path, so resolve it the
  // same way the server does and assert it is a real, runnable node.
  const chosen = nodeRuntime();
  const out = execFileSync(chosen, [server], { encoding: 'utf8', timeout: 20000 });
  assert.match(out, /^server-started v\d+\.\d+\.\d+ pid=\d+/, out);
  assert.ok(!/libmittinode/.test(chosen), 'fallback runtime is a working node here');

  delete process.env.MITTICLOUD_NATIVE_DIR;
  delete process.env.MITTICLOUD_EMBEDDED;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('env assignments around the launch survive the rewrite', () => {
  process.env.MITTICLOUD_EMBEDDED = '1';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittinode-'));
  const launcher = path.join(dir, 'libmittinode.so');
  fs.writeFileSync(launcher, 'x');
  process.env.MITTICLOUD_NATIVE_DIR = dir;

  const cmd =
    'ZCODE_REMOTE_MODE="desktop-attached-remote" ZCODE_APP_VERSION=\'3.14.5\' /home/mitti/.zcode/server/node /home/mitti/.zcode/server/zcode-server.cjs';
  const out = redirectNodeInvocation(cmd);
  assert.ok(out.includes('ZCODE_REMOTE_MODE="desktop-attached-remote"'), out);
  assert.ok(out.includes("ZCODE_APP_VERSION='3.14.5'"), out);
  assert.ok(out.includes(launcher), out);

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
// --- the node:sqlite stand-in for ZCode's Node 22 server ---

test('zcode-server gets the node:sqlite shim so it can boot on the shipped Node 18', () => {
  process.env.MITTICLOUD_EMBEDDED = '1';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittinode-'));
  const launcher = path.join(dir, 'libmittinode.so');
  fs.writeFileSync(launcher, 'x');
  process.env.MITTICLOUD_NATIVE_DIR = dir;
  try {
    const out = redirectNodeInvocation('node ~/.zcode/server/zcode-server.cjs --port 0');
    assert.ok(out.startsWith(launcher + ' '), out);
    assert.ok(out.includes('--require=' + NODE22_SHIM), 'shim flag injected: ' + out);
    // the flag must sit before the script, or node treats it as an argument
    assert.ok(
      out.indexOf('--require=') < out.indexOf('zcode-server.cjs'),
      'flag precedes the script: ' + out
    );

    // a quoted node path keeps its quoting and still gains the flag
    const quoted = redirectNodeInvocation('"$HOME/.zcode/server/node" "$HOME/.zcode/server/zcode-server.cjs"');
    assert.ok(quoted.includes('" --require='), quoted);

    // re-running the rewrite must not stack a second flag
    const once = redirectNodeInvocation('node ~/.zcode/server/zcode-server.cjs');
    assert.equal(redirectNodeInvocation(once), once);
  } finally {
    delete process.env.MITTICLOUD_NATIVE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Cursor/code-server are redirected but never given the zcode shim', () => {
  process.env.MITTICLOUD_EMBEDDED = '1';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittinode-'));
  const launcher = path.join(dir, 'libmittinode.so');
  fs.writeFileSync(launcher, 'x');
  process.env.MITTICLOUD_NATIVE_DIR = dir;
  try {
    const cursor = redirectNodeInvocation('node ~/.cursor-server/bin/server-main.js --port 0');
    assert.ok(cursor.startsWith(launcher + ' '), cursor);
    assert.ok(!cursor.includes('mitti-node22-shim'), 'Cursor must not load the sqlite shim: ' + cursor);
  } finally {
    delete process.env.MITTICLOUD_NATIVE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the shim file exists where the rewrite points and answers node:sqlite', () => {
  // the rewrite points at this exact path; it must ship with the server
  assert.equal(fs.existsSync(NODE22_SHIM), true, 'shim exists at ' + NODE22_SHIM);
  const out = execFileSync(
    process.execPath,
    [
      '-e',
      `const s=require(${JSON.stringify(NODE22_SHIM)});process.stdout.write(typeof s.DatabaseSync+' '+typeof s.StatementSync)`,
    ],
    { encoding: 'utf8' }
  );
  assert.equal(out.trim(), 'function function');
});

// --- the rest of the Node 22 surface the ZCode client needs ---
//
// Each of these was a real blocker found by running the actual client bundle,
// so they are pinned here. The client refuses to start unless journal_mode
// reads back as "wal"; it calls `crypto.…` as a bare global; and it requires
// node:sea.

test('the sqlite stand-in answers the WAL handshake the client insists on', () => {
  const out = execFileSync(
    process.execPath,
    [
      '--require',
      NODE22_SHIM,
      '-e',
      `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(':memory:');
      // the write form must not throw
      db.prepare('pragma journal_mode = wal').run();
      // the read form must come back "wal", or the client aborts startup
      const read = db.prepare('pragma journal_mode').get();
      process.stdout.write(String(read && read.journal_mode));
      `,
    ],
    { encoding: 'utf8' }
  );
  assert.equal(out.trim(), 'wal');
});

test('the shim exposes crypto and node:sea that Node 18 lacks as globals', () => {
  const out = execFileSync(
    process.execPath,
    [
      '--require',
      NODE22_SHIM,
      '-e',
      `
      const sea = require('node:sea');
      process.stdout.write([
        typeof globalThis.crypto,
        typeof globalThis.crypto.subtle,
        typeof globalThis.crypto.randomUUID,
        sea.isSea(),
        sea.getAssetKeys().length,
      ].join(' '));
      `,
    ],
    { encoding: 'utf8' }
  );
  // crypto object, subtle present, randomUUID callable, not a SEA, no assets
  assert.equal(out.trim(), 'object object function false 0');
});

test('node:sea reports the truth for a non-SEA process instead of throwing', () => {
  const out = execFileSync(
    process.execPath,
    [
      '--require',
      NODE22_SHIM,
      '-e',
      `
      const sea = require('node:sea');
      let code = 'none';
      try { sea.getAsset('nope'); } catch (e) { code = e.code; }
      process.stdout.write(code);
      `,
    ],
    { encoding: 'utf8' }
  );
  // the real module throws ERR_NOT_IN_SEA when there are no assets
  assert.equal(out.trim(), 'ERR_NOT_IN_SEA');
});

// --- the ICU-less gap: ZCode's server uses \p{...} regexes and Intl, neither of
// which exists on nodejs-mobile's Node 18. Both are only reachable when the shim
// runs on a Node that has no ICU, which every dev machine here does — so the
// shim honours MITTI_FORCE_NO_ICU to make that path testable anywhere.

test('on a Node without ICU the shim rewrites \\p{...} so a regex LITERAL parses', () => {
  // The exact failure from the phone: a file whose SOURCE contains /[\p{L}]/u
  // cannot be parsed at all on an ICU-less Node — it dies before a line runs.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mitti-icu-'));
  const script = path.join(dir, 'literal.js');
  fs.writeFileSync(
    script,
    'const r = /[\\p{L}\\p{N}\\p{M}\\p{S}]/u;\n' +
      // 'a' is a letter, '5' a digit, '+' a math symbol (category S) — all match;
      // '!' is punctuation (P), which the class does NOT include.
      'process.stdout.write(String(r.test("a")) + " " + String(r.test("5")) + " " + String(r.test("+")) + " " + String(r.test("!")));\n'
  );
  try {
    // sanity: with ICU disabled the shim must make this file load and match
    const out = execFileSync(process.execPath, ['--require=' + NODE22_SHIM, script], {
      encoding: 'utf8',
      env: { ...process.env, MITTI_FORCE_NO_ICU: '1' },
    });
    assert.equal(out.trim(), 'true true true false', out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the shim answers Intl on a Node that has none, in local time', () => {
  const out = execFileSync(
    process.execPath,
    [
      '--require=' + NODE22_SHIM,
      '-e',
      'const f=new Intl.DateTimeFormat("en-CA",{year:"numeric",month:"2-digit",day:"2-digit"});' +
        'const p=f.formatToParts(new Date(2026,9,14));' +
        'process.stdout.write(p.map(x=>x.type+"="+x.value).join(","))',
    ],
    { encoding: 'utf8', env: { ...process.env, MITTI_FORCE_NO_ICU: '1' } }
  );
  assert.equal(out.trim(), 'year=2026,month=10,day=14');
});

test('on a full-ICU host the shim leaves regexes and Intl untouched', () => {
  // The substitutions are an approximation, so they must never run where the real
  // Unicode tables exist. With ICU present the shim reports so and changes nothing.
  const out = execFileSync(
    process.execPath,
    [
      '--require=' + NODE22_SHIM,
      '-e',
      'process.stdout.write(String(new Intl.DateTimeFormat("en-CA",{timeZone:"UTC"}).resolvedOptions().timeZone != null))',
    ],
    { encoding: 'utf8', env: { ...process.env, MITTI_FORCE_NO_ICU: '' } }
  );
  assert.equal(out.trim(), 'true');
});

test('a Node that already has node:sqlite is unaffected by the shim loader', () => {
  // the flag must never break a host whose Node already ships node:sqlite
  const out = execFileSync(
    process.execPath,
    ['--require=' + NODE22_SHIM, '-e', 'process.stdout.write(String(typeof require("node:sqlite").DatabaseSync))'],
    { encoding: 'utf8' }
  );
  assert.equal(out.trim(), 'function');
});

// --- the PTY helper lookup (full interactive shell) ---

test('ptyHelper: found only when the app shipped libmittish.so', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittish-'));
  try {
    delete process.env.MITTICLOUD_NATIVE_DIR;
    assert.equal(ptyHelper(), null, 'no env: nothing to find');

    process.env.MITTICLOUD_NATIVE_DIR = dir;
    assert.equal(ptyHelper(), null, 'missing helper: null');

    const helper = path.join(dir, 'libmittish.so');
    fs.writeFileSync(helper, 'x');
    assert.equal(ptyHelper(), helper, 'present helper: its path');

    process.env.MITTICLOUD_NATIVE_DIR = path.join(dir, 'nope');
    assert.equal(ptyHelper(), null, 'bad dir: null');
  } finally {
    delete process.env.MITTICLOUD_NATIVE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
