// Live apps API — mounted by initApps(app) BEFORE the global 1 MB json parser
// (app file uploads are multi-MB).
//
//   GET    /api/apps                          list apps (live state + disk + ram)
//   POST   /api/apps            { name }      create an empty app
//   POST   /api/apps/:name/files { files: [{ path, contentBase64 }] }   batch upload
//   POST   /api/apps/:name/zip   multipart "zip"                        zip deploy
//   POST   /api/apps/:name/deploy { install }  npm install (if package.json) + start
//   POST   /api/apps/:name/start  { force }    POST .../stop   POST .../restart
//   GET    /api/apps/:name/logs                last 200 lines + last install log
//   PATCH  /api/apps/:name       { entry, env, runOnBoot, ramCapMB,
//                                  startCommand, installCommand }
//   DELETE /api/apps/:name                     stop + remove folder + registry
//   POST   /api/apps/:name/export              zip of the app + mitti.json manifest
import express, { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { DATA_DIR, resolveSafe, PathError } from '../lib/paths.js';
import { zipRead } from '../lib/zip.js';
import { buildDirZip } from '../lib/dirzip.js';
import {
  APPS_DIR,
  AppError,
  appLogs,
  appState,
  createApp,
  deleteApp,
  getRecord,
  installLog,
  listApps,
  npmInstallAvailable,
  restartApp,
  runCustomInstall,
  runNpmBuild,
  runNpmInstall,
  setDeployStep,
  startApp,
  stopApp,
  updateApp,
  validName,
} from '../lib/apprunner.js';
import { buildQueue, classifyProject } from '../lib/buildqueue.js';
import { isEmbeddedAndroid } from '../lib/paths.js';

const MAX_ZIP_BYTES = 60 * 1024 * 1024;
const MAX_INFLATED_BYTES = 200 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ZIP_BYTES, files: 1 },
});

// A Next.js app on embedded Android has no native SWC binary — the npm package
// @next/swc-android-arm64 does not exist, so Next's loadNative() would try (and
// fail) to download it mid-build. Drop a stub package into node_modules that
// re-exports the WASM build of the same compiler, which runs on the phone's
// ICU-less Node. Written post-install so a fresh node_modules can't wipe it.
const NEXT_SWC_ANDROID = '@next/swc-android-arm64';
function seedNextSwcStub(dirAbs, profile) {
  if (!isEmbeddedAndroid()) return;
  if (!profile || profile.startKind !== 'next') return;
  try {
    const nextPkg = path.join(dirAbs, 'node_modules', 'next', 'package.json');
    const version = JSON.parse(fs.readFileSync(nextPkg, 'utf8')).version;
    const stubDir = path.join(dirAbs, 'node_modules', '@next', 'swc-android-arm64');
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(
      path.join(stubDir, 'package.json'),
      JSON.stringify({ name: '@next/swc-android-arm64', version, private: true, main: 'index.js' }, null, 2) + '\n'
    );
    fs.writeFileSync(
      path.join(stubDir, 'index.js'),
      '// MittiCloud: no native SWC binary exists for Android. This stub points\n' +
        '// Next at the WASM build of the same compiler, which runs on this host.\n' +
        "module.exports = require('@next/swc-wasm-nodejs');\n"
    );
  } catch {
    /* if the seeding fails the build just reports its own real error */
  }
}

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
    const content = typeof f?.contentBase64 === 'string' ? f.contentBase64 : null;
    // An empty file is legitimate: real projects ship plenty of them (a blank
    // .gitkeep, an empty config, an empty package marker). Only a MISSING field
    // is an error — the old `!content` test rejected every zero-byte file and
    // failed the whole deploy.
    if (content === null) throw new PathError(`Missing contentBase64 for ${rel}`);
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

// Multipart folder upload: part field name = target path, part body = bytes.
// Same contract as /api/sites/:name/upload — streams structure and big files
// without base64, used by the web dashboard and the app's native picker.
const UPLOAD_TMP_DIR = path.join(DATA_DIR, 'upload-tmp');
fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
const uploadMany = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_TMP_DIR,
    filename(req, file, cb) {
      cb(null, `app-upload-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
    },
  }),
  limits: { files: 5000, fileSize: MAX_UPLOAD_BYTES },
});

router.post('/:name/upload', uploadMany.any(), async (req, res, next) => {
  const files = Array.isArray(req.files) ? req.files : [];
  const staged = [];
  try {
    const root = appDir(req.params.name);
    if (files.length === 0) {
      throw new PathError('Send files as multipart parts whose field name is the target path');
    }
    for (const f of files) {
      const rel = String(f.fieldname ?? '').replace(/\\/g, '/');
      if (!rel || rel.startsWith('/') || rel.split('/').some((s) => s === '' || s === '.' || s === '..')) {
        throw new PathError(`Bad file path: ${rel || '(empty)'}`);
      }
      staged.push({ rel, abs: resolveSafe(rel, root), tmp: f.path });
    }
    for (const p of staged) {
      await fsp.mkdir(path.dirname(p.abs), { recursive: true });
      try {
        await fsp.rename(p.tmp, p.abs);
      } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        await fsp.copyFile(p.tmp, p.abs);
      }
      p.tmp = null;
    }
    res.json({ ok: true, files: staged.length });
  } catch (err) {
    next(err);
  } finally {
    for (const p of staged) {
      if (p.tmp) await fsp.unlink(p.tmp).catch(() => {});
    }
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
    const rec = getRecord(name);
    // the saved start command is part of classification: it can turn an
    // otherwise unrunnable folder into a 'custom' app
    const profile = classifyProject(dirAbs, rec);
    const hasPkg = fs.existsSync(path.join(dirAbs, 'package.json'));
    let install = null;
    let built = false;
    // one install or build at a time on the phone — a second project waits its turn
    setDeployStep(name, 'waiting');
    const customInstall = rec && rec.installCommand ? rec.installCommand.trim() : '';
    const outcome = await buildQueue.enqueue(async () => {
      if (wantInstall && customInstall) {
        setDeployStep(name, 'installing');
        install = await runCustomInstall(name, customInstall);
        if (!install.ok) return { step: 'install', error: install.error || 'the install command failed' };
      } else if (wantInstall && hasPkg) {
        setDeployStep(name, 'installing');
        if (!(await npmInstallAvailable())) {
          throw new AppError(
            'No package manager on this device — install Node.js with npm, or deploy with install:false'
          );
        }
        install = await runNpmInstall(name, { full: profile.hasBuild });
        if (!install.ok) return { step: 'install', error: install.error || 'npm install failed' };
        // A Next.js app on embedded Android has no native SWC binary — the npm
        // package @next/swc-android-arm64 does not exist, and `loadNative()` would
        // otherwise try (and fail) to download it mid-build. Seed a stub that
        // redirects Next to the WASM build of the same compiler, which runs on
        // the phone. Harmless on a desktop with a real binary.
        seedNextSwcStub(dirAbs, profile);
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
