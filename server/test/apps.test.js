// Black-box tests for the live Node-app hosting engine (server/lib/apprunner.js
// + server/routes/apps.js), the code-editor content routes (server/routes/files.js)
// and the deep-health upgrade (server/routes/health.js + server/lib/selfcheck.js),
// wired through the REAL app exported by server/index.js. Vault + data are
// redirected to a throwaway temp folder, so the real registry is never touched.
//
// Hosted apps are REAL child processes serving on 127.0.0.1:7401-7499. They are
// zero-dependency (no npm registry is ever hit — every deploy uses
// install:false, and npmInstallAvailable() only spawns `npm --version`).
// Cleanup is airtight: each app is deleteApp'ed (stop + rm + registry) and the
// suite-level after() kills anything left so no node processes leak.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- redirect vault/data BEFORE importing anything from server/ ---
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mitticloud-apps-'));
process.env.MITTICLOUD_VAULT_DIR = path.join(TMP_ROOT, 'vault');
process.env.MITTICLOUD_DATA_DIR = path.join(TMP_ROOT, 'data');

const { DATA_DIR } = await import('../lib/paths.js');
const { app } = await import('../index.js');
const {
  APPS_DIR,
  REGISTRY_FILE,
  validName,
  detectEntry,
  buildEnv,
  npmInstallAvailable,
  readRegistry,
  stopAllApps,
} = await import('../lib/apprunner.js');
const { zipRead } = await import('../lib/zip.js');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // belt + braces: remove every app this file may have created (each DELETE
  // also stops the process), kill any leftover child, then tear the rest down
  for (const name of ['echo-app', 'boom-app', 'list-app', 'editor-app']) {
    try {
      await api('DELETE', `/api/apps/${name}`);
    } catch {
      /* server may already be closing */
    }
  }
  stopAllApps();
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeIdleConnections?.();
  });
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

// --- helpers ---

async function api(method, url, body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, opts);
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // non-JSON body (zip export, served pages)
  }
  return { status: res.status, json, raw };
}

const b64 = (s) => Buffer.from(s).toString('base64');

