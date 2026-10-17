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
//      throws ERR_UNKNOWN_BUILTIN_MODULE and the process exits 1. It is not
//      merely a require gap: the client uses it as a REAL database (it writes a
//      session and reads it straight back), so this now supplies real SQLite
//      via WebAssembly. See lib/mitti-sqlite.cjs. (fixed below)
//   2. Unicode property escapes — zcode-server's source contains a regex LITERAL
//      using \p{L}\p{N}\p{M}\p{S}. V8 can only compile those with ICU, and
//      nodejs-mobile's Node 18 is built WITHOUT ICU (`process.versions.icu` is
//      undefined). So the file fails at PARSE time, before any line runs. A
//      runtime shim cannot help a file that will not parse — the source has to
//      be rewritten before V8 sees it. (fixed below)
//   3. `Intl` — absent entirely on the ICU-less build, yet the server calls
//      Intl.DateTimeFormat for locale/timezone headers and date ranges. (fixed below)
//   4. ES2023/2024 methods — Node 18 has no Array#toSorted/toReversed/toSpliced/
//      `with`, no Promise.withResolvers, no Object.groupBy, no Array.fromAsync.
//      The client's own code uses them, and one of them killed MCP startup on
//      the phone (`Object.keys(...).toSorted is not a function`), so the shim
//      installs the missing ones. (fixed below)
//
// Loaded with `node --require <this file> zcode-server.cjs`, in front of the
// script so it also reaches a shell-wrapped launch.
//
// WHAT IS HONEST ABOUT IT
// SQLite is real (WASM) and rows persist, but it runs in rollback-journal mode
// while reporting "wal" to satisfy the client's handshake — see
// lib/mitti-sqlite.cjs for why that is safe here. The Unicode ranges are
// explicit approximations of the Unicode classes, not the tables themselves,
// and the Intl stand-in formats in the device's own local time rather than an
// arbitrary IANA zone. Everything else — the session, file editing, the agent —
// works normally. Each substitution says so once on stderr instead of
// pretending, because a silent no-op would look like it worked while quietly
// dropping data.
'use strict';

const Module = require('node:module');

const warned = new Set();
function warnOnce(what, detail) {
  if (warned.has(what)) return;
  warned.add(what);
  process.stderr.write(`mitti shim: ${what} — ${detail}\n`);
}

// ---------------------------------------------------------------------------
// 1. `node:sqlite` — real SQLite for the Node 22 builtin
// ---------------------------------------------------------------------------
//
// This used to be a stand-in that stored nothing. That was not enough: the
// client's session store INSERTs a session and then SELECTs it back to verify
// the write, so "nothing stored" became `Session not found after write` —
// which the agent reports as `fault.command.executionFailed` and the desktop
// shows as "Failed to send". Now backed by real SQLite compiled to WASM
// (node-sqlite3-wasm): no native build, and it runs on the phone's arm64
// Bionic Node 18. See lib/mitti-sqlite.cjs for the details and the two
// deliberate compromises (journal mode, statement pooling).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createSqlite } = require('./mitti-sqlite.cjs');
const sqlite = createSqlite(warnOnce);

// ---------------------------------------------------------------------------
// 1a. ES2023/2024 methods Node 18 does not have
// ---------------------------------------------------------------------------
//
// The client is written for Node 20+, so it calls methods the phone's Node 18
// simply does not define. One of them is fatal rather than cosmetic: MCP
// startup threw `Object.keys(...).toSorted is not a function` on every boot,
// which disables the tool servers. Installed only when missing, so a newer
// host is untouched.

