// Shared battery readout for every battery-aware feature (sandbox gate,
// MittiOps task gate, status). The MITTI_FAKE_BATTERY env hook wins when set
// (JSON like {"level":22,"charging":false,"mocked":false}); malformed JSON
// counts as "no battery data" so a broken hook never bricks the gates.
import { getBattery } from './termux.js';

/**
 * Battery readout or null when nothing is known. On a desktop without the
 * env hook this returns the mocked { level: 87, charging: true, mocked: true }
 * shape from termux.js — mocked:true always passes the gates.
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
  try {
    return await getBattery();
  } catch {
    return null;
  }
}

/**
 * The low-battery gate rule shared by sandbox and tasks: true when the
 * device is really (not mocked) running on battery below 30%. In that state
 * heavy work waits and scheduled jobs defer until charging.
 */
export function isLowBattery(battery) {
  return Boolean(
    battery &&
      !battery.mocked &&
      !battery.charging &&
      Number(battery.level) < 30
  );
}
