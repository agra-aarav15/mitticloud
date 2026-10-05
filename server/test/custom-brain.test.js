// Black-box test for the Custom (OpenAI-compatible) brain: a REAL local mock
// of /chat/completions, a session created with a custom endpoint + model, and
// one full message round trip through the real app. Proves the URL, the
// Bearer key, the model name and the reply all actually flow.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// --- redirect vault/data BEFORE importing anything from server/ ---
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mitticloud-custombrain-'));
process.env.MITTICLOUD_VAULT_DIR = path.join(TMP_ROOT, 'vault');
process.env.MITTICLOUD_DATA_DIR = path.join(TMP_ROOT, 'data');

const { app } = await import('../index.js');

// --- the OpenAI-compatible mock ---

const seen = { path: null, auth: null, model: null, lastUser: null };

const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    seen.path = req.url;
    seen.auth = req.headers.authorization || null;
    try {
      const body = JSON.parse(raw);
      seen.model = body.model || null;
      const users = (body.messages || []).filter((m) => m.role === 'user');
      seen.lastUser = users.length ? users[users.length - 1].content : null;
    } catch {
      /* malformed body — seen.* stays */
    }
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'MOCK REPLY: custom brain works' } }],
      })
    );
  });
});

let server;
let base;
let mockUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  mockUrl = `http://127.0.0.1:${mock.address().port}/v1`;
});

after(() => new Promise((resolve) => server.close(resolve)));
after(() => new Promise((resolve) => mock.close(resolve)));
after(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));

async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('a custom OpenAI-compatible brain round-trips URL, key, model and reply', async () => {
  // save the key the way the dashboard does
  const saved = await api('PUT', '/api/agent/keys', { providerId: 'custom', key: 'sk-test-123' });
  assert.equal(saved.status, 200);

  const created = await api('POST', '/api/agent/sessions', {
    providerId: 'custom',
    endpoint: mockUrl,
    model: 'mock-mini',
    workspace: '.',
  });
  assert.equal(created.status, 200);
  const s = created.json;
  assert.equal(s.endpoint, mockUrl, 'session keeps the custom URL');
  assert.equal(s.model, 'mock-mini');

  const sent = await api('POST', `/api/agent/sessions/${s.id}/messages`, {
    text: 'hello custom brain',
  });
  assert.equal(sent.status, 200);

  // give the background turn a moment to hit the mock
  for (let i = 0; i < 40 && !seen.model; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(seen.path, '/v1/chat/completions', 'request hits <endpoint>/chat/completions');
  assert.equal(seen.auth, 'Bearer sk-test-123', 'the saved key rides as Bearer');
  assert.equal(seen.model, 'mock-mini', 'the session model is sent');
  assert.ok(
    String(seen.lastUser).includes('hello custom brain'),
    'the user text reaches the model'
  );

  // the reply lands in the session
  const view = await api('GET', `/api/agent/sessions/${s.id}`);
  const texts = (view.json.messages || []).map((m) => m.text || '').join('\n');
  assert.match(texts, /MOCK REPLY: custom brain works/);
});

test('a session stays editable: PATCH swaps endpoint and model', async () => {
  const created = await api('POST', '/api/agent/sessions', {
    providerId: 'custom',
    endpoint: mockUrl,
    model: 'mock-mini',
    workspace: '.',
  });
  const s = created.json;
  const patched = await api('PATCH', `/api/agent/sessions/${s.id}`, {
    endpoint: mockUrl.replace('/v1', '/v2'),
    model: 'mock-large',
    title: 'My custom brain',
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.endpoint, mockUrl.replace('/v1', '/v2'));
  assert.equal(patched.json.model, 'mock-large');
  assert.equal(patched.json.title, 'My custom brain');

  // a running session refuses edits instead of corrupting the turn
  const fakeRunning = await api('POST', '/api/agent/sessions', {
    providerId: 'custom',
    endpoint: mockUrl,
    model: 'm',
    workspace: '.',
  });
  const id = fakeRunning.json.id;
  // flip running directly on disk to simulate an in-flight turn
  const { DATA_DIR } = await import('../lib/paths.js');
  const file = path.join(DATA_DIR, 'agent-sessions', id + '.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.running = true;
  fs.writeFileSync(file, JSON.stringify(raw));
  const refused = await api('PATCH', `/api/agent/sessions/${id}`, { model: 'x' });
  assert.equal(refused.status, 409, 'running sessions are not edited mid-turn');
});
