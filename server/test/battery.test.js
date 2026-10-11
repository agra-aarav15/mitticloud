// Unit tests for the phone's own battery file (server/lib/battery.js
// readAppBattery + the low-battery rule). The Android app writes the phone's
// real battery to data/battery.json every 30 seconds; the server trusts it only
// while it is fresh, well-formed and actually says whether a battery is present.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mitticloud-battery-'));
process.env.MITTICLOUD_VAULT_DIR = path.join(TMP_ROOT, 'vault');
process.env.MITTICLOUD_DATA_DIR = path.join(TMP_ROOT, 'data');

const { DATA_DIR } = await import('../lib/paths.js');
const { readAppBattery, isLowBattery } = await import('../lib/battery.js');

const APP_BATTERY_FILE = path.join(DATA_DIR, 'battery.json');

before(() => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
});

after(() => {
  delete process.env.MITTI_FAKE_BATTERY;
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

test('a fresh, well-formed app battery file is accepted as real', () => {
  fs.writeFileSync(
    APP_BATTERY_FILE,
    JSON.stringify({ present: true, level: 68, charging: false })
  );
  const b = readAppBattery();
  assert.ok(b, 'expected a readout');
  assert.equal(b.present, true);
  assert.equal(b.level, 68);
  assert.equal(b.mocked, false, 'an app readout is always real, never mocked');
});

test('a file older than 5 minutes is ignored as stale', () => {
  fs.writeFileSync(APP_BATTERY_FILE, JSON.stringify({ present: true, level: 90, charging: false }));
  const old = Date.now() / 1000 - 10 * 60;
  fs.utimesSync(APP_BATTERY_FILE, old, old);
  assert.equal(readAppBattery(), null, 'stale reads must not be trusted');
});

test('malformed JSON and a missing present flag are ignored', () => {
  fs.writeFileSync(APP_BATTERY_FILE, '{ not json');
  assert.equal(readAppBattery(), null);

  fs.writeFileSync(APP_BATTERY_FILE, JSON.stringify({ level: 50 }));
  assert.equal(readAppBattery(), null, 'no present flag means no answer');
});

test('no file at all reads as nothing', () => {
  fs.rmSync(APP_BATTERY_FILE, { force: true });
  assert.equal(readAppBattery(), null);
});

test('isLowBattery only gates a real, unplugged phone under 30%', () => {
  assert.equal(isLowBattery({ present: true, level: 22, charging: false, mocked: false }), true);
  assert.equal(isLowBattery({ present: true, level: 22, charging: false, mocked: true }), false);
  assert.equal(isLowBattery({ present: true, level: 22, charging: true, mocked: false }), false);
  assert.equal(isLowBattery({ present: true, level: 55, charging: false, mocked: false }), false);
  assert.equal(isLowBattery({ present: false, level: 5, charging: false, mocked: false }), false);
  assert.equal(isLowBattery(null), false);
});