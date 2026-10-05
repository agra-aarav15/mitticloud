// Black-box tests for the automation honesty rules: a battery-deferred run
// answers 202 + deferred (never a fake ok:true), and a deferral does NOT
// advance the schedule anchor (a weekly task left due retries every tick,
// not next week).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mitticloud-tasksgate-'));
process.env.MITTICLOUD_VAULT_DIR = path.join(TMP_ROOT, 'vault');
process.env.MITTICLOUD_DATA_DIR = path.join(TMP_ROOT, 'data');

const { DATA_DIR } = await import('../lib/paths.js');
const { app } = await import('../index.js');

const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

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
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const readTasks = () => JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));

test('a battery-deferred webhook answers 202/deferred and keeps the schedule anchor', async () => {
  const created = await api('POST', '/api/tasks', {
    name: 'weekly job',
    kind: 'js',
    code: 'log("ran for real")',
    everyMinutes: 10080,
  });
  assert.ok(created.status === 200 || created.status === 201, 'task created');
  const id = created.json.task.id;

  // pretend the last real run happened a week ago — the task is due now
  const tasks = readTasks();
  const t = tasks.find((x) => x.id === id);
  const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  t.lastRunAttemptAt = weekAgo;
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));

  // phone on battery: the run must defer
  process.env.MITTI_FAKE_BATTERY = JSON.stringify({ level: 18, charging: false, mocked: false });
  try {
    const list = await api('GET', '/api/tasks');
    const webhookId = list.json.tasks.find((x) => x.id === id).webhookId;
    assert.ok(webhookId, 'the task has its webhook id');

    const hook = await api('POST', `/hook/${webhookId}`);
    assert.equal(hook.status, 202, 'deferred is 202, not a fake 200');
    assert.equal(hook.json.ok, false);
    assert.equal(hook.json.deferred, true);

    const after = readTasks().find((x) => x.id === id);
    assert.equal(after.lastRunAttemptAt, weekAgo, 'deferral does NOT advance the anchor — retries next tick');
    assert.ok(after.lastDeferredAt, 'the deferral itself is recorded');
    assert.equal(after.lastRunAt, null, 'nothing ran, nothing claims it did');
  } finally {
    delete process.env.MITTI_FAKE_BATTERY;
  }
});

test('with the battery gate cleared the same webhook runs for real', async () => {
  const created = await api('POST', '/api/tasks', {
    name: 'instant job',
    kind: 'js',
    code: 'console.log("hello from the run")',
    everyMinutes: 1440,
  });
  const id = created.json.task.id;
  const list = await api('GET', '/api/tasks');
  const webhookId = list.json.tasks.find((x) => x.id === id).webhookId;
  const hook = await api('POST', `/hook/${webhookId}`);
  assert.equal(hook.status, 200);
  assert.equal(hook.json.ok, true);
  assert.equal(hook.json.status, 'ok');
  const after = readTasks().find((x) => x.id === id);
  assert.ok(after.lastRunAttemptAt, 'a real run stamps the anchor');
});
