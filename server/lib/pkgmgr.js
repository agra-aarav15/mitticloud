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