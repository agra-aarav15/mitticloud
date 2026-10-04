// Black-box tests for the MittiBadge: real counts only — publish a site,
// load its page, and the badge must report exactly that visit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mitticloud-badge-'));
process.env.MITTICLOUD_VAULT_DIR = path.join(TMP_ROOT, 'vault');
process.env.MITTICLOUD_DATA_DIR = path.join(TMP_ROOT, 'data');

const { app } = await import('../index.js');

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

after(() => new Promise((resolve) => server.close(resolve)));
after(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));

async function api(method, url, body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, opts);
  return { status: res.status, text: await res.text(), type: res.headers.get('content-type') || '' };
}

test('badge for a never-visited valid name shows an honest zero', async () => {
  const r = await api('GET', '/badge/fresh-site.svg');
  assert.equal(r.status, 200);
  assert.match(r.type, /svg/);
  assert.match(r.text, /0 visits today/);
  assert.match(r.text, /MITTICLOUD · SERVED FROM A DRAWER PHONE/);
  assert.match(r.text, /AC power|charging|battery/);
});

test('an invalid site name 404s', async () => {
  const r = await api('GET', '/badge/Bad_Name.svg');
  assert.equal(r.status, 404);
});

test('a real page load makes the badge count exactly one', async () => {
  await api('POST', '/api/sites', { name: 'shop' });
  await api('POST', '/api/sites/shop/files', {
    files: [{ path: 'index.html', contentBase64: Buffer.from('<h1>kurti shop</h1>').toString('base64') }],
  });
  const page = await api('GET', '/s/shop/');
  assert.equal(page.status, 200);

  const r = await api('GET', '/badge/shop.svg');
  assert.equal(r.status, 200);
  assert.match(r.text, /1 visits today/);

  await api('GET', '/s/shop/');
  const r2 = await api('GET', '/badge/shop.svg');
  assert.match(r2.text, /2 visits today/);
});

test('the snippet endpoint hands back a pasteable img tag', async () => {
  const r = await api('GET', '/badge/shop');
  assert.equal(r.status, 200);
  assert.match(r.text, /&lt;img src="http:\/\/127\.0\.0\.1:\d+\/badge\/shop\.svg"/);
  assert.match(r.text, /Live preview/);
});
