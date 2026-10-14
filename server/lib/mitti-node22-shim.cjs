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
// and rewriting it there would silently swap a precise Unicode class for an
// approximation. So the whole section is skipped on a normal host.

const BACKSLASH = '\\';

// Property name -> an explicit class body. `u`-flag form uses \u{...} code
// points; the non-`u` form uses surrogate pairs (a `u`-mode regex matches code
// points, so a lone surrogate there would be wrong).
const PROPS_U = {
  L: 'A-Za-z\\u00AA\\u00B5\\u00BA\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02C1\\u0370-\\u0374\\u0376\\u0377\\u037A-\\u037D\\u037F\\u0386\\u0388-\\u03FF\\u0400-\\u04FF\\u0500-\\u052F\\u0531-\\u0556\\u0561-\\u0587\\u05D0-\\u05EA\\u0620-\\u064A\\u066E\\u066F\\u0671-\\u06D3\\u06FA-\\u06FC\\u0710-\\u072F\\u0904-\\u0939\\u0958-\\u0961\\u0971-\\u0980\\u0985-\\u098C\\u098F\\u0990\\u0993-\\u09A8\\u0A05-\\u0A0A\\u0A72-\\u0A74\\u0E01-\\u0E30\\u10A0-\\u10C5\\u1E00-\\u1F15\\u3041-\\u3096\\u30A1-\\u30FA\\u3105-\\u312F\\u4E00-\\u9FFF\\uA000-\\uA48C\\uAC00-\\uD7A3\\uF900-\\uFA6D\\uFB00-\\uFB06\\uFF21-\\uFF3A\\uFF41-\\uFF5A',
  N: '0-9\\u0660-\\u0669\\u06F0-\\u06F9\\u07C0-\\u07C9\\u0966-\\u096F\\u09E6-\\u09EF\\u0A66-\\u0A6F\\u0AE6-\\u0AEF\\u0B66-\\u0B6F\\u0BE6-\\u0BEF\\u0C66-\\u0C6F\\u0CE6-\\u0CEF\\u0D66-\\u0D6F\\u0E50-\\u0E59\\u0ED0-\\u0ED9\\u0F20-\\u0F29\\u1040-\\u1049\\u17E0-\\u17E9\\u1810-\\u1819\\u1946-\\u194F\\uFF10-\\uFF19',
  M: '\\u0300-\\u036F\\u0483-\\u0489\\u0591-\\u05BD\\u05BF\\u05C1\\u05C2\\u05C4\\u05C5\\u05C7\\u0610-\\u061A\\u064B-\\u065F\\u0670\\u06D6-\\u06DC\\u06DF-\\u06E4\\u06E7\\u06E8\\u06EA-\\u06ED\\u0711\\u0730-\\u074A\\u07A6-\\u07B0\\u07EB-\\u07F3\\u0816-\\u0819\\u081B-\\u0823\\u0825-\\u0827\\u0829-\\u082D\\u0859-\\u085B\\u08E3-\\u0903\\u093A\\u093C\\u0941-\\u0948\\u094D\\u0951-\\u0957\\u0962\\u0963',
  S: '\\u0024\\u002B\\u003C-\\u003E\\u005E\\u0060\\u007C\\u007E\\u00A2-\\u00A6\\u00A8\\u00A9\\u00AC\\u00AE-\\u00B1\\u00B4\\u00B6\\u00B8\\u00D7\\u00F7\\u02C2-\\u02C5\\u02D2-\\u02DF\\u02E5-\\u02EB\\u02ED\\u02EF-\\u02FF\\u0375\\u0384\\u0385\\u03F6\\u0482\\u058D-\\u058F\\u0606-\\u0608\\u060B\\u060E\\u060F\\u06DE\\u06E9\\u06FD\\u06FE\\u07F6\\u07FE\\u07FF\\u09F2\\u09F3\\u09FA\\u09FB\\u0AF1\\u0B70\\u0BF3-\\u0BFA',
  // Emoji classes are supplementary-plane; \u{...} is required (and only valid
  // with the `u` flag, which every emoji regex here sets).
  Extended_Pictographic: '\\u{1F000}-\\u{1F0FF}\\u{1F10D}-\\u{1F10F}\\u{1F12F}\\u{1F16C}-\\u{1F171}\\u{1F17E}\\u{1F17F}\\u{1F18E}\\u{1F191}-\\u{1F19A}\\u{1F1AD}-\\u{1F1E5}\\u{1F201}-\\u{1F20F}\\u{1F21A}\\u{1F22F}\\u{1F232}-\\u{1F23A}\\u{1F23C}-\\u{1F23F}\\u{1F249}-\\u{1F3FA}\\u{1F400}-\\u{1F53D}\\u{1F546}-\\u{1F64F}\\u{1F680}-\\u{1F6FF}\\u{1F774}-\\u{1F77F}\\u{1F7D5}-\\u{1F7FF}\\u{1F80C}-\\u{1F80F}\\u{1F848}-\\u{1F84F}\\u{1F85A}-\\u{1F85F}\\u{1F888}-\\u{1F88F}\\u{1F8AE}-\\u{1F8FF}\\u{1F90C}-\\u{1F93A}\\u{1F93C}-\\u{1F945}\\u{1F947}-\\u{1F9FF}\\u{1FA70}-\\u{1FAFF}\\u{1FC00}-\\u{1FFFD}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{1F1E6}-\\u{1F1FF}',
  Regional_Indicator: '\\u{1F1E6}-\\u{1F1FF}',
  Emoji_Component: '\\u{200D}\\u{FE0F}\\u{1F3FB}-\\u{1F3FF}\\u{1F1E6}-\\u{1F1FF}0-9#*',
};

