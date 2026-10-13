// Black-box tests for owner-supplied run commands — the "any language" door
// (server/lib/apprunner.js runCustomCommand/runCustomInstall + the
// startCommand/installCommand fields on PATCH /api/apps/:name).
//
// The custom command goes to the platform shell in the app folder with PORT
// set, so these tests use `node <file>` as the stand-in for python/php/go:
// what is proven is the shell path, the PORT hand-off and the queue wiring,
// not Node itself (apps.test.js covers Node entries). Vault + data are
// redirected to a throwaway temp folder; every app is deleted in after().
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- redirect vault/data BEFORE importing anything from server/ ---
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mitticloud-customrun-'));
process.env.MITTICLOUD_VAULT_DIR = path.join(TMP_ROOT, 'vault');
process.env.MITTICLOUD_DATA_DIR = path.join(TMP_ROOT, 'data');

const { app } = await import('../index.js');
const { APPS_DIR, stopAllApps } = await import('../lib/apprunner.js');
const { classifyProject } = await import('../lib/buildqueue.js');

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
  for (const name of ['cmd-app', 'inst-app']) {
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
    /* non-JSON body */
  }
  return { status: res.status, json, raw };
}

const b64 = (s) => Buffer.from(s).toString('base64');

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
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms`);
    await new Promise((r) => setTimeout(r, step));
  }
}

// Two .js files at the root: detectEntry() finds no entry (no common name, not
// a lone .js), so WITHOUT a start command this folder cannot run at all. The
// custom command is the only door — exactly the case the feature exists for.
const SERVER_JS = [
  "require('http').createServer(function (q, s) {",
  "  s.end('custom door on port ' + process.env.PORT);",
  "}).listen(process.env.PORT);",
].join('\n');
const MKFILE_JS = "require('fs').writeFileSync('installed.txt', 'yes');";
const FILES = [
  { path: 'app-main.js', contentBase64: b64(SERVER_JS) },
  { path: 'mkfile.js', contentBase64: b64(MKFILE_JS) },
];

// --- validation of the two command fields ---

test('PATCH /api/apps/:name validates startCommand/installCommand', async () => {
  assert.equal((await api('POST', '/api/apps', { name: 'cmd-app' })).status, 200);
  const put = (body) => api('PATCH', '/api/apps/cmd-app', body);
  assert.equal((await put({ startCommand: 'two\nlines' })).status, 400);
  assert.equal((await put({ startCommand: 'x'.repeat(501) })).status, 400);
  assert.equal((await put({ installCommand: 42 })).status, 400);
  const ok = await put({ startCommand: 'node app-main.js', installCommand: 'node mkfile.js' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.app.startCommand, 'node app-main.js');
  assert.equal(ok.json.app.installCommand, 'node mkfile.js');
  // empty string clears back to automatic detection
  const cleared = await put({ installCommand: '' });
  assert.equal(cleared.json.app.installCommand, undefined);
  await put({ installCommand: 'node mkfile.js' });
});

test('classifyProject: a saved start command wins over every heuristic', async () => {
  const dir = path.join(APPS_DIR, 'cmd-app');
  assert.equal(classifyProject(dir).startKind, null); // no entry, no package.json
  assert.equal(classifyProject(dir, { startCommand: 'node app-main.js' }).startKind, 'custom');
  assert.equal(classifyProject(dir, { startCommand: '   ' }).startKind, null);
});

// --- the custom door end to end: install command, then shell start ---

test('deploy runs the install command, then the custom start command serves HTTP', async () => {
  assert.equal((await api('POST', '/api/apps/cmd-app/files', { files: FILES })).status, 200);

  // the validation test above left commands saved; clear them so this probe
  // sees the bare folder
  await api('PATCH', '/api/apps/cmd-app', { startCommand: '', installCommand: '' });
  // without any command the folder is unrunnable — the honest error proves the
  // custom path below is what made it live
  const noCmd = await api('POST', '/api/apps/cmd-app/deploy', { install: false });
  assert.equal(noCmd.status, 400);
  assert.match(noCmd.json.error, /No entry file found/);
  await api('PATCH', '/api/apps/cmd-app', { startCommand: 'node app-main.js', installCommand: 'node mkfile.js' });

  const dep = await api('POST', '/api/apps/cmd-app/deploy', { install: true });
  assert.equal(dep.status, 200);
  assert.equal(dep.json.kind, 'custom');
  assert.ok(dep.json.port >= 7401 && dep.json.port <= 7499);
  // starting seeded the app's own package.json (CommonJS) so a bare .js never
  // inherits an ancestor repo's module type
  const pkg = JSON.parse(fs.readFileSync(path.join(APPS_DIR, 'cmd-app', 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'commonjs');

  // the install command really ran in the app folder
  assert.equal(fs.existsSync(path.join(APPS_DIR, 'cmd-app', 'installed.txt')), true);

  // and the started process answers with the custom server's own words
  const page = await until(async () => {
    const res = await fetch(`http://127.0.0.1:${dep.json.port}/`);
    const text = await res.text();
    return text.includes('custom door on port ' + dep.json.port) ? text : null;
  }, 8000);
  assert.ok(page);

  // the log shows the command as typed, so a failure is readable
  const logs = await api('GET', '/api/apps/cmd-app/logs');
  assert.ok(logs.json.lines.some((l) => l.includes('$ node app-main.js')));

  const stop = await api('POST', '/api/apps/cmd-app/stop');
  assert.equal(stop.status, 200);
});

test('listApps surfaces the saved commands so the UI can show them', async () => {
  assert.equal((await api('POST', '/api/apps', { name: 'inst-app' })).status, 200);
  await api('PATCH', '/api/apps/inst-app', { startCommand: 'python3 app.py' });
  const list = await api('GET', '/api/apps');
  const row = list.json.apps.find((a) => a.name === 'inst-app');
  assert.equal(row.startCommand, 'python3 app.py');
  assert.equal(row.installCommand, null);
});
