// Tests for the Cloudflare Pages publish engine:
//  - blake3.js against OFFICIAL test vectors (BLAKE3-team/BLAKE3, hash mode),
//    including inputs long enough to cross many chunks + tree merges
//  - the wrangler asset-hash formula (blake3(base64(content)+extension))
//  - accounts list, the full deploy call sequence (fake fetch, real order),
//    file collection and content types
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { blake3hex, pagesAssetHash } = await import('../lib/blake3.js');
const { accountsList, deploySite, collectFiles, contentTypeFor, loadToken } = await import(
  '../lib/cfpages.js'
);

// --- blake3: official vectors (input = repeating 0..250) ---

function vectorInput(len) {
  const b = Buffer.alloc(len);
  for (let i = 0; i < len; i++) b[i] = i % 251;
  return b;
}

const OFFICIAL = [
  [0, 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'],
  [1, '2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213'],
  [63, 'e9bc37a594daad83be9470df7f7b3798297c3d834ce80ba85d6e207627b7db7b'],
  [64, '4eed7141ea4a5cd4b788606bd23f46e212af9cacebacdc7d1f4c6dc7f2511b98'],
  [1024, '42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7'],
  [2048, 'e776b6028c7cd22a4d0ba182a8bf62205d2ef576467e838ed6f2529b85fba24a'],
  [102400, 'bc3e3d41a1146b069abffad3c0d44860cf664390afce4d9661f7902e7943e085'],
];

test('blake3 matches the official test vectors (0..102400 bytes, many chunks)', () => {
  for (const [len, want] of OFFICIAL) {
    assert.equal(blake3hex(vectorInput(len)), want, `official vector len ${len}`);
  }
});

test('pagesAssetHash is blake3(base64(content)+extension), hex cut to 32', () => {
  // independent re-derivation of the wrangler formula from the verified core
  const content = Buffer.from('<html>hi</html>');
  const expected = blake3hex(Buffer.from(content.toString('base64') + 'html', 'utf8')).slice(0, 32);
  assert.equal(pagesAssetHash(content, 'index.html'), expected);
  assert.equal(pagesAssetHash(content, 'index.html').length, 32);
  // no extension -> empty suffix
  const noExt = blake3hex(Buffer.from(content.toString('base64') + '', 'utf8')).slice(0, 32);
  assert.equal(pagesAssetHash(content, 'justfile'), noExt);
});

// --- accounts ---

test('accountsList parses the account array from a fake Cloudflare', async () => {
  const fake = async (url, opts) => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      result: [{ id: 'abc123def456', name: "Aarav's account" }],
    }),
  });
  const out = await accountsList(fake, 'tok');
  assert.deepEqual(out, [{ id: 'abc123def456', name: "Aarav's account" }]);
});

test('accountsList surfaces the Cloudflare error code and message', async () => {
  const fake = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: false,
      errors: [{ code: 9109, message: 'Invalid API Token' }],
    }),
  });
  await assert.rejects(accountsList(fake, 'bad'), /9109.*Invalid API Token/);
});

// --- deploy sequence ---

function fakeCloudflare(log) {
  return async (url, opts = {}) => {
    log.push({ url: String(url).replace(/^https:\/\/api\.cloudflare\.com\/client\/v4/, ''), method: opts.method || 'GET' });
    if (url.endsWith('/pages/projects/mitticloud-demo')) {
      return { ok: true, status: 200, json: async () => ({ success: true, result: { name: 'mitticloud-demo' } }) };
    }
    if (url.endsWith('/upload-token')) {
      return { ok: true, status: 200, json: async () => ({ success: true, result: { jwt: 'asset-jwt' } }) };
    }
    if (url.endsWith('/pages/assets/check-missing')) {
      const body = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ success: true, result: body.hashes.slice(0, 1) }) };
    }
    if (url.endsWith('/pages/assets/upload')) {
      const files = JSON.parse(opts.body);
      assert.equal(files[0].base64, true);
      assert.ok(files[0].metadata.contentType.length > 0);
      assert.equal(opts.headers.authorization, 'Bearer asset-jwt', 'asset calls use the upload JWT');
      return { ok: true, status: 200, json: async () => ({ success: true, result: files.map((f) => f.key) }) };
    }
    if (url.endsWith('/pages/assets/upsert-hashes')) {
      return { ok: true, status: 200, json: async () => ({ success: true, result: null }) };
    }
    if (url.endsWith('/deployments')) {
      const form = opts.body;
      assert.ok(form instanceof FormData, 'deployment posts multipart');
      const manifest = JSON.parse(form.get('manifest'));
      assert.ok(manifest['/index.html'], 'manifest maps /index.html');
      assert.ok(manifest['/css/style.css'], 'manifest maps nested paths');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: { id: 'dep1', url: 'https://abc123.mitticloud-demo.pages.dev' },
        }),
      };
    }
    throw new Error('unexpected fetch: ' + url);
  };
}

