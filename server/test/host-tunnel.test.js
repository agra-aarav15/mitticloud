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

// The 24/7 fix: cloudflared used to exit and stay dead until the user tapped
// again. Now an unexpected exit must bring the tunnel back by itself. The Node
// runtime run with a missing script is a perfect stand-in for a cloudflared that
// drops: it starts and exits non-zero at once.
async function postTunnel(route, body) {
  const res = await fetch(base + route, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('a tunnel that exits is restarted automatically, and stop cancels it', async () => {
  delete process.env.MITTICLOUD_NATIVE_DIR;
  const started = await postTunnel('/api/host/tunnel/quick', { bin: process.execPath });
  assert.equal(started.status, 200);

  let json = null;
  for (let i = 0; i < 40; i++) {
    json = (await getJson('/api/host/tunnel')).json;
    if (json.restarts >= 1 || json.restarting) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(json.restarts >= 1 || json.restarting, 'the watchdog queued a restart');
  assert.ok(
    json.log.some((l) => /dropped|bringing it back/i.test(l)),
    'the log says the tunnel dropped and was brought back'
  );

  await postTunnel('/api/host/tunnel/stop');
  const stopped = (await getJson('/api/host/tunnel')).json;
  assert.equal(Boolean(stopped.restarting), false, 'stopping cancels the pending restart');
});

test('a tunnel whose binary cannot start is marked failed and not retried', async () => {
  const { status } = await postTunnel('/api/host/tunnel/quick', { bin: 'definitely-not-a-real-binary-xyz' });
  assert.equal(status, 200);
  await new Promise((r) => setTimeout(r, 400));
  const json = (await getJson('/api/host/tunnel')).json;
  assert.ok(json.failed, 'a missing binary is reported as failed');
  assert.equal(json.restarts || 0, 0, 'a spawn failure is never retried in a loop');
  await postTunnel('/api/host/tunnel/stop');
});