/** Poll fn() until it returns truthy (or throws after `ms`). */
async function until(fn, ms, step = 250) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for: ${fn}`);
    await new Promise((r) => setTimeout(r, step));
  }
}

// A zero-dependency CJS app that proves both facts worth proving: the runner
// hands it PORT, and owner-set env vars reach the process. package.json pins
// "type":"commonjs" so no ancestor package.json can flip the module system.
const ECHO_INDEX = [
  "require('http').createServer(function (q, s) {",
  "  s.end('hello ' + (process.env.MY_MSG || '') + ' on port ' + process.env.PORT);",
  "}).listen(process.env.PORT);",
].join('\n');
const ECHO_FILES = [
  { path: 'index.js', contentBase64: b64(ECHO_INDEX) },
  { path: 'package.json', contentBase64: b64(JSON.stringify({ type: 'commonjs' })) },
];

// --- 1. name rules (pure function) ---

test('validName: rejects uppercase, spaces, over-32, the reserved "apps"; accepts a good one', () => {
  assert.throws(() => validName('MyApp'), /Name can use/);
  assert.throws(() => validName('has space'), /Name can use/);
  assert.throws(() => validName('a'.repeat(33)), /Name can use/);
  assert.throws(() => validName(''), /Name can use/);
  assert.throws(() => validName('apps'), /reserved/);
  assert.equal(validName('good-app-1'), 'good-app-1');
});

// --- 2. entry detection (pure function over a real dir) ---

test('detectEntry: package.json main wins over common names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mitti-detect-main-'));
  try {
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'lib', 'main.js'), '// real entry\n');
    fs.writeFileSync(path.join(dir, 'index.js'), '// decoy\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ main: 'lib/main.js' }));
    assert.deepEqual(detectEntry(dir), { entry: 'lib/main.js', how: 'package.json main' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectEntry: scripts.start "node server.js" is honoured when main is absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mitti-detect-start-'));
  try {
    fs.writeFileSync(path.join(dir, 'server.js'), '// server\n');
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { start: 'node server.js' } })
    );
    assert.deepEqual(detectEntry(dir), { entry: 'server.js', how: 'npm start' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectEntry: falls back to index.js, and null on an empty dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mitti-detect-fb-'));
  try {
    assert.equal(detectEntry(dir), null, 'empty dir -> null');
    fs.writeFileSync(path.join(dir, 'index.js'), '// app\n');
    assert.deepEqual(detectEntry(dir), { entry: 'index.js', how: 'common name' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 3. env construction ---

test('buildEnv: parent secrets scrubbed, PORT always set, app env added, junk keys ignored', () => {
  process.env.SOME_TEST_KEY = 'parent-secret';
  process.env.MITTI_FAKE_PROBE = 'parent-fake';
  try {
    const env = buildEnv({ MY_MSG: 'hi', 'bad-key': 'nope' }, 7421);
    assert.equal(env.SOME_TEST_KEY, undefined, 'parent *KEY* never reaches an app');
    assert.equal(env.MITTI_FAKE_PROBE, undefined, 'parent MITTI_FAKE* never reaches an app');
    assert.equal(env.PORT, '7421', 'PORT is always the chosen port');
    assert.equal(env.MY_MSG, 'hi', 'owner-set app env is added deliberately');
    assert.equal('bad-key' in env, false, 'invalid app env key names are ignored');
    assert.ok(env.PATH, 'ordinary parent env still passes through');
  } finally {
    delete process.env.SOME_TEST_KEY;
    delete process.env.MITTI_FAKE_PROBE;
  }
});

test('npmInstallAvailable answers a boolean (no registry contact)', async () => {
  assert.equal(typeof (await npmInstallAvailable()), 'boolean');
});

// --- 4. create + list + duplicate ---

test('createApp makes the dir + registry row; duplicate create is a 409', async () => {
  const created = await api('POST', '/api/apps', { name: 'list-app' });
  assert.equal(created.status, 200);
  assert.ok(fs.existsSync(path.join(APPS_DIR, 'list-app')), 'dir created under APPS_DIR');
  assert.ok(readRegistry().some((a) => a.name === 'list-app'), 'registry row written');

  const list = await api('GET', '/api/apps');
  const row = list.json.apps.find((a) => a.name === 'list-app');
  assert.ok(row, 'the app is listed');
  assert.equal(row.state, 'stopped');

  const dup = await api('POST', '/api/apps', { name: 'list-app' });
  assert.equal(dup.status, 409);
});

// --- 5. PATCH persists to the registry + validates ---

test('PATCH sets env/runOnBoot/ramCapMB in data/apps.json; bad values are 400s', async () => {
  const ok = await api('PATCH', '/api/apps/list-app', {
    env: { GOOD_KEY: 'v1' },
    runOnBoot: true,
    ramCapMB: 256,
  });
  assert.equal(ok.status, 200);
  const rec = readRegistry().find((a) => a.name === 'list-app');
  assert.deepEqual(rec.env, { GOOD_KEY: 'v1' });
  assert.equal(rec.runOnBoot, true);
  assert.equal(rec.ramCapMB, 256);
  assert.ok(fs.existsSync(REGISTRY_FILE), 'registry lives at data/apps.json');

  const lowCap = await api('PATCH', '/api/apps/list-app', { ramCapMB: 10 });
  assert.equal(lowCap.status, 400, 'ramCapMB < 32 is refused');

  const badKey = await api('PATCH', '/api/apps/list-app', { env: { 'BAD-KEY': 'v' } });
  assert.equal(badKey.status, 400, 'invalid env key name is refused');
});

// --- 6. full lifecycle against the REAL engine ---

test('lifecycle: upload, PATCH env, deploy serves on 7401-7499 with env; stop kills; start revives', async () => {
  const created = await api('POST', '/api/apps', { name: 'echo-app' });
  assert.equal(created.status, 200);

  const uploaded = await api('POST', '/api/apps/echo-app/files', { files: ECHO_FILES });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.json));

  const patched = await api('PATCH', '/api/apps/echo-app', { env: { MY_MSG: 'mitti-echo' } });
  assert.equal(patched.status, 200);

  const deployed = await api('POST', '/api/apps/echo-app/deploy', { install: false });
  assert.equal(deployed.status, 200, JSON.stringify(deployed.json));
  assert.equal(deployed.json.state, 'running');
  const port = deployed.json.port;
  assert.ok(port >= 7401 && port <= 7499, `port ${port} inside 7401-7499`);
  assert.equal(deployed.json.installRan, false, 'install:false ran no npm');

  const body = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  assert.ok(body.includes('mitti-echo'), 'the PATCHed env var reached the app process');
  assert.ok(body.includes(String(port)), 'the PORT env var reached the app process');

  const list = await api('GET', '/api/apps');
  const row = list.json.apps.find((a) => a.name === 'echo-app');
  assert.equal(row.state, 'running');
  assert.ok('ramMB' in row, 'ramMB field exists (honest null where /proc is missing)');
  assert.equal(row.port, port);

  const stopped = await api('POST', '/api/apps/echo-app/stop', {});
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.state, 'stopped');
  await until(
    async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
        return null; // still answering -> keep polling
      } catch {
        return true; // connection refused -> the kill landed
      }
    },
    5000,
    200
  );
  await assert.rejects(
    () => fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }),
    undefined,
    'after stop, the app no longer answers'
  );

  const started = await api('POST', '/api/apps/echo-app/start', {});
  assert.equal(started.status, 200, JSON.stringify(started.json));
  assert.equal(started.json.state, 'running');
  assert.ok(started.json.port >= 7401 && started.json.port <= 7499);
  const body2 = await fetch(`http://127.0.0.1:${started.json.port}/`).then((r) => r.text());
  assert.ok(body2.includes('mitti-echo'), 'env survives a restart');
});