test('deploySite follows the full wrangler order and returns live URLs', async () => {
  const log = [];
  const fetchImpl = fakeCloudflare(log);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfpages-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>demo</h1>');
  fs.mkdirSync(path.join(dir, 'css'));
  fs.writeFileSync(path.join(dir, 'css', 'style.css'), 'body{}');
  const files = collectFiles(dir);

  const out = await deploySite(fetchImpl, 'tok', 'acc123', 'mitticloud-demo', files);
  const u = log.map((l) => l.url);
  assert.deepEqual(u, [
    '/accounts/acc123/pages/projects/mitticloud-demo',
    '/accounts/acc123/pages/projects/mitticloud-demo/upload-token',
    '/accounts/acc123/pages/assets/check-missing',
    '/accounts/acc123/pages/assets/upload',
    '/accounts/acc123/pages/assets/upsert-hashes',
    '/accounts/acc123/pages/projects/mitticloud-demo/deployments',
  ]);
  assert.equal(out.url, 'https://mitticloud-demo.pages.dev');
  assert.equal(out.files, 2);
  assert.equal(out.uploaded, 1, 'only the missing hash was re-uploaded');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deploySite creates the project when Cloudflare says 8000007 (not found)', async () => {
  const log = [];
  let seenCreate = false;
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).endsWith('/pages/projects/mitticloud-fresh')) {
      if ((opts.method || 'GET') === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: false, errors: [{ code: 8000007, message: 'Project not found' }] }),
        };
      }
      seenCreate = true;
      return { ok: true, status: 200, json: async () => ({ success: true, result: { name: 'mitticloud-fresh' } }) };
    }
    if (String(url).endsWith('/pages/projects') && (opts.method || 'GET') === 'POST') {
      seenCreate = true;
      return { ok: true, status: 200, json: async () => ({ success: true, result: { name: 'mitticloud-fresh' } }) };
    }
    return fakeCloudflare(log)(url, opts);
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfpages-'));
  fs.writeFileSync(path.join(dir, 'index.html'), 'x');
  fs.mkdirSync(path.join(dir, 'css'));
  fs.writeFileSync(path.join(dir, 'css', 'style.css'), 'body{}');
  const out = await deploySite(fetchImpl, 'tok', 'acc123', 'mitticloud-fresh', collectFiles(dir));
  assert.equal(seenCreate, true);
  assert.equal(out.project, 'mitticloud-fresh');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- helpers ---

test('collectFiles walks nested folders with posix rel paths, sorted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfcollect-'));
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'c.txt'), 'c');
  const rels = collectFiles(dir).map((f) => f.rel);
  assert.deepEqual(rels, ['a.txt', 'b.txt', 'sub/c.txt']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('contentTypeFor maps the web set and falls back to octet-stream', () => {
  assert.equal(contentTypeFor('index.html'), 'text/html');
  assert.equal(contentTypeFor('app.js'), 'text/javascript');
  assert.equal(contentTypeFor('photo.JPG'), 'image/jpeg');
  assert.equal(contentTypeFor('data.weird'), 'application/octet-stream');
  assert.equal(contentTypeFor('noext'), 'application/octet-stream');
});
