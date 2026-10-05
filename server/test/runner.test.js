// Tests for the CLI agent runner: prompt passed as ONE safe argv element,
// stdin mode for templates without {prompt}, honest failure notes, and the
// empty-command guard. Uses a fake spawn — plus one REAL .cmd-shim test that
// proves the Windows EINVAL fix on the actual machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { runCliTurn, presetInstalled, spawnRequestFor, cmdArg } = await import('../lib/runner.js');

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

  const r = spawnRequestFor('opencode', ['run', 'organize my files']);
  assert.deepEqual(seenArgs, [r.file, r.args]);
  const out = session.messages[1];
  assert.equal(out.role, 'assistant');
  assert.equal(out.engine, 'cli');
  assert.equal(out.text, 'listing 3 files… done');
  assert.equal(out.streaming, false);
  assert.equal(out.ok, true);
  assert.ok(saves.length >= 1, 'persist ran during the turn');
});

test('spawnRequestFor wraps .cmd-shim CLIs through cmd.exe on Windows only', () => {
  if (process.platform === 'win32') {
    const r = spawnRequestFor('opencode', ['run', 'organize my files']);
    assert.equal(r.file, 'cmd.exe');
    assert.deepEqual(r.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.match(r.args[3], /opencode/);
    assert.match(r.args[3], /"organize my files"/);
    assert.equal(cmdArg('plain'), 'plain');
    assert.equal(cmdArg("a b"), '"a b"');
    assert.equal(cmdArg('say "hi"'), '"say ""hi"""');
  } else {
    assert.deepEqual(spawnRequestFor('opencode', ['run', 'x']), {
      file: 'opencode',
      args: ['run', 'x'],
    });
  }
});

test('a REAL .cmd shim installs, is detected, and the prompt arrives as one argument', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mitti-shim-'));
  await fs.promises.writeFile(
    path.join(dir, 'fakecli.cmd'),
    '@echo off\r\necho fakecli 1.2.3\r\necho [%~1]\r\n'
  );
  const prevPath = process.env.PATH;
  process.env.PATH = dir + ';' + prevPath;
  try {
    assert.equal(await presetInstalled({ id: 'fake', bin: 'fakecli', pkg: null }), true);
    assert.equal(await presetInstalled({ id: 'nope', bin: 'definitely-not-here-xyz', pkg: null }), false);

    const session = makeSession({ cliCmd: 'fakecli {prompt}' });
    await runCliTurn(session, () => {});
    const out = session.messages[1];
    assert.equal(out.ok, true);
    assert.match(out.text, /\[organize my files\]/, 'prompt lands as ONE argument');
  } finally {
    process.env.PATH = prevPath;
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
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

test('a CLI that prints nothing is stopped with an honest sign-in hint', async () => {
  const spawnImpl = () => {
    const child = fakeChild();
    // never emits data, never closes — a stuck CLI waiting for a TTY
    setTimeout(() => child.emit('close', null), 5000).unref?.();
    return child;
  };
  const session = makeSession({ cliCmd: 'opencode run {prompt}' });
  await runCliTurn(session, () => {}, { spawnImpl, noOutputMs: 60 });
  const out = session.messages[1];
  assert.equal(out.ok, false, 'a silent stall is never a success');
  assert.match(out.text, /No output for 90 seconds — stopped/);
  assert.match(out.text, /opencode/);
  assert.match(out.text, /sign in/);
});

test('a CLI that exits 0 without printing is marked as nothing-to-show', async () => {
  const spawnImpl = () => {
    const child = fakeChild();
    setTimeout(() => child.emit('close', 0), 5);
    return child;
  };
  const session = makeSession();
  await runCliTurn(session, () => {}, { spawnImpl });
  assert.match(session.messages[1].text, /printed nothing/);
});
