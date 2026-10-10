// Live app runner — MittiCloud hosts real Node.js apps, not just static sites.
// Each app is a folder in the vault (vault/files/apps/<name>/) so the Files tab
// and the code editor reach its files like any other file. The runner:
//   - detects the entry file (package.json main / scripts.start / common names)
//   - scans a free port in 7401-7499 and hands it to the app as PORT
//   - waits until the app answers HTTP (any answer counts — it is listening)
//   - keeps the last 200 log lines, restarts crashes with backoff (x3)
//   - enforces an honest RAM guard: no new starts under 300 MB free,
//     optional per-app cap kills an app that eats past its allowance
// State lives in memory; the REGISTRY (data/apps.json) persists config.
// Children die with the server (exit hook) — an app is never orphaned.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { DATA_DIR, FILES_DIR, PathError } from './paths.js';
import { spawnRequestFor } from './runner.js';
import { classifyProject } from './buildqueue.js';
import { fileURLToPath } from 'node:url';

const STATIC_SERVER = fileURLToPath(new URL('./staticServe.js', import.meta.url));

export const APPS_DIR = path.join(FILES_DIR, 'apps');
export const REGISTRY_FILE = path.join(DATA_DIR, 'apps.json');
const PORT_MIN = 7401;
const PORT_MAX = 7499;
const START_TIMEOUT_MS = 5000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const LOG_CAP = 200;
const MIN_FREE_MB_TO_START = 300;
const RESTART_BACKOFF_MS = [1000, 3000, 9000];
const MB = 1024 * 1024;

// states: 'stopped' | 'starting' | 'running' | 'crashed'
const live = new Map(); // name -> { child, state, port, logs[], attempts, desiredStop, startedAt, ramMB, ramReadAt, installLog }

export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.status = status;
  }
}

const NAME_RE = /^[a-z0-9-]{1,32}$/;

export function validName(name) {
  const n = String(name || '').trim();
  if (!NAME_RE.test(n)) {
    throw new AppError('Name can use lowercase letters, digits and dashes (max 32)');
  }
  if (n === 'apps') {
    throw new AppError('That name is reserved');
  }
  return n;
}

// --- registry (atomic temp+rename, same law as every other data file) ---

export function readRegistry() {
  try {
    const j = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    return Array.isArray(j.apps) ? j.apps : [];
  } catch {
    return [];
  }
}

function writeRegistry(apps) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = REGISTRY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ apps }, null, 2) + '\n');
  fs.renameSync(tmp, REGISTRY_FILE);
}

export function getRecord(name) {
  return readRegistry().find((a) => a.name === name) || null;
}

function putRecord(record) {
  const apps = readRegistry().filter((a) => a.name !== record.name);
  apps.push(record);
  writeRegistry(apps);
  return record;
}

// --- entry detection ---

/** Pick the entry file for an app dir. Returns { entry, how } or null. */
export function detectEntry(dirAbs) {
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dirAbs, 'package.json'), 'utf8'));
  } catch {
    /* no package.json — fall through to filename heuristics */
  }
  if (pkg && typeof pkg.main === 'string' && pkg.main.trim()) {
    const main = pkg.main.trim().replace(/\\/g, '/');
    if (fs.existsSync(path.join(dirAbs, main))) return { entry: main, how: 'package.json main' };
  }
  if (pkg && typeof pkg.scripts?.start === 'string') {
    const m = pkg.scripts.start.match(/^node\s+(\S+)$/);
    if (m && fs.existsSync(path.join(dirAbs, m[1]))) return { entry: m[1], how: 'npm start' };
  }
  for (const name of ['index.js', 'server.js', 'app.js', 'main.js']) {
    if (fs.existsSync(path.join(dirAbs, name))) return { entry: name, how: 'common name' };
  }
  // a lone .js file at the root is unambiguous enough to run
  try {
    const roots = fs.readdirSync(dirAbs).filter((f) => f.endsWith('.js') && !f.endsWith('.config.js'));
    if (roots.length === 1) return { entry: roots[0], how: 'only .js file' };
  } catch {
    /* gone */
  }
  return null;
}

// --- ports ---