// --- 7. crash honesty (restart ladder: 1s + 3s + 9s backoffs, then crashed) ---

test('a crashing app gets an honest deploy error, its boom in the logs, and ends crashed', async (t) => {
  t.after(async () => {
    try {
      await api('DELETE', '/api/apps/boom-app');
    } catch {
      /* already gone */
    }
  });
  await api('POST', '/api/apps', { name: 'boom-app' });
  await api('POST', '/api/apps/boom-app/files', {
    files: [{ path: 'index.js', contentBase64: b64("console.error('boom-test'); process.exit(1);") }],
  });

  const deployed = await api('POST', '/api/apps/boom-app/deploy', { install: false });
  assert.ok(
    deployed.status >= 400 && deployed.status <= 599,
    `deploy reports the failure honestly (got ${deployed.status})`
  );
  assert.ok(deployed.json && deployed.json.error, 'with a human-readable message');

  const logs = await until(async () => {
    const r = await api('GET', '/api/apps/boom-app/logs');
    const text = (r.json.lines || []).join('\n');
    return /boom-test|exited/.test(text) ? text : null;
  }, 20000);
  assert.match(logs, /boom-test|exited/);

  // the backoff ladder (1s + 3s + 9s) must exhaust into an honest 'crashed'
  await until(async () => {
    const list = await api('GET', '/api/apps');
    const row = list.json.apps.find((a) => a.name === 'boom-app');
    return row && row.state === 'crashed' ? row : null;
  }, 25000);
});

// --- 8. code editor routes over the app folder ---

test('editor: PUT/GET /api/files/content round-trips an app file; caps and refusals hold', async (t) => {
  t.after(async () => {
    try {
      await api('DELETE', '/api/apps/editor-app');
    } catch {
      /* already gone */
    }
  });
  await api('POST', '/api/apps', { name: 'editor-app' });

  // no lock token needed while unlocked (the default)
  const put = await api('PUT', '/api/files/content', {
    path: 'apps/editor-app/notes.txt',
    content: 'mitti editor rocks',
  });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  const onDisk = fs.readFileSync(path.join(APPS_DIR, 'editor-app', 'notes.txt'), 'utf8');
  assert.equal(onDisk, 'mitti editor rocks', 'the atomic write landed on disk');

  const get = await api('GET', '/api/files/content?path=apps/editor-app/notes.txt');
  assert.equal(get.status, 200);
  assert.equal(get.json.content, 'mitti editor rocks');
  assert.equal(get.json.path, 'apps/editor-app/notes.txt');
  assert.equal(get.json.size, Buffer.byteLength('mitti editor rocks'));

  const tooBig = await api('PUT', '/api/files/content', {
    path: 'apps/editor-app/big.txt',
    content: 'a'.repeat(201 * 1024), // just over the 200 KB save cap
  });
  assert.equal(tooBig.status, 413);

  const binary = await api('PUT', '/api/files/content', {
    path: 'apps/editor-app/blob.txt',
    content: 'text\u0000with a NUL byte',
  });
  assert.equal(binary.status, 415);

  const escape = await api('GET', '/api/files/content?path=../escape');
  assert.equal(escape.status, 400);
  assert.ok(!fs.existsSync(path.join(TMP_ROOT, 'escape')), 'nothing written outside the vault');
});

