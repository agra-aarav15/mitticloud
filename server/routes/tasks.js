// MittiOps — scheduled jobs & webhooks for the pocket cloud, battery-aware.
//
// SECURITY: tasks run owner-written code on the owner's own device. That is
// the exact same trust level as the Sandbox (node -e / python -c via execFile,
// never a shell). Nothing here assumes untrusted callers; do not expose this
// server to the public internet without adding authentication first.
//
// The battery gate: when the phone is really on battery below 30% (mocked
// reads always pass), scheduled and webhook-triggered jobs DO NOT execute —
// they are recorded as {status:'deferred'} and retried by the scheduler once
// the phone is charging again.
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR } from '../lib/paths.js';
import { readBattery, isLowBattery } from '../lib/battery.js';

const execFileP = promisify(execFile);
const tasksRouter = Router();
const hookRouter = Router();

const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const MAX_CODE = 10000;
const TIMEOUT_MS = 10000;
const MAX_BUFFER = 256 * 1024;
const MAX_RUNS = 10;
const MAX_RUN_TEXT = 2000;
const MAX_NAME = 120;
const MIN_EVERY = 1;
const MAX_EVERY = 10080; // one week in minutes
const LANGUAGES = ['js', 'python'];
const TICK_MS = 60 * 1000; // scheduler cadence

// --- storage: data/tasks.json, temp file + rename (never half-written) ---

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** Read all tasks. Missing/corrupt file -> []. */
function loadTasks() {
  ensureDataDir();
  try {
    const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Atomically replace the whole task list. */
function saveTasks(tasks) {
  ensureDataDir();
  const tmp = TASKS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2) + '\n');
  fs.renameSync(tmp, TASKS_FILE);
}

function findTask(tasks, id) {
  return tasks.find((t) => t.id === id) || null;
}

// --- id / validation helpers ---

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function randomId(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Coerce everyMinutes to null (manual/webhook only) or an integer 1..10080. */
function parseEveryMinutes(value) {
  if (value === undefined || value === null || value === '') return { value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_EVERY || n > MAX_EVERY) {
    return { error: `everyMinutes must be an integer between ${MIN_EVERY} and ${MAX_EVERY} (or null for manual)` };
  }
  return { value: n };
}

/** Validate {name, kind, code} fields; returns {error} or nothing. */
function validateCoreFields({ name, kind, code }) {
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim() === '') {
      return { error: 'name must be a non-empty string' };
    }
    if (name.trim().length > MAX_NAME) {
      return { error: `name is too long (max ${MAX_NAME} characters)` };
    }
  }
  if (kind !== undefined && !LANGUAGES.includes(kind)) {
    return { error: "kind must be 'js' or 'python'" };
  }
  if (code !== undefined) {
    if (typeof code !== 'string' || code.trim() === '') {
      return { error: 'code must be a non-empty string' };
    }
    if (code.length > MAX_CODE) {
      return { error: `code is too long (max ${MAX_CODE} characters)` };
    }
  }
  return null;
}

const cap = (s) =>
  typeof s === 'string' && s.length > MAX_RUN_TEXT ? s.slice(0, MAX_RUN_TEXT) : s;

// --- execution (same approach as sandbox: execFile, never shell:true) ---

// Cached result of the python probe: 'python3' | 'python' | false (none).
let pythonBin = null;

async function detectPython() {
  if (pythonBin !== null) return pythonBin;
  const tryBin = async (bin) => {
    try {
      await execFileP(bin, ['--version'], { timeout: 2500 });
      return true;
    } catch (err) {
      // ENOENT: not on PATH. Any other failure means the binary exists.
      return err.code !== 'ENOENT';
    }
  };
  if (await tryBin('python3')) {
    pythonBin = 'python3';
    return pythonBin;
  }
  pythonBin = (await tryBin('python')) ? 'python' : false;
  return pythonBin;
}

/**
 * Run task code once. Returns {status:'ok'|'fail', ms, stdout, error}.
 * Exit code 0 -> ok; non-zero exit or timeout -> fail (stderr in error).
 */
