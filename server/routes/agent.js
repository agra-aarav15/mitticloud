// MittiAgent — a background helper that works on a schedule, battery-aware.
//
// The agent is one shared job (not per-id like MittiOps): when enabled, the
// 60s scheduler checks whether scheduleMinutes has elapsed since the last
// attempt and, if the battery is fine, runs one tick (Gemini + small local
// tools — see server/lib/agentRunner.js).
//
// Battery gate: unplugged and below 30% (real reads only; MITTI_FAKE_BATTERY
// overrides for dev/testing) -> manual runs answer {batteryMode:true} so the
// UI can ask "Run anyway?", and scheduled runs defer silently (recorded as a
// {deferred:true} entry at most once per 10 minutes so history stays honest
// without spamming).
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../lib/paths.js';
import { readBattery, isLowBattery } from '../lib/battery.js';
import { runAgentTick, resolveApiKey } from '../lib/agentRunner.js';

const router = Router();

const AGENT_DIR = path.join(DATA_DIR, 'agent');
const CONFIG_FILE = path.join(AGENT_DIR, 'config.json');
const RUNS_FILE = path.join(AGENT_DIR, 'runs.json');
const MAX_RUNS = 20;
const MAX_RUN_TEXT = 2000;
const MAX_INSTRUCTION = 4000;
const MAX_KEY = 256;
const MIN_SCHEDULE = 5;
const MAX_SCHEDULE = 1440; // one day in minutes
const DEFAULT_SCHEDULE = 60;
const TICK_MS = 60 * 1000; // scheduler cadence (same as MittiOps)
const DEFER_RECORD_MS = 10 * 60 * 1000; // one deferred entry per 10 minutes max

// --- storage: data/agent/{config,runs}.json, temp file + rename ---

function ensureAgentDir() {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
}

