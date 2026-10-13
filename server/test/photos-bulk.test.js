// Black-box tests for selective photo deletion (POST /api/photos/delete) and
// for the metadata pruning both delete paths now share: a deleted photo leaves
// no favorite and no sha1 index entry behind. Vault + data are redirected to a
// throwaway temp folder, so the real photo vault is never touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- redirect vault/data BEFORE importing anything from server/ ---
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mitticloud-photobulk-'));
process.env.MITTICLOUD_VAULT_DIR = path.join(TMP_ROOT, 'vault');
process.env.MITTICLOUD_DATA_DIR = path.join(TMP_ROOT, 'data');

const { app } = await import('../index.js');
const { DATA_DIR, PHOTOS_DIR } = await import('../lib/paths.js');

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
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeIdleConnections?.();
  });
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

async function api(method, url, body) {
  const opts = { method };
  if (body !== undefined) {
    if (typeof body === 'object' && typeof body.get === 'function') {
      opts.body = body; // FormData: fetch must set the multipart boundary itself
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
    /* non-JSON body */
  }
  return { status: res.status, json, raw };
}

// smallest bytes that are "a photo" to this API: extension decides, content is
// never parsed — the vault stores what it is given
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9]);

async function uploadOne(name, bytes) {
  const fd = new FormData();
  fd.append('photo', new Blob([bytes], { type: 'image/jpeg' }), name);
  const { status, json } = await api('POST', '/api/photos/one', fd);
  assert.equal(status, 200);
  return json.path;
}

const readMeta = () =>
  JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'photos-meta.json'), 'utf8'));

test('bulk delete removes exactly the picked photos and reports the rest', async () => {
  const a = await uploadOne('a.jpg', JPEG);
  const b = await uploadOne('b.jpg', JPEG.subarray(1));
  const c = await uploadOne('c.jpg', JPEG.subarray(2));
  // favorite two of them so pruning has something to clean
  assert.equal((await api('PATCH', `/api/photos/${encodeURIComponent(a)}/favorite`, { favorite: true })).status, 200);
  assert.equal((await api('PATCH', `/api/photos/${encodeURIComponent(b)}/favorite`, { favorite: true })).status, 200);

  const del = await api('POST', '/api/photos/delete', { paths: [a, b, 'nope/missing.jpg'] });
  assert.equal(del.status, 200);
  assert.equal(del.json.ok, true);
  assert.equal(del.json.deleted, 2);
  assert.deepEqual(del.json.missing, ['nope/missing.jpg']);

  const list = await api('GET', '/api/photos');
  assert.deepEqual(list.json.photos.map((p) => p.path), [c]);

  // files are gone from disk, the untouched one is not
  assert.equal(fs.existsSync(path.join(PHOTOS_DIR, a)), false);
  assert.equal(fs.existsSync(path.join(PHOTOS_DIR, b)), false);
  assert.equal(fs.existsSync(path.join(PHOTOS_DIR, c)), true);

  // favorites AND the sha1 index are pruned for deleted photos only
  const meta = readMeta();
  assert.deepEqual(meta.favorites, {});
  assert.equal(Object.keys(meta.bySha1).length, 1);

  // re-uploading the same bytes now stores a fresh copy (index was pruned)
  const a2 = await uploadOne('a-again.jpg', JPEG);
  assert.notEqual(a2, a);
});

test('bulk delete validates its input and jails every path', async () => {
  assert.equal((await api('POST', '/api/photos/delete', {})).status, 400);
  assert.equal((await api('POST', '/api/photos/delete', { paths: [] })).status, 400);
  assert.equal(
    (await api('POST', '/api/photos/delete', { paths: Array.from({ length: 501 }, () => 'x.jpg') })).status,
    400
  );
  // a traversal attempt is reported missing, never resolved outside the vault
  const esc = await api('POST', '/api/photos/delete', { paths: ['..%2F..%2Fetc%2Fpasswd'] });
  assert.equal(esc.status, 200);
  assert.deepEqual(esc.json.missing, ['..%2F..%2Fetc%2Fpasswd']);
  assert.equal(esc.json.deleted, 0);
});

test('single DELETE prunes metadata too (shared helper)', async () => {
  const d = await uploadOne('d.jpg', JPEG.subarray(3));
  await api('PATCH', `/api/photos/${encodeURIComponent(d)}/favorite`, { favorite: true });
  assert.equal((await api('DELETE', '/api/photos?path=' + encodeURIComponent(d))).status, 200);
  const meta = readMeta();
  assert.deepEqual(meta.favorites, {});
  assert.equal(Object.values(meta.bySha1).includes(d), false);
});
