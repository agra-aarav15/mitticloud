// Project kinds and the one-at-a-time build queue.
//
// classifyProject() decides how a folder runs, from its files only:
//   website  — index.html at the root and no package.json
//   app      — has a package.json; the runner ladder decides how it starts
//
// runSerial() makes sure only ONE install/build runs at a time on the phone.
// A second project waits, and says so, instead of fighting for memory.
import fs from 'node:fs';
import path from 'node:path';

export const KIND_WEBSITE = 'website';
export const KIND_APP = 'app';

const BUILD_OUTPUT_DIRS = ['dist', 'build', 'out'];

function readPkg(dirAbs) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirAbs, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * How this folder should run. Pure: reads only the folder's own files.
 * Returns { kind, hasBuild, startKind, outputDir }.
 *  - startKind: 'next' (scripts.start is `next start`), 'node' (`node <file>`),
 *    'static' (a build output folder to serve), or null (use the entry detector).
 */
export function classifyProject(dirAbs) {
  const pkg = readPkg(dirAbs);
  if (!pkg) {
    return {
      kind: KIND_WEBSITE,
      hasBuild: false,
      startKind: null,
      outputDir: null,
    };
  }
  const scripts = pkg.scripts || {};
  const hasBuild = typeof scripts.build === 'string' && scripts.build.trim() !== '';
  const start = typeof scripts.start === 'string' ? scripts.start.trim() : '';
  let startKind = null;
  if (/^next\s+start\b/.test(start)) startKind = 'next';
  else if (/^node\s+\S+$/.test(start)) startKind = 'node';

  let outputDir = null;
  if (!startKind && hasBuild) {
    for (const d of BUILD_OUTPUT_DIRS) {
      if (fs.existsSync(path.join(dirAbs, d, 'index.html'))) {
        outputDir = d;
        startKind = 'static';
        break;
      }
    }
  }
  return { kind: KIND_APP, hasBuild, startKind, outputDir };
}

/**
 * Human status word for the row, from the step that is running.
 * Keeps the words the UI shows in one place.
 */
export const STATUS_WORDS = {
  waiting: 'Waiting for the build before yours',
  installing: 'Installing',
  building: 'Building',
  starting: 'Starting',
  live: 'Live',
};

/**
 * One-at-a-time queue. enqueue(task) resolves with task()'s result.
 * `onWait(position)` is called when a task has to wait behind others, so the
 * UI can say "Waiting for the build before yours" honestly.
 */
export function createQueue() {
  let tail = Promise.resolve();
  let pending = 0;
  return {
    get pending() {
      return pending;
    },
    enqueue(task, onWait) {
      const ahead = pending;
      pending += 1;
      if (ahead > 0 && typeof onWait === 'function') onWait(ahead);
      const run = tail.then(() => task());
      tail = run.catch(() => {}).finally(() => {
        pending -= 1;
      });
      return run;
    },
  };
}

export const buildQueue = createQueue();
