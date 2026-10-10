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
  assert.equal(json.ok, true);
  assert.equal(json.site, 'ziptest');
  assert.equal(json.files, 2);
  assert.equal(json.unwrapped, null, 'flat archives stay flat');
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
  assert.equal(json.files, 1);
  const root = await api('GET', '/s/ziptest/');
  assert.equal(root.status, 200, 'the lone HTML page is the site entry');
  assert.ok(root.raw.includes('version two'));
  const about = await api('GET', '/s/ziptest/about.html');
  assert.equal(about.status, 200);
  assert.ok(about.raw.includes('version two'));
});

test('a folder with several HTML pages and no index lists them as links', async () => {
  await api('POST', '/api/sites', { name: 'multipage' });
  await api('POST', '/api/sites/multipage/files', {
    files: [
      { path: 'a.html', contentBase64: Buffer.from('<p>page a</p>').toString('base64') },
      { path: 'b.html', contentBase64: Buffer.from('<p>page b</p>').toString('base64') },
    ],
  });
  const root = await api('GET', '/s/multipage/');
  assert.equal(root.status, 200);
  assert.ok(root.raw.includes('href="/s/multipage/a.html"'));
  assert.ok(root.raw.includes('href="/s/multipage/b.html"'));
});

test('a site with index.html still serves it, and a missing file still 404s', async () => {
  await api('POST', '/api/sites', { name: 'withindex' });
  await api('POST', '/api/sites/withindex/files', {
    files: [
      { path: 'index.html', contentBase64: Buffer.from('<p>front</p>').toString('base64') },
      { path: 'other.html', contentBase64: Buffer.from('<p>other</p>').toString('base64') },
    ],
  });
  const root = await api('GET', '/s/withindex/');
  assert.equal(root.status, 200);
  assert.ok(root.raw.includes('front'));
  assert.equal((await api('GET', '/s/withindex/missing.txt')).status, 404);
});

test('a GitHub-style wrapper folder is unwrapped so /s/<name>/ serves index.html', async (t) => {
  // the exact layout a "Download ZIP" from GitHub produces — the bug the
  // owner hit with his real portfolio
  const { status, json } = await api(
    'POST',
    '/api/sites/wrapped/zip',
    zipForm([
      { path: 'agra-aarav15.github.io-main/index.html', data: '<h1>portfolio live</h1>' },
      { path: 'agra-aarav15.github.io-main/styles.css', data: 'body{background:#0a0a0a}' },
      { path: 'agra-aarav15.github.io-main/projects/a.html', data: '<p>deep page</p>' },
    ])
  );
  assert.equal(status, 200);
  assert.equal(json.unwrapped, 'agra-aarav15.github.io-main');
  const index = await api('GET', '/s/wrapped/');
  assert.equal(index.status, 200, 'index.html now at the site root');
  assert.ok(index.raw.includes('portfolio live'));
  assert.equal((await api('GET', '/s/wrapped/projects/a.html')).status, 200);
  assert.ok(!fs.existsSync(path.join(SITES_DIR, 'wrapped', 'agra-aarav15.github.io-main')));
  t.after(async () => { await api('DELETE', '/api/sites/wrapped'); });
});

test('a zip whose entries do NOT share one root stays verbatim', async (t) => {
  const { status, json } = await api(
    'POST',
    '/api/sites/mixed/zip',
    zipForm([
      { path: 'index.html', data: '<h1>root page</h1>' },
      { path: 'docs/readme.md', data: '# docs' },
    ])
  );
  assert.equal(status, 200);
  assert.equal(json.unwrapped, null, 'index.html at root means nothing to unwrap');
  assert.equal((await api('GET', '/s/mixed/')).status, 200);
  t.after(async () => { await api('DELETE', '/api/sites/mixed'); });
});

test('a zip bomb that inflates past the cap is refused without wiping the site', async () => {
  const big = Buffer.alloc(60 * 1024 * 1024, 0); // zeros deflate ~1000:1
  const fd = new FormData();
  fd.append(
    'zip',
    new Blob([
      zipWrite([
        { path: 'a.bin', data: big },
        { path: 'b.bin', data: big },
      ]),
    ]),
    'bomb.zip'
  );
  const before = await api('GET', '/s/ziptest/about.html');
  const { status, json } = await api('POST', '/api/sites/ziptest/zip', fd);
  assert.equal(status, 400);
  assert.match(json.error, /inflates past/);
  assert.equal((await api('GET', '/s/ziptest/about.html')).status, 200, 'site intact');
  assert.equal(before.status, 200);
});

test('an upload with no zip field does not create a site', async () => {
  const fd = new FormData();
  fd.append('notzip', new Blob([Buffer.from('x')]), 'x.zip');
  await api('POST', '/api/sites/no-site-created/zip', fd);
  const list = await api('GET', '/api/sites');
  assert.equal(
    (list.json.sites || []).some((s) => s.name === 'no-site-created'),
    false,
    'rejected upload must not leave a registered site'
  );
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
