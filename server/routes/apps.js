// Live apps API — mounted by initApps(app) BEFORE the global 1 MB json parser
// (app file uploads are multi-MB). All mutations sit under the lock guard
// (index.js mounts lockWrites on /api/apps first).
//
//   GET    /api/apps                          list apps (live state + disk + ram)
//   POST   /api/apps            { name }      create an empty app
//   POST   /api/apps/:name/files { files: [{ path, contentBase64 }] }   batch upload
//   POST   /api/apps/:name/zip   multipart "zip"                        zip deploy
//   POST   /api/apps/:name/deploy { install }  npm install (if package.json) + start
//   POST   /api/apps/:name/start  { force }    POST .../stop   POST .../restart
//   GET    /api/apps/:name/logs                last 200 lines + last install log
//   PATCH  /api/apps/:name       { entry, env, runOnBoot, ramCapMB }
//   DELETE /api/apps/:name                     stop + remove folder + registry
//   POST   /api/apps/:name/export              zip of the app + mitti.json manifest
import express, { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { resolveSafe, PathError } from '../lib/paths.js';
import { zipRead } from '../lib/zip.js';
import { buildDirZip } from '../lib/dirzip.js';
import {
  APPS_DIR,
  AppError,
  appLogs,
  appState,
  createApp,
  deleteApp,
  installLog,
  listApps,
  npmInstallAvailable,
  restartApp,
  runNpmBuild,
  runNpmInstall,
  setDeployStep,
  startApp,
  stopApp,
  updateApp,
  validName,
} from '../lib/apprunner.js';
import { buildQueue, classifyProject } from '../lib/buildqueue.js';

const MAX_ZIP_BYTES = 60 * 1024 * 1024;
const MAX_INFLATED_BYTES = 200 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ZIP_BYTES, files: 1 },
});

function appDir(name) {
  validName(name);
  const dir = path.join(APPS_DIR, name);
  if (!fs.existsSync(dir)) {
    const e = new Error(`Unknown app: ${name}`);
    e.status = 404;
    throw e;
  }
  return dir;
}

/** Validate every rel path, then write — a bad entry never half-publishes. */
function planPaths(files, root) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new PathError('Missing "files" array');
  }
  if (files.length > 2000) {
    throw new PathError('Too many files in one batch (max 2000)');
  }
  const planned = [];
  for (const f of files) {
    const rel = typeof f?.path === 'string' ? f.path.replace(/\\/g, '/') : '';
    if (!rel || rel.startsWith('/') || rel.split('/').some((s) => s === '' || s === '.' || s === '..')) {
      throw new PathError(`Bad file path: ${rel || '(empty)'}`);
    }
    const content = typeof f?.contentBase64 === 'string' ? f.contentBase64 : '';
    if (!content) throw new PathError(`Missing contentBase64 for ${rel}`);
    const buf = Buffer.from(content, 'base64');
    if (buf.length > MAX_UPLOAD_BYTES) throw new PathError(`${rel} is over the size cap`);
    planned.push({ rel, abs: resolveSafe(rel, root), buf });
  }
  return planned;
}

async function writePlanned(planned) {
  for (const p of planned) {
    await fsp.mkdir(path.dirname(p.abs), { recursive: true });
    await fsp.writeFile(p.abs, p.buf);
  }
}

const router = Router();

router.get('/', (req, res, next) => {
  try {
    res.json({ apps: listApps() });
  } catch (err) {
    next(err);
  }
});

router.post('/', (req, res, next) => {
  try {
    const rec = createApp(req.body?.name);
    res.json({ ok: true, app: rec });
  } catch (err) {
    next(err);
  }
});

router.post('/:name/files', async (req, res, next) => {
  try {
    const root = appDir(req.params.name);
    const planned = planPaths(req.body?.files, root);
    await writePlanned(planned);
    res.json({ ok: true, files: planned.length });
  } catch (err) {
    next(err);
  }
});

// zip deploy: read (bomb-capped), unwrap a shared top folder, stage + swap
router.post('/:name/zip', upload.single('zip'), async (req, res, next) => {
  const root = appDir(req.params.name);
  try {
    if (!req.file) throw new PathError('Missing zip (multipart field "zip")');
    const entries = zipRead(req.file.buffer, { maxInflatedBytes: MAX_INFLATED_BYTES });
    const planned = planPaths(
      entries.map((e) => ({ path: e.path, contentBase64: e.data.toString('base64') })),
      root
    );
    let unwrapped = null;
    if (planned.length) {
      const first = planned[0].rel.split('/')[0];
      if (first && planned.every((p) => p.rel.startsWith(first + '/'))) {
        for (const p of planned) p.rel = p.rel.slice(first.length + 1);
        unwrapped = first;
      }
    }
    const staging = root + '.staging';
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.mkdir(staging, { recursive: true });
    for (const p of planned) {
      await fsp.mkdir(path.dirname(path.join(staging, p.rel)), { recursive: true });
      await fsp.writeFile(path.join(staging, p.rel), p.buf);
    }
    const previous = root + '.previous';
    await fsp.rm(previous, { recursive: true, force: true });
    await fsp.rename(root, previous);
    await fsp.rename(staging, root);
    await fsp.rm(previous, { recursive: true, force: true });
    res.json({ ok: true, files: planned.length, unwrapped });
  } catch (err) {
    next(err);
  }
});

