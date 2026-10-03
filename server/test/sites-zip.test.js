// Black-box tests for the MittiHost ZIP upload + usage endpoints
// (POST /api/sites/:name/zip, GET /api/sites/:name/usage) wired through the
// REAL app exported by server/index.js. Zips are built with the project's own
// zipWrite engine; vault + data are redirected to a throwaway temp folder, so
// the real site registry is never touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- redirect vault/data BEFORE importing anything from server/ ---
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mitticloud-siteszip-'));
process.env.MITTICLOUD_VAULT_DIR = path.join(TMP_ROOT, 'vault');
process.env.MITTICLOUD_DATA_DIR = path.join(TMP_ROOT, 'data');

const { DATA_DIR } = await import('../lib/paths.js');
const { app } = await import('../index.js');
const { zipWrite } = await import('../lib/zip.js');

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

  // a site with pre-existing content, to prove ZIP upload REPLACES it
  await api('POST', '/api/sites', { name: 'ziptest' });
  await api('POST', '/api/sites/ziptest/files', {
    files: [{ path: 'old.txt', contentBase64: Buffer.from('to be replaced').toString('base64') }],
  });
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

const zipForm = (entries, field = 'zip') => {
  const fd = new FormData();
  const buf = zipWrite(entries.map((e) => ({ path: e.path, data: Buffer.from(e.data) })));
  fd.append(field, new Blob([buf]), 'site.zip');
  return fd;
};

// --- happy path: upload, replace, serve ---

test('zip upload writes every entry and reports the file count', async () => {
  const { status, json } = await api(
    'POST',
    '/api/sites/ziptest/zip',
    zipForm([
      { path: 'index.html', data: '<h1>version one</h1>' },
      { path: 'css/style.css', data: 'body{color:#111}' },
    ])
  );
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, site: 'ziptest', files: 2 });
});

test('the uploaded site is served at /s/<name> and old content is gone', async () => {
  const index = await api('GET', '/s/ziptest/');
  assert.equal(index.status, 200);
  assert.ok(index.raw.includes('version one'));
  const css = await api('GET', '/s/ziptest/css/style.css');
  assert.equal(css.status, 200);
  assert.equal(css.raw, 'body{color:#111}');
  const old = await api('GET', '/s/ziptest/old.txt');
  assert.equal(old.status, 404, 'REPLACE means the previous files are removed');
});

test('a second upload replaces the site again (no stale index)', async () => {
  const { status, json } = await api(
    'POST',
    '/api/sites/ziptest/zip',
    zipForm([{ path: 'about.html', data: '<p>version two</p>' }])
  );
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, site: 'ziptest', files: 1 });
  assert.equal((await api('GET', '/s/ziptest/')).status, 404, 'index.html is gone');
  const about = await api('GET', '/s/ziptest/about.html');
  assert.equal(about.status, 200);
  assert.ok(about.raw.includes('version two'));
});

test('usage reports {bytes, files} for the current contents', async () => {
  const { status, json } = await api('GET', '/api/sites/ziptest/usage');
  assert.equal(status, 200);
  assert.deepEqual(json, { bytes: Buffer.byteLength('<p>version two</p>'), files: 1 });
});

// --- rejections (and the site must survive every one of them) ---

test('traversal entry inside the zip is rejected, site untouched', async () => {
  const { status, json } = await api(
    'POST',
    '/api/sites/ziptest/zip',
    zipForm([
      { path: '../evil.txt', data: 'escaped' },
      { path: 'ok.txt', data: 'fine' },
    ])
  );
  assert.equal(status, 400);
  assert.match(json.error, /Unsafe path/);
  assert.ok(!fs.existsSync(path.join(TMP_ROOT, 'evil.txt')), 'nothing written outside the site');
  assert.ok(!fs.existsSync(path.join(SITES_DIR, 'ziptest', 'ok.txt')), 'partial write prevented');
  assert.equal((await api('GET', '/s/ziptest/about.html')).status, 200, 'site survives');
});

test('absolute path entry inside the zip is rejected', async () => {
  const { status, json } = await api(
    'POST',
    '/api/sites/ziptest/zip',
    zipForm([{ path: '/abs.txt', data: 'escaped' }])
  );
  assert.equal(status, 400);
  assert.match(json.error, /Unsafe path/);
});

test('a non-zip body is a 400', async () => {
  const fd = new FormData();
  fd.append('zip', new Blob([Buffer.from('this is not a zip file')]), 'junk.zip');
  const { status, json } = await api('POST', '/api/sites/ziptest/zip', fd);
  assert.equal(status, 400);
  assert.match(json.error, /ZIP/);
});

test('missing zip form field is a 400', async () => {
  const fd = new FormData();
  fd.append('notzip', new Blob([Buffer.from('x')]), 'x.zip');
  const { status } = await api('POST', '/api/sites/ziptest/zip', fd);
  assert.equal(status, 400);
});

test('archives over 25 MB are rejected', async () => {
  const fd = new FormData();
  fd.append('zip', new Blob([Buffer.alloc(26 * 1024 * 1024, 7)]), 'big.zip');
  const { status } = await api('POST', '/api/sites/ziptest/zip', fd);
  assert.equal(status, 400);
});

test('zip upload auto-creates a missing site; usage on unknown site and bad name are 404', async (t) => {
  const form = zipForm([{ path: 'index.html', data: '<p>hi</p>' }]);
  const created = await api('POST', '/api/sites/ghost-site/zip', form);
  assert.equal(created.status, 200, 'zip upload auto-creates the site');
  assert.equal((await api('GET', '/s/ghost-site/')).status, 200);
  t.after(async () => { await api('DELETE', '/api/sites/ghost-site'); });
  assert.equal((await api('GET', '/api/sites/ghost-site/usage')).status, 200);
  assert.equal((await api('GET', '/api/sites/never-was/usage')).status, 404);
  const bad = new FormData();
  bad.append('zip', new Blob([zipWrite([{ path: 'x.txt', data: Buffer.from('x') }])]), 'x.zip');
  assert.equal((await api('POST', '/api/sites/UPPER/zip', bad)).status, 404);
});
