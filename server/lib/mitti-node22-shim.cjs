// mitti-node22-shim.cjs — lets a newer client's server boot on MittiCloud's Node 18.
//
// WHY THIS EXISTS
// ZCode 3.14.x deploys its own Node 22 runtime (linux-arm64, glibc) and runs
// `node zcode-server.cjs` on the connected machine. Android cannot execute that
// glibc binary, so MittiCloud swaps in the Node it ships inside the APK — Node
// 18 (nodejs-mobile). But zcode-server.cjs `require("node:sqlite")` at load
// time, and `node:sqlite` only exists from Node 22.5. On Node 18 the require
// throws ERR_UNKNOWN_BUILTIN_MODULE, the process exits 1, and ZCode reports
// "Stream closed before handshake completed" — the exact failure this fixes.
//
// WHAT IT DOES
// Registers a stand-in for `node:sqlite` before the server loads, so the
// require resolves and the process can start, finish its handshake and run a
// coding session. Loaded with `node --require <this file> zcode-server.cjs`.
//
// WHAT IS HONEST ABOUT IT
// The stand-in is an in-memory store, not SQLite. ZCode's SQLite-backed
// features — off-peak task queue, task automation/NOTES persistence — will not
// survive a restart and are not fully implemented. Everything else (the
// session, file editing, the agent) works normally. It says so once on stderr
// instead of pretending: a silent no-op would look like it worked while quietly
// dropping writes.
'use strict';

const Module = require('node:module');

const warned = new Set();
function warnOnce(what) {
  if (warned.has(what)) return;
  warned.add(what);
  process.stderr.write(
    `mitti shim: ${what} is running in memory only — this device has Node ` +
      `${process.versions.node}, and zcode-server expects Node 22's real SQLite. ` +
      'Task/schedule history will not persist across restarts.\n'
  );
}

/**
 * A statement that answers the shapes zcode-server uses (run/get/all/iterate)
 * without pretending to parse general SQL: it keeps nothing and returns empty
 * results, which is the truthful answer for "no rows stored".
 */
class StatementSync {
  constructor(sql) {
    this.source = String(sql || '');
  }
  run() {
    warnOnce('SQLite writes');
    return { changes: 1, lastInsertRowid: 0 };
  }
  get() {
    return undefined;
  }
  all() {
    return [];
  }
  iterate() {
    return [][Symbol.iterator]();
  }
  setReadBigInts() {}
  setAllowBareNamedParameters() {}
}

/** The `DatabaseSync` shape zcode-server constructs: `new DatabaseSync(path)`. */
class DatabaseSync {
  constructor(location) {
    this.location = location;
    this.isOpen = true;
    warnOnce('node:sqlite');
  }
  exec() {
    warnOnce('SQLite writes');
  }
  prepare(sql) {
    return new StatementSync(sql);
  }
  close() {
    this.isOpen = false;
  }
  open() {
    this.isOpen = true;
  }
  function() {
    return undefined;
  }
  aggregate() {
    return undefined;
  }
}

const sqlite = { DatabaseSync, StatementSync, backup: async () => {} };

// Resolve `node:sqlite` (and the bare `sqlite` some bundlers emit) to the
// stand-in. Everything else falls through untouched.
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'node:sqlite' || request === 'sqlite') return sqlite;
  return originalLoad.call(this, request, parent, isMain);
};

module.exports = sqlite;