// Windows' SO_REUSEADDR lets a bind probe "succeed" on a port another process
// is already listening on — so a port is only free when BOTH checks agree:
// a connect attempt (the reliable Windows signal) and a bind probe (which
// catches listeners connect cannot reach, and behaves properly on Linux).
function portInUseByConnect(port) {
  const tryOnce = (host) =>
    new Promise((resolve) => {
      const sock = net.connect({ port, host });
      const done = (inUse) => {
        sock.destroy();
        resolve(inUse);
      };
      sock.setTimeout(300, () => done(false));
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
  return (async () => {
    if (await tryOnce('127.0.0.1')) return true;
    return await tryOnce('::1');
  })();
}

function portFreeByBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    const timer = setTimeout(() => {
      srv.close();
      resolve(false);
    }, 400);
    srv.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    srv.once('listening', () => {
      clearTimeout(timer);
      srv.close(() => resolve(true));
    });
    srv.listen(port); // no host — exactly how a typical app binds server.listen(PORT)
  });
}

function scanFreePort() {
  return new Promise((resolve, reject) => {
    let port = PORT_MIN;
    const tryNext = async () => {
      while (port <= PORT_MAX) {
        const probe = port++;
        if (await portInUseByConnect(probe)) continue;
        if (await portFreeByBind(probe)) return resolve(probe);
      }
      reject(new AppError(`No free port in ${PORT_MIN}-${PORT_MAX} — stop an app first`));
    };
    tryNext();
  });
}

// --- env ---

// The parent's own secrets (lock token, agent keys, anything secret-shaped)
// never reach an app process. Env vars the OWNER set for this app are added
// deliberately on top — that is the feature.
const SECRET_RE = /TOKEN|KEY|SECRET|PASSWORD|MITTI_FAKE/i;
export function buildEnv(appEnv, port) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!SECRET_RE.test(k)) env[k] = v;
  }
  env.PORT = String(port);
  for (const [k, v] of Object.entries(appEnv || {})) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = String(v);
  }
  return env;
}

// --- logs ---

function pushLog(state, line) {
  state.logs.push(`${new Date().toISOString()} ${line}`);
  if (state.logs.length > LOG_CAP) state.logs.splice(0, state.logs.length - LOG_CAP);
}

// --- RAM (best-effort, never a guess — null means "unreadable here") ---

function readRamMB(pid) {
  if (process.platform === 'linux' || process.platform === 'android') {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
      if (m) return Math.round(Number(m[1]) / 1024);
    } catch {
      return null;
    }
  }
  return null; // other platforms: honest "—" rather than a guess
}

// --- the engine ---

function assertDir(name) {
  const dirAbs = path.join(APPS_DIR, name);
  if (!fs.existsSync(dirAbs)) {
    throw new AppError(`App folder not found: apps/${name}`, 404);
  }
  return dirAbs;
}

async function waitForHttp(port, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(400) });
      res.body?.cancel?.().catch(() => {});
      return true; // any HTTP answer means the server is up
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