// --- 9. export ---

test('export: a real zip (PK) carrying mitti.json with the app name and entry', async () => {
  const res = await fetch(base + '/api/apps/echo-app/export', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.ok((res.headers.get('content-type') || '').startsWith('application/zip'));
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString('ascii'), 'PK', 'body starts with the zip magic');

  const entries = zipRead(buf);
  assert.ok(entries.some((e) => e.path === 'index.js'), 'the app code travels too');
  const manifest = entries.find((e) => e.path === 'mitti.json');
  assert.ok(manifest, 'mitti.json is inside the zip');
  const m = JSON.parse(manifest.data.toString('utf8'));
  assert.equal(m.name, 'echo-app');
  assert.equal(m.entry, 'index.js');
});

// --- 10. delete ---

test('DELETE removes the dir and the registry row (fs + registry verify)', async () => {
  // stop first and wait until the child is really gone: deleteApp kills
  // asynchronously, and on Windows the dying process holds its cwd open for a
  // few ms — deleting a RUNNING app can race the rm (reported separately)
  await api('POST', '/api/apps/echo-app/stop', {});
  await until(async () => {
    const list = await api('GET', '/api/apps');
    const row = list.json.apps.find((a) => a.name === 'echo-app');
    return row && row.state === 'stopped' ? row : null;
  }, 5000);
  // give the killed process a beat to release its cwd handle
  await new Promise((r) => setTimeout(r, 300));

  const deleted = await api('DELETE', '/api/apps/echo-app');
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.deleted, true);
  assert.equal(fs.existsSync(path.join(APPS_DIR, 'echo-app')), false, 'folder gone');
  assert.equal(readRegistry().some((a) => a.name === 'echo-app'), false, 'registry row gone');
  const list = await api('GET', '/api/apps');
  assert.equal(list.json.apps.some((a) => a.name === 'echo-app'), false);
});

// --- 11. deep health (sites liveness + backup age) ---

test('deep health: a served site counts up, an empty registered site counts down', async (t) => {
  t.after(async () => {
    await api('DELETE', '/api/sites/dh-up');
    await api('DELETE', '/api/sites/dh-down');
  });
  await api('POST', '/api/sites', { name: 'dh-up' });
  await api('POST', '/api/sites/dh-up/files', {
    files: [{ path: 'index.html', contentBase64: b64('<h1>deep health up</h1>') }],
  });
  await api('POST', '/api/sites', { name: 'dh-down' }); // registered, zero files

  assert.equal((await api('GET', '/s/dh-up/')).status, 200);
  assert.equal((await api('GET', '/s/dh-down/')).status, 404, 'the empty site is really down');

  const { status, json } = await api('GET', '/api/health?deep=1');
  assert.equal(status, 200);
  assert.ok(json.sites.total >= 2, 'both sites are counted');
  assert.equal(json.sites.up, json.sites.total - 1, 'exactly the empty site is down');
  assert.equal(json.sites.results.find((r) => r.name === 'dh-up').up, true);
  assert.equal(json.sites.results.find((r) => r.name === 'dh-down').up, false);

  assert.ok('count' in json.backup, 'backup.count field present');
  assert.ok('ageMs' in json.backup, 'backup.ageMs field present (null when none ran yet)');
  assert.equal(json.backup.count, 0, 'no backup has run in this throwaway data dir');
  assert.equal(json.backup.ageMs, null);
});