function atomicWrite(file, obj) {
  ensureAgentDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Read the agent config. Missing/corrupt file -> {}. */
function loadConfig() {
  ensureAgentDir();
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function saveConfig(config) {
  atomicWrite(CONFIG_FILE, config);
}

/** Read the run history (newest first). Missing/corrupt file -> []. */
function loadRuns() {
  ensureAgentDir();
  try {
    const data = JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function recordRun(entry) {
  saveRuns([entry, ...loadRuns()].slice(0, MAX_RUNS));
}

function saveRuns(runs) {
  atomicWrite(RUNS_FILE, runs);
}

const cap = (s) =>
  typeof s === 'string' && s.length > MAX_RUN_TEXT ? s.slice(0, MAX_RUN_TEXT) : s;

/** The status body shared by GET / and PUT /. The key itself never leaves. */
function statusBody(config) {
  return {
    enabled: config.enabled === true,
    hasKey: resolveApiKey(config) !== null,
    instruction: typeof config.instruction === 'string' ? config.instruction : '',
    scheduleMinutes: Number.isInteger(config.scheduleMinutes) ? config.scheduleMinutes : null,
    lastRunAt: typeof config.lastRunAt === 'string' ? config.lastRunAt : null,
  };
}

// --- run one tick, shared by the manual button and the scheduler ---

// One run at a time (manual button and scheduler share this guard).
let inFlight = false;

async function runTickOnce() {
  const out = await runAgentTick(loadConfig());
  if (out.needsKey) return out; // nothing ran — the caller decides what to say

  const at = new Date().toISOString();
  const config = loadConfig();
  config.lastRunAt = at;
  config.lastAttemptAt = at;
  saveConfig(config);
  recordRun({
    at,
    ok: out.ok === true,
    say: typeof out.say === 'string' ? cap(out.say) : null,
    toolCalls: Number.isInteger(out.toolCalls) ? out.toolCalls : 0,
    ms: typeof out.ms === 'number' ? Math.max(0, Math.round(out.ms)) : 0,
    ...(out.error ? { error: cap(String(out.error)) } : {}),
  });
  return out;
}

// --- /api/agent routes ---

router.get('/', (req, res) => {
  res.json(statusBody(loadConfig()));
});

router.put('/', (req, res, next) => {
  try {
    const body = req.body || {};
    const config = loadConfig();

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
      }
      if (body.enabled && config.enabled !== true) {
        // first enable (or re-enable): the schedule counts from now
        config.enabledAt = new Date().toISOString();
      }
      config.enabled = body.enabled;
    }
    if (body.instruction !== undefined) {
      if (typeof body.instruction !== 'string' || body.instruction.trim() === '') {
        return res.status(400).json({ error: 'instruction must be a non-empty string' });
      }
      if (body.instruction.length > MAX_INSTRUCTION) {
        return res
          .status(400)
          .json({ error: `instruction is too long (max ${MAX_INSTRUCTION} characters)` });
      }
      config.instruction = body.instruction;
    }
    if (body.scheduleMinutes !== undefined) {
      const n = Number(body.scheduleMinutes);
      if (!Number.isInteger(n) || n < MIN_SCHEDULE || n > MAX_SCHEDULE) {
        return res.status(400).json({
          error: `scheduleMinutes must be an integer between ${MIN_SCHEDULE} and ${MAX_SCHEDULE}`,
        });
      }
      config.scheduleMinutes = n;
    }
    if (body.key !== undefined) {
      // only overwrite when a non-empty string is given (empty = keep the old key)
      if (typeof body.key !== 'string') {
        return res.status(400).json({ error: 'key must be a string' });
      }
      if (body.key.length > MAX_KEY) {
        return res.status(400).json({ error: `key is too long (max ${MAX_KEY} characters)` });
      }
      const key = body.key.trim();
      if (key !== '') config.key = key;
    }

    if (config.createdAt === undefined) config.createdAt = new Date().toISOString();
    if (!Number.isInteger(config.scheduleMinutes)) config.scheduleMinutes = DEFAULT_SCHEDULE;
    saveConfig(config);
    res.json({ ok: true, ...statusBody(config) });
  } catch (err) {
    next(err);
  }
});

router.post('/run', async (req, res, next) => {
  try {
    if (inFlight) {
      return res.status(409).json({ error: 'Agent is already running' });
    }
    const force = (req.body || {}).force === true;

    // Battery gate: unplugged and low -> do NOT run, ask first (unless forced).
    const battery = await readBattery();
    if (isLowBattery(battery) && !force) {
      return res.json({
        batteryMode: true,
        level: Number(battery.level),
        message: 'Agent work could heat the phone. Run anyway?',
      });
    }

    inFlight = true;
    try {
      const out = await runTickOnce();
      if (out.needsKey) {
        return res.json({ needsKey: true, hint: out.hint });
      }
      return res.json(out);
    } finally {
      inFlight = false;
    }
  } catch (err) {
    next(err);
  }
});

router.get('/runs', (req, res) => {
  res.json({ runs: loadRuns() });
});

// --- scheduler: one interval, runs the agent when due (gate applies) ---

function initAgent(app) {
  app.use('/api/agent', router);

  let lastDeferRecordAt = 0;

  const timer = setInterval(async () => {
    try {
      if (inFlight) return;
      const config = loadConfig();
      if (config.enabled !== true) return;
      if (!resolveApiKey(config)) return; // silent — the panel shows the missing-key chip
      if (typeof config.instruction !== 'string' || config.instruction.trim() === '') return;
      if (
        !Number.isInteger(config.scheduleMinutes) ||
        config.scheduleMinutes < MIN_SCHEDULE ||
        config.scheduleMinutes > MAX_SCHEDULE
      ) {
        return;
      }

      const now = Date.now();
      const anchor =
        Date.parse(config.lastAttemptAt || config.enabledAt || config.createdAt || '') || now;
      if (now - anchor < config.scheduleMinutes * 60 * 1000) return;

      // Battery gate (scheduler flavour): skip silently while unplugged and
      // low. lastAttemptAt is NOT stamped here, so the run happens on the
      // first tick after the phone is charging again.
      const battery = await readBattery();
      if (isLowBattery(battery)) {
        if (now - lastDeferRecordAt >= DEFER_RECORD_MS) {
          lastDeferRecordAt = now;
          recordRun({
            at: new Date().toISOString(),
            deferred: true,
            ok: false,
            say: null,
            toolCalls: 0,
            ms: 0,
            error: `Battery mode — phone on battery at ${Number(battery.level)}%. Agent run deferred until charging.`,
          });
        }
        return;
      }

      inFlight = true;
      try {
        await runTickOnce();
      } finally {
        inFlight = false;
      }
    } catch (err) {
      console.error('[mitticloud] agent scheduler tick failed:', err);
    }
  }, TICK_MS);
  timer.unref?.();

  return timer;
}

export default router;
export { initAgent };
