// MittiBadge stats — real per-site visitor counts for the embeddable badge.
// Counted in memory, flushed to data/badge-stats.json every 30 seconds (and
// on read), so a hit never costs a disk write but nothing is lost on a
// graceful restart.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const FILE = path.join(DATA_DIR, 'badge-stats.json');
const FLUSH_MS = 30 * 1000;

const counts = new Map(); // site -> { day, hits, total }
let loaded = false;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (j && typeof j === 'object') {
      for (const [site, s] of Object.entries(j)) {
        if (s && typeof s === 'object' && Number.isFinite(s.hits)) {
          counts.set(site, { day: s.day, hits: s.hits, total: s.total || s.hits });
        }
      }
    }
  } catch {
    // first boot — zero everything, honestly
  }
}

function flush() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = {};
    for (const [site, s] of counts) obj[site] = s;
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
    fs.renameSync(tmp, FILE);
  } catch {
    // stats are nice-to-have; never crash a page request over them
  }
}

let flushTimer = null;

export function countHit(site) {
  load();
  const day = today();
  const e = counts.get(site) || { day, hits: 0, total: 0 };
  if (e.day !== day) {
    e.day = day;
    e.hits = 0;
  }
  e.hits += 1;
  e.total += 1;
  counts.set(site, e);
  if (!flushTimer) {
    flushTimer = setInterval(flush, FLUSH_MS);
    flushTimer.unref?.();
  }
}

/** Live numbers for a site (flushes first so a fresh read is the truth). */
export function statsFor(site) {
  load();
  flush();
  const day = today();
  const e = counts.get(site);
  if (!e) return { day, hits: 0, total: 0 };
  if (e.day !== day) return { day, hits: 0, total: e.total };
  return { day: e.day, hits: e.hits, total: e.total };
}
