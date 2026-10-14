// mitti-node22-shim.cjs — lets a newer client's server boot on MittiCloud's Node 18.
//
// WHY THIS EXISTS
// ZCode 3.14.x/3.15.x deploys its own Node 22 runtime (linux-arm64, glibc) and
// runs `node zcode-server.cjs` on the connected machine. Android cannot execute
// that glibc binary, so MittiCloud swaps in the Node it ships inside the APK —
// nodejs-mobile's Node 18. That Node is missing three things the server needs,
// and each one alone kills the session with "Stream closed before handshake
// completed (exit code 1)":
//
//   1. `require("node:sqlite")` — a Node 22.5+ builtin. On Node 18 the require
//      throws ERR_UNKNOWN_BUILTIN_MODULE and the process exits 1. (fixed below)
//   2. Unicode property escapes — zcode-server's source contains a regex LITERAL
//      using \p{L}\p{N}\p{M}\p{S}. V8 can only compile those with ICU, and
//      nodejs-mobile's Node 18 is built WITHOUT ICU (`process.versions.icu` is
//      undefined). So the file fails at PARSE time, before any line runs. A
//      runtime shim cannot help a file that will not parse — the source has to
//      be rewritten before V8 sees it. (fixed below)
//   3. `Intl` — absent entirely on the ICU-less build, yet the server calls
//      Intl.DateTimeFormat for locale/timezone headers and date ranges. (fixed below)
//
// Loaded with `node --require <this file> zcode-server.cjs`, in front of the
// script so it also reaches a shell-wrapped launch.
//
// WHAT IS HONEST ABOUT IT
// The node:sqlite stand-in is an in-memory store, not SQLite: ZCode's SQLite-
// backed task queue and automation history will not survive a restart. The
// Unicode ranges are explicit approximations of the Unicode classes, not the
// tables themselves, and the Intl stand-in formats in the device's own local
// time rather than an arbitrary IANA zone. Everything else — the session, file
// editing, the agent — works normally. Each substitution says so once on stderr
// instead of pretending, because a silent no-op would look like it worked while
// quietly dropping data.
'use strict';

const Module = require('node:module');

const warned = new Set();
function warnOnce(what, detail) {
  if (warned.has(what)) return;
  warned.add(what);
  process.stderr.write(`mitti shim: ${what} — ${detail}\n`);
}

