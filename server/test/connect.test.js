// Tests for the v0.14 connect layer: client keys (server/lib/clientKeys.js +
// server/routes/clients.js), the MCP endpoint (server/routes/mcp.js +
// server/lib/mcpCore.js), the stdio proxy (scripts/mitti-mcp.mjs — spawned as
// a REAL subprocess speaking line-delimited JSON-RPC) and the backup exclusion
// for client-keys.json. Vault + data are redirected to a throwaway temp folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// --- redirect vault/data BEFORE importing anything from server/ ---
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mitticloud-connect-'));
process.env.MITTICLOUD_VAULT_DIR = path.join(TMP_ROOT, 'vault');
process.env.MITTICLOUD_DATA_DIR = path.join(TMP_ROOT, 'data');

const { app } = await import('../index.js');
const { createKey, verifyKey, listKeys, revokeKey } = await import('../lib/clientKeys.js');
const { runBackupNow } = await import('../lib/backup.js');

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

after(() => {
  server.close();
});

async function jfetch(pathname, opts = {}) {
  const res = await fetch(base + pathname, opts);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* empty body is fine */
  }
  return { status: res.status, body };
}

async function rpc(key, method, params, id = 1) {
  const res = await fetch(base + '/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// --- client keys ---

test('createKey returns the full key exactly once and a redacted record', () => {
  const { key, record } = createKey('unit client');
  assert.match(key, /^mitti_[A-Za-z0-9_-]{20,}$/);
  assert.equal(record.name, 'unit client');
  assert.ok(record.id);
  assert.equal(record.key, undefined);
  assert.equal(record.hash, undefined);
});

test('listKeys never leaks key material or hashes', () => {
  const all = listKeys();
  assert.ok(all.length >= 1);
  for (const k of all) {
    assert.equal(k.key, undefined);
    assert.equal(k.hash, undefined);
    assert.ok(k.name && k.createdAt);
  }
  const raw = fs.readFileSync(path.join(process.env.MITTICLOUD_DATA_DIR, 'client-keys.json'), 'utf8');
  assert.ok(raw.includes('"hash"'), 'hash is stored at rest');
  assert.ok(!JSON.stringify(listKeys()).includes('"hash"'), 'hash never listed');
});

test('verifyKey accepts the real key and bumps lastUsed; wrong key rejected', () => {
  const { key } = createKey('verify me');
  const rec = verifyKey(key);
  assert.ok(rec && rec.name === 'verify me');
  assert.ok(rec.lastUsed, 'lastUsed set on first use');
  assert.equal(verifyKey('mitti_totally-wrong'), null);
  assert.equal(verifyKey('garbage'), null);
});

test('revokeKey kills the key for good', () => {
  const { key, record } = createKey('shortlived');
  assert.ok(verifyKey(key));
  revokeKey(record.id);
  assert.equal(verifyKey(key), null);
  assert.throws(() => revokeKey(record.id), /No such key/);
});

// --- /mcp over HTTP ---

test('POST /mcp without a key is 401 with a human hint', async () => {
  const r = await rpc(null, 'initialize', {});
  assert.equal(r.status, 401);
  assert.match(r.body.error, /client key/i);
});

test('POST /mcp with a bogus key is 401', async () => {
  const r = await rpc('mitti_bogus', 'initialize', {});
  assert.equal(r.status, 401);
});

test('initialize handshakes with serverInfo and instructions', async () => {
  const { key } = createKey('handshake');
  const r = await rpc(key, 'initialize', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.result.protocolVersion, '2025-03-26');
  assert.equal(r.body.result.serverInfo.name, 'mitticloud');
  assert.ok(r.body.result.instructions.length > 10);
});

test('notifications/initialized gets 202 and no reply', async () => {
  const { key } = createKey('notify');
  const res = await fetch(base + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(res.status, 202);
});

test('tools/list exposes the 11 promised tools with schemas', async () => {
  const { key } = createKey('list tools');
  const r = await rpc(key, 'tools/list', {});
  const names = r.body.result.tools.map((t) => t.name);
  for (const n of [
    'server_status',
    'list_files',
    'read_file',
    'write_file',
    'list_photos',
    'list_sites',
    'list_apps',
    'start_app',
    'stop_app',
    'app_logs',
    'memory_context',
  ]) {
    assert.ok(names.includes(n), `missing tool: ${n}`);
  }
  for (const t of r.body.result.tools) {
    assert.ok(t.description && t.inputSchema, `${t.name} needs a description + schema`);
  }
});

test('tools/call server_status reports the version honestly', async () => {
  const { key } = createKey('status');
  const r = await rpc(key, 'tools/call', { name: 'server_status', arguments: {} });
  const text = r.body.result.content[0].text;
  assert.match(text, /MittiCloud v0\.14\.0/);
  assert.match(text, /free memory:/);
  assert.equal(r.body.result.isError, undefined);
});

test('write_file → read_file round-trip inside the vault', async () => {
  const { key } = createKey('roundtrip');
  const w = await rpc(key, 'tools/call', {
    name: 'write_file',
    arguments: { path: 'mcp-test/round.txt', content: 'hello from an AI app' },
  });
  assert.match(w.body.result.content[0].text, /Wrote mcp-test\/round\.txt/);
  const r = await rpc(key, 'tools/call', {
    name: 'read_file',
    arguments: { path: 'mcp-test/round.txt' },
  }, 2);
  assert.equal(r.body.result.content[0].text, 'hello from an AI app');
});

test('path traversal is refused, not followed', async () => {
  const { key } = createKey('traversal');
  const r = await rpc(key, 'tools/call', {
    name: 'read_file',
    arguments: { path: '../../data/client-keys.json' },
  });
  assert.equal(r.body.result.isError, true);
  assert.match(r.body.result.content[0].text, /Refused/);
});

test('oversized writes are refused at the cap', async () => {
  const { key } = createKey('bigwrite');
  const r = await rpc(key, 'tools/call', {
    name: 'write_file',
    arguments: { path: 'mcp-test/big.txt', content: 'x'.repeat(201 * 1024) },
  });
  assert.equal(r.body.result.isError, true);
  assert.match(r.body.result.content[0].text, /cap/);
});

test('unknown tool gets an honest protocol error; unknown app an honest tool error', async () => {
  const { key } = createKey('errors');
  const bad = await rpc(key, 'tools/call', { name: 'does_not_exist', arguments: {} });
  assert.equal(bad.body.error.code, -32602);
  const ghost = await rpc(key, 'tools/call', { name: 'app_logs', arguments: { name: 'ghost' } }, 2);
  assert.equal(ghost.body.result.isError, true);
  assert.match(ghost.body.result.content[0].text, /No such app/);
});

// --- the stdio proxy, as a real subprocess ---

function stdioExchange(key, lines) {
  // notifications get no reply — only count requests that carry an id
  const expected = lines.filter((l) => JSON.parse(l).id != null).length;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), 'scripts', 'mitti-mcp.mjs')], {
      env: { ...process.env, MITTI_URL: base, MITTI_KEY: key },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = [];
    child.stdout.on('data', (d) => {
      out.push(d);
      const got = out.join('').split('\n').filter(Boolean);
      if (got.length >= expected) {
        child.kill();
        resolve(got.map((l) => JSON.parse(l)));
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    for (const l of lines) child.stdin.write(l + '\n');
    child.stdin.end();
    setTimeout(() => {
      child.kill();
      reject(new Error('stdio proxy timed out'));
    }, 8000).unref();
  });
}

test('stdio proxy: initialize → write_file over the real subprocess', async () => {
  const { key } = createKey('stdio e2e');
  const replies = await stdioExchange(key, [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'write_file', arguments: { path: 'mcp-test/stdio.txt', content: 'via stdio' } },
    }),
  ]);
  assert.equal(replies[0].id, 1);
  assert.equal(replies[0].result.serverInfo.name, 'mitticloud');
  assert.equal(replies[1].id, 2);
  assert.match(replies[1].result.content[0].text, /Wrote mcp-test\/stdio\.txt/);
});

test('stdio proxy: without a key it refuses to start', async () => {
  const child = spawn(process.execPath, [path.join(process.cwd(), 'scripts', 'mitti-mcp.mjs')], {
    env: { ...process.env, MITTI_URL: base, MITTI_KEY: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const errText = await new Promise((resolve) => {
    let e = '';
    child.stderr.on('data', (d) => (e += d));
    child.on('exit', (code) => resolve({ code, e }));
  });
  assert.equal(errText.code, 1);
  assert.match(errText.e, /No MITTI_KEY/);
});

// --- backups never carry client keys ---

test('runBackupNow skips client-keys.json', () => {
  const folder = runBackupNow();
  assert.ok(fs.existsSync(path.join(folder, 'sites.json')) === fs.existsSync(path.join(process.env.MITTICLOUD_DATA_DIR, 'sites.json')));
  assert.equal(fs.existsSync(path.join(folder, 'client-keys.json')), false);
});
