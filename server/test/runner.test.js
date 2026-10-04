// Tests for the CLI agent runner: prompt passed as ONE safe argv element,
// stdin mode for templates without {prompt}, honest failure notes, and the
// empty-command guard. Uses a fake spawn — no real CLI needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';

const { runCliTurn } = await import('../lib/runner.js');

function fakeChild(script = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: (s) => script.stdinWrites.push(s), end: () => {} };
  child.kill = () => {};
  child.script = script;
  return child;
}

function makeSession(overrides = {}) {
  return {
    id: 'cli00001',
    engine: 'cli',
    cliCmd: 'opencode run {prompt}',
    workspaceAbs: process.cwd(),
    messages: [{ role: 'user', text: 'organize my files', ts: new Date().toISOString() }],
    ...overrides,
  };
}

test('the prompt is passed as ONE argv element and real output lands in the session', async () => {
  let seenArgs = null;
  const script = {};
  const spawnImpl = (cmd, args) => {
    seenArgs = [cmd, args];
    const child = fakeChild(script);
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from('listing 3 files…'));
      child.stdout.emit('data', Buffer.from(' done'));
      child.emit('close', 0);
    }, 5);
    return child;
  };
  const session = makeSession();
  const saves = [];
  await runCliTurn(session, (s) => saves.push(s.messages.length), { spawnImpl });

  assert.deepEqual(seenArgs, ['opencode', ['run', 'organize my files']]);
  const out = session.messages[1];
  assert.equal(out.role, 'assistant');
  assert.equal(out.engine, 'cli');
  assert.equal(out.text, 'listing 3 files… done');
  assert.equal(out.streaming, false);
  assert.equal(out.ok, true);
  assert.ok(saves.length >= 1, 'persist ran during the turn');
});

test('templates without {prompt} get the message on stdin', async () => {
  const writes = [];
  const spawnImpl = (cmd, args, opts) => {
    const child = fakeChild({ stdinWrites: writes });
    setTimeout(() => child.emit('close', 0), 5);
    return child;
  };
  const session = makeSession({ cliCmd: 'npx -y some-agent' });
  await runCliTurn(session, () => {}, { spawnImpl });
  assert.equal(writes[0], 'organize my files\n');
  assert.equal(session.messages[1].ok, true);
});

test('a failing CLI says its real exit code, nothing invented', async () => {
  const spawnImpl = () => {
    const child = fakeChild();
    setTimeout(() => {
      child.stderr.emit('data', Buffer.from('model not configured'));
      child.emit('close', 2);
    }, 5);
    return child;
  };
  const session = makeSession();
  await runCliTurn(session, () => {}, { spawnImpl });
  const out = session.messages[1];
  assert.equal(out.ok, false);
  assert.match(out.text, /model not configured/);
  assert.match(out.text, /\[CLI exited with code 2\]/);
});

test('an empty command ends in an honest error, no spawn at all', async () => {
  let spawned = false;
  const spawnImpl = () => {
    spawned = true;
    return fakeChild();
  };
  const session = makeSession({ cliCmd: '   ' });
  await runCliTurn(session, () => {}, { spawnImpl });
  assert.equal(spawned, false);
  assert.match(session.messages[1].text, /No CLI command set/);
});