router.post('/:name/deploy', async (req, res, next) => {
  try {
    const name = validName(req.params.name);
    const dirAbs = appDir(name);
    const wantInstall = req.body?.install !== false;
    const profile = classifyProject(dirAbs);
    const hasPkg = fs.existsSync(path.join(dirAbs, 'package.json'));
    let install = null;
    let built = false;
    // one install or build at a time on the phone — a second project waits its turn
    setDeployStep(name, 'waiting');
    const outcome = await buildQueue.enqueue(async () => {
      if (wantInstall && hasPkg) {
        setDeployStep(name, 'installing');
        if (!(await npmInstallAvailable())) {
          throw new AppError(
            'npm is not available on this device — install Node.js/npm, or deploy with install:false'
          );
        }
        install = await runNpmInstall(name, { full: profile.hasBuild });
        if (!install.ok) return { step: 'install', error: install.error || 'npm install failed' };
      }
      if (wantInstall && profile.hasBuild) {
        setDeployStep(name, 'building');
        const b = await runNpmBuild(name);
        if (!b.ok) return { step: 'build', error: b.error || 'npm run build failed' };
        built = true;
      }
      return null;
    }, () => setDeployStep(name, 'waiting'));
    if (outcome) {
      setDeployStep(name, 'failed:' + outcome.step);
      const e = new Error(outcome.error);
      e.status = 502;
      e.expose = true;
      e.step = outcome.step;
      throw e;
    }
    setDeployStep(name, 'starting');
    let started;
    try {
      started = await startApp(name);
    } catch (err) {
      setDeployStep(name, 'failed:start');
      throw err;
    }
    setDeployStep(name, null);
    res.json({
      ok: true,
      name,
      state: appState(name).state,
      port: started.port,
      url: `http://127.0.0.1:${started.port}`,
      installRan: Boolean(install),
      buildRan: built,
      kind: profile.startKind,
      entry: started.entry,
    });
  } catch (err) {
    next(err);
  }
});

for (const action of ['start', 'stop', 'restart']) {
  router.post(`/:name/${action}`, async (req, res, next) => {
    try {
      const name = validName(req.params.name);
      appDir(name);
      let out;
      if (action === 'start') out = await startApp(name, { force: req.body?.force === true });
      else if (action === 'stop') out = stopApp(name);
      else out = await restartApp(name);
      const st = appState(name);
      res.json({ ok: true, state: st.state, port: st.port, ...out });
    } catch (err) {
      next(err);
    }
  });
}

router.get('/:name/logs', (req, res, next) => {
  try {
    const name = validName(req.params.name);
    res.json({ lines: appLogs(name), installLog: installLog(name) });
  } catch (err) {
    next(err);
  }
});

router.patch('/:name', (req, res, next) => {
  try {
    const rec = updateApp(req.params.name, req.body || {});
    res.json({ ok: true, app: rec });
  } catch (err) {
    next(err);
  }
});

router.delete('/:name', async (req, res, next) => {
  try {
    res.json(await deleteApp(req.params.name));
  } catch (err) {
    next(err);
  }
});

// export: the app + mitti.json manifest travels as one zip — any machine with
// Node takes it over with `PORT=<port> node <entry>` (README documents it)
router.post('/:name/export', async (req, res, next) => {
  try {
    const name = validName(req.params.name);
    const dir = appDir(name);
    const rec = listApps().find((a) => a.name === name) || {};
    const manifest = {
      mitticloud: 1,
      name,
      entry: rec.entry,
      port: rec.port,
      env: rec.env || {},
      runOnBoot: rec.runOnBoot,
      ramCapMB: rec.ramCapMB,
      exportedAt: new Date().toISOString(),
    };
    await fsp.writeFile(path.join(dir, 'mitti.json'), JSON.stringify(manifest, null, 2) + '\n');
    const { buffer } = await buildDirZip(dir, { maxBytes: 200 * 1024 * 1024 });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}-export.zip"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

/** Mount under /api/apps with its own big-body parser (like MittiHost). */
export function mountApps(app) {
  app.use('/api/apps', express.json({ limit: '128mb' }));
  app.use('/api/apps', router);
}
