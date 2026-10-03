// Black-box tests for the optional lock token (server/lib/auth.js +
// server/routes/lock.js) wired through the REAL app exported by
// server/index.js. The vault + data dirs are redirected to a throwaway temp
// folder via MITTICLOUD_VAULT_DIR / MITTICLOUD_DATA_DIR (see paths.js), so the
// real vault, settings.json and site registry are never touched. Tests run
// sequentially and build on each other's lock state.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- redirect vault/data BEFORE importing anything from server/ ---
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mitticloud-lock-'));
process.env.MITTICLOUD_VAULT_DIR = path.join(TMP_ROOT, 'vault');
process.env.MITTICLOUD_DATA_DIR = path.join(TMP_ROOT, 'data');

const { DATA_DIR } = await import('../lib/paths.js');
const { app } = await import('../index.js');

// --- tiny server + fetch helper ---

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

async function api(method, url, body, headers) {
  const opts = { method, headers: { ...(headers || {}) } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base + url, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// --- unlocked: writes pass, then the lock is set ---

test('unlocked: POST /api/sites creates a site with no token', async () => {
  const { status, json } = await api('POST', '/api/sites', { name: 'lockcheck' });
  assert.equal(status, 201);
  assert.equal(json.site.name, 'lockcheck');
});

test('PUT /api/lock sets the token (settings source, never echoed)', async () => {
  const { status, json } = await api('PUT', '/api/lock', { token: 'secret-one' });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.locked, true);
  assert.equal(json.source, 'settings');
  assert.ok(!JSON.stringify(json).includes('secret-one'), 'token must never be returned');
});

test('GET /api/lock-status reports locked + source without the token', async () => {
  const { status, json } = await api('GET', '/api/lock-status');
  assert.equal(status, 200);
  assert.deepEqual(json, { locked: true, source: 'settings' });
});

test('locked: write without a token is 401 (message, no token leak)', async () => {
  const { status, json } = await api('POST', '/api/sites', { name: 'second' });
  assert.equal(status, 401);
  assert.match(json.error, /Locked/);
  assert.ok(!JSON.stringify(json).includes('secret-one'), 'token must never be returned');
});

test('locked: write with a wrong token is 401', async () => {
  const { status } = await api(
    'POST',
    '/api/sites',
    { name: 'second' },
    { 'x-mitti-token': 'wrong-guess' }
  );
  assert.equal(status, 401);
});

test('locked: write with the right header passes', async () => {
  const { status } = await api(
    'POST',
    '/api/sites',
    { name: 'second' },
    { 'x-mitti-token': 'secret-one' }
  );
  assert.equal(status, 201);
});

test('locked: write with ?token= passes too', async () => {
  const { status } = await api('POST', '/api/sites?token=secret-one', { name: 'third' });
  assert.equal(status, 201);
});

test('GET /api/health stays open while locked', async () => {
  const { status, json } = await api('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
});

// --- changing the lock ---

test('PUT /api/lock with a wrong current token is 401', async () => {
  const { status } = await api(
    'PUT',
    '/api/lock',
    { token: 'secret-two' },
    { 'x-mitti-token': 'wrong-guess' }
  );
  assert.equal(status, 401);
  const still = (await api('GET', '/api/lock-status')).json;
  assert.equal(still.locked, true, 'lock unchanged after a rejected change');
});

test('PUT /api/lock with the current token rotates it', async () => {
  const { status, json } = await api(
    'PUT',
    '/api/lock',
    { token: 'secret-two' },
    { 'x-mitti-token': 'secret-one' }
  );
  assert.equal(status, 200);
  assert.equal(json.locked, true);
  // old token no longer works, new one does
  const old = await api('POST', '/api/sites', { name: 'fourth' }, { 'x-mitti-token': 'secret-one' });
  assert.equal(old.status, 401);
  const fresh = await api(
    'POST',
    '/api/sites',
    { name: 'fourth' },
    { 'x-mitti-token': 'secret-two' }
  );
  assert.equal(fresh.status, 201);
});

test('env MITTI_TOKEN wins over settings while set', async () => {
  process.env.MITTI_TOKEN = 'env-secret';
  try {
    const st = (await api('GET', '/api/lock-status')).json;
    assert.deepEqual(st, { locked: true, source: 'env' });
    // the settings token is no longer accepted...
    const old = await api(
      'POST',
      '/api/sites',
      { name: 'envsite' },
      { 'x-mitti-token': 'secret-two' }
    );
    assert.equal(old.status, 401);
    // ...but the env token is
    const fresh = await api(
      'POST',
      '/api/sites',
      { name: 'envsite' },
      { 'x-mitti-token': 'env-secret' }
    );
    assert.equal(fresh.status, 201);
  } finally {
    delete process.env.MITTI_TOKEN;
  }
});

test('PUT /api/lock {token: ""} disables the lock (needs current token)', async () => {
  const { status, json } = await api(
    'PUT',
    '/api/lock',
    { token: '' },
    { 'x-mitti-token': 'secret-two' }
  );
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, locked: false, source: null });
  const st = (await api('GET', '/api/lock-status')).json;
  assert.deepEqual(st, { locked: false, source: null });
  // unlocked again: plain writes pass
  const { status: s2 } = await api('POST', '/api/sites', { name: 'fifth' });
  assert.equal(s2, 201);
});

test('PUT /api/lock without a token field is a 400', async () => {
  const { status } = await api('PUT', '/api/lock', {});
  assert.equal(status, 400);
  const { status: s2 } = await api('PUT', '/api/lock', { token: 42 });
  assert.equal(s2, 400);
});

test('the token lives in data/settings.json (managed via the API)', async () => {
  // disabled by the last mutation above
  const settings = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'));
  assert.equal(settings.lockToken, '');
  // and setting again persists it
  await api('PUT', '/api/lock', { token: 'on-disk-secret' });
  const after = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'));
  assert.equal(after.lockToken, 'on-disk-secret');
  assert.equal((await api('GET', '/api/lock-status')).json.locked, true);
  // leave the cloud unlocked for any other eyes on this data dir
  await api('PUT', '/api/lock', { token: '' }, { 'x-mitti-token': 'on-disk-secret' });
});
