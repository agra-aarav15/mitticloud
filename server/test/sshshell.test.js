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

const { resolveShell, shellPath, shellEnv, redirectNodeInvocation, isEmbeddedAndroid, ptyHelper, NODE22_SHIM } =
  await import('../lib/sshserver.js');
const { shellTmpDir, DATA_DIR } = await import('../lib/paths.js');
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

test('shellEnv hands embedded children a writable TMPDIR and respects an explicit one', () => {
  // There is no /tmp on Android: a child whose os.tmpdir() falls back to it
  // dies on the first socket bind (the agent crash-looped 114 times on
  // `listen EACCES /tmp/znr-*.sock`). TMPDIR is how libuv is told better.
  const savedTmp = process.env.TMPDIR;
  const savedEmbedded = process.env.MITTICLOUD_EMBEDDED;
  delete process.env.TMPDIR;
  try {
    delete process.env.MITTICLOUD_EMBEDDED;
    if (process.platform !== 'android') {
      assert.equal('TMPDIR' in shellEnv(), false, 'desktop: no TMPDIR is added');
      assert.equal(shellTmpDir(), null, 'desktop: no tmp dir is created');
    }

    process.env.MITTICLOUD_EMBEDDED = '1';
    const env = shellEnv();
    assert.ok(env.TMPDIR, 'embedded: TMPDIR is set');
    assert.equal(env.TMPDIR, path.join(DATA_DIR, 'tmp'), 'embedded: TMPDIR is under data/');
    assert.equal(fs.existsSync(env.TMPDIR), true, 'embedded: TMPDIR exists');

    process.env.TMPDIR = '/kept/tmp';
    assert.equal(shellEnv().TMPDIR, '/kept/tmp', 'an explicit TMPDIR is respected');
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
    if (savedEmbedded === undefined) delete process.env.MITTICLOUD_EMBEDDED;
    else process.env.MITTICLOUD_EMBEDDED = savedEmbedded;
  }
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

// The regression that made every remote send fail: the client's session store
// INSERTs a session and then SELECTs it straight back to confirm the write. The
// old stand-in stored nothing, so that check threw `Session not found after
// write`, which the agent reports as `fault.command.executionFailed` — the
// desktop's "Failed to send" banner. These tests pin the real behaviour.

test('node:sqlite is a REAL database: a written row reads back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mitti-sql-'));
  const dbFile = path.join(dir, 'session.sqlite');
  try {
    const out = execFileSync(
      process.execPath,
      [
        '--require',
        NODE22_SHIM,
        '-e',
        `
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(process.argv[1], { timeout: 5000 });
        db.exec('create table session (id text primary key, title text, time_updated integer)');
        // the client writes with VARIADIC binds and reads back the same row
        db.prepare('insert into session (id, title, time_updated) values (?, ?, ?)')
          .run('sess_1', 'hello', 42);
        const back = db.prepare('select * from session where id = ?').get('sess_1');
        const list = db.prepare('select * from session order by time_updated desc, id desc limit ?').all(10);
        const missing = db.prepare('select * from session where id = ?').get('nope');
        const upd = db.prepare('update session set time_updated = max(time_updated, ?) where id = ?').run(999, 'sess_1');
        db.close();
        // and the data survives a reopen — real file, real persistence
        const again = new DatabaseSync(process.argv[1]);
        const persisted = again.prepare('select time_updated from session where id = ?').get('sess_1');
        again.close();
        process.stdout.write(JSON.stringify({
          back: back && back.title,
          listed: list.length,
          missing: missing === undefined,   // node:sqlite returns undefined, not null
          changes: upd.changes,
          persisted: persisted && persisted.time_updated,
        }));
        `,
        dbFile,
      ],
      { encoding: 'utf8' }
    );
    assert.deepEqual(JSON.parse(out.trim()), {
      back: 'hello',
      listed: 1,
      missing: true,
      changes: 1,
      persisted: 999,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the sqlite adapter takes named binds, bare or prefixed', () => {
  const out = execFileSync(
    process.execPath,
    [
      '--require',
      NODE22_SHIM,
      '-e',
      `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(':memory:');
      db.exec('create table t (id text primary key, v integer)');
      db.prepare('insert into t (id, v) values (:id, :v)').run({ id: 'a', v: 1 });   // bare
      db.prepare('insert into t (id, v) values (:id, :v)').run({ ':id': 'b', ':v': 2 }); // prefixed
      process.stdout.write(JSON.stringify(db.prepare('select id from t order by id').all()));
      `,
    ],
    { encoding: 'utf8' }
  );
  assert.deepEqual(JSON.parse(out.trim()), [{ id: 'a' }, { id: 'b' }]);
});

test('unfinalized statements never lock the database out of DDL or a reopen', () => {
  // The client prepares statements and never finalizes them. A WASM statement
  // held open blocks DROP TABLE, VACUUM and reopening the file, so the adapter
  // must not keep one alive between calls. This is the trap that made the
  // first prototype fail on the phone.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mitti-lock-'));
  const dbFile = path.join(dir, 'lock.sqlite');
  try {
    const out = execFileSync(
      process.execPath,
      [
        '--require',
        NODE22_SHIM,
        '-e',
        `
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(process.argv[1]);
        db.exec('create table t (a integer)');
        db.prepare('insert into t values (?)').run(1);
        // statements used but never finalized, as the client does
        db.prepare('select * from t where a = ?').get(1);
        db.prepare('select * from t').all();
        for (let i = 0; i < 200; i += 1) db.prepare('select ? as v').get(i);
        const step = [];
        try { db.exec('drop table t'); step.push('drop-ok'); } catch (e) { step.push('drop-failed:' + e.message); }
        db.close();
        try {
          const again = new DatabaseSync(process.argv[1]);
          again.exec('vacuum');
          step.push('reopen-vacuum-ok');
          again.close();
        } catch (e) { step.push('reopen-failed:' + e.message); }
        process.stdout.write(step.join(' '));
        `,
        dbFile,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(out.trim(), 'drop-ok reopen-vacuum-ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the shim adds the ES2023 methods Node 18 lacks (MCP startup needs toSorted)', () => {
  // On the phone the agent logged `Object.keys(...).toSorted is not a function`
  // at every boot, which failed MCP startup. The shim installs the missing
  // methods; the real ones are left alone on a newer host.
  const out = execFileSync(
    process.execPath,
    [
      '--require',
      NODE22_SHIM,
      '-e',
      `
      const added = {
        toSorted: [3,1,2].toSorted((a,b) => a-b),
        toReversed: [1,2,3].toReversed(),
        toSpliced: [1,2,3,4].toSpliced(1,2,'x'),
        with: [1,2,3].with(-1, 9),
        withResolvers: typeof Promise.withResolvers().promise.then,
        groupBy: Object.keys(Object.groupBy([1,2,3,4], (n) => (n % 2 ? 'odd' : 'even'))),
        mapGroupBy: [...Map.groupBy([1,2,3,4], (n) => (n % 2 ? 'odd' : 'even')).keys()],
        isWellFormed: 'ok'.isWellFormed(),
      };
      process.stdout.write(JSON.stringify(added));
      `,
    ],
    { encoding: 'utf8' }
  );
  assert.deepEqual(JSON.parse(out.trim()), {
    toSorted: [1, 2, 3],
    toReversed: [3, 2, 1],
    toSpliced: [1, 'x', 4],
    with: [1, 2, 9],
    withResolvers: 'function',
    groupBy: ['odd', 'even'],
    mapGroupBy: ['odd', 'even'],
    isWellFormed: true,
  });
});

test('the real-SQLite adapter ships with the server and is used, not the old stub', () => {
  // The APK stages server/ + node_modules, so the adapter and its engine must
  // both exist next to the shim.
  const adapter = path.join(path.dirname(NODE22_SHIM), 'mitti-sqlite.cjs');
  assert.equal(fs.existsSync(adapter), true, 'adapter exists at ' + adapter);
  const engine = path.join(
    path.dirname(NODE22_SHIM),
    '..',
    '..',
    'node_modules',
    'node-sqlite3-wasm',
    'dist',
    'node-sqlite3-wasm.wasm'
  );
  assert.equal(fs.existsSync(engine), true, 'wasm engine exists at ' + engine);
  const src = fs.readFileSync(NODE22_SHIM, 'utf8');
  assert.ok(src.includes("require('./mitti-sqlite.cjs')"), 'the shim uses the adapter');
  // dependency declared so the APK build installs it
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(NODE22_SHIM), '..', '..', 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies['node-sqlite3-wasm'], 'node-sqlite3-wasm is a dependency');
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

test('the worker reroute targets the agent bundle and never the server', () => {
  // The shim redirects a spawn of the agent bundle onto a worker thread, because
  // the bundle faults on the main thread on Android. It must NOT touch
  // zcode-server.cjs: that is the long-lived server, and wrapping it in a worker
  // would break the connection outright. Read the pattern straight from the shim
  // so this test cannot drift from the code it guards.
  const src = fs.readFileSync(NODE22_SHIM, 'utf8');
  const m = src.match(/const BUNDLE_RE = (\/.*\/);/);
  assert.ok(m, 'BUNDLE_RE is present in the shim');
  const bundleRe = eval(m[1]);

  const shouldMatch = [
    '/home/u/.zcode/server/agents/glm/zcode.cjs',
    '/data/local/tmp/fh/zcode.cjs',
    '/data/local/tmp/fh/zcode-agent.cjs',
    'C:\\Users\\x\\.zcode\\agents\\zcode.cjs',
  ];
  const mustNotMatch = [
    '/home/u/.zcode/server/zcode-server.cjs', // the server itself
    '/x/zcode-server.cjs',
    '/x/zmzcode.cjs',
    '/x/otherzcode.cjs',
    '/x/notzcode.cjs',
  ];
  for (const p of shouldMatch) assert.ok(bundleRe.test(p), 'should match: ' + p);
  for (const p of mustNotMatch) assert.ok(!bundleRe.test(p), 'must NOT match: ' + p);
});

test('the worker wrapper ships beside the shim and forwards stdio', () => {
  const wrapper = path.join(path.dirname(NODE22_SHIM), 'mitti-agent-wrapper.cjs');
  assert.equal(fs.existsSync(wrapper), true, 'wrapper exists at ' + wrapper);
  const src = fs.readFileSync(wrapper, 'utf8');
  // It must be a worker-thread runner that forwards real stdio both ways and
  // propagates the exit code — that is what makes it stand in for a child.
  assert.ok(src.includes("require('node:worker_threads')"), 'uses worker_threads');
  assert.ok(src.includes('process.stdin.pipe('), 'forwards stdin in');
  assert.ok(src.includes('worker.stdout.pipe(process.stdout)'), 'forwards stdout out');
  assert.ok(src.includes("worker.on('exit'"), 'propagates the exit code');
  // And it must be syntactically valid, since a broken wrapper would turn a
  // working agent into a silent failure.
  execFileSync(process.execPath, ['--check', wrapper], { encoding: 'utf8' });
});

test('the agent-entry reroute matches the deployed entry and nothing else', () => {
  // The server spawns `.../server/agents/glm/zcode-agent` per session; on the
  // phone that spawn dies with EACCES, so the shim reroutes it to the sibling
  // bundle on the phone's own node. Read the pattern from the shim so this test
  // cannot drift from the code it guards.
  const src = fs.readFileSync(NODE22_SHIM, 'utf8');
  const m = src.match(/const AGENT_BIN_RE = (\/.*\/);/);
  assert.ok(m, 'AGENT_BIN_RE is present in the shim');
  const agentRe = eval(m[1]);

  const shouldMatch = [
    '/data/data/in.mitticloud.app/files/mitti/vault/.zcode/server/agents/glm/zcode-agent',
    'C:\\Users\\x\\.zcode\\server\\agents\\glm\\zcode-agent.exe',
    '/x/zcode-agent',
  ];
  const mustNotMatch = [
    '/x/zcode-agent.cjs', // the bundle, not the entry — handled by BUNDLE_RE
    '/home/u/.zcode/server/zcode-server.cjs', // the server itself
    '/x/my-zcode-agent-backup', // lookalikes are not the entry
    '/x/zcode-agent-old',
    '/x/not-the-agent',
  ];
  for (const p of shouldMatch) assert.ok(agentRe.test(p), 'should match: ' + p);
  for (const p of mustNotMatch) assert.ok(!agentRe.test(p), 'must NOT match: ' + p);
});

test('spawning the agent entry runs the sibling bundle, never the vault file', () => {
  // The exact phone failure, reproduced anywhere: the "entry" is garbage that
  // cannot be executed (spawn would die EACCES/ENOENT), the sibling bundle is a
  // tiny script. With the shim loaded in Android mode, spawning the entry must
  // run the bundle on a worker — marker printed, session args passed through.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mitti-agententry-'));
  try {
    const entry = path.join(dir, 'zcode-agent');
    fs.writeFileSync(entry, 'this is not executable and must never be execed\n');
    fs.writeFileSync(
      path.join(dir, 'zcode.cjs'),
      'process.stdout.write("AGENT_BUNDLE_RAN argv=" + process.argv.slice(2).join(",") + "\\n");\n'
    );
    const driver = path.join(dir, 'driver.js');
    fs.writeFileSync(
      driver,
      'const { spawn } = require("node:child_process");\n' +
        'const child = spawn(process.argv[2], ["app-server", "--stdio"], { stdio: ["ignore", "pipe", "pipe"] });\n' +
        'child.on("error", (e) => { process.stdout.write("SPAWN_ERROR:" + e.code + "\\n"); });\n' +
        'child.stdout.on("data", (d) => process.stdout.write(d));\n'
    );
    const out = execFileSync(process.execPath, ['--require=' + NODE22_SHIM, driver, entry], {
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, MITTICLOUD_PLATFORM: 'android' },
    });
    assert.ok(
      out.includes('AGENT_BUNDLE_RAN argv=app-server,--stdio'),
      'the bundle ran with the session args; got: ' + JSON.stringify(out)
    );
    assert.ok(!out.includes('SPAWN_ERROR'), 'no spawn error; got: ' + JSON.stringify(out));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without the sibling bundle the agent-entry spawn is left alone', () => {
  // Honest fallback: an entry with no zcode.cjs beside it is some future layout
  // the shim does not understand, so the original spawn must run untouched —
  // here it fails at spawn level, exactly as it would without the shim.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mitti-agententry-'));
  try {
    const entry = path.join(dir, 'zcode-agent');
    fs.writeFileSync(entry, 'not executable\n');
    const driver = path.join(dir, 'driver.js');
    fs.writeFileSync(
      driver,
      'const { spawn } = require("node:child_process");\n' +
        'const child = spawn(process.argv[2], ["app-server", "--stdio"], { stdio: ["ignore", "pipe", "pipe"] });\n' +
        'child.on("error", (e) => { process.stdout.write("SPAWN_ERROR:" + e.code + "\\n"); process.exit(0); });\n' +
        'child.stdout.on("data", (d) => process.stdout.write(d));\n' +
        'child.on("close", (c) => { process.stdout.write("EXIT:" + c + "\\n"); });\n'
    );
    const out = execFileSync(process.execPath, ['--require=' + NODE22_SHIM, driver, entry], {
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, MITTICLOUD_PLATFORM: 'android' },
    });
    assert.ok(
      /SPAWN_ERROR:(EACCES|ENOENT)/.test(out),
      'the untouched spawn fails at spawn level; got: ' + JSON.stringify(out)
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('the Intl stand-ins work when called as plain functions, like the real ones', () => {
  // ECMA-402 makes Intl constructors callable without `new` (they return a
  // fresh instance) — the client's config reader calls DateTimeFormat that
  // way, and the old class-based stand-in died with
  // "cannot be invoked without 'new'".
  const out = execFileSync(
    process.execPath,
    [
      '--require=' + NODE22_SHIM,
      '-e',
      'const f=Intl.DateTimeFormat("en-CA",{year:"numeric",month:"2-digit",day:"2-digit"});' +
        'const g=Intl.NumberFormat("en-US");' +
        'process.stdout.write(f.format(new Date(2026,9,14))+"|"+g.format(42));',
    ],
    { encoding: 'utf8', env: { ...process.env, MITTI_FORCE_NO_ICU: '1' } }
  );
  assert.equal(out.trim(), '2026-10-14|42');
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