async function runTaskCode(kind, code) {
  const started = Date.now();
  const base = (stdout, error) => ({
    ms: Date.now() - started,
    stdout: cap(stdout || ''),
    error: cap(error || ''),
  });
  try {
    const cmd = kind === 'js' ? 'node' : await detectPython();
    if (!cmd) {
      return { status: 'fail', ...base('', 'Python is not installed on this device') };
    }
    const args = kind === 'js' ? ['-e', code] : ['-c', code];
    const { stdout } = await execFileP(cmd, args, {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return { status: 'ok', ...base(stdout, '') };
  } catch (err) {
    // Killed by our timeout.
    if (err.killed || err.signal === 'SIGTERM' || err.signal === 'SIGKILL') {
      return {
        status: 'fail',
        ...base(err.stdout, `Timed out after ${TIMEOUT_MS / 1000}s — the process was killed. ${err.stderr || ''}`.trim()),
      };
    }
    // Non-zero exit (exception, syntax error) is a normal failed run.
    if (typeof err.stdout === 'string' || typeof err.stderr === 'string') {
      return { status: 'fail', ...base(err.stdout, err.stderr || String(err.message || err)) };
    }
    // Spawn failure (ENOENT etc.).
    return { status: 'fail', ...base('', String(err.message || err)) };
  }
}

// One run at a time per task (manual, webhook and scheduler share this guard).
const inFlight = new Set();

/**
 * Attempt a run, honouring the battery gate. Mutates + persists the task:
 * appends to runs (last 10), updates lastRunAt/lastStatus/lastDurationMs and
 * stamps lastRunAttemptAt so deferred scheduled jobs retry on the next tick.
 * Returns the response body for this attempt.
 */
async function attemptRun(task, { force = false } = {}) {
  const now = new Date().toISOString();

  // Battery gate: real device on battery below 30% -> defer (unless forced).
  const battery = await readBattery();
  if (isLowBattery(battery) && !force) {
    const level = Number(battery.level);
    const entry = {
      at: now,
      status: 'deferred',
      ms: 0,
      error: `Battery mode — phone on battery at ${level}%. Will run when charging.`,
    };
    task.lastRunAttemptAt = now;
    task.lastStatus = 'deferred';
    task.lastRunAt = now;
    task.runs = [entry, ...(task.runs || [])].slice(0, MAX_RUNS);
    saveTasks(loadTasks().map((t) => (t.id === task.id ? task : t)));
    return { ok: true, status: 'deferred', level, error: entry.error };
  }

  const result = await runTaskCode(task.kind, task.code);
  const entry = {
    at: now,
    status: result.status,
    ms: result.ms,
    stdout: result.stdout,
    error: result.error,
  };
  task.lastRunAttemptAt = now;
  task.lastRunAt = now;
  task.lastStatus = result.status;
  task.lastDurationMs = result.ms;
  task.runs = [entry, ...(task.runs || [])].slice(0, MAX_RUNS);
  saveTasks(loadTasks().map((t) => (t.id === task.id ? task : t)));
  return {
    ok: true,
    status: result.status,
    ms: result.ms,
    stdout: result.stdout,
    error: result.error,
  };
}

// --- /api/tasks routes ---

tasksRouter.get('/', (req, res) => {
  // code is included on purpose: the dashboard needs it for inline editing.
  res.json({ tasks: loadTasks() });
});

tasksRouter.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const invalid = validateCoreFields(body);
    if (invalid) return res.status(400).json(invalid);
    const every = parseEveryMinutes(body.everyMinutes);
    if (every.error) return res.status(400).json({ error: every.error });

    const task = {
      id: randomId(12),
      name: body.name.trim(),
      kind: body.kind,
      code: body.code,
      everyMinutes: every.value,
      webhookId: randomId(6),
      enabled: true,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      lastRunAttemptAt: null,
      lastStatus: null,
      lastDurationMs: null,
      runs: [],
    };
    saveTasks([...loadTasks(), task]);
    res.status(201).json({ task });
  } catch (err) {
    next(err);
  }
});

