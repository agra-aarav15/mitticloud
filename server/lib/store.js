// Minimal JSON file store at data/state.json.
// Read/write whole-object, plus get/set convenience. Writes go through a
// temp file + rename so the state file is never left half-written.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const STATE_FILE = path.join(DATA_DIR, 'state.json');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** Read the whole store as an object. Missing/corrupt file -> {}. */
export function readStore() {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** Atomically replace the whole store (temp file + rename). */
export function writeStore(obj) {
  ensureDataDir();
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, STATE_FILE);
  return obj;
}

/** Get one key, or `fallback` when absent. */
export function get(key, fallback) {
  const data = readStore();
  return Object.prototype.hasOwnProperty.call(data, key)
    ? data[key]
    : fallback;
}

/** Set one key (read-modify-write) and return the value. */
export function set(key, value) {
  const data = readStore();
  data[key] = value;
  writeStore(data);
  return value;
}
