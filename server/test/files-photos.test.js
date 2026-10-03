// Black-box tests for the Files (real-drive) + Photos (backup) API extensions.
//
// server/index.js starts listening on import and exports nothing, so these
// tests mount the REAL route modules on a minimal express app exactly the way
// index.js does (express.json + 404 + error handler), listen on port 0 and
// talk over global fetch. The vault + data dirs are redirected to throwaway
// temp folders via MITTICLOUD_VAULT_DIR / MITTICLOUD_DATA_DIR (see paths.js),
// so the real vault is never touched. Tests within the file run sequentially
// and share the seeded fixtures; later tests mutate earlier ones' output.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- redirect vault/data BEFORE importing anything from server/ ---
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mitticloud-drive-'));
process.env.MITTICLOUD_VAULT_DIR = path.join(TMP_ROOT, 'vault');
process.env.MITTICLOUD_DATA_DIR = path.join(TMP_ROOT, 'data');

const { FILES_DIR, PHOTOS_DIR, DATA_DIR } = await import('../lib/paths.js');
const { default: filesRouter } = await import('../routes/files.js');
const { default: photosRouter } = await import('../routes/photos.js');
const { buildDirZip } = await import('../lib/dirzip.js');
const { zipRead } = await import('../lib/zip.js');
const express = (await import('express')).default;
const multer = (await import('multer')).default;

// --- fixtures ---

const FAKE_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
const PHOTO_A = Buffer.from(`mitticloud-photo-alpha-${'A'.repeat(64)}`);
const PHOTO_B = Buffer.from(`mitticloud-photo-beta--${'B'.repeat(64)}`);
const PHOTO_C = Buffer.from(`mitticloud-photo-gamma-${'C'.repeat(64)}`);
const SEED_PHOTO_REL = '2026/01/15/seed-photo.jpg';

// path (posix, vault/files-relative) -> bytes
const SEED_FILES = new Map([
  ['top.txt', Buffer.from('top level file')],
  ['docs/readme.txt', Buffer.from('hello mitticloud')],
  ['docs/sub/deep/nested-note.txt', Buffer.from('deeply nested note')],
  ['pics/mitti.jpg', FAKE_JPEG],
]);

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

function seedFile(rel, data) {
  const abs = path.join(FILES_DIR, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
}

function countFiles(dir) {
  let n = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      if (ent.isDirectory()) stack.push(path.join(cur, ent.name));
      else if (ent.isFile()) n++;
    }
  }
  return n;
}

function exists(rel) {
  return fs.existsSync(path.join(FILES_DIR, ...rel.split('/')));
}

// --- tiny app + fetch helpers ---

let server;
let base;

/** Same mounting order + error handler as server/index.js. */
function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/photos', photosRouter);
  app.use('/api/files', filesRouter);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const isMulterError =
      (typeof multer.MulterError === 'function' && err instanceof multer.MulterError) ||
      (err && err.name === 'MulterError');
    if (isMulterError) {
      return res.status(400).json({ error: `Upload failed: ${err.message}` });
    }
    const status =
      Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599
        ? err.status
        : 500;
    if (status >= 500) console.error('[test] error:', err);
    res.status(status).json({ error: err?.message || 'Internal server error' });
  });
  return app;
}

/** fetch + JSON decode; `json`/FormData body passed straight through. */
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
    // binary / non-JSON response
  }
  return { status: res.status, headers: res.headers, json, raw };
}

// --- lifecycle ---

before(async () => {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  for (const [rel, data] of SEED_FILES) seedFile(rel, data);
  const seedPhoto = path.join(PHOTOS_DIR, ...SEED_PHOTO_REL.split('/'));
  fs.mkdirSync(path.dirname(seedPhoto), { recursive: true });
  fs.writeFileSync(seedPhoto, FAKE_JPEG);

  server = buildApp().listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));
after(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));

// --- legacy endpoints still work (shapes unchanged for the live UI) ---

test('legacy: GET /api/files browses with name/type/size/modifiedAt entries', async () => {
  const { status, json } = await api('GET', '/api/files?path=docs');
  assert.equal(status, 200);
  assert.equal(json.path, 'docs');
  const names = json.entries.map((e) => e.name);
  assert.deepEqual(names, ['sub', 'readme.txt']); // dirs first, then files
  for (const e of json.entries) {
    assert.deepEqual(Object.keys(e), ['name', 'type', 'size', 'modifiedAt']);
  }
});

