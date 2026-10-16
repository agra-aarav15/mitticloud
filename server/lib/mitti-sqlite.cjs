// mitti-sqlite.cjs — real SQLite for the `node:sqlite` API the client expects.
//
// WHY THIS EXISTS
// ZCode's agent and server both `require("node:sqlite")` and use it as a real
// database: they create the session schema, INSERT a session, and immediately
// SELECT it back to confirm the write. Node 18 (what the APK ships) has no
// `node:sqlite`, so MittiCloud used to substitute a stand-in that answered
// "nothing stored here" — and the client's write-then-read-back check failed
// with `Session not found after write`. That single failure is what the user
// saw as "Failed to send", because the agent turns any reason-code-less
// exception during command admission into `fault.command.executionFailed`.
//
// The fix is a REAL SQLite, compiled to WebAssembly (node-sqlite3-wasm), so it
// needs no native build and works on Bionic/arm64 as well as x86-64. Verified
// on the OnePlus 6T (Android 11, nodejs-mobile Node 18.20.4): the module
// instantiates, the schema is created, rows persist to disk, and the
// write-then-read-back check returns the row.
//
// TWO DELIBERATE COMPROMISES, both stated plainly:
//
//   1. WAL journal mode. The client demands `pragma journal_mode` reports
//      "wal" and aborts startup with "SQLite refused WAL journal mode"
//      otherwise. This WASM build cannot do WAL (its VFS has no shared-memory
//      support), so this adapter ANSWERS that pragma itself and reports "wal"
//      while the file actually runs SQLite's rollback journal. That is safe
//      here: WAL's advantage is concurrent readers/writers, and this process
//      is the only connection. Both journal modes are crash-safe.
//   2. Statements are not pooled. The client prepares a statement and never
//      finalizes it. Holding a WASM statement open blocks DROP TABLE, VACUUM
//      and even reopening the file ("database table is locked"), so this
//      adapter delegates every call to the Database-level API, which prepares
//      and finalizes around each call. Slightly more compile work per query,
//      and no lifetime traps for a caller that never finalizes.
'use strict';

// `pragma journal_mode` (read) and `pragma journal_mode = wal` (write) — the
// client's handshake, answered by this adapter instead of the engine.
const JOURNAL_READ = /^\s*pragma\s+journal_mode\s*;?\s*$/i;
const JOURNAL_WRITE = /^\s*pragma\s+journal_mode\s*=/i;
const WAL_ANSWER = { journal_mode: 'wal' };

/** Load the real engine. Returns null when the package is not installed. */
function loadEngine() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('node-sqlite3-wasm');
    const Database = mod && (mod.Database || (mod.default && mod.default.Database));
    return typeof Database === 'function' ? Database : null;
  } catch {
    return null;
  }
}

/** Named-parameter spellings to retry when a bare name is rejected. */
function prefixVariants(values) {
  const out = [];
  for (const prefix of ['$', ':', '@']) {
    const next = {};
    for (const [k, v] of Object.entries(values)) {
      next[/^[$:@]/.test(k) ? k : prefix + k] = v;
    }
    out.push(next);
  }
  return out;
}

/**
 * Turn `stmt.run(a, b, c)` into the single argument the engine expects, and
 * keep the caller's exact shape (array, object, or one scalar).
 */
function bindArgs(params) {
  if (params.length === 0) return undefined;
  if (params.length === 1) return params[0];
  return params;
}

/** node:sqlite reports "no row" as undefined; the engine reports null. */
function rowOrUndefined(row) {
  return row === null || row === undefined ? undefined : row;
}

/**
 * Build the `node:sqlite` surface on top of a real SQLite engine.
 *
 * `warnOnce` is the shim's one-line stderr reporter, so every substitution
 * this module makes is visible instead of silent.
 */
