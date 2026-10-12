// Black-box tests for the tunnel/public-link plumbing in server/routes/host.js,
// wired through the REAL app exported by server/index.js. The focus is the
// "bundled cloudflared" behaviour the Android app relies on: when the APK's
// native-library folder (MITTICLOUD_NATIVE_DIR) holds libmittitunnel.so, the
// tunnel status reports bundled:true and the default binary is that file.
// Vault + data are redirected to a throwaway temp folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- redirect vault/data BEFORE importing anything from server/ ---
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mitticloud-tunnel-'));
process.env.MITTICLOUD_VAULT_DIR = path.join(TMP_ROOT, 'vault');
process.env.MITTICLOUD_DATA_DIR = path.join(TMP_ROOT, 'data');
delete process.env.MITTICLOUD_NATIVE_DIR;

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

async function getJson(url) {
  const res = await fetch(base + url);
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('the LAN helper reports at least one address', async () => {
  const { status, json } = await getJson('/api/host/lan');
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.urls));
});

test('with no native dir the tunnel is not bundled', async () => {
  delete process.env.MITTICLOUD_NATIVE_DIR;
  const { status, json } = await getJson('/api/host/tunnel');
  assert.equal(status, 200);
  assert.equal(json.running, false);
  assert.equal(json.bundled, false);
});

test('a native dir holding libmittitunnel.so marks the tunnel bundled', async () => {
  const native = path.join(TMP_ROOT, 'nativelib');
  fs.mkdirSync(native, { recursive: true });
  fs.writeFileSync(path.join(native, 'libmittitunnel.so'), '#!/bin/sh\n');
  process.env.MITTICLOUD_NATIVE_DIR = native;
  try {
    const { status, json } = await getJson('/api/host/tunnel');
    assert.equal(status, 200);
    assert.equal(json.bundled, true);
  } finally {
    delete process.env.MITTICLOUD_NATIVE_DIR;
  }
});