test('legacy: POST /api/files/mkdir creates a directory', async () => {
  const { status, json } = await api('POST', '/api/files/mkdir', { path: 'made-dir' });
  assert.equal(status, 200);
  assert.deepEqual(json, { created: true });
  assert.ok(exists('made-dir'));
  fs.rmSync(path.join(FILES_DIR, 'made-dir'), { recursive: true, force: true }); // keep usage exact
});

// --- GET /api/files/search ---

test('search finds a nested file, case-insensitively', async () => {
  const { status, json } = await api('GET', '/api/files/search?q=NESTED-NOTE');
  assert.equal(status, 200);
  const hit = json.results.find((r) => r.path === 'docs/sub/deep/nested-note.txt');
  assert.ok(hit, 'nested file should be found');
  assert.equal(hit.size, SEED_FILES.get('docs/sub/deep/nested-note.txt').length);
  assert.ok(!Number.isNaN(Date.parse(hit.mtime)));
  assert.deepEqual(Object.keys(hit), ['path', 'size', 'mtime']);
});

test('search matches folder names too (size 0)', async () => {
  const { status, json } = await api('GET', '/api/files/search?q=deep');
  assert.equal(status, 200);
  const hit = json.results.find((r) => r.path === 'docs/sub/deep');
  assert.ok(hit, 'folder should be found');
  assert.equal(hit.size, 0);
});

test('search without q is a 400', async () => {
  const { status } = await api('GET', '/api/files/search');
  assert.equal(status, 400);
});

// --- GET /api/files/usage ---

test('usage totals match the seeded sizes per top-level entry', async () => {
  const size = (rel) => SEED_FILES.get(rel).length;
  const docsBytes = size('docs/readme.txt') + size('docs/sub/deep/nested-note.txt');
  const { status, json } = await api('GET', '/api/files/usage');
  assert.equal(status, 200);
  assert.deepEqual(json.tree, [
    { path: 'docs', bytes: docsBytes, files: 2 },
    { path: 'pics', bytes: size('pics/mitti.jpg'), files: 1 },
    { path: 'top.txt', bytes: size('top.txt'), files: 1 },
  ]);
  assert.equal(json.total, docsBytes + size('pics/mitti.jpg') + size('top.txt'));
});

// --- GET /api/files/archive ---

test('archive zips a folder; zipRead round-trips name + bytes', async () => {
  const res = await fetch(base + '/api/files/archive?path=' + encodeURIComponent('docs'));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/zip/);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="docs.zip"');
  const buf = Buffer.from(await res.arrayBuffer());
  const entries = zipRead(buf); // sorted by path
  assert.deepEqual(entries.map((e) => e.path), ['readme.txt', 'sub/deep/nested-note.txt']);
  assert.equal(entries[0].data.toString(), 'hello mitticloud');
  assert.equal(entries[1].data.toString(), 'deeply nested note');
});

test('archive: missing dir 404, file target 400, traversal 400', async () => {
  assert.equal((await api('GET', '/api/files/archive?path=no-such-dir')).status, 404);
  assert.equal((await api('GET', '/api/files/archive?path=pics/mitti.jpg')).status, 400);
  assert.equal((await api('GET', '/api/files/archive?path=..%2Foutside')).status, 400);
});

// --- POST /api/files/rename ---

test('rename file', async () => {
  const { status, json } = await api('POST', '/api/files/rename', {
    path: 'docs/readme.txt',
    newName: 'intro.txt',
  });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, path: 'docs/intro.txt' });
  assert.ok(exists('docs/intro.txt'));
  assert.ok(!exists('docs/readme.txt'));
});

test('rename folder keeps its contents', async () => {
  const { status, json } = await api('POST', '/api/files/rename', {
    path: 'docs/sub',
    newName: 'nested',
  });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, path: 'docs/nested' });
  assert.equal(
    fs.readFileSync(path.join(FILES_DIR, 'docs/nested/deep/nested-note.txt'), 'utf8'),
    'deeply nested note'
  );
});

