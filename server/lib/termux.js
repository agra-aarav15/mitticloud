// Termux detection + battery/storage with graceful fallbacks.
// On a desktop (no Termux) every value degrades to mocked: true so the
// dashboard still works for development and demos.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';

const execFileP = promisify(execFile);

// Cached detection promise — the check is cheap but not free, and the
// answer cannot change while the process runs.
let termuxPromise = null;

function envLooksTermux() {
  const prefix = process.env.PREFIX || '';
  return prefix.includes('com.termux');
}

/**
 * True when running inside Termux (PREFIX contains com.termux) or when a
 * termux-battery-status command resolves on PATH. Result is cached.
 */
export function isTermux() {
  if (!termuxPromise) {
    termuxPromise = (async () => {
      if (envLooksTermux()) return true;
      try {
        await execFileP('termux-battery-status', [], { timeout: 3000 });
        return true;
      } catch (err) {
        // ENOENT: not on PATH -> not Termux. Any other failure means the
        // command exists (Termux-like) but errored; still treat as Termux.
        return err.code !== 'ENOENT';
      }
    })().catch(() => false);
  }
  return termuxPromise;
}

/**
 * Real battery read on Windows via WMI. Resolves { present:false } on a
 * desktop without a battery (it runs on AC — that is the truth, there is
 * nothing to invent). Throws when PowerShell fails outright.
 */
async function getWindowsBattery() {
  const { stdout } = await execFileP(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$b = Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1; ' +
        'if ($b -and $b.EstimatedChargeRemaining -ne $null) { ' +
        '"{\\"level\\":" + [int]$b.EstimatedChargeRemaining + ' +
        '",\\"charging\\":" + ($b.BatteryStatus -eq 2).ToString().ToLower() + "}" ' +
        '} else { "none" }',
    ],
    { timeout: 8000, maxBuffer: 1024 * 1024 }
  );
  const t = stdout.trim();
  if (!t || t === 'none') return { present: false, mocked: false };
  const o = JSON.parse(t);
  const level = Number(o.level);
  if (!Number.isFinite(level)) return { present: false, mocked: false };
  return {
    level,
    charging: o.charging === true,
    temperature: null,
    mocked: false,
    present: true,
  };
}

/**
 * Battery status. On Termux: parse termux-battery-status JSON.
 * On Windows: a real WMI read (or { present:false } on a desktop with no
 * battery — AC power, nothing mocked). On other systems without a battery
 * API: { present:false } too. The honest answer always wins.
 */
export async function getBattery() {
  if (await isTermux()) {
    try {
      const { stdout } = await execFileP('termux-battery-status', [], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      const raw = JSON.parse(stdout);
      const level = Number(raw.percentage ?? raw.level ?? 0);
      const charging =
        raw.plugged === true ||
        raw.plugged === 'true' ||
        raw.plugged === 1 ||
        raw.status === 'CHARGING' ||
        raw.status === 'FULL';
      const tempNum = Number(raw.temperature);
      const temperature =
        raw.temperature != null && Number.isFinite(tempNum) ? tempNum : null;
      return { level, charging, temperature, mocked: false, present: true };
    } catch {
      return { present: false, mocked: false };
    }
  }
  if (process.platform === 'win32') {
    try {
      return await getWindowsBattery();
    } catch {
      return { present: false, mocked: false };
    }
  }
  return { present: false, mocked: false };
}

/**
 * Storage stats for `dir` (the vault root). Uses fs.statfs; on failure
 * (unsupported platform, missing dir) returns mocked: true.
 */
export async function getStorage(dir) {
  try {
    const s = await fsp.statfs(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize; // free for unprivileged users
    const usedPct =
      total > 0 ? Math.round(((total - free) / total) * 1000) / 10 : 0;
    return { total, free, usedPct, mocked: false };
  } catch {
    return { total: null, free: null, usedPct: null, mocked: true };
  }
}
