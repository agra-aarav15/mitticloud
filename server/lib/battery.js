// Shared battery readout for every battery-aware feature (agent gate,
// MittiOps task gate, status). The MITTI_FAKE_BATTERY env hook wins when set
// (JSON like {"level":22,"charging":false,"mocked":false}); malformed JSON
// counts as "no battery data" so a broken hook never bricks the gates.
import fs from 'node:fs';
import path from 'node:path';

import { getBattery } from './termux.js';
import { DATA_DIR } from './paths.js';

// The Android app writes the phone's real battery here every 30 seconds.
const APP_BATTERY_FILE = path.join(DATA_DIR, 'battery.json');

function readAppBattery() {
  try {
    const raw = JSON.parse(fs.readFileSync(APP_BATTERY_FILE, 'utf8'));
    if (typeof raw.present !== 'boolean') return null;
    if (Date.now() - fs.statSync(APP_BATTERY_FILE).mtimeMs > 5 * 60 * 1000) return null;
    return { ...raw, mocked: false };
  } catch {
    return null;
  }
}

/**
 * Battery readout or null when nothing is known. Real reads only: a desktop
 * without a battery returns { present:false } (AC power — the honest shape).
 */
export async function readBattery() {
  const fake = process.env.MITTI_FAKE_BATTERY;
  if (fake) {
    try {
      return JSON.parse(fake);
    } catch {
      return null;
    }
  }
  const fromApp = readAppBattery();
  if (fromApp) return fromApp;
  try {
    return await getBattery();
  } catch {
    return null;
  }
}

/**
 * The low-battery gate rule shared by the agent and tasks: true when the
 * device is really (not mocked) running on battery below 30%. A device with
 * no battery at all (present:false, e.g. a desktop on AC) never gates.
 * In that state heavy work waits and scheduled jobs defer until charging.
 */
export function isLowBattery(battery) {
  return Boolean(
    battery &&
      battery.present !== false &&
      !battery.mocked &&
      !battery.charging &&
      Number.isFinite(Number(battery.level)) &&
      Number(battery.level) < 30
  );
}