/** Start (or restart) an app. Resolves { port, entry } once it is serving. */
export async function startApp(name, { force = false } = {}) {
  validName(name);
  const rec = getRecord(name);
  const dirAbs = assertDir(name);

  const existing = live.get(name);
  // 'starting' with a live child means a start is genuinely in flight; a
  // 'starting' state whose child already died is the restart ladder waiting —
  // that call must fall through and respawn, not answer "already".
  if (
    existing &&
    (existing.state === 'running' || (existing.state === 'starting' && existing.child))
  ) {
    return { port: existing.port, entry: existing.entry, already: true };
  }

  const mem = {
    freeMB: Math.round(os.freemem() / MB),
    totalMB: Math.round(os.totalmem() / MB),
  };
  if (!force && mem.freeMB < MIN_FREE_MB_TO_START) {
    throw new AppError(
      `Only ${mem.freeMB} MB free RAM — the phone needs ${MIN_FREE_MB_TO_START} MB to spare. ` +
        `Stop something else first, plug in power, or start anyway.`,
      507
    );
  }

  const profile = classifyProject(dirAbs);
  const detected = detectEntry(dirAbs);
  const entry = (rec && rec.entry) || (detected && detected.entry);
  if (profile.startKind !== 'next' && profile.startKind !== 'static') {
    if (!entry) {
      throw new AppError(
        'No entry file found — add package.json with a "main", or an index.js / server.js / app.js'
      );
    }
    if (!fs.existsSync(path.join(dirAbs, entry))) {
      throw new AppError(`Entry file missing: ${entry}`, 404);
    }
  }

  const port = await scanFreePort();
  const state = {
    child: null,
    state: 'starting',
    port,
    entry,
    logs: [],
    // the crash ladder (x3) must survive the respawn: a ladder restart lands
    // here with state 'starting' and no child, and its attempt count carries
    attempts: existing && existing.state === 'starting' ? existing.attempts : 0,
    desiredStop: false,
    startedAt: Date.now(),
    ramMB: null,
    ramReadAt: 0,
    installLog: existing ? existing.installLog : '',
  };
  live.set(name, state);
  const label =
    profile.startKind === 'next'
      ? 'npm start (next)'
      : profile.startKind === 'static'
        ? `static ${profile.outputDir}/`
        : `node ${entry}`;
  pushLog(state, `starting ${label} on port ${port}`);

  // node.exe is a real executable — spawn it DIRECTLY (the cmd.exe shim in
  // runner.js is only for .cmd shims like npm, and an absolute execPath with
  // spaces ("C:\Program Files\...") does not survive the cmd quoting round-trip)
  let child;
  const childEnv = buildEnv(rec && rec.env, port);
  if (profile.startKind === 'next') {
    const req = spawnRequestFor('npm', ['start']);
    child = spawn(req.file, req.args, {
      cwd: dirAbs,
      env: childEnv,
      windowsHide: true,
      windowsVerbatimArguments: Boolean(req.windowsVerbatimArguments),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else if (profile.startKind === 'static') {
    child = spawn(process.execPath, [STATIC_SERVER, path.join(dirAbs, profile.outputDir)], {
      cwd: dirAbs,
      env: childEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    child = spawn(process.execPath, [entry], {
      cwd: dirAbs,
      env: childEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  state.child = child;

  child.stdout.on('data', (c) =>
    String(c)
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((l) => pushLog(state, l))
  );
  child.stderr.on('data', (c) =>
    String(c)
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((l) => pushLog(state, l))
  );

  child.once('exit', (code, signal) => {
    const wasStarting = state.state === 'starting';
    state.child = null;
    state.ramMB = null;
    if (state.desiredStop) {
      state.state = 'stopped';
      pushLog(state, 'stopped');
      return;
    }
    pushLog(state, `exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`);
    // a crash within 60s of start counts toward the backoff ladder
    if (Date.now() - state.startedAt < 60000 && state.attempts < RESTART_BACKOFF_MS.length) {
      const delay = RESTART_BACKOFF_MS[state.attempts];
      state.attempts += 1;
      state.state = 'starting';
      pushLog(state, `restart ${state.attempts}/${RESTART_BACKOFF_MS.length} in ${delay} ms`);
      setTimeout(() => {
        if (state.desiredStop || live.get(name) !== state) return;
        startApp(name, { force: true }).catch(() => {});
      }, delay);
      return;
    }
    state.state = 'crashed';
    if (wasStarting) {
      pushLog(state, 'the app exited before it answered — the logs above usually say why');
    }
  });

  const up = await waitForHttp(port, START_TIMEOUT_MS);
  if (state.desiredStop) return { port, entry, stopped: true };
  // a "yes" from the port only counts if OUR child is still the one alive —
  // an answer could come from another process that holds the port (proven in
  // the gate: a v6/ipv4 bind gap let a sibling app answer for a dead child)
  const childAlive = state.child && state.child.exitCode == null && state.child.signalCode == null;
  if (up && childAlive) {
    state.state = 'running';
    state.attempts = 0;
    pushLog(state, `serving on http://127.0.0.1:${port}`);
  } else if (state.child) {
    // alive but silent — kill it and say so honestly
    state.state = 'crashed';
    pushLog(state, `no answer on port ${port} within 5 s — stopped waiting`);
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    throw new AppError(
      `The app did not answer on port ${port} within 5 s. It may listen on a fixed port — ` +
        `make it read process.env.PORT. Its output is in the logs.`,
      504
    );
  } else {
    // the process already exited: the exit handler recorded the crash and may
    // be retrying — surface the honest error, leave the ladder alone
    throw new AppError(
      `The app exited before answering on port ${port}. Its output is in the logs — ` +
        `the last lines usually say why.`,
      504
    );
  }
  return { port, entry };
}

export function stopApp(name) {
  validName(name);
  const state = live.get(name);
  if (!state || !state.child) {
    if (state) state.state = 'stopped';
    return { stopped: true, wasRunning: false };
  }
  state.desiredStop = true;
  state.state = 'stopped';
  try {
    state.child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      if (state.child) state.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, 3000).unref();
  return { stopped: true, wasRunning: true };
}

export async function restartApp(name) {
  stopApp(name);
  // give the old process a beat to release the port
  await new Promise((r) => setTimeout(r, 700));
  return startApp(name, { force: true });
}

export function appState(name) {
  const state = live.get(name);
  if (!state) return { state: 'stopped', port: null, logs: [] };
  return { state: state.state, port: state.port, entry: state.entry, logs: state.logs };
}

export function appLogs(name) {
  const state = live.get(name);
  return state ? state.logs : [];
}

export function installLog(name) {
  const state = live.get(name);
  return state ? state.installLog || '' : '';
}

// --- npm install (runs on the deployment, with a live log) ---

export function npmInstallAvailable() {
  return new Promise((resolve) => {
    const req = spawnRequestFor('npm', ['--version']);
    const child = spawn(req.file, req.args, {
      windowsHide: true,
      windowsVerbatimArguments: Boolean(req.windowsVerbatimArguments),
      stdio: 'ignore',
    });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

/**
 * Run an npm command in the app dir and stream it into the install log.
 * `full` installs dev dependencies too — a build needs its build tools.
 */
export function runNpmInstall(name, { full = false, args = null } = {}) {
  validName(name);
  const dirAbs = assertDir(name);
  const state = live.get(name) || { logs: [], installLog: '' };
  live.set(name, state); // so installLog() finds it even before a first start
  const npmArgs = args || ['install', ...(full ? [] : ['--omit=dev']), '--no-audit', '--no-fund'];
  return new Promise((resolve) => {
    const req = spawnRequestFor('npm', npmArgs);
    const child = spawn(req.file, req.args, {
      cwd: dirAbs,
      windowsHide: true,
      windowsVerbatimArguments: Boolean(req.windowsVerbatimArguments),
      env: buildEnv(null, 0),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const grow = (c) => {
      out += c.toString('utf8');
      if (out.length > 20000) out = out.slice(-20000);
      state.installLog = out;
    };
    child.stdout.on('data', grow);
    child.stderr.on('data', grow);
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
      resolve({
        ok: false,
        log: out,
        error: 'npm install timed out after 5 minutes — check the internet connection and try again',
      });
    }, INSTALL_TIMEOUT_MS);
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, log: out, error: `npm could not start: ${err.message}` });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, log: out });
      else
        resolve({
          ok: false,
          log: out,
          error: `npm install exited with code ${code} — read the install log for the real error`,
        });
    });
  });
}

/** `npm run build` in the app dir, streamed into the install log. */
export function runNpmBuild(name) {
  return runNpmInstall(name, { full: true, args: ['run', 'build'] });
}

// --- listing / resources ---

function statTree(dirAbs) {
  let bytes = 0;
  let files = 0;
  const stack = [dirAbs];
  while (stack.length) {
    const cur = stack.pop();
    let dirents;
    try {
      dirents = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of dirents) {
      if (ent.isSymbolicLink()) continue;
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) {
        try {
          bytes += fs.statSync(full).size;
          files++;
        } catch {
          /* raced */
        }
      }
    }
  }
  return { bytes, files };
}

/** Registry rows merged with live state + honest disk/ram numbers. */
// The deploy step a project is in right now, or its failure: 'waiting' |
// 'installing' | 'building' | 'starting' | 'failed:<step>' | null (idle).
const deployStep = new Map(); // name -> string

export function setDeployStep(name, step) {
  if (step) deployStep.set(name, step);
  else deployStep.delete(name);
}

export function listApps() {
  const now = Date.now();
  return readRegistry().map((rec) => {
    const state = live.get(rec.name);
    const dirAbs = path.join(APPS_DIR, rec.name);
    const onDisk = fs.existsSync(dirAbs) ? statTree(dirAbs) : { bytes: 0, files: 0 };
    let ramMB = null;
    if (state && state.child && state.state === 'running') {
      if (now - state.ramReadAt > 10000) {
        state.ramMB = readRamMB(state.child.pid);
        state.ramReadAt = now;
      }
      ramMB = state.ramMB;
    }
    const detected = fs.existsSync(dirAbs) ? detectEntry(dirAbs) : null;
    return {
      name: rec.name,
      entry: rec.entry || (detected && detected.entry) || null,
      entryAuto: detected ? detected.how : null,
      port: state ? state.port : rec.port || null,
      url: state && state.port ? `http://127.0.0.1:${state.port}` : null,
      state: state ? state.state : 'stopped',
      runOnBoot: Boolean(rec.runOnBoot),
      ramCapMB: rec.ramCapMB || null,
      env: rec.env || {},
      ramMB,
      bytes: onDisk.bytes,
      fileCount: onDisk.files,
      createdAt: rec.createdAt || null,
      updatedAt: rec.updatedAt || null,
      deployStep: deployStep.get(rec.name) || null,
    };
  });
}

// --- RAM monitor (cap enforcement; lazy timer while apps run) ---

let monitorTimer = null;

function ensureMonitor() {
  if (monitorTimer) return;
  monitorTimer = setInterval(() => {
    let anyRunning = false;
    for (const rec of readRegistry()) {
      const state = live.get(rec.name);
      if (!state || state.state !== 'running' || !state.child) continue;
      anyRunning = true;
      state.ramMB = readRamMB(state.child.pid);
      state.ramReadAt = Date.now();
      if (rec.ramCapMB && state.ramMB != null && state.ramMB > rec.ramCapMB) {
        pushLog(
          state,
          `killed: using ${state.ramMB} MB, over its ${rec.ramCapMB} MB cap`
        );
        state.child.kill('SIGKILL');
        state.desiredStop = true; // a cap kill is final — restarting a memory hog helps nobody
        state.state = 'crashed';
      }
    }
    if (!anyRunning && monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
  }, 10000);
  monitorTimer.unref?.();
}

// --- boot + shutdown ---

/** Start every app with runOnBoot. Called once when the server boots. */
export async function initApps() {
  fs.mkdirSync(APPS_DIR, { recursive: true });
  const bootable = readRegistry().filter((a) => a.runOnBoot);
  for (const rec of bootable) {
    try {
      await startApp(rec.name, { force: true });
      console.log(`[mitticloud] app started: ${rec.name}`);
    } catch (err) {
      console.log(`[mitticloud] app failed to start: ${rec.name} — ${err.message}`);
    }
  }
  ensureMonitor();
}

/** Kill every child — the server's exit hook calls this. Sync, best-effort. */
export function stopAllApps() {
  for (const [name, state] of live) {
    if (state.child) {
      try {
        state.child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }
    if (state) {
      state.state = 'stopped';
      pushLog(state, 'stopped (server shut down)');
    }
  }
}

// --- registry mutations used by the routes ---

export function createApp(name) {
  validName(name);
  const dirAbs = path.join(APPS_DIR, name);
  if (fs.existsSync(dirAbs)) {
    throw new AppError(`An app called ${name} already exists`, 409);
  }
  if (getRecord(name)) {
    throw new AppError(`An app called ${name} is already registered`, 409);
  }
  fs.mkdirSync(dirAbs, { recursive: true });
  const now = new Date().toISOString();
  putRecord({ name, entry: null, env: {}, runOnBoot: false, ramCapMB: null, createdAt: now, updatedAt: now });
  ensureMonitor();
  return getRecord(name);
}

export function updateApp(name, patch) {
  validName(name);
  const rec = getRecord(name);
  if (!rec) throw new AppError(`Unknown app: ${name}`, 404);
  if (patch.entry !== undefined) {
    if (patch.entry === null || patch.entry === '') rec.entry = null;
    else if (typeof patch.entry === 'string' && !patch.entry.includes('..') && !path.isAbsolute(patch.entry)) {
      rec.entry = patch.entry.replace(/\\/g, '/');
    } else throw new AppError('entry must be a relative file path');
  }
  if (patch.env !== undefined) {
    if (typeof patch.env !== 'object' || patch.env === null || Array.isArray(patch.env)) {
      throw new AppError('env must be an object of key/value strings');
    }
    const clean = {};
    for (const [k, v] of Object.entries(patch.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        throw new AppError(`Env names use letters, digits and underscores: ${k}`);
      }
      clean[k] = String(v);
    }
    rec.env = clean;
  }
  if (patch.runOnBoot !== undefined) rec.runOnBoot = Boolean(patch.runOnBoot);
  if (patch.ramCapMB !== undefined) {
    if (patch.ramCapMB === null) rec.ramCapMB = null;
    else {
      const n = Number(patch.ramCapMB);
      if (!Number.isFinite(n) || n < 32) throw new AppError('ramCapMB must be a number (MB, at least 32)');
      rec.ramCapMB = Math.round(n);
    }
  }
  rec.updatedAt = new Date().toISOString();
  putRecord(rec);
  return rec;
}

export async function deleteApp(name) {
  validName(name);
  stopApp(name);
  const dirAbs = path.join(APPS_DIR, name);
  // a dying child holds its cwd as an open handle on Windows — wait for the
  // exit, then retry the removal; the registry row goes either way
  const state = live.get(name);
  const deadline = Date.now() + 3000;
  while (state && state.child && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  let folderRemoved = true;
  for (let i = 0; i < 12; i++) {
    try {
      fs.rmSync(dirAbs, { recursive: true, force: true });
      folderRemoved = true;
      break;
    } catch (err) {
      folderRemoved = false;
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(err.code) || i === 11) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  writeRegistry(readRegistry().filter((a) => a.name !== name));
  live.delete(name);
  return { deleted: true, folderRemoved };
}
