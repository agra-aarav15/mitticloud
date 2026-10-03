// Shared battery readout for every battery-aware feature (agent gate,
// MittiOps task gate, status). The MITTI_FAKE_BATTERY env hook wins when set
// (JSON like {"level":22,"charging":false,"mocked":false}); malformed JSON
// counts as "no battery data" so a broken hook never bricks the gates.
import { getBattery } from './termux.js';

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