if (typeof Array.prototype.toSorted !== 'function') {
  Object.defineProperty(Array.prototype, 'toSorted', {
    value: function toSorted(compareFn) {
      return [...this].sort(compareFn);
    },
    writable: true,
    configurable: true,
  });
  warnOnce('Array.prototype.toSorted', 'added, because this Node is older than 20 (MCP startup needs it)');
}
if (typeof Array.prototype.toReversed !== 'function') {
  Object.defineProperty(Array.prototype, 'toReversed', {
    value: function toReversed() {
      return [...this].reverse();
    },
    writable: true,
    configurable: true,
  });
}
if (typeof Array.prototype.toSpliced !== 'function') {
  Object.defineProperty(Array.prototype, 'toSpliced', {
    value: function toSpliced(start, deleteCount, ...items) {
      const copy = [...this];
      copy.splice(start, deleteCount === undefined ? copy.length : deleteCount, ...items);
      return copy;
    },
    writable: true,
    configurable: true,
  });
}
if (typeof Array.prototype.with !== 'function') {
  Object.defineProperty(Array.prototype, 'with', {
    value: function with_(index, value) {
      const copy = [...this];
      const i = index < 0 ? copy.length + index : index;
      if (i < 0 || i >= copy.length) throw new RangeError('Invalid index');
      copy[i] = value;
      return copy;
    },
    writable: true,
    configurable: true,
  });
}
if (typeof Promise.withResolvers !== 'function') {
  Object.defineProperty(Promise, 'withResolvers', {
    value: function withResolvers() {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    },
    writable: true,
    configurable: true,
  });
}
if (typeof Object.groupBy !== 'function') {
  Object.defineProperty(Object, 'groupBy', {
    value: function groupBy(items, keyFn) {
      const out = Object.create(null);
      let i = 0;
      for (const item of items) {
        const key = keyFn(item, i++);
        (out[key] || (out[key] = [])).push(item);
      }
      return out;
    },
    writable: true,
    configurable: true,
  });
}
if (typeof Map.groupBy !== 'function') {
  Object.defineProperty(Map, 'groupBy', {
    value: function groupBy(items, keyFn) {
      const out = new Map();
      let i = 0;
      for (const item of items) {
        const key = keyFn(item, i++);
        const bucket = out.get(key);
        if (bucket) bucket.push(item);
        else out.set(key, [item]);
      }
      return out;
    },
    writable: true,
    configurable: true,
  });
}
if (typeof String.prototype.isWellFormed !== 'function') {
  Object.defineProperty(String.prototype, 'isWellFormed', {
    value: function isWellFormed() {
      return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(this);
    },
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// 1b. `globalThis.crypto` — present in Node 19+, absent in Node 18
// ---------------------------------------------------------------------------
//
// Node 18 HAS WebCrypto; it just is not exposed as a bare global yet (that
// landed in Node 19). The client bundle calls `crypto.subtle…` directly, so on
// a bare Node 18 it dies with "crypto is not defined". One defineProperty is
// the whole fix — and it is the real implementation, not a stand-in.
if (typeof globalThis.crypto === 'undefined' && require('node:crypto').webcrypto) {
  Object.defineProperty(globalThis, 'crypto', {
    value: require('node:crypto').webcrypto,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  warnOnce('globalThis.crypto', 'exposed from node:crypto.webcrypto, because this Node is older than 19');
}
// randomUUID lives on node:crypto in 18 and moved onto globalThis.crypto later.
if (globalThis.crypto && typeof globalThis.crypto.randomUUID !== 'function') {
  globalThis.crypto.randomUUID = () => require('node:crypto').randomUUID();
}

// ---------------------------------------------------------------------------
// 1c. `node:sea` — present in Node 20.12+, absent in Node 18
// ---------------------------------------------------------------------------
//
// Single-executable-application support. This process is not a SEA, which is
// exactly what the real module reports for a normal Node run, so the honest
// answers are: isSea() false, no assets. Answering that way keeps the client's
// own feature detection on the correct branch instead of throwing.
const sea = {
  isSea: () => false,
  getAsset: () => {
    const e = new Error('Cannot find the requested asset: not a single executable application');
    e.code = 'ERR_NOT_IN_SEA';
    throw e;
  },
  getRawAsset: () => {
    const e = new Error('Cannot find the requested asset: not a single executable application');
    e.code = 'ERR_NOT_IN_SEA';
    throw e;
  },
  getAssetKeys: () => [],
};

// `util` exposes its OWN TextDecoder, separate from the global one. The wasm SWC
// glue does `require('util').TextDecoder` and on a no-ICU Node that one is not the
// global we patched — it throws ERR_NO_ICU for { fatal: true } before the shim's
// global patch can see it. Wrap util's decoder too, keeping every other export.
function wrapTextDecoder(OriginalTextDecoder) {
  if (typeof OriginalTextDecoder !== 'function') return OriginalTextDecoder;
  function WrappedTextDecoder(label, options) {
    if (!new.target) return new OriginalTextDecoder(label, options);
    try {
      return Reflect.construct(OriginalTextDecoder, [label, options]);
    } catch (err) {
      if (!err || err.code !== 'ERR_NO_ICU' || !options || typeof options !== 'object') throw err;
      const opts = { ...options };
      delete opts.fatal;
      delete opts.ignoreBOM;
      warnOnce('TextDecoder', 'dropped the ICU-only "fatal" option, because this device\'s Node ' + process.versions.node + ' is built without ICU');
      return Reflect.construct(OriginalTextDecoder, [label, opts]);
    }
  }
  WrappedTextDecoder.prototype = OriginalTextDecoder.prototype;
  try {
    Object.setPrototypeOf(WrappedTextDecoder, OriginalTextDecoder);
  } catch {
    /* a plain function is still a working constructor */
  }
  return WrappedTextDecoder;
}
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'node:sqlite' || request === 'sqlite') return sqlite;
  if (request === 'node:sea' || request === 'sea') return sea;
  const loaded = originalLoad.call(this, request, parent, isMain);
  // Wrap util.TextDecoder the first time any caller pulls `util` in. It is the
  // same util every require returns, so wrapping once covers every caller. Only
  // done when ICU is absent — a normal Node keeps the real decoder.
  if ((request === 'util' || request === 'node:util') && !hasIcu()) {
    try {
      const orig = loaded.TextDecoder;
      if (typeof orig === 'function' && !orig.__mittiWrapped) {
        const wrapped = wrapTextDecoder(orig);
        wrapped.__mittiWrapped = true;
        Object.defineProperty(loaded, 'TextDecoder', { value: wrapped, configurable: true, writable: true, enumerable: true });
      }
    } catch {
      /* a frozen util keeps its own decoder; the wasm glue still fails on it */
    }
  }
  return loaded;
};
// Give the loader the same answers for a bare `require('sea')` made through
// ESM interop, which does not go through Module._load.
if (!process.versions.sea) {
  try {
    Object.defineProperty(process.versions, 'sea', { get: () => false });
  } catch {
    /* non-configurable on some builds: the Module._load path still covers us */
  }
}

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
// V8 matches property names LOOSELY — case, underscores and hyphens are
// ignored, so \p{Uppercase_Letter}, \p{uppercase_letter} and \p{gc=Lu} all
// name the same thing. The tables are keyed by the normalized form, so every
// spelling a bundled package uses lands on the same row.
const normalizeName = (n) => String(n).toLowerCase().replace(/[^a-z0-9=]/g, '');
const PROPS_U = {};
const PROPS_NO_U = {};
for (const [name, forms] of Object.entries(TABLES)) {
  const key = normalizeName(name);
  PROPS_U[key] = forms.u;
  PROPS_NO_U[key] = forms.n;
}

/** Does the shim have a table for this property name? */
function hasProperty(name) {
  return Object.prototype.hasOwnProperty.call(PROPS_U, normalizeName(name));
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
    const body = table[normalizeName(name)];
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

/**
 * Replace the ESCAPED form, \\p{X}, as it appears inside a string literal of a
 * "source as text" module. The string's VALUE is regex source that gets evaluated
 * later, so the replacement is emitted in the same escaped shape (\\u{...}); the
 * regexes that carry these escapes set the `u` flag.
 */
function rewriteEscapedProperties(source, table) {
  if (source.indexOf(BACKSLASH + BACKSLASH + 'p{') < 0 && source.indexOf(BACKSLASH + BACKSLASH + 'P{') < 0) {
    return source;
  }
  return source.replace(/\\\\([pP])\{([A-Za-z_=]+)\}/g, (whole, kind, name) => {
    const body = table[normalizeName(name)];
    if (!body) return whole;
    const doubled = body.split(BACKSLASH).join(BACKSLASH + BACKSLASH);
    return kind === 'p' ? doubled : '^' + doubled;
  });
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
      // A "source as text" module (*.text.js) exports CODE as a string, and that
      // code is evaluated later — where neither this hook nor the RegExp hook can
      // see it. Next.js's bundled edge-runtime does exactly this (its
      // url.js.text.js carries /[$_\p{ID_Start}]/u, eval'd by load.js), so the
      // ESCAPED form inside the string literal is rewritten here, while it still
      // can be. Only these files get it: for ordinary modules the escaped form is
      // data, not regex source, and must be left alone.
      if (/\.(text|txt)\.js$/.test(filename)) content = rewriteEscapedProperties(content, PROPS_U);
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

  // (c) Code STRINGS evaluated at RUN time — new Function(...) and the vm
  // module. A regex LITERAL inside such a string never passes through _compile,
  // so (a) cannot see it. Both of these run their code in a scope of their own,
  // so rewriting the string changes nothing else. (globalThis.eval is
  // deliberately NOT patched: replacing it turns a caller's DIRECT eval into an
  // indirect one, so the evaluated code loses the caller's scope — measured as
  // "require is not defined in ES module scope" during `next build`. The
  // *.text.js rewrite in (a) covers that path instead.)
  const PROPERTY_MARK = BACKSLASH + 'p{';
  const NEGATED_MARK = BACKSLASH + 'P{';
  function rewriteCode(code) {
    if (typeof code !== 'string') return code;
    if (code.indexOf(PROPERTY_MARK) < 0 && code.indexOf(NEGATED_MARK) < 0) return code;
    return rewriteProperties(code, PROPS_U);
  }

  const OriginalFunction = Function;
  function PatchedFunction(...args) {
    if (args.length) args[args.length - 1] = rewriteCode(String(args[args.length - 1]));
    return Reflect.construct(OriginalFunction, args);
  }
  PatchedFunction.prototype = OriginalFunction.prototype;
  try {
    Object.setPrototypeOf(PatchedFunction, OriginalFunction);
  } catch {
    /* a plain function is still a working constructor */
  }
  globalThis.Function = PatchedFunction;

  try {
    const vm = require('node:vm');
    const OriginalScript = vm.Script;
    class PatchedScript extends OriginalScript {
      constructor(code, options) {
        super(rewriteCode(code), options);
      }
    }
    vm.Script = PatchedScript;
    for (const name of ['compileFunction', 'runInThisContext', 'runInNewContext', 'runInContext']) {
      const original = vm[name];
      if (typeof original !== 'function') continue;
      vm[name] = function patchedVm(first, ...rest) {
        return original.call(this, rewriteCode(first), ...rest);
      };
    }
  } catch {
    /* no vm module here (or a frozen namespace): the other hooks still apply */
  }

  // (d) TextDecoder's ICU-only options. Node built without ICU THROWS
  // ERR_NO_ICU for `new TextDecoder(label, { fatal: true })`, and Next.js's
  // wasm SWC binding does exactly that while loading — so the wasm compiler
  // could never start, and `next build` fell through to downloading a native
  // `@next/swc-android-arm64` binary that does not exist for Android. The
  // wrapper retries without the ICU-only option instead of failing; the only
  // difference is that invalid byte sequences decode to U+FFFD rather than
  // throwing, which is the honest best this platform can do.
  // (d1) The GLOBAL decoder, for code that uses globalThis.TextDecoder.
  const OriginalTextDecoder = globalThis.TextDecoder;
  if (typeof OriginalTextDecoder === 'function' && !OriginalTextDecoder.__mittiWrapped) {
    const Wrapped = wrapTextDecoder(OriginalTextDecoder);
    Wrapped.__mittiWrapped = true;
    try {
      Object.setPrototypeOf(Wrapped, OriginalTextDecoder);
    } catch { /* still a constructor */ }
    globalThis.TextDecoder = Wrapped;
  }
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

  // A function, not a class: ECMA-402 makes Intl constructors callable without
  // `new` (they return a fresh instance), and the client's config reader does
  // exactly that — a class here died with "cannot be invoked without 'new'".
  function DateTimeFormat(locale, options) {
    if (!new.target) return new DateTimeFormat(locale, options);
    this.locale = typeof locale === 'string' && locale ? locale : 'en-US';
    this.options = options && typeof options === 'object' ? options : {};
    warnOnce('Intl', 'substituted a local-time formatter, because this device\'s Node ' + process.versions.node + ' has no ICU');
  }
  DateTimeFormat.prototype.resolvedOptions = function () {
    // Honest: this stand-in formats in the device's own local time and cannot
    // resolve an arbitrary IANA zone (no ICU), so it says 'local' rather than
    // claiming a zone it is not actually using.
    return { locale: this.locale, timeZone: this.options.timeZone || 'local', calendar: 'gregory', numberingSystem: 'latn' };
  };
  DateTimeFormat.prototype.format = function (date) {
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
  };
  DateTimeFormat.prototype.formatToParts = function (date) {
    const d = date instanceof Date ? date : new Date(date === undefined ? Date.now() : date);
    const want = ['year', 'month', 'day'];
    return want.map((type) => ({ type, value: field(d, type) }));
  };
  DateTimeFormat.prototype.formatRange = function (a, b) {
    return `${this.format(a)} – ${this.format(b)}`;
  };

  function NumberFormat(locale) {
    if (!new.target) return new NumberFormat(locale);
    this.locale = locale || 'en-US';
  }
  NumberFormat.prototype.format = function (n) {
    return String(n);
  };
  NumberFormat.prototype.resolvedOptions = function () {
    return { locale: this.locale };
  };

  globalThis.Intl = {
    DateTimeFormat,
    NumberFormat,
    getCanonicalLocales: (l) => (Array.isArray(l) ? l : [l]).filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// 4. Run the heavy client bundle on a WORKER thread, not the main thread
// ---------------------------------------------------------------------------
//
// Measured on arm64 Android (OnePlus 6T, Android 11) with the real ZCode client
// bundle (~15 MB glm/zcode.cjs):
//
//   main thread          -> SIGSEGV, exit 139, zero output, every run
//   worker thread 4 MB   -> clean exit, reaches its own config loading
//   worker thread 8/16/64MB -> clean exit, same
//   --stack-size, ulimit -s -> no effect on the main-thread crash
//
// Desktop x86-64 does not crash at all, and on desktop Node 18 + this shim the
// bundle produces byte-identical output to native Node 22 — so the code and the
// shim are right, and the fault is specific to how the main thread is set up on
// this platform. Running the bundle on a worker thread avoids it.
//
// Scope is deliberately narrow: only a spawn/exec of a script whose path looks
// like the ZCode client bundle, only on Android, and only when the wrapper is
// actually present. Anything else is left completely alone.
const WRAPPER = (() => {
  try {
    const p = require('node:path').join(__dirname, 'mitti-agent-wrapper.cjs');
    return require('node:fs').existsSync(p) ? p : null;
  } catch {
    return null;
  }
})();

// fork() children speak an IPC protocol (process.send / process.on('message')),
// which a plain worker thread cannot provide — they need the fork wrapper.
const FORK_WRAPPER = (() => {
  try {
    const p = require('node:path').join(__dirname, 'mitti-fork-wrapper.cjs');
    return require('node:fs').existsSync(p) ? p : null;
  } catch {
    return null;
  }
})();

// Match the ZCode AGENT bundle by name, tolerating a suffix like
// "zcode-agent.cjs" as well as the shipped "zcode.cjs".
//
// It must NOT match "zcode-server.cjs": that is the long-lived server process,
// and wrapping the server in a worker would break the whole connection. Only
// the agent, which the server spawns per session, is rerouted.
const BUNDLE_RE = /(^|[/\\])zcode(?:[-_.](?!server\b)[^/\\]*)?\.cjs$/;

// Match the agent ENTRY the server spawns per session: the deployed
// `.../server/agents/glm/zcode-agent`. That file is a `#!/bin/sh` wrapper the
// desktop writes (exec "$runtime_root/node" ... zcode.cjs), but on this phone
// spawning it dies with EACCES — it is a vault file the sandbox refuses to
// exec. The fix below never execs it: when the sibling zcode.cjs bundle is
// present, the spawn is rewritten to run the bundle on this process's own node
// (which is already the phone's Node) via the worker wrapper. When the sibling
// is missing the spawn is left alone, so a future layout fails honestly.
const AGENT_BIN_RE = /(^|[/\\])zcode-agent(\.exe)?$/;

// A Jest worker child — the per-file worker processes Next.js's compiler
// spawns. On arm64 Android the wasm-bindgen initialization faults on the
// process main thread (the same SIGSEGV the agent bundle hit), so jest-worker
// children die before their first line: measured as "Jest worker encountered 1
// child process exceptions" with zero stderr on the phone. They go through the
// same worker wrapper, so a build that needs them runs on a worker thread.
const JEST_WORKER_RE = /jest[-_]worker[/\\].*processChild\.c?js$/;

// The COMMAND a Jest worker is spawned as. Next.js forks processChild.js
// directly — it is args[0], not an argument, so it has its own matcher.
const JEST_WORKER_CMD_RE = /processChild\.c?js$/;

function isAndroidArm() {
  // nodejs-mobile reports process.platform === 'android' on the phone. The env
  // var is a fallback for a build that reports 'linux' instead.
  return process.platform === 'android' || process.env.MITTICLOUD_PLATFORM === 'android';
}

if (WRAPPER && isAndroidArm()) {
  const childProcess = require('node:child_process');
  const nodePath = require('node:path');
  const nodeFs = require('node:fs');

  // Given a spawn's (command, args), decide whether it launches the client
  // bundle OR a Jest worker, and if so hand back the launch rewritten to go
  // through the wrapper.
  function redirect(args) {
    if (!Array.isArray(args)) return null;
    const bundleIdx = args.findIndex((a) => typeof a === 'string' && BUNDLE_RE.test(a));
    if (bundleIdx >= 0) {
      // Insert the wrapper immediately before the bundle path, keeping every flag
      // (notably --require for this shim) ahead of it.
      return { args: args.slice(0, bundleIdx).concat([WRAPPER], args.slice(bundleIdx)), reason: 'agent bundle' };
    }
    const jestIdx = args.findIndex((a) => typeof a === 'string' && JEST_WORKER_RE.test(a));
    if (jestIdx >= 0) {
      return { args: args.slice(0, jestIdx).concat([WRAPPER], args.slice(jestIdx)), reason: 'jest-worker child' };
    }
    return null;
  }

  // A fork() child — processChild.js travels as the command, not an argument.
  // It speaks the fork IPC protocol, so it must go through FORK_WRAPPER (which
  // keeps the channel), not the stdio-only agent WRAPPER. fork() takes the
  // script as its first arg (modulePath), so the wrapper becomes the module
  // and the real target becomes the first argument.
  function redirectFork(command, args) {
    if (!FORK_WRAPPER) return null;
    if (typeof command !== 'string' || !JEST_WORKER_CMD_RE.test(command)) return null;
    warnOnce('jest-worker on a worker thread', 'the build\'s compile worker runs on a worker, because on this platform it faults on the main thread');
    return { command: FORK_WRAPPER, args: [command].concat(Array.isArray(args) ? args : []) };
  }

  // Given a spawn's COMMAND, decide whether it is the agent entry the server
  // launches per session — and if its sibling bundle is there, hand back the
  // whole call rewritten to run the bundle on this process's own node through
  // the wrapper. The vault file itself is never executed.
  function redirectCommand(command, args) {
    if (typeof command !== 'string' || !AGENT_BIN_RE.test(command)) return null;
    const bundle = nodePath.join(nodePath.dirname(command), 'zcode.cjs');
    if (!nodeFs.existsSync(bundle)) {
      warnOnce(
        'agent entry without its bundle',
        command + ' has no sibling zcode.cjs — the spawn is left alone and may fail'
      );
      return null;
    }
    warnOnce(
      'agent entry rerouted',
      'spawn of ' + command + ' runs the sibling bundle instead, because vault files cannot be execed here'
    );
    return {
      command: process.execPath,
      args: [WRAPPER, bundle].concat(Array.isArray(args) ? args : []),
    };
  }

  for (const name of ['spawn', 'execFile', 'fork', 'execFileSync']) {
    const original = childProcess[name];
    if (typeof original !== 'function') continue;
    childProcess[name] = function patched(...callArgs) {
      const rerouted = redirectCommand(callArgs[0], callArgs[1]);
      if (rerouted) {
        warnOnce(
          'client bundle on a worker thread',
          'the agent runs on a worker, because on this platform it faults on the main thread'
        );
        return original.call(this, rerouted.command, rerouted.args, ...callArgs.slice(2));
      }
      // A jest-worker fork puts the worker path in the COMMAND, not the args —
      // proven by an instrumentation pass on the phone, where redirect() never
      // saw processChild.js at all.
      const reroutedFork = redirectFork(callArgs[0], callArgs[1]);
      if (reroutedFork) {
        return original.call(this, reroutedFork.command, reroutedFork.args, ...callArgs.slice(2));
      }
      const args = callArgs[1];
      const reroute = redirect(args);
      if (reroute) {
        warnOnce(
          'child on a worker thread',
          reroute.reason + ' runs on a worker, because on this platform it faults on the main thread'
        );
        return original.call(this, callArgs[0], reroute.args, ...callArgs.slice(2));
      }
      return original.apply(this, callArgs);
    };
  }
}

module.exports = sqlite;