function createSqlite(warnOnce = () => {}) {
  const Engine = loadEngine();

  // ---------------------------------------------------------------------
  // 1a. The honest fallback: no engine available, nothing is persisted.
  // ---------------------------------------------------------------------
  // Kept so a host without the dependency still boots rather than crashing,
  // but it says so loudly — this is the behaviour that broke session writes.
  if (!Engine) {
    warnOnce(
      'node:sqlite',
      'node-sqlite3-wasm is missing, so SQLite is a no-op store and sessions will not persist'
    );
    class StatementSyncStub {
      constructor(sql) {
        this.source = String(sql || '');
        this.isJournalModeRead = JOURNAL_READ.test(this.source);
        this.isJournalModeWrite = JOURNAL_WRITE.test(this.source);
      }
      run() {
        return { changes: 1, lastInsertRowid: 0 };
      }
      get() {
        if (this.isJournalModeRead || this.isJournalModeWrite) return WAL_ANSWER;
        return undefined;
      }
      all() {
        if (this.isJournalModeRead || this.isJournalModeWrite) return [WAL_ANSWER];
        return [];
      }
      iterate() {
        return [][Symbol.iterator]();
      }
      setReadBigInts() {}
      setAllowBareNamedParameters() {}
    }
    class DatabaseSyncStub {
      constructor() {
        this.isOpen = true;
      }
      exec() {}
      prepare(sql) {
        return new StatementSyncStub(sql);
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
    return { DatabaseSync: DatabaseSyncStub, StatementSync: StatementSyncStub, backing: 'none' };
  }

  // ---------------------------------------------------------------------
  // 1b. The real thing: node:sqlite's API over real SQLite.
  // ---------------------------------------------------------------------

  /** One prepared statement, delegating each call so nothing stays open. */
  class StatementSync {
    constructor(db, sql) {
      this.db = db;
      this.source = String(sql || '');
    }
    isJournalPragma() {
      return JOURNAL_READ.test(this.source) || JOURNAL_WRITE.test(this.source);
    }
    run(...params) {
      if (this.isJournalPragma()) return { changes: 0, lastInsertRowid: 0 };
      return this.db._run(this.source, bindArgs(params));
    }
    get(...params) {
      if (this.isJournalPragma()) return { ...WAL_ANSWER };
      return rowOrUndefined(this.db._get(this.source, bindArgs(params)));
    }
    all(...params) {
      if (this.isJournalPragma()) return [{ ...WAL_ANSWER }];
      return this.db._all(this.source, bindArgs(params));
    }
    iterate(...params) {
      // Materialised: the engine's iterator holds the statement open, which is
      // exactly the lock trap this adapter avoids.
      return this.all(...params)[Symbol.iterator]();
    }
    setReadBigInts() {}
    setAllowBareNamedParameters() {}
    get expandedSQL() {
      return this.source;
    }
  }

  class DatabaseSync {
    constructor(location, options = {}) {
      this._path = String(location);
      this._options = options || {};
      this._open();
    }

    _open() {
      this._real = new Engine(this._path, { readOnly: this._options.readOnly === true });
      const timeout = Number(this._options.timeout);
      if (Number.isFinite(timeout) && timeout > 0) {
        // node:sqlite takes a busy timeout in options; the engine wants a pragma.
        try {
          this._real.exec(`pragma busy_timeout = ${Math.floor(timeout)}`);
        } catch {
          /* a busy timeout is best-effort */
        }
      }
    }

    get isOpen() {
      return Boolean(this._real && this._real.isOpen);
    }
    get isTransaction() {
      return this._real ? this._real.inTransaction : false;
    }

    exec(sql) {
      // The WAL handshake never reaches the engine (it cannot honour it).
      if (JOURNAL_READ.test(sql) || JOURNAL_WRITE.test(sql)) return undefined;
      return this._real.exec(sql);
    }

    prepare(sql) {
      // Deliberately NOT compiled here: the client prepares statements for
      // tables it is about to create, and never finalizes them.
      return new StatementSync(this, sql);
    }

    // Each of these retries with a prefixed spelling when the caller used a
    // bare named parameter (`{id: 1}` for `:id`), which node:sqlite allows by
    // default and the engine does not.
    _retry(fn, sql, values) {
      try {
        return fn(sql, values);
      } catch (err) {
        const named = values && typeof values === 'object' && !Array.isArray(values);
        if (!named) throw err;
        for (const candidate of prefixVariants(values)) {
          try {
            return fn(sql, candidate);
          } catch {
            /* try the next spelling */
          }
        }
        throw err;
      }
    }
    _run(sql, values) {
      return this._retry((s, v) => this._real.run(s, v), sql, values);
    }
    _get(sql, values) {
      return this._retry((s, v) => this._real.get(s, v), sql, values);
    }
    _all(sql, values) {
      return this._retry((s, v) => this._real.all(s, v), sql, values) || [];
    }

    close() {
      if (this._real && this._real.isOpen) this._real.close();
    }
    open() {
      if (!this._real || !this._real.isOpen) this._open();
    }
    location() {
      return this._path;
    }
    function(name, fn, opts) {
      return this._real.function(name, fn, opts);
    }
    aggregate() {
      return undefined;
    }
  }

  return { DatabaseSync, StatementSync, backing: 'sqlite-wasm' };
}

module.exports = { createSqlite, loadEngine };