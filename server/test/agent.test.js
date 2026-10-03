// Black-box + unit tests for the Agent Server: sessions CRUD, the battery
// gate, provider-key privacy, the tool jail (nothing escapes the workspace),
// real tool actions, and the boot sweep that marks restarted turns over.
// The brain is faked for loop tests (no network); route tests run WITHOUT
// keys so every turn ends in an honest "no API key" error — never a fetch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- redirect vault/data BEFORE importing anything from server/ ---
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mitticloud-agent-'));
process.env.MITTICLOUD_VAULT_DIR = path.join(TMP_ROOT, 'vault');
process.env.MITTICLOUD_DATA_DIR = path.join(TMP_ROOT, 'data');

const { app } = await import('../index.js');
const { VAULT_DIR } = await import('../lib/paths.js');
const { runTurn, runTool } = await import('../lib/agentLoop.js');
const { saveSession, loadSession, bootSweep, setKey, getKey } = await import(
  '../lib/agentStore.js'
);

let server;
let base;

before(async () => {
  fs.mkdirSync(path.join(VAULT_DIR, 'files'), { recursive: true });
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

async function waitIdle(id, tries = 100) {
  for (let i = 0; i < tries; i++) {
    const { json } = await api('GET', `/api/agent/sessions/${id}`);
    if (json && json.running === false) return json;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('session never went idle');
}

// --- providers + keys: values never leak ---

test('providers list carries free-tier notes + hasKey, never a key value', async () => {
  setKey('gemini', 'secret-value-123');
  const { status, json } = await api('GET', '/api/agent/providers');
  assert.equal(status, 200);
  const gemini = json.providers.find((p) => p.id === 'gemini');
  assert.equal(gemini.hasKey, true);
  assert.ok(gemini.freeNote.length > 10);
  assert.equal(JSON.stringify(json).includes('secret-value-123'), false);
  setKey('gemini', null);
  assert.equal(getKey('gemini'), null);
});

test('PUT /api/agent/keys accepts and clears a key without echoing it', async () => {
  const put = await api('PUT', '/api/agent/keys', { providerId: 'groq', key: 'gsk_test' });
  assert.equal(put.json.ok, true);
  assert.equal(put.json.hasKey, true);
  const clear = await api('PUT', '/api/agent/keys', { providerId: 'groq', key: '' });
  assert.equal(clear.json.hasKey, false);
  const bad = await api('PUT', '/api/agent/keys', { providerId: 'nope', key: 'x' });
  assert.equal(bad.status, 400);
});

// --- sessions CRUD ---

test('session lifecycle: create -> list -> 404 after delete', async () => {
  const created = await api('POST', '/api/agent/sessions', { providerId: 'gemini' });
  assert.equal(created.status, 200);
  assert.equal(created.json.workspace, '.');
  assert.ok(created.json.workspaceAbs.startsWith(path.resolve(VAULT_DIR)));
  assert.equal(created.json.running, false);

  const list = await api('GET', '/api/agent/sessions');
  assert.ok(list.json.sessions.some((s) => s.id === created.json.id));

  const del = await api('DELETE', `/api/agent/sessions/${created.json.id}`);
  assert.equal(del.json.ok, true);
  const gone = await api('GET', `/api/agent/sessions/${created.json.id}`);
  assert.equal(gone.status, 404);
});

test('message validation: empty text 400, oversized 400, unknown session 404', async () => {
  const empty = await api('POST', '/api/agent/sessions/whatever00/messages', { text: '' });
  assert.equal(empty.status, 404, 'unknown session reported before validation');

  const created = await api('POST', '/api/agent/sessions', { providerId: 'gemini' });
  const id = created.json.id;
  const noText = await api('POST', `/api/agent/sessions/${id}/messages`, { text: '   ' });
  assert.equal(noText.status, 400);
  const big = await api('POST', `/api/agent/sessions/${id}/messages`, {
    text: 'x'.repeat(8001),
  });
  assert.equal(big.status, 400);
  await api('DELETE', `/api/agent/sessions/${id}`);
});

test('battery gate: low + unplugged asks first, force runs anyway', async () => {
  process.env.MITTI_FAKE_BATTERY = JSON.stringify({ level: 22, charging: false, mocked: false });
  try {
    const created = await api('POST', '/api/agent/sessions', { providerId: 'gemini' });
    const id = created.json.id;

    const gated = await api('POST', `/api/agent/sessions/${id}/messages`, {
      text: 'organize my files',
    });
    assert.equal(gated.json.batteryMode, true);
    assert.equal(gated.json.level, 22);
    assert.match(gated.json.message, /Run anyway/);
    const afterGate = await api('GET', `/api/agent/sessions/${id}`);
    assert.equal(afterGate.json.messages.length, 0, 'gated message is not stored');

    const forced = await api('POST', `/api/agent/sessions/${id}/messages`, {
      text: 'organize my files',
      force: true,
    });
    assert.equal(forced.json.started, true);
    const idle = await waitIdle(id);
    assert.ok(idle.messages.length >= 2);
    const last = idle.messages[idle.messages.length - 1];
    assert.match(last.text, /No API key saved for Gemini/);
    await api('DELETE', `/api/agent/sessions/${id}`);
  } finally {
    delete process.env.MITTI_FAKE_BATTERY;
  }
});

test('custom provider without an endpoint ends in an honest brain error', async () => {
  const created = await api('POST', '/api/agent/sessions', { providerId: 'custom' });
  const id = created.json.id;
  const started = await api('POST', `/api/agent/sessions/${id}/messages`, { text: 'hi' });
  assert.equal(started.json.started, true);
  const idle = await waitIdle(id);
  assert.match(idle.messages[idle.messages.length - 1].text, /No endpoint set/);
  await api('DELETE', `/api/agent/sessions/${id}`);
});

// --- tools: the jail holds, the real actions work ---

test('path jail: list/read refuse to escape the workspace', async () => {
  const up = await runTool('list_files', { path: '../../' }, VAULT_DIR);
  assert.equal(up.ok, false);
  assert.match(up.output, /escapes the vault root|Invalid path|Tool error/);
  const abs = await runTool('read_file', { path: 'C:\\Windows\\win.ini' }, VAULT_DIR);
  assert.equal(abs.ok, false);
});

test('real tools: write_file -> read_file -> run_command round-trip', async () => {
  const wrote = await runTool(
    'write_file',
    { path: 'agent-test/note.txt', content: 'mitti round trip' },
    VAULT_DIR
  );
  assert.equal(wrote.ok, true);
  const read = await runTool('read_file', { path: 'agent-test/note.txt' }, VAULT_DIR);
  assert.equal(read.ok, true);
  assert.equal(read.output, 'mitti round trip');
  const cmd = await runTool('run_command', { command: 'echo mitti-cmd-ok' }, VAULT_DIR);
  assert.equal(cmd.ok, true);
  assert.match(cmd.output, /mitti-cmd-ok/);
  const unknown = await runTool('rm_rf_everything', {}, VAULT_DIR);
  assert.equal(unknown.ok, false);
  assert.match(unknown.output, /Unknown tool/);
});

// --- the loop with a scripted brain ---

test('runTurn: brain tool call is executed and the jail error comes back', async () => {
  const session = {
    id: 'loop0001',
    title: 'loop test',
    providerId: 'gemini',
    workspace: '.',
    workspaceAbs: VAULT_DIR,
    messages: [{ role: 'user', text: 'list the parent folder', ts: new Date().toISOString() }],
  };
  const scripted = [
    { text: '', calls: [{ name: 'list_files', args: { path: '../../etc' } }] },
    { text: 'I could not: the path escapes the workspace.', calls: [] },
  ];
  let i = 0;
  await runTurn(session, () => {}, {
    callBrainImpl: async () => scripted[i++],
    systemText: 'test',
  });
  const roles = session.messages.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'tool', 'assistant']);
  assert.match(session.messages[2].text, /Tool error|escapes/i);
  assert.match(session.messages[3].text, /could not/);
});

test('runTurn: a plain text answer ends the turn after one brain call', async () => {
  const session = {
    id: 'loop0002',
    title: 'plain test',
    providerId: 'gemini',
    workspace: '.',
    workspaceAbs: VAULT_DIR,
    messages: [{ role: 'user', text: 'say hi', ts: new Date().toISOString() }],
  };
  let calls = 0;
  await runTurn(session, () => {}, {
    callBrainImpl: async () => {
      calls++;
      return { text: 'Hi! What should I organize first?', calls: [] };
    },
    systemText: 'test',
  });
  assert.equal(calls, 1);
  assert.equal(session.messages.length, 2);
  assert.equal(session.messages[1].text, 'Hi! What should I organize first?');
});

// --- restart sweep ---

test('bootSweep marks a session stuck in running:false with an honest note', async () => {
  const s = {
    id: '5eed0001',
    title: 'sweep test',
    providerId: 'gemini',
    workspace: '.',
    workspaceAbs: VAULT_DIR,
    running: true,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
  };
  saveSession(s);
  assert.equal(loadSession('5eed0001').running, true);
  const fixed = bootSweep();
  assert.ok(fixed >= 1);
  const after = loadSession('5eed0001');
  assert.equal(after.running, false);
  assert.match(after.error, /restarted while the agent was working/);
});
