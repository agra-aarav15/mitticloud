// Black-box tests for the multipart folder-upload routes
// (POST /api/sites/:name/upload, POST /api/apps/:name/upload) wired through
// the REAL app exported by server/index.js. Each part's field name is the
// target path inside the project — exactly what the web dashboard and the
// Android app send — so folder structure and big files survive without
// base64. Vault + data are redirected to a throwaway temp folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- redirect vault/data BEFORE importing anything from server/ ---
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mitticloud-upload-'));
process.env.MITTICLOUD_VAULT_DIR = path.join(TMP_ROOT, 'vault');
process.env.MITTICLOUD_DATA_DIR = path.join(TMP_ROOT, 'data');

const { DATA_DIR } = await import('../lib/paths.js');
const { app } = await import('../index.js');
const { APPS_DIR } = await import('../lib/apprunner.js');

const SITES_DIR = path.join(DATA_DIR, 'sites');

// --- tiny server + fetch helpers ---

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  await api('POST', '/api/sites', { name: 'uptest' });
});

after(() => new Promise((resolve) => server.close(resolve)));
after(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));

async function api(method, url, body) {
  const opts = { method };
  if (body !== undefined) {
    if (body instanceof FormData) {
      opts.body = body;
    } else {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(base + url, opts);
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // non-JSON (served site pages)
  }
  return { status: res.status, json, raw };
}

const folderForm = (files) => {
  const fd = new FormData();
  for (const f of files) fd.append(f.path, new Blob([f.data]), f.path.split('/').pop());
  return fd;
};

// --- happy path: structure, serving, big files ---

test('multipart upload writes the folder structure and serves it', async () => {
  const { status, json } = await api(
    'POST',
    '/api/sites/uptest/upload',
    folderForm([
      { path: 'index.html', data: '<h1>hello multipart</h1>' },
      { path: 'css/site.css', data: 'body{color:#000}' },
      { path: 'js/app.js', data: 'console.log(1)' },
    ])
  );
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.written, 3);
  assert.equal(
    fs.readFileSync(path.join(SITES_DIR, 'uptest', 'css', 'site.css'), 'utf8'),
    'body{color:#000}'
  );
  const page = await api('GET', '/s/uptest/');
  assert.equal(page.status, 200);
  assert.ok(page.raw.includes('hello multipart'));
});

test('a file over the old 2 MB base64 cap uploads fine', async () => {
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  const { status, json } = await api(
    'POST',
    '/api/sites/uptest/upload',
    folderForm([{ path: 'media/big.bin', data: big }])
  );
  assert.equal(status, 200);
  assert.equal(json.written, 1);
  const st = fs.statSync(path.join(SITES_DIR, 'uptest', 'media', 'big.bin'));
  assert.equal(st.size, big.length);
});

// --- safety: paths stay inside the site, unknown sites 404 ---

test('an escaping field name is refused and writes nothing', async () => {
  const { status } = await api(
    'POST',
    '/api/sites/uptest/upload',
    folderForm([{ path: '../escape.txt', data: 'nope' }])
  );
  assert.ok(status >= 400);
  assert.equal(fs.existsSync(path.join(SITES_DIR, 'escape.txt')), false);
  assert.equal(fs.existsSync(path.join(SITES_DIR, 'uptest', 'escape.txt')), false);
});

test('upload to an unknown site is a 404', async () => {
  const { status } = await api(
    'POST',
    '/api/sites/nosuchsite/upload',
    folderForm([{ path: 'a.txt', data: 'x' }])
  );
  assert.equal(status, 404);
});

// --- the same contract on the apps side ---

test('app folder upload lands in the app directory', async () => {
  const created = await api('POST', '/api/apps', { name: 'upapp' });
  assert.equal(created.status, 200);
  const { status, json } = await api(
    'POST',
    '/api/apps/upapp/upload',
    folderForm([
      { path: 'index.js', data: 'console.log("up")' },
      { path: 'lib/util.js', data: 'module.exports = {}' },
    ])
  );
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.files, 2);
  assert.equal(
    fs.readFileSync(path.join(APPS_DIR, 'upapp', 'lib', 'util.js'), 'utf8'),
    'module.exports = {}'
  );
  const list = await api('GET', '/api/apps');
  const rec = (list.json.apps || []).find((a) => a.name === 'upapp');
  assert.equal(rec.fileCount, 2);
});
