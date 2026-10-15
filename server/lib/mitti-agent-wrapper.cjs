// mitti-agent-wrapper.cjs — run a Node script on a worker thread, forwarding
// stdio and the exit code, so the caller sees an ordinary child process.
//
// WHY THIS EXISTS
// Measured on an arm64 Android phone (OnePlus 6T, Android 11), with the real
// ZCode client bundle (~15 MB, glm/zcode.cjs):
//
//   main thread            -> SIGSEGV, exit 139, zero output (every time)
//   worker thread, 4 MB    -> clean exit, runs to its config-loading stage
//   worker thread, 8 MB    -> clean exit, same
//   worker thread, 16 MB   -> clean exit, same
//   worker thread, 64 MB   -> clean exit, same
//
// So the crash is specific to running that bundle on the process main thread on
// Android, and it is NOT a stack-size shortage (4 MB is enough; --stack-size and
// ulimit -s change nothing). Desktop x86-64 does not crash at all. The same
// bundle on desktop Node 18 + the shim produces identical output to native Node
// 22, so the code and the shim are correct — the fault is in how the main
// thread is set up on this platform.
//
// This wrapper sidesteps it: the script runs on a worker thread instead.
//
// USAGE
//   node --require <agent shim> this-file.cjs <script> [args...]
// The script's argv[1] is the script path, exactly as if it had been run
// directly, and its stdin/stdout/stderr are this process's.
'use strict';

const { Worker } = require('node:worker_threads');

const target = process.argv[2];
if (!target) {
  process.stderr.write('mitti-agent-wrapper: no target script given\n');
  process.exit(64);
}
const rest = process.argv.slice(2);

// A large stack is cheap insurance, but 4 MB already sufficed in testing; the
// point is the thread, not the size.
const STACK = Number(process.env.MITTI_AGENT_STACK_MB || 64) * 1024 * 1024;

const src = `
const { workerData } = require('node:worker_threads');
// Make the worker look exactly like a normally-spawned process.
process.argv = ['node'].concat(workerData.rest);
try {
  // The agent needs this shim (node:sqlite, crypto, node:sea). Workers normally
  // inherit --require from execArgv, but do not rely on that: the shim sits
  // beside this wrapper, so load it explicitly and deterministically.
  try { require(workerData.shim); } catch (e) {
    process.stderr.write('mitti-agent-wrapper: shim load failed: ' + (e && e.message) + '\\n');
  }
  // Anything else the parent was launched with (e.g. a user --require).
  for (const a of process.execArgv) {
    if (a.startsWith('--require=')) {
      const m = a.slice('--require='.length);
      if (m !== workerData.shim) { try { require(m); } catch {} }
    }
  }
  require(workerData.target);
} catch (e) {
  process.stderr.write('mitti-agent-wrapper: ' + (e && (e.stack || e.message)) + '\\n');
  process.exit(1);
}
`;

const SHIM = require('node:path').join(__dirname, 'mitti-node22-shim.cjs');

let worker;
try {
  worker = new Worker(src, {
    eval: true,
    workerData: { target, rest, shim: SHIM },
    stdin: true,
    stdout: true,
    stderr: true,
    stackSize: STACK,
  });
} catch (e) {
  process.stderr.write('mitti-agent-wrapper: worker failed to start: ' + e.message + '\n');
  process.exit(70);
}

// Forward real stdio in both directions. This is what makes the worker
// indistinguishable from a normally-spawned child to whoever launched us.
process.stdin.pipe(worker.stdin);
worker.stdout.pipe(process.stdout);
worker.stderr.pipe(process.stderr);

worker.on('error', (e) => {
  process.stderr.write('mitti-agent-wrapper: worker error: ' + (e && e.message) + '\n');
  process.exit(70);
});
worker.on('exit', (code) => process.exit(code === undefined ? 0 : code));

// A killed parent should not leave the worker running.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => process.exit(0));
}