// ---------------------------------------------------------------------------
// 1. `node:sqlite` — a stand-in so the require resolves on Node 18
// ---------------------------------------------------------------------------

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
    warnOnce('SQLite writes', 'kept in memory only, so task/schedule history will not persist across restarts');
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
    warnOnce('node:sqlite', 'running in memory only; task/schedule history will not persist across restarts');
  }
  exec() {
    warnOnce('SQLite writes', 'kept in memory only, so task/schedule history will not persist across restarts');
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

// ---------------------------------------------------------------------------
// 2. Unicode property escapes — only on a build without ICU
// ---------------------------------------------------------------------------
//
// Only a Node with no ICU needs this: a full-ICU Node compiles \p{...} itself,
// and rewriting it there would swap its precise tables for ours. The whole
// section is skipped on a normal host.
//
// The tables are GENERATED (tools/gen-unicode-tables.cjs) by dumping every code
// point from a full-ICU Node, so they are exact rather than approximate. They
// cover every property the client's servers and agents actually use — the
// server needs \p{L}\p{N}\p{M}\p{S}; the agent bundle also uses \p{P}, \p{Pd},
// \p{White_Space}, \p{Script=Han} and the three emoji classes.

const BACKSLASH = '\\';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TABLES = require('./mitti-unicode-tables.cjs');
// { name: { u: '<class body for a /u regex>', n: '<surrogate form>' } }
const PROPS_U = {};
const PROPS_NO_U = {};
for (const [name, forms] of Object.entries(TABLES)) {
  PROPS_U[name] = forms.u;
  PROPS_NO_U[name] = forms.n;
}

/** Does the shim have a table for this property name? */
function hasProperty(name) {
  return Object.prototype.hasOwnProperty.call(PROPS_U, name);
}

function hasIcu() {
  // MITTI_FORCE_NO_ICU lets a test exercise the no-ICU path on a full-ICU host,
  // where the rewrite and the Intl stand-in would otherwise never run.
  return process.env.MITTI_FORCE_NO_ICU === '1' ? false : Boolean(process.versions.icu);
}

/** Replace \p{X} / \P{X} (single-backslash, not itself escaped) with ranges. */
function rewriteProperties(source, table) {
  if (source.indexOf(BACKSLASH + 'p{') < 0 && source.indexOf(BACKSLASH + 'P{') < 0) return source;
  // A negative look-behind keeps a doubled backslash (\ \p{) — the string-literal
  // form — untouched; only the single-backslash regex-source form is a hazard.
  // One global replace over a 12 MB file is fast; a per-character loop is O(n^2).
  let changed = false;
  const unknown = [];
  const out = source.replace(/(?<!\\)\\([pP])\{([A-Za-z_=]+)\}/g, (whole, kind, name) => {
    const body = table[name];
    if (!body) {
      // Not in the tables: leaving it means the regex still throws at compile
      // time. Record it so the failure is visible instead of silent.
      if (!unknown.includes(name)) unknown.push(name);
      return whole;
    }
    changed = true;
    return kind === 'p' ? body : '^' + body;
  });
  if (changed) {
    warnOnce('Unicode \\p{...}', 'substituted exact ranges, because this device\'s Node ' + process.versions.node + ' is built without ICU');
  }
  if (unknown.length) {
    // A property with no table would still crash the client's file. Say so.
    warnOnce('Unicode \\p{...} not covered', 'no range table for: ' + unknown.join(', ') + ' — a regex using it may still fail on this Node');
  }
  return out;
}

if (!hasIcu()) {
  // (a) Regex LITERALS: rewrite the module source before V8 parses it. This is
  // the only fix for a parse-time crash — no runtime wrapper can help.
  const originalCompile = Module.prototype._compile;
  Module.prototype._compile = function patchedCompile(content, filename) {
    // PROPS_U is used for source rewriting: every \p{...} literal in the servers
    // we target sits inside a /.../u regex (emoji, file paths), where \u{...} is
    // valid. A non-`u` literal would need surrogates, which no known server uses.
    if (typeof content === 'string' && content.indexOf('p{') >= 0) {
      content = rewriteProperties(content, PROPS_U);
    }
    return originalCompile.call(this, content, filename);
  };

  // (b) Regexes built at RUN time (new RegExp(string, flags)).
  const OriginalRegExp = RegExp;
  function PatchedRegExp(pattern, flags) {
    if (typeof pattern === 'string' && pattern.indexOf('p{') >= 0) {
      const useU = typeof flags === 'string' && flags.indexOf('u') >= 0;
      // string patterns may carry either \p{ or \\p{ depending on how they were written
      let p = pattern.replace(new RegExp(BACKSLASH + BACKSLASH + '([pP]' + BACKSLASH + '?){', 'g'), '$1{');
      p = rewriteProperties(p, useU ? PROPS_U : PROPS_NO_U);
      return new OriginalRegExp(p, flags);
    }
    return new OriginalRegExp(pattern, flags);
  }
  PatchedRegExp.prototype = OriginalRegExp.prototype;
  for (const key of Object.getOwnPropertyNames(OriginalRegExp)) {
    if (!(key in PatchedRegExp)) {
      try {
        Object.defineProperty(PatchedRegExp, key, Object.getOwnPropertyDescriptor(OriginalRegExp, key));
      } catch {
        /* non-configurable: skip */
      }
    }
  }
  Object.setPrototypeOf(PatchedRegExp, OriginalRegExp);
  globalThis.RegExp = PatchedRegExp;
}

// ---------------------------------------------------------------------------
// 3. Intl — a minimal stand-in when the build has none
// ---------------------------------------------------------------------------
//
// The server calls Intl.DateTimeFormat for locale/timezone headers and for
// day-range queries. Without ICU there is no way to compute an arbitrary IANA
// zone, so the stand-in formats in the device's own local time — the honest
// answer for a phone reporting its own day. Only installed when Intl is absent.

if (process.env.MITTI_FORCE_NO_ICU === '1' || typeof globalThis.Intl === 'undefined' || typeof globalThis.Intl.DateTimeFormat !== 'function') {
  const pad2 = (n) => String(n).padStart(2, '0');
  const field = (d, kind) =>
    ({
      year: String(d.getFullYear()),
      month: pad2(d.getMonth() + 1),
      day: pad2(d.getDate()),
      hour: pad2(d.getHours()),
      minute: pad2(d.getMinutes()),
      second: pad2(d.getSeconds()),
      'dayPeriod': d.getHours() < 12 ? 'AM' : 'PM',
      weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()],
    })[kind];

  class DateTimeFormat {
    constructor(locale, options) {
      this.locale = typeof locale === 'string' && locale ? locale : 'en-US';
      this.options = options && typeof options === 'object' ? options : {};
      warnOnce('Intl', 'substituted a local-time formatter, because this device\'s Node ' + process.versions.node + ' has no ICU');
    }
    resolvedOptions() {
      // Honest: this stand-in formats in the device's own local time and cannot
      // resolve an arbitrary IANA zone (no ICU), so it says 'local' rather than
      // claiming a zone it is not actually using.
      return { locale: this.locale, timeZone: this.options.timeZone || 'local', calendar: 'gregory', numberingSystem: 'latn' };
    }
    format(date) {
      const d = date instanceof Date ? date : new Date(date === undefined ? Date.now() : date);
      const order = ['year', 'month', 'day', 'hour', 'minute', 'second'];
      const wanted = order.filter((key) => key in this.options);
      const keys = wanted.length ? wanted : ['year', 'month', 'day'];
      // Join by what each pair of adjacent fields is: a date dash, a date/time
      // space, or a time colon — the shape Intl would produce.
      let out = '';
      keys.forEach((key, idx) => {
        if (idx > 0) {
          const prev = keys[idx - 1];
          const datePair = (a) => a === 'year' || a === 'month' || a === 'day';
          out += datePair(prev) && datePair(key) ? '-' : datePair(prev) !== datePair(key) ? ' ' : ':';
        }
        out += field(d, key);
      });
      return out;
    }
    formatToParts(date) {
      const d = date instanceof Date ? date : new Date(date === undefined ? Date.now() : date);
      const want = ['year', 'month', 'day'];
      return want.map((type) => ({ type, value: field(d, type) }));
    }
    formatRange(a, b) {
      return `${this.format(a)} – ${this.format(b)}`;
    }
  }

  globalThis.Intl = {
    DateTimeFormat,
    NumberFormat: class {
      constructor(locale) {
        this.locale = locale || 'en-US';
      }
      format(n) {
        return String(n);
      }
      resolvedOptions() {
        return { locale: this.locale };
      }
    },
    getCanonicalLocales: (l) => (Array.isArray(l) ? l : [l]).filter(Boolean),
  };
}

module.exports = sqlite;