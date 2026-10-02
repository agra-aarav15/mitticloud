// POST /api/sandbox/run — run a short code snippet on the device.
// Body: { language: 'js' | 'python', code: string, confirm?: boolean }.
// execFile only (never shell:true), 5s timeout, 256 KiB output cap.
// Battery mode: unplugged and below 30% -> ask before running (MITTI_FAKE_BATTERY
// overrides the real battery readout for dev/testing).
import { Router } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getBattery } from '../lib/termux.js';

const execFileP = promisify(execFile);
const router = Router();

const MAX_CODE = 20000;
const TIMEOUT_MS = 5000;
const MAX_BUFFER = 256 * 1024;
const LANGUAGES = ['js', 'python'];

// Cached result of the python probe: 'python3' | 'python' | false (none).
let pythonBin = null;

function tryPython(bin) {
  return execFileP(bin, ['--version'], { timeout: 2500 }).then(
    () => true,
    (err) => {
      // ENOENT: not on PATH. Any other failure (bad exit code, timeout)
      // means the binary exists but misbehaved -> still counts as installed.
      return err.code !== 'ENOENT';
    }
  );
}

async function detectPython() {
  if (pythonBin !== null) return pythonBin;
  if (await tryPython('python3')) {
    pythonBin = 'python3';
    return pythonBin;
  }
  pythonBin = (await tryPython('python')) ? 'python' : false;
  return pythonBin;
}

// Battery readout for the gate. The env hook wins when set; malformed JSON
// counts as "no battery data" so a broken hook never bricks the sandbox.
async function readBattery() {
  const fake = process.env.MITTI_FAKE_BATTERY;
  if (fake) {
    try {
      return JSON.parse(fake);
    } catch {
      return null;
    }
  }
  try {
    return await getBattery();
  } catch {
    return null;
  }
}

async function runSnippet(cmd, args) {
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileP(cmd, args, {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return {
      stdout: stdout || '',
      stderr: stderr || '',
      durationMs: Date.now() - started,
      timedOut: false,
    };
  } catch (err) {
    // Killed by our timeout -> 200 with timedOut: true.
    if (err.killed || err.signal === 'SIGTERM' || err.signal === 'SIGKILL') {
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || '',
        durationMs: Date.now() - started,
        timedOut: true,
      };
    }
    // Non-zero exit (exception, syntax error) is still a valid run.
    if (typeof err.stdout === 'string' || typeof err.stderr === 'string') {
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || '',
        durationMs: Date.now() - started,
        timedOut: false,
      };
    }
    throw err; // spawn failure (ENOENT etc.) -> 500 via error handler
  }
}

router.post('/run', async (req, res, next) => {
  const { language, code, confirm } = req.body || {};

  if (!LANGUAGES.includes(language)) {
    return res.status(400).json({ error: "language must be 'js' or 'python'" });
  }
  if (typeof code !== 'string' || code.trim() === '') {
    return res.status(400).json({ error: 'code must be a non-empty string' });
  }
  if (code.length > MAX_CODE) {
    return res.status(400).json({ error: `code is too long (max ${MAX_CODE} characters)` });
  }
  if (confirm !== undefined && typeof confirm !== 'boolean') {
    return res.status(400).json({ error: 'confirm must be a boolean' });
  }

  // Battery gate: on battery and low -> do NOT execute, ask first.
  const battery = await readBattery();
  if (
    battery &&
    !battery.mocked &&
    !battery.charging &&
    Number(battery.level) < 30 &&
    confirm !== true
  ) {
    return res.json({
      batteryMode: true,
      level: battery.level,
      charging: false,
      message: `Phone is on battery (${battery.level}%). Heavy work could heat it up — run anyway?`,
    });
  }

  try {
    if (language === 'js') {
      const result = await runSnippet('node', ['-e', code]);
      return res.json(result);
    }
    const bin = await detectPython();
    if (!bin) {
      return res.status(400).json({ error: 'Python is not installed on this device' });
    }
    const result = await runSnippet(bin, ['-c', code]);
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
