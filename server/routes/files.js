// File server routes (root = vault/files):
//   GET    /api/files?path=<rel>               browse one directory
//   GET    /api/files/download?path=<rel>      download one file (attachment)
//   POST   /api/files/mkdir  body { path }     create directory
//   DELETE /api/files?path=<rel>[&force=true]  delete file / dir (force for non-empty)
import { Router } from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { FILES_DIR, resolveSafe, PathError } from '../lib/paths.js';

const router = Router();

const toPosix = (p) => String(p).replace(/\\/g, '/');

function queryPath(req, { required = false } = {}) {
  const raw = req.query.path;
  const rel = typeof raw === 'string' ? raw : '';
  if (required && !rel.trim()) {
    throw new PathError('Missing required query parameter: path');
  }
  return rel;
}

router.get('/', async (req, res, next) => {
  try {
    const rel = queryPath(req);
    const abs = resolveSafe(rel, FILES_DIR);
    let dirents;
    try {
      dirents = await fsp.readdir(abs, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') {
        const e = new Error(`Path not found: ${toPosix(rel)}`);
        e.status = 404;
        throw e;
      }
      if (err.code === 'ENOTDIR') {
        throw new PathError(`Not a directory: ${toPosix(rel)}`);
      }
      throw err;
    }
    const entries = [];
    for (const ent of dirents) {
      if (ent.isSymbolicLink()) continue; // never follow links out of the vault
      const full = path.join(abs, ent.name);
      let st;
      try {
        st = await fsp.stat(full);
      } catch {
        continue; // raced with a delete
      }
      const isDir = ent.isDirectory();
      entries.push({
        name: ent.name,
        type: isDir ? 'dir' : 'file',
        size: isDir ? 0 : st.size,
        modifiedAt: st.mtime.toISOString(),
      });
    }
    entries.sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name, undefined, { numeric: true })
        : a.type === 'dir'
          ? -1
          : 1
    );
    res.json({ path: toPosix(rel), entries });
  } catch (err) {
    next(err);
  }
});

router.get('/download', async (req, res, next) => {
  try {
    const rel = queryPath(req, { required: true });
    const abs = resolveSafe(rel, FILES_DIR);
    const st = await fsp.lstat(abs).catch(() => null);
    if (!st) {
      const e = new Error(`File not found: ${toPosix(rel)}`);
      e.status = 404;
      throw e;
    }
    if (!st.isFile()) {
      throw new PathError(`Not a downloadable file: ${toPosix(rel)}`);
    }
    res.download(abs, path.basename(abs));
  } catch (err) {
    next(err);
  }
});

router.post('/mkdir', async (req, res, next) => {
  try {
    const rel = req.body && typeof req.body.path === 'string' ? req.body.path : '';
    if (!rel.trim()) {
      throw new PathError('Missing "path" in request body');
    }
    const abs = resolveSafe(rel, FILES_DIR);
    try {
      await fsp.mkdir(abs, { recursive: true });
    } catch (err) {
      // mkdir recursive succeeds silently for existing dirs; ENOTDIR/EEXIST
      // here means a non-directory occupies the path.
      if (err.code === 'EEXIST' || err.code === 'ENOTDIR') {
        throw new PathError(`Cannot create directory: ${toPosix(rel)}`);
      }
      throw err;
    }
    res.json({ created: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/', async (req, res, next) => {
  try {
    const rel = queryPath(req, { required: true });
    const abs = resolveSafe(rel, FILES_DIR);
    const rootAbs = path.resolve(FILES_DIR);
    if (abs === rootAbs) {
      throw new PathError('Refusing to delete the files root');
    }
    const st = await fsp.lstat(abs).catch(() => null);
    if (!st) {
      const e = new Error(`Not found: ${toPosix(rel)}`);
      e.status = 404;
      throw e;
    }
    if (st.isDirectory()) {
      const force = req.query.force === 'true' || req.query.force === '1';
      const contents = await fsp.readdir(abs);
      if (contents.length > 0 && !force) {
        return res.status(400).json({
          error: `Directory not empty: ${toPosix(rel)}. Pass force=true to delete it anyway.`,
        });
      }
      await fsp.rm(abs, { recursive: true, force: true });
    } else {
      await fsp.unlink(abs);
    }
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;