test('rename errors: missing source 404, target exists 409, empty name 400, separators 400, traversal 400', async () => {
  assert.equal((await api('POST', '/api/files/rename', { path: 'ghost.txt', newName: 'x' })).status, 404);
  assert.equal((await api('POST', '/api/files/rename', { path: 'docs/intro.txt', newName: 'intro.txt' })).status, 409);
  assert.equal((await api('POST', '/api/files/rename', { path: 'docs/intro.txt', newName: '  ' })).status, 400);
  assert.equal((await api('POST', '/api/files/rename', { path: 'docs/intro.txt', newName: 'a/b' })).status, 400);
  assert.equal((await api('POST', '/api/files/rename', { path: '../outside', newName: 'x' })).status, 400);
});

// --- POST /api/files/move ---

test('move a folder to the root (toDir "")', async () => {
  const { status, json } = await api('POST', '/api/files/move', { from: 'docs/nested', toDir: '' });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, path: 'nested' });
  assert.ok(exists('nested/deep/nested-note.txt'));
  assert.ok(!exists('docs/nested'));
});

test('move a file into a folder', async () => {
  const { status, json } = await api('POST', '/api/files/move', { from: 'top.txt', toDir: 'docs' });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, path: 'docs/top.txt' });
  assert.ok(exists('docs/top.txt'));
  assert.ok(!exists('top.txt'));
});

test('move errors: missing source 404, missing toDir 404, dest exists 409, root refused 400, into itself 400', async () => {
  fs.writeFileSync(path.join(FILES_DIR, 'clash.txt'), 'x');
  fs.writeFileSync(path.join(FILES_DIR, 'docs', 'clash.txt'), 'y');
  assert.equal((await api('POST', '/api/files/move', { from: 'ghost.txt', toDir: '' })).status, 404);
  assert.equal((await api('POST', '/api/files/move', { from: 'clash.txt', toDir: 'no-such-dir' })).status, 404);
  assert.equal((await api('POST', '/api/files/move', { from: 'clash.txt', toDir: 'docs' })).status, 409);
  assert.equal((await api('POST', '/api/files/move', { from: '.', toDir: '' })).status, 400);
  assert.equal((await api('POST', '/api/files/move', { from: 'docs', toDir: 'docs' })).status, 400);
});

// --- POST /api/files/copy ---

test('copy a folder recursively (source stays put)', async () => {
  const { status, json } = await api('POST', '/api/files/copy', { from: 'nested', toDir: 'docs' });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, path: 'docs/nested' });
  assert.equal(
    fs.readFileSync(path.join(FILES_DIR, 'docs/nested/deep/nested-note.txt'), 'utf8'),
    'deeply nested note'
  );
  assert.ok(exists('nested/deep/nested-note.txt'), 'source survives a copy');
});

test('copy a single file', async () => {
  fs.mkdirSync(path.join(FILES_DIR, 'copy-dest')); // a folder to copy into
  const { status, json } = await api('POST', '/api/files/copy', { from: 'clash.txt', toDir: 'copy-dest' });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, path: 'copy-dest/clash.txt' });
  assert.equal(fs.readFileSync(path.join(FILES_DIR, 'copy-dest/clash.txt'), 'utf8'), 'x');
});

test('copy errors: missing source 404, dest exists 409, traversal 400', async () => {
  assert.equal((await api('POST', '/api/files/copy', { from: 'ghost.txt', toDir: '' })).status, 404);
  assert.equal((await api('POST', '/api/files/copy', { from: 'nested', toDir: 'docs' })).status, 409);
  assert.equal((await api('POST', '/api/files/copy', { from: '../outside', toDir: '' })).status, 400);
});

// --- POST /api/files/delete (multi) ---

test('multi-delete removes files + dirs recursively, skips missing', async () => {
  const { status, json } = await api('POST', '/api/files/delete', {
    paths: ['nested', 'clash.txt', 'ghost.txt'],
  });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, deleted: 2 });
  assert.ok(!exists('nested'));
  assert.ok(!exists('clash.txt'));
  assert.ok(exists('docs/intro.txt'), 'the rest of the vault is untouched');
});

test('multi-delete: traversal 400, root refused 400, empty list 400', async () => {
  assert.equal((await api('POST', '/api/files/delete', { paths: ['../escaped'] })).status, 400);
  assert.equal((await api('POST', '/api/files/delete', { paths: ['.'] })).status, 400);
  assert.equal((await api('POST', '/api/files/delete', { paths: [] })).status, 400);
});

// --- POST /api/files/upload-multipart ---

