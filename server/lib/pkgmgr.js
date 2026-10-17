// Which package manager installs and builds a hosted app.
//
// On a desktop, `npm` from PATH is used — unchanged behaviour.
//
// Inside the Android APK there is NO npm: the nodejs-mobile runtime ships only
// libnode.so, `npm` is not on PATH, and the current npm release SEGFAULTS on
// that runtime. Both were proven on the phone: `npm --version` died with ENOENT,
// and `node npm-cli.js --version` died with SIGSEGV while a bare `node -e` ran
// fine. Yarn 1 does run there — `yarn add lodash` installed the package — so the
// APK bundles Yarn 1 and every install/build/start that would have run `npm`
// runs the bundled Yarn through our own node instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEmbeddedAndroid } from './paths.js';
import { nodeRuntime } from './nodeRuntime.js';
import { spawnRequestFor } from './runner.js';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const SHIM_FILE = path.join(LIB_DIR, 'mitti-node22-shim.cjs');

/**
 * Extra flags for running a JS tool on THIS host's own node. The phone's Node is
 * built without ICU, so any package whose source carries a `\p{...}` regex
 * literal fails to PARSE (Next.js's bundled zod and edge-runtime both do). The
 * shim — which already rewrites those escapes for the client's own servers —
 * fixes it. A host with ICU needs nothing.
 */
function hostNodeFlags() {
  if (process.versions.icu) return [];
  try {
    if (!fs.statSync(SHIM_FILE).isFile()) return [];
  } catch {
    return [];
  }
  return [`--require=${SHIM_FILE}`];
}

/** The app root (where server/, public/ and bundled-yarn/ live side by side). */
export function appRoot() {
  return process.env.MITTICLOUD_APP_ROOT || path.resolve(LIB_DIR, '..', '..');
}

/**
 * The bundled Yarn entry (yarn.js), or null when this build has none. The APK
 * ships it at <app root>/bundled-yarn/yarn/bin/yarn.js, next to server/.
 */
export function bundledYarnPath(root = appRoot()) {
  const p = path.join(root, 'bundled-yarn', 'yarn', 'bin', 'yarn.js');
  try {
    return fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

/** True when installs must go through the bundled Yarn rather than PATH npm. */
export function useBundledYarn() {
  return isEmbeddedAndroid() && Boolean(bundledYarnPath());
}

/** The manager's name, for honest status text in errors. */
export function packageTool() {
  return useBundledYarn() ? 'yarn' : 'npm';
}

/**
 * The extra env a package manager needs. npm and Yarn both want a writable
 * HOME (they keep config and caches there) and a TMPDIR that is not the
 * nonexistent /tmp. An explicitly set value always wins.
 */
export function packageEnv(base, { home = null, cache = null } = {}) {
  const env = { ...base };
  if (!useBundledYarn()) return env;
  if (home && !env.HOME) env.HOME = home;
  if (cache) env.YARN_CACHE_FOLDER = cache;
  env.YARN_IGNORE_PATH = '1'; // never fall back to a PATH yarn/npm
  return env;
}

/**
 * A request that answers the manager's version — the availability probe.
 * @returns {{file:string, args:string[], windowsVerbatimArguments?:boolean}}
 */
export function versionRequest() {
  if (useBundledYarn()) {
    return { file: nodeRuntime(), args: [bundledYarnPath(), '--version'] };
  }
  return spawnRequestFor('npm', ['--version']);
}

/**
 * An install request. `full` installs devDependencies too (a build needs its
 * build tools): npm omits dev by default, Yarn installs them by default, so the
 * production flag is flipped between the two.
 */
export function installRequest({ full = false } = {}) {
  if (useBundledYarn()) {
    return {
      file: nodeRuntime(),
      args: [
        bundledYarnPath(),
        'install',
        '--no-progress',
        '--non-interactive',
        `--production=${full ? 'false' : 'true'}`,
      ],
    };
  }
  return spawnRequestFor('npm', ['install', ...(full ? [] : ['--omit=dev']), '--no-audit', '--no-fund']);
}

/** A request to run one package script (`build`, `start`, ...). */
export function runRequest(script, extraArgs = []) {
  if (useBundledYarn()) {
    return { file: nodeRuntime(), args: [bundledYarnPath(), 'run', script, ...extraArgs] };
  }
  return spawnRequestFor('npm', ['run', script, ...extraArgs]);
}

/** True when a file is a JS entry point node can run (a node shebang, or .js). */
export function looksLikeNodeScript(file) {
  if (/\.(c|m)?js$/i.test(file)) return true;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(96);
    const n = fs.readSync(fd, buf, 0, 96, 0);
    fs.closeSync(fd);
    return /^#![^\n]*\bnode\b/.test(buf.subarray(0, n).toString('utf8'));
  } catch {
    return false;
  }
}

/**
 * A request that runs one of the app's package scripts the way Android allows.
 *
 * A package script like `next build` is run by the manager through the wrapper
 * `node_modules/.bin/next`, and Android REFUSES to execute a file in an app's
 * own writable storage — the build dies with `.bin/next: Permission denied`
 * (measured on the phone). So when the script's tool resolves to a JavaScript
 * entry point, run THAT file on our own node instead of the wrapper; it is what
 * the wrapper does anyway. Falls back to the normal manager request whenever the
 * tool is missing or is a native binary (which must keep its own path).
 */
export function scriptRunRequest(appDir, script, fallback) {
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  } catch {
    return fallback;
  }
  const cmd = pkg && pkg.scripts && typeof pkg.scripts[script] === 'string' ? pkg.scripts[script].trim() : '';
  if (!cmd) return fallback;
  const [head, ...rest] = cmd.split(/\s+/);
  if (!head || head.includes('/') || head.includes('\\')) return fallback; // a path, not a tool name
  let real;
  try {
    real = fs.realpathSync(path.join(appDir, 'node_modules', '.bin', head)); // the wrapper is a symlink on POSIX
    if (!fs.statSync(real).isFile()) return fallback;
  } catch {
    return fallback;
  }
  if (!looksLikeNodeScript(real)) return fallback; // a native tool keeps the normal path
  return { file: nodeRuntime(), args: [...hostNodeFlags(), real, ...rest] };
}