// mitti-fork-wrapper.cjs — run a node script on a worker thread while keeping
// the real child_process.fork() IPC channel alive on THIS (main) thread.
//
// WHY THIS EXISTS
// Next.js's jest-worker spawns compile workers with child_process.fork(
//   .../processChild.js). The child speaks the fork protocol: it listens on
//   process.on('message') and answers with process.send(). On arm64 Android a
//   heavy script faults on the process main thread (same SIGSEGV the ZCode
//   agent bundle hit), so the script must run on a worker thread. A worker
//   thread has no process.channel / process.send — so this wrapper, itself the
//   real forked child, keeps the IPC channel on the main thread and bridges:
//
//     jest parent <==IPC==> [wrapper main] <==MessagePort==> [worker: script]
//
// Inside the worker we shim just enough of `process` (send + the 'message'
// listener registry) for jest-worker's processChild protocol; every other part
// of `process` stays real.
//
// USAGE (spawned by the shim's child_process.fork patch — modulePath arg):
//   node this-file.cjs <script> [args...]
'use strict';

const { Worker } = require('node:worker_threads');
const path = require('node:path');

const target = process.argv[2];
if (!target) {
  try { if (process.send) process.send([2, 'Error', 'mitti-fork-wrapper: no target']); } catch (e) {}
  process.stderr.write('mitti-fork-wrapper: no target script given\n');
  process.exit(64);
}
const rest = process.argv.slice(2);
const SHIM = path.join(__dirname, 'mitti-node22-shim.cjs');
const STACK = Number(process.env.MITTI_FORK_STACK_MB || 64) * 1024 * 1024;

const src = `
const { parentPort, workerData } = require('node:worker_threads');
process.argv = ['node'].concat(workerData.rest);

// Fork-channel facade over parentPort. The real IPC lives in the wrapper's
// main thread; here we give the script just enough process surface — a 'message'
// listener registry and process.send — for jest-worker's processChild protocol.
const handlers = new Set();
const origOn = process.on.bind(process);
const origOnce = process.once.bind(process);
const origRm = process.removeListener ? process.removeListener.bind(process) : (() => process);
const deliver = (m) => {
  handlers.forEach((fn) => {
    try { fn(m); } catch (e) { parentPort.postMessage({ __mitti: 'err', stack: String(e && e.stack || e) }); }
  });
};
parentPort.on('message', (m) => { if (m && m.__mitti === 'msg') deliver(m.msg); });
const addH = (fn) => { handlers.add(fn); return process; };
const rmH = (fn) => { handlers.delete(fn); return process; };
const addOnce = (fn) => { const w = (m) => { handlers.delete(w); fn(m); }; handlers.add(w); return process; };
process.on = (ev, fn) => (ev === 'message' ? addH(fn) : origOn(ev, fn));
process.once = (ev, fn) => (ev === 'message' ? addOnce(fn) : origOnce(ev, fn));
process.addListener = process.on;
process.removeListener = (ev, fn) => (ev === 'message' ? rmH(fn) : origRm(ev, fn));
process.off = process.removeListener;
process.send = (msg) => { parentPort.postMessage({ __mitti: 'msg', msg }); return true; };
// jest-worker checks process.send truthiness; some builds touch process.channel.
if (process.channel === undefined) {
  try { Object.defineProperty(process, 'channel', { value: { ref() {}, unref() {} }, configurable: true }); } catch (e) {}
}

try { require(workerData.target); } catch (e) {
  parentPort.postMessage({ __mitti: 'err', stack: String(e && e.stack || e) });
  process.exit(1);
}
`;

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
  try { if (process.send) process.send([2, 'Error', 'mitti-fork-wrapper: ' + e.message]); } catch (e2) {}
  process.stderr.write('mitti-fork-wrapper: worker failed to start: ' + e.message + '\n');
  process.exit(70);
}

process.stdin.pipe(worker.stdin);
worker.stdout.pipe(process.stdout);
worker.stderr.pipe(process.stderr);

// parent (jest) -> wrapper -> worker
process.on('message', (m) => {
  try { worker.postMessage({ __mitti: 'msg', msg: m }); } catch (e) {}
});
// worker -> wrapper -> parent
worker.on('message', (m) => {
  if (m && m.__mitti === 'msg') {
    try { if (process.send) process.send(m.msg); } catch (e) {}
  } else if (m && m.__mitti === 'err') {
    try { if (process.send) process.send([2, 'Error', String(m.stack)]); } catch (e) {}
    process.stderr.write('mitti-fork-wrapper worker: ' + m.stack + '\n');
  }
});
worker.on('error', (e) => {
  process.stderr.write('mitti-fork-wrapper: worker error: ' + (e && e.message) + '\n');
  process.exit(70);
});
worker.on('exit', (code) => process.exit(code === undefined ? 0 : code));
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => process.exit(0));
}