test('upload-multipart writes a nested rel path, creating parents', async () => {
  const fd = new FormData();
  fd.set('to', 'uploads');
  fd.set('rel', '2026/report final.txt');
  fd.append('file', new Blob([Buffer.from('quarterly report content')]), 'report final.txt');
  const { status, json } = await api('POST', '/api/files/upload-multipart', fd);
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, path: 'uploads/2026/report final.txt' });
  assert.equal(
    fs.readFileSync(path.join(FILES_DIR, 'uploads/2026/report final.txt'), 'utf8'),
    'quarterly report content'
  );
});

test('upload-multipart with empty "to" lands in the files root', async () => {
  const fd = new FormData();
  fd.set('to', '');
  fd.set('rel', 'root-drop.bin');
  fd.append('file', new Blob([FAKE_JPEG]), 'drop.bin');
  const { status, json } = await api('POST', '/api/files/upload-multipart', fd);
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, path: 'root-drop.bin' });
});

test('upload-multipart rejects bad rel paths and missing file', async () => {
  const noFile = new FormData();
  noFile.set('to', '');
  noFile.set('rel', 'x.txt');
  assert.equal((await api('POST', '/api/files/upload-multipart', noFile)).status, 400);

  const mk = (rel) => {
    const fd = new FormData();
    fd.set('to', '');
    fd.set('rel', rel);
    fd.append('file', new Blob([Buffer.from('x')]), 'x.txt');
    return fd;
  };
  assert.equal((await api('POST', '/api/files/upload-multipart', mk('../evil.txt'))).status, 400);
  assert.equal((await api('POST', '/api/files/upload-multipart', mk('/evil.txt'))).status, 400);
  assert.equal((await api('POST', '/api/files/upload-multipart', mk(''))).status, 400);
});

// --- legacy: single DELETE still works after the refactor ---

test('legacy: DELETE /api/files deletes one file', async () => {
  const { status, json } = await api(
    'DELETE',
    '/api/files?path=' + encodeURIComponent('uploads/2026/report final.txt')
  );
  assert.equal(status, 200);
  assert.deepEqual(json, { deleted: true });
  assert.ok(!exists('uploads/2026/report final.txt'));
});

// --- zip size cap (shared helper behind both archive routes) ---

test('buildDirZip refuses trees over the byte cap with 413', async () => {
  await assert.rejects(
    () => buildDirZip(FILES_DIR, { maxBytes: 1 }),
    (err) => err.status === 413
  );
});

// --- POST /api/photos/one (sha1 dedup) ---

let photoAPath = '';
let photoBPath = '';

test('photos/one stores a new photo and indexes its sha1', async () => {
  const fd = new FormData();
  fd.append('photo', new Blob([PHOTO_A], { type: 'image/jpeg' }), 'a.jpg');
  const { status, json } = await api('POST', '/api/photos/one', fd);
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, duplicate: false, path: json.path });
  assert.match(json.path, /^\d{4}\/\d{2}\/\d{2}\//); // day-folder convention
  assert.ok(fs.existsSync(path.join(PHOTOS_DIR, ...json.path.split('/'))));
  photoAPath = json.path;
});

test('photos/one dedupes identical bytes without writing again', async () => {
  const before = countFiles(PHOTOS_DIR);
  const fd = new FormData();
  fd.append('photo', new Blob([PHOTO_A], { type: 'image/jpeg' }), 'a-again.jpg');
  const { status, json } = await api('POST', '/api/photos/one', fd);
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, duplicate: true, path: photoAPath });
  assert.equal(countFiles(PHOTOS_DIR), before, 'no extra file on disk');
});

test('photos/one stores different bytes as a new photo', async () => {
  const fd = new FormData();
  fd.append('photo', new Blob([PHOTO_B], { type: 'image/jpeg' }), 'b.jpg');
  const { status, json } = await api('POST', '/api/photos/one', fd);
  assert.equal(status, 200);
  assert.equal(json.duplicate, false);
  assert.notEqual(json.path, photoAPath);
  photoBPath = json.path;
});

test('photos/one updates data/photos-meta.json with correct sha1 keys', async () => {
  const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'photos-meta.json'), 'utf8'));
  assert.deepEqual(Object.keys(meta), ['bySha1', 'favorites']);
  assert.equal(meta.bySha1[sha1(PHOTO_A)], photoAPath);
  assert.ok(meta.bySha1[sha1(PHOTO_B)]);
});

test('photos/one without a file is a 400', async () => {
  const fd = new FormData();
  fd.set('notphoto', 'x');
  assert.equal((await api('POST', '/api/photos/one', fd)).status, 400);
});

// --- GET /api/photos (favorite merged in) ---

test('listing keeps its shape and adds favorite:false', async () => {
  const { status, json } = await api('GET', '/api/photos');
  assert.equal(status, 200);
  const seed = json.photos.find((p) => p.path === SEED_PHOTO_REL);
  assert.ok(seed, 'seeded photo should be listed');
  assert.deepEqual(Object.keys(seed), ['name', 'path', 'url', 'size', 'uploadedAt', 'favorite']);
  assert.equal(seed.favorite, false);
  const a = json.photos.find((p) => p.path === photoAPath);
  assert.ok(a);
  assert.equal(a.favorite, false);
});

// --- PATCH /api/photos/:id/favorite ---

test('favorite PATCH persists true into the meta file and listing', async () => {
  const url = '/api/photos/' + encodeURIComponent(photoAPath) + '/favorite';
  const { status, json } = await api('PATCH', url, { favorite: true });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, favorite: true });

  const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'photos-meta.json'), 'utf8'));
  assert.equal(meta.favorites[photoAPath], true);

  const list = (await api('GET', '/api/photos')).json.photos;
  assert.equal(list.find((p) => p.path === photoAPath).favorite, true);
  assert.equal(list.find((p) => p.path === SEED_PHOTO_REL).favorite, false);
});

test('favorite PATCH false removes the flag again', async () => {
  const url = '/api/photos/' + encodeURIComponent(photoAPath) + '/favorite';
  const { status, json } = await api('PATCH', url, { favorite: false });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, favorite: false });
  const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'photos-meta.json'), 'utf8'));
  assert.ok(!(photoAPath in meta.favorites));
});

test('favorite PATCH errors: missing photo 404, bad body 400, traversal 400', async () => {
  const gone = '/api/photos/' + encodeURIComponent('2026/01/01/none.jpg') + '/favorite';
  assert.equal((await api('PATCH', gone, { favorite: true })).status, 404);
  const ok = '/api/photos/' + encodeURIComponent(SEED_PHOTO_REL) + '/favorite';
  assert.equal((await api('PATCH', ok, {})).status, 400);
  assert.equal((await api('PATCH', ok, { favorite: 'yes' })).status, 400);
  assert.equal((await api('PATCH', '/api/photos/..%2Fevil.jpg/favorite', { favorite: true })).status, 400);
});

// --- GET /api/photos/archive ---

test('photos archive zips the whole vault; zipRead round-trips bytes', async () => {
  const res = await fetch(base + '/api/photos/archive');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/zip/);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="photos.zip"');
  const entries = zipRead(Buffer.from(await res.arrayBuffer()));
  const byPath = new Map(entries.map((e) => [e.path, e.data]));
  assert.deepEqual(
    [...byPath.keys()].sort(),
    [SEED_PHOTO_REL, photoAPath, photoBPath].sort()
  );
  assert.equal(byPath.get(SEED_PHOTO_REL).length, FAKE_JPEG.length);
  assert.deepEqual(byPath.get(photoAPath), PHOTO_A);
});

// --- legacy: /api/photos/upload + DELETE still work (shapes unchanged) ---

test('legacy: photos upload returns uploaded[] and DELETE removes one', async () => {
  const fd = new FormData();
  fd.append('photos', new Blob([PHOTO_C], { type: 'image/jpeg' }), 'c1.jpg');
  fd.append('photos', new Blob([PHOTO_C.subarray(4)], { type: 'image/jpeg' }), 'c2.jpg');
  const { status, json } = await api('POST', '/api/photos/upload', fd);
  assert.equal(status, 200);
  assert.equal(json.uploaded.length, 2);
  for (const item of json.uploaded) {
    assert.deepEqual(Object.keys(item), ['name', 'path', 'url', 'size', 'uploadedAt']);
  }

  const first = json.uploaded[0].path;
  const del = await api('DELETE', '/api/photos?path=' + encodeURIComponent(first));
  assert.equal(del.status, 200);
  assert.deepEqual(del.json, { deleted: true });
});
