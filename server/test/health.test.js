// Black-box tests for deep health (GET /api/health?deep=1), the security
// flag on GET /api/status and the settings backup (POST /api/backup/run),
// wired through the REAL app exported by server/index.js. Vault + data are
// redirected to a throwaway temp folder; the corrupted-json case uses its own
// throwaway file and cleans up after itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- redirect vault/data BEFORE importing anything from server/ ---
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mitticloud-health-'));
process.env.MITTICLOUD_VAULT_DIR = path.join(TMP_ROOT, 'vault');
process.env.MITTICLOUD_DATA_DIR = path.join(TMP_ROOT, 'data');

const { DATA_DIR } = await import('../lib/paths.js');
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
  return { status: res.status, json: await res.json().catch(() => null) };
}

// --- /api/health shallow vs deep ---

test('shallow /api/health keeps its shape (ok + uptimeSec only)', async () => {
  const { status, json } = await api('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.ok(Number.isInteger(json.uptimeSec));
  assert.equal(json.checks, undefined, 'no deep keys without ?deep=1');
  assert.equal(json.mem, undefined);
});

test('?deep=1 adds mem, vaultWritable, dataOk and a checks array', async () => {
  const { status, json } = await api('GET', '/api/health?deep=1');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.ok(Number.isInteger(json.uptimeSec));
  assert.ok(Number.isInteger(json.mem.freeMB) && json.mem.freeMB > 0);
  assert.ok(Number.isInteger(json.mem.totalMB) && json.mem.totalMB >= json.mem.freeMB);
  assert.equal(json.vaultWritable, true);
  assert.equal(json.dataOk, true);
  assert.deepEqual(json.checks, [
    { name: 'vault-writable', ok: true },
    { name: 'data-json', ok: true },
  ]);
});

test('a corrupt data/*.json flips dataOk false and ok false (then is restored)', async () => {
  const broken = path.join(DATA_DIR, 'zz-selfcheck-corrupt.json');
  fs.writeFileSync(broken, '{ this is not json');
  try {
    const { json } = await api('GET', '/api/health?deep=1');
    assert.equal(json.ok, false);
    assert.equal(json.dataOk, false);
    assert.equal(json.vaultWritable, true);
    assert.deepEqual(json.checks.find((c) => c.name === 'data-json'), {
      name: 'data-json',
      ok: false,
    });
  } finally {
    fs.unlinkSync(broken);
  }
  const healed = (await api('GET', '/api/health?deep=1')).json;
  assert.equal(healed.ok, true);
  assert.equal(healed.dataOk, true);
});

// --- /api/status carries the lock state ---

test('GET /api/status includes security.locked (false while unlocked)', async () => {
  const { status, json } = await api('GET', '/api/status');
  assert.equal(status, 200);
  assert.deepEqual(json.security, { locked: false });
});

// --- settings backup ---

test('POST /api/backup/run snapshots data/*.json into data/backups/<date>/', async () => {
  fs.writeFileSync(path.join(DATA_DIR, 'state.json'), '{"seeded":true}\n');
  const { status, json } = await api('POST', '/api/backup/run');
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, folder: json.folder });
  assert.match(path.basename(json.folder), /^\d{4}-\d{2}-\d{2}$/);
  const copied = JSON.parse(fs.readFileSync(path.join(json.folder, 'state.json'), 'utf8'));
  assert.equal(copied.seeded, true);
});

test('backups keep only the 7 most recent date folders', async () => {
  const backups = path.join(DATA_DIR, 'backups');
  // seed 8 fake older folders (today's real one makes 9 -> prune keeps 7)
  for (let d = 1; d <= 8; d++) {
    const name = `2026-01-0${d}`;
    fs.mkdirSync(path.join(backups, name), { recursive: true });
  }
  const { status } = await api('POST', '/api/backup/run');
  assert.equal(status, 200);
  const left = fs
    .readdirSync(backups, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort();
  assert.equal(left.length, 7);
  assert.equal(left[0], '2026-01-03', 'oldest folders deleted first');
  assert.ok(left.includes(new Date().toISOString().slice(0, 10)), "today's folder survives");
});