tasksRouter.patch('/:id', async (req, res, next) => {
  try {
    const tasks = loadTasks();
    const task = findTask(tasks, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const body = req.body || {};
    const invalid = validateCoreFields(body);
    if (invalid) return res.status(400).json(invalid);
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    if (body.everyMinutes !== undefined) {
      const every = parseEveryMinutes(body.everyMinutes);
      if (every.error) return res.status(400).json({ error: every.error });
    }

    if (body.name !== undefined) task.name = body.name.trim();
    if (body.kind !== undefined) task.kind = body.kind;
    if (body.code !== undefined) task.code = body.code;
    if (body.everyMinutes !== undefined) task.everyMinutes = parseEveryMinutes(body.everyMinutes).value;
    if (body.enabled !== undefined) task.enabled = body.enabled;
    saveTasks(tasks);
    res.json({ task });
  } catch (err) {
    next(err);
  }
});

tasksRouter.delete('/:id', (req, res) => {
  const tasks = loadTasks();
  const task = findTask(tasks, req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  saveTasks(tasks.filter((t) => t.id !== task.id));
  res.json({ ok: true });
});

tasksRouter.get('/:id/runs', (req, res) => {
  const task = findTask(loadTasks(), req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ runs: task.runs || [] });
});

tasksRouter.post('/:id/run', async (req, res, next) => {
  try {
    const tasks = loadTasks();
    const task = findTask(tasks, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!task.enabled) {
      return res.status(409).json({ error: 'Task is disabled' });
    }
    if (inFlight.has(task.id)) {
      return res.status(409).json({ error: 'Task is already running' });
    }
    const force = (req.body || {}).force === true;
    // Manual runs ask first: a real device on low battery gets the same
    // "could heat the phone" gate as the sandbox and the agent (the
    // scheduler keeps its silent defer — nobody is watching at 3am).
    const battery = await readBattery();
    if (isLowBattery(battery) && !force) {
      return res.json({
        batteryMode: true,
        level: Number(battery.level),
        message: 'Task work could heat the phone. Run anyway?',
      });
    }
    inFlight.add(task.id);
    try {
      const out = await attemptRun(task, { force });
      return res.json(out);
    } finally {
      inFlight.delete(task.id);
    }
  } catch (err) {
    next(err);
  }
});

// --- webhook trigger: POST /hook/<webhookId> (plain curl friendly) ---

hookRouter.post('/:webhookId', async (req, res, next) => {
  try {
    const task = loadTasks().find((t) => t.webhookId === req.params.webhookId);
    if (!task) return res.status(404).json({ error: 'Unknown webhook' });
    if (!task.enabled) {
      return res.status(409).json({ ok: false, error: 'Task is disabled' });
    }
    if (inFlight.has(task.id)) {
      return res.status(409).json({ ok: false, error: 'Task is already running' });
    }
    inFlight.add(task.id);
    try {
      const out = await attemptRun(task, {});
      return res.json(out);
    } finally {
      inFlight.delete(task.id);
    }
  } catch (err) {
    next(err);
  }
});

// --- scheduler: one interval, due enabled tasks run (gate applies) ---

function initTasks(app) {
  app.use('/api/tasks', tasksRouter);
  app.use('/hook', hookRouter);

  const timer = setInterval(async () => {
    try {
      const tasks = loadTasks();
      const now = Date.now();
      for (const task of tasks) {
        if (!task.enabled || !Number.isInteger(task.everyMinutes)) continue;
        if (inFlight.has(task.id)) continue;
        const anchor = Date.parse(task.lastRunAttemptAt || task.createdAt || '') || now;
        if (now - anchor < task.everyMinutes * 60 * 1000) continue;
        inFlight.add(task.id);
        try {
          // attemptRun stamps lastRunAttemptAt even when deferred, so a task
          // left due while on battery retries every tick until charging.
          await attemptRun(task, {});
        } catch (err) {
          console.error('[mitticloud] scheduled task failed:', task.id, err);
        } finally {
          inFlight.delete(task.id);
        }
      }
    } catch (err) {
      console.error('[mitticloud] task scheduler tick failed:', err);
    }
  }, TICK_MS);
  timer.unref?.();

  return timer;
}

export default tasksRouter;
export { initTasks, hookRouter };
