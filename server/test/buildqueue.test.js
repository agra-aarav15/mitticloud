// Unit tests for the v0.15 project classifier and the one-at-a-time build queue
// (server/lib/buildqueue.js), plus the static fallback server it hands a built
// folder to (server/lib/staticServe.js). No network: every fixture is local.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { classifyProject, createQueue, KIND_APP, KIND_WEBSITE } = await import(
  '../lib/buildqueue.js'
);

const here = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(here, '..', 'lib', 'staticServe.js');

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mitti-classify-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

test('classify: index.html with no package.json is a website', () => {
  const dir = fixture({ 'index.html': '<h1>hi</h1>' });
  const p = classifyProject(dir);
  assert.equal(p.kind, KIND_WEBSITE);
  assert.equal(p.startKind, null);
  assert.equal(p.hasBuild, false);
});

test('classify: a Next.js project (next start + build) needs a full install and runs npm start', () => {
  const dir = fixture({
    'package.json': { scripts: { build: 'next build', start: 'next start' } },
  });
  const p = classifyProject(dir);
  assert.equal(p.kind, KIND_APP);
  assert.equal(p.hasBuild, true);
  assert.equal(p.startKind, 'next');
});

test('classify: a plain node start script is honoured', () => {
  const dir = fixture({ 'package.json': { scripts: { start: 'node server.js' } } });
  const p = classifyProject(dir);
  assert.equal(p.kind, KIND_APP);
  assert.equal(p.startKind, 'node');
  assert.equal(p.hasBuild, false);
});

test('classify: a build that leaves dist/index.html is served as static output', () => {
  const dir = fixture({
    'package.json': { scripts: { build: 'vite build' } },
    'dist/index.html': '<h1>built</h1>',
  });
  const p = classifyProject(dir);
  assert.equal(p.startKind, 'static');
  assert.equal(p.outputDir, 'dist');
});

test('classify: a package.json with no build and no start falls back to the entry detector', () => {
  const dir = fixture({ 'package.json': { name: 'x' }, 'index.js': 'console.log(1)' });
  const p = classifyProject(dir);
  assert.equal(p.kind, KIND_APP);
  assert.equal(p.startKind, null);
  assert.equal(p.hasBuild, false);
});

test('queue: a second task waits for the first, and the wait is reported', async () => {
  const q = createQueue();
  const order = [];
  let waitedAhead = null;
  const first = q.enqueue(async () => {
    order.push('first-start');
    await new Promise((r) => setTimeout(r, 120));
    order.push('first-end');
    return 'A';
  });
  const second = q.enqueue(
    async () => {
      order.push('second');
      return 'B';
    },
    (ahead) => {
      waitedAhead = ahead;
    }
  );
  assert.deepEqual(await Promise.all([first, second]), ['A', 'B']);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  assert.equal(waitedAhead, 1);
});

test('queue: a failing task does not block the next one', async () => {
  const q = createQueue();
  const bad = q.enqueue(async () => {
    throw new Error('boom');
  });
  await assert.rejects(bad, /boom/);
  assert.equal(await q.enqueue(async () => 'after'), 'after');
});

test('static fallback: serves index, a real asset, and refuses to leave its folder', async () => {
  const dir = fixture({
    'dist/index.html': '<h1>built site</h1>',
    'dist/app.css': 'body{color:#fafafa}',
    'secret.txt': 'TOP-SECRET-OUTSIDE',
  });
  const root = path.join(dir, 'dist');
  const port = 7490 + Math.floor(Math.random() * 8);
  const child = spawn(process.execPath, [STATIC, root], {
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 100));
      up = await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false);
    }
    assert.ok(up, 'static server came up');
    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.match(await home.text(), /built site/);
    const css = await fetch(`http://127.0.0.1:${port}/app.css`);
    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
    const escape = await fetch(`http://127.0.0.1:${port}/..%2Fsecret.txt`);
    const body = await escape.text();
    assert.ok(!body.includes('TOP-SECRET-OUTSIDE'), 'must not serve a file outside the folder');
  } finally {
    child.kill('SIGKILL');
  }
});
