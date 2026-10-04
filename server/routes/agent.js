// Agent Server — the 24/7 agent that lives in MittiCloud.
//
// What it is: chat sessions with a multi-provider brain (Gemini free tier,
// NVIDIA NIM, Groq, OpenCode Zen, or any OpenAI-compatible endpoint — the
// user pastes the key) and real hands (list/read/write files + run commands,
// jailed to the session's workspace folder inside the vault).
//
// What it is NOT: a mock, a demo, or a scheduler. Every message starts a real
// turn that does real work on this device. The phone can be serving 200 web
// visitors and still run the agent — that is the whole point.
//
// Battery law: starting a turn when the device is unplugged and below 30%
// answers {batteryMode:true,...} so the UI can ask "Run anyway?" — same rule
// as tasks and the old gates (force:true overrides).
//
// Lock law: writes here are state-changing, so while a lock token is set the
// global guard requires x-mitti-token — visitors can read the chat, not drive it.
import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, VAULT_DIR, resolveSafe } from '../lib/paths.js';
import { readBattery, isLowBattery } from '../lib/battery.js';
import {
  newId,
  saveSession,
  loadSession,
  deleteSession,
  listSessions,
  bootSweep,
  setKey,
  keyStatus,
} from '../lib/agentStore.js';
import { providerSummaries, providerById } from '../lib/agentProviders.js';
import { runTurn, systemPrompt } from '../lib/agentLoop.js';
import { cliPresetsStatus, presetById, runCliTurn } from '../lib/runner.js';

const router = Router();

const MAX_TEXT = 8000;

// One running turn per session.
const running = new Set();

// One npm install at a time (CLI brains) — real log tail, no faked progress.
let installing = null; // { presetId, startedAt, log: [] }

// --- workspaces: any folder directly inside the vault, plus the vault root ---

async function listWorkspaces() {
  const out = [{ id: '.', label: 'Vault root', abs: VAULT_DIR }];
  try {
    const entries = await fs.readdir(VAULT_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && e.name !== '.tmp') {
        out.push({ id: e.name, label: e.name, abs: path.join(VAULT_DIR, e.name) });
      }
    }
  } catch {
    // vault unreadable — the root entry still works
  }
  return out;
}

async function resolveWorkspace(id) {
  const wsList = await listWorkspaces();
  const ws = wsList.find((w) => w.id === id) || wsList[0];
  return ws;
}

function sessionView(s) {
  return {
    id: s.id,
    title: s.title,
    engine: s.engine === 'cli' ? 'cli' : 'brain',
    providerId: s.providerId || null,
    cliLabel: s.cliLabel || null,
    cliCmd: s.cliCmd || null,
    endpoint: s.endpoint || null,
    model: s.model || null,
    workspace: s.workspace,
    workspaceAbs: s.workspaceAbs,
    running: s.running === true,
    error: s.error || null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messages: Array.isArray(s.messages) ? s.messages : [],
  };
}

// --- routes ---

router.get('/providers', (req, res) => {
  res.json({ providers: providerSummaries(), keys: keyStatus() });
});

router.put('/keys', async (req, res, next) => {
  try {
    const { providerId, key } = req.body || {};
    const preset = providerById(String(providerId || ''));
    if (!preset) return res.status(400).json({ error: 'Unknown provider' });
    if (typeof key !== 'string') return res.status(400).json({ error: 'key must be a string' });
    const trimmed = key.trim();
    if (trimmed.length > 512) return res.status(400).json({ error: 'key is too long' });
    setKey(preset.id, trimmed === '' ? null : trimmed);
    res.json({ ok: true, hasKey: trimmed !== '' });
  } catch (err) {
    next(err);
  }
});

router.get('/workspaces', async (req, res, next) => {
  try {
    res.json({ workspaces: await listWorkspaces() });
  } catch (err) {
    next(err);
  }
});

router.get('/cli/status', async (req, res, next) => {
  try {
    res.json({
      presets: await cliPresetsStatus(),
      installing: installing
        ? { presetId: installing.presetId, startedAt: installing.startedAt, logTail: installing.log.slice(-6) }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/cli/install', async (req, res, next) => {
  try {
    if (installing) {
      return res.status(409).json({ error: 'An install is already running', presetId: installing.presetId });
    }
    const preset = presetById(String((req.body || {}).presetId || ''));
    if (!preset || !preset.install) {
      return res.status(400).json({ error: 'That preset has nothing to install' });
    }
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npmBin, ['i', '-g', preset.pkg], { windowsHide: true });
    installing = { presetId: preset.id, startedAt: new Date().toISOString(), log: [] };
    const push = (buf) => {
      for (const line of String(buf).split(/\r?\n/).filter((l) => l.trim())) {
        installing.log.push(line.slice(0, 200));
      }
      if (installing.log.length > 60) installing.log.splice(0, installing.log.length - 60);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (err) => installing && installing.log.push('npm failed: ' + err.message));
    child.on('close', (code) => {
      if (installing) installing.log.push(`[npm exited with code ${code}]`);
      setTimeout(() => {
        installing = null;
      }, 2000);
    });
    res.json({ started: true, presetId: preset.id, cmd: preset.install });
  } catch (err) {
    next(err);
  }
});

router.get('/sessions', (req, res) => {
  res.json({ sessions: listSessions() });
});

router.post('/sessions', async (req, res, next) => {
  try {
    const body = req.body || {};
    const now = new Date().toISOString();
    let session;
    if (body.engine === 'cli') {
      const cliCmd = typeof body.cliCmd === 'string' ? body.cliCmd.trim() : '';
      if (!cliCmd || cliCmd.length > 300) {
        return res.status(400).json({ error: 'A CLI command with {prompt} in it is required' });
      }
      if (!cliCmd.includes('{prompt}')) {
        return res
          .status(400)
          .json({ error: 'The command needs {prompt} — the message is passed as one safe argument' });
      }
      const ws = await resolveWorkspace(String(body.workspace || '.'));
      session = {
        id: newId(),
        title: 'New session',
        engine: 'cli',
        cliCmd,
        cliLabel: typeof body.cliLabel === 'string' && body.cliLabel.trim() ? body.cliLabel.trim() : 'CLI agent',
        workspace: ws.id,
        workspaceAbs: ws.abs,
        running: false,
        error: null,
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
    } else {
      const preset = providerById(String(body.providerId || 'gemini'));
      if (!preset) return res.status(400).json({ error: 'Unknown provider' });
      const ws = await resolveWorkspace(String(body.workspace || '.'));
      session = {
        id: newId(),
        title: 'New session',
        engine: 'brain',
        providerId: preset.id,
        endpoint:
          typeof body.endpoint === 'string' && body.endpoint.trim() ? body.endpoint.trim() : null,
        model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null,
        workspace: ws.id,
        workspaceAbs: ws.abs,
        running: false,
        error: null,
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
    }
    saveSession(session);
    res.json(sessionView(session));
  } catch (err) {
    next(err);
  }
});

router.get('/sessions/:id', (req, res) => {
  const s = loadSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'No such session' });
  res.json(sessionView(s));
});

router.delete('/sessions/:id', (req, res) => {
  if (running.has(req.params.id)) {
    return res.status(409).json({ error: 'Session is running — wait for it to finish' });
  }
  res.json({ ok: deleteSession(req.params.id) });
});

router.post('/sessions/:id/messages', async (req, res, next) => {
  try {
    const session = loadSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'No such session' });
    if (running.has(session.id)) {
      return res.status(409).json({ error: 'The agent is already working on this session' });
    }
    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'text is required' });
    if (text.length > MAX_TEXT) {
      return res.status(400).json({ error: `Message too long (max ${MAX_TEXT} characters)` });
    }
    const force = body.force === true;

    // Battery gate: unplugged and low -> ask first, same rule as everywhere.
    const battery = await readBattery();
    if (isLowBattery(battery) && !force) {
      return res.json({
        batteryMode: true,
        level: Number(battery.level),
        message: 'Agent work could heat the phone. Run anyway?',
      });
    }

    const now = new Date().toISOString();
    if (session.messages.length === 0) {
      session.title = text.length > 60 ? text.slice(0, 60) + '…' : text;
    }
    session.messages.push({ role: 'user', text, ts: now });
    session.updatedAt = now;
    session.running = true;
    session.error = null;
    saveSession(session);
    running.add(session.id);

    // The turn runs in the background; the phone UI polls the session while
    // this server keeps serving everyone else. persist() writes every step.
    const persist = (s) => {
      s.updatedAt = new Date().toISOString();
      try {
        saveSession(s);
      } catch (err) {
        console.error('[mitticloud] agent session save failed:', err);
      }
    };
    const turn =
      session.engine === 'cli'
        ? runCliTurn(session, persist)
        : runTurn(session, persist);
    turn
      .catch((err) => {
        console.error('[mitticloud] agent turn failed:', err);
        session.messages.push({
          role: 'assistant',
          text: `Agent error: ${String(err?.message || err)}`,
          error: true,
          ts: new Date().toISOString(),
        });
      })
      .finally(() => {
        session.running = false;
        session.updatedAt = new Date().toISOString();
        saveSession(session);
        running.delete(session.id);
      });

    res.json({ started: true });
  } catch (err) {
    next(err);
  }
});

/** Mount on /api/agent + honest boot note about restarted sessions. */
function initAgent(app) {
  const restarted = bootSweep();
  if (restarted > 0) {
    console.log(`[mitticloud] agent: ${restarted} session(s) were mid-turn at last shutdown — marked over`);
  }
  app.use('/api/agent', router);
  return router;
}

export { systemPrompt };
export default router;
export { initAgent };