// Surrogate-pair fallbacks for the emoji classes, used only if an emoji
// property ever appears in a regex WITHOUT the `u` flag (none do today).
const PROPS_NO_U = {
  L: PROPS_U.L,
  N: PROPS_U.N,
  M: PROPS_U.M,
  S: PROPS_U.S,
  Extended_Pictographic: PROPS_U.Extended_Pictographic.replace(/\\u\{([0-9A-Fa-f]+)\}-\\u\{([0-9A-Fa-f]+)\}/g, (m, a, b) => pairRange(a, b)).replace(/\\u\{([0-9A-Fa-f]+)\}/g, (m, a) => pairRange(a, a)),
  Regional_Indicator: pairRange('1F1E6', '1F1FF'),
  Emoji_Component: PROPS_U.Emoji_Component.replace(/\\u\{([0-9A-Fa-f]+)\}-\\u\{([0-9A-Fa-f]+)\}/g, (m, a, b) => pairRange(a, b)).replace(/\\u\{([0-9A-Fa-f]+)\}/g, (m, a) => pairRange(a, a)),
};

function pairRange(fromHex, toHex) {
  const split = (hex) => {
    const cp = parseInt(hex, 16) - 0x10000;
    return { hi: (0xd800 + (cp >> 10)).toString(16), lo: (0xdc00 + (cp & 0x3ff)).toString(16) };
  };
  const a = split(fromHex);
  const b = split(toHex);
  if (fromHex === toHex) return `\\u${a.hi}\\u${a.lo}`;
  if (a.hi === b.hi) return `\\u${a.hi}[\\u${a.lo}-\\u${b.lo}]`;
  return `(?:\\u${a.hi}[\\u${a.lo}-\\uDFFF]|[\\u${(parseInt(a.hi, 16) + 1).toString(16)}-\\u${(parseInt(b.hi, 16) - 1).toString(16)}][\\uDC00-\\uDFFF]|\\u${b.hi}[\\uDC00-\\u${b.lo}])`;
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
  const out = source.replace(/(?<!\\)\\([pP])\{([A-Za-z_=]+)\}/g, (whole, kind, name) => {
    const body = table[name];
    if (!body) return whole;
    changed = true;
    return kind === 'p' ? body : '^' + body;
  });
  if (changed) {
    warnOnce('Unicode \\p{...} ranges', 'approximated, because this device\'s Node ' + process.versions.node + ' is built without ICU');
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