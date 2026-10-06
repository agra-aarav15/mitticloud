// File server routes (root = vault/files):
//   GET    /api/files?path=<rel>                browse one directory
//   GET    /api/files/download?path=<rel>       download one file (attachment)
//   GET    /api/files/search?q=<text>           name substring search (max 100 hits)
//   GET    /api/files/usage                     per top-level folder byte/file totals
//   GET    /api/files/archive?path=<dir>        download a folder as a ZIP (cap 200 MB)
//   POST   /api/files/mkdir   body { path }     create directory
//   POST   /api/files/rename  { path, newName } rename a file or folder
//   POST   /api/files/move    { from, toDir }   move a file or folder into toDir
//   POST   /api/files/copy    { from, toDir }   copy a file or folder (recursive) into toDir
//   POST   /api/files/delete  { paths: [...] }  multi-delete (dirs go recursively)
//   POST   /api/files/upload-multipart          multipart "file" + fields { to, rel }
//   DELETE /api/files?path=<rel>[&force=true]   delete file / dir (force for non-empty)
// Every user-supplied path is vault-relative and resolved through resolveSafe().
import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { FILES_DIR, resolveSafe, PathError } from '../lib/paths.js';
import { buildDirZip } from '../lib/dirzip.js';

const router = Router();

const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024; // folder ZIP download cap
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_VISITED = 20000; // bound the walk on huge vaults
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024; // per uploaded file

const toPosix = (p) => String(p).replace(/\\/g, '/');
const relFromRoot = (abs) => toPosix(path.relative(FILES_DIR, abs));

function queryPath(req, { required = false } = {}) {
  const raw = req.query.path;
  const rel = typeof raw === 'string' ? raw : '';
  if (required && !rel.trim()) {
    throw new PathError('Missing required query parameter: path');
  }
  return rel;
}

// --- shared helpers ---

/** Stat a path with lstat, answering 404 with `message` when it is missing. */
async function lstatOr404(abs, message) {
  const st = await fsp.lstat(abs).catch(() => null);
  if (!st) {
    const e = new Error(message);
    e.status = 404;
    throw e;
  }
  return st;
}

/** Resolve {from, toDir} for move/copy; returns {fromAbs, fromSt, destAbs}. */
async function resolveMoveCopy(from, toDir, verb) {
  const fromRel = typeof from === 'string' ? from : '';
  if (!fromRel.trim()) {
    throw new PathError(`Missing "from" in request body`);
  }
  const fromAbs = resolveSafe(fromRel, FILES_DIR);
  const rootAbs = path.resolve(FILES_DIR);
  if (fromAbs === rootAbs) {
    throw new PathError(`Refusing to ${verb} the files root`);
  }
  const fromSt = await lstatOr404(fromAbs, `Not found: ${toPosix(fromRel)}`);

  const dirRel = typeof toDir === 'string' ? toDir : '';
  const dirAbs = resolveSafe(dirRel, FILES_DIR); // '' -> files root
  const dirSt = await fsp.lstat(dirAbs).catch(() => null);
  if (!dirSt || !dirSt.isDirectory()) {
    const e = new Error(`Destination folder not found: ${toPosix(dirRel) || '.'}`);
    e.status = 404;
    throw e;
  }
  if (fromSt.isDirectory() && (dirAbs === fromAbs || dirAbs.startsWith(fromAbs + path.sep))) {
    throw new PathError(`Cannot ${verb} a folder into itself`);
  }
  const destAbs = path.join(dirAbs, path.basename(fromAbs));
  const destSt = await fsp.lstat(destAbs).catch(() => null);
  if (destSt) {
    const e = new Error(`Destination already exists: ${relFromRoot(destAbs)}`);
    e.status = 409;
    throw e;
  }
  return { fromAbs, fromSt, destAbs };
}

/** Recursively copy a file or directory tree (symlinks skipped). */
async function copyTree(fromAbs, destAbs) {
  const st = await fsp.lstat(fromAbs);
  if (st.isDirectory()) {
    await fsp.mkdir(destAbs, { recursive: true });
    const dirents = await fsp.readdir(fromAbs, { withFileTypes: true });
    for (const ent of dirents) {
      if (ent.isSymbolicLink()) continue;
      await copyTree(path.join(fromAbs, ent.name), path.join(destAbs, ent.name));
    }
  } else if (st.isFile()) {
    await fsp.copyFile(fromAbs, destAbs);
  }
}

/**
 * Delete one vault-relative path. Dirs need force=true when non-empty.
 * Returns { deleted: boolean } (false when the path was already gone).
 */
async function deleteOne(rel, { force = false } = {}) {
  const abs = resolveSafe(rel, FILES_DIR);
  const rootAbs = path.resolve(FILES_DIR);
  if (abs === rootAbs) {
    throw new PathError('Refusing to delete the files root');
  }
  const st = await fsp.lstat(abs).catch(() => null);
  if (!st) return { deleted: false };
  if (st.isDirectory()) {
    const contents = await fsp.readdir(abs);
    if (contents.length > 0 && !force) {
      const e = new Error(
        `Directory not empty: ${toPosix(rel)}. Pass force=true to delete it anyway.`
      );
      e.status = 400;
      throw e;
    }
    await fsp.rm(abs, { recursive: true, force: true });
  } else {
    await fsp.unlink(abs);
  }
  return { deleted: true };
}

/** Sum bytes + file count of a whole subtree (symlinks skipped). */
async function statTree(dirAbs) {
  let bytes = 0;
  let files = 0;
  const stack = [dirAbs];
  while (stack.length > 0) {
    const cur = stack.pop();
    let dirents;
    try {
      dirents = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue; // missing/unreadable subtree
    }
    for (const ent of dirents) {
      if (ent.isSymbolicLink()) continue;
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        const st = await fsp.stat(full).catch(() => null);
        if (st) {
          bytes += st.size;
          files++;
        }
      }
    }
  }
  return { bytes, files };
}

// --- browse / download ---

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

// --- search / usage / archive ---

router.get('/search', async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      throw new PathError('Missing required query parameter: q');
    }
    const needle = q.toLowerCase();
    const results = [];
    let visited = 0;
    const stack = ['']; // dirs to scan, as vault-relative paths
    while (stack.length > 0 && results.length < MAX_SEARCH_RESULTS && visited < MAX_SEARCH_VISITED) {
      const relDir = stack.pop();
      let dirents;
      try {
        dirents = await fsp.readdir(path.join(FILES_DIR, relDir), { withFileTypes: true });
      } catch {
        continue; // missing/unreadable subtree
      }
      for (const ent of dirents) {
        if (++visited > MAX_SEARCH_VISITED) break;
        if (ent.isSymbolicLink()) continue;
        const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
        const matches = ent.name.toLowerCase().includes(needle);
        if (ent.isDirectory()) {
          stack.push(rel);
          if (matches) {
            const st = await fsp.stat(path.join(FILES_DIR, rel)).catch(() => null);
            if (st) results.push({ path: rel, size: 0, mtime: st.mtime.toISOString() });
          }
        } else if (ent.isFile() && matches) {
          const st = await fsp.stat(path.join(FILES_DIR, rel)).catch(() => null);
          if (st) results.push({ path: rel, size: st.size, mtime: st.mtime.toISOString() });
        }
        if (results.length >= MAX_SEARCH_RESULTS) break;
      }
    }
    results.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

router.get('/usage', async (req, res, next) => {
  try {
    const dirents = await fsp.readdir(FILES_DIR, { withFileTypes: true }).catch(() => []);
    const tree = [];
    for (const ent of dirents) {
      if (ent.isSymbolicLink()) continue;
      const abs = path.join(FILES_DIR, ent.name);
      if (ent.isDirectory()) {
        tree.push({ path: ent.name, ...(await statTree(abs)) });
      } else if (ent.isFile()) {
        const st = await fsp.stat(abs).catch(() => null);
        if (st) tree.push({ path: ent.name, bytes: st.size, files: 1 });
      }
    }
    const total = tree.reduce((sum, t) => sum + t.bytes, 0);
    tree.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
    res.json({ total, tree });
  } catch (err) {
    next(err);
  }
});

router.get('/archive', async (req, res, next) => {
  try {
    const rel = queryPath(req, { required: true });
    const abs = resolveSafe(rel, FILES_DIR);
    const st = await lstatOr404(abs, `Path not found: ${toPosix(rel)}`);
    if (!st.isDirectory()) {
      throw new PathError(`Not a directory: ${toPosix(rel)}`);
    }
    const base = toPosix(rel).split('/').filter(Boolean).pop() || 'files';
    const zipName = base.replace(/[^\w.-]+/g, '_') + '.zip';
    const { buffer } = await buildDirZip(abs, { maxBytes: MAX_ARCHIVE_BYTES });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// --- mkdir / rename / move / copy / delete ---

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

router.post('/rename', async (req, res, next) => {
  try {
    const body = req.body || {};
    const rel = typeof body.path === 'string' ? body.path : '';
    const newName = typeof body.newName === 'string' ? body.newName.trim() : '';
    if (!rel.trim()) {
      throw new PathError('Missing "path" in request body');
    }
    if (!newName) {
      throw new PathError('Missing "newName" in request body');
    }
    if (newName === '.' || newName === '..' || newName.includes('/') || newName.includes('\\')) {
      throw new PathError('newName must be a plain file or folder name (no path separators)');
    }
    const abs = resolveSafe(rel, FILES_DIR);
    await lstatOr404(abs, `Not found: ${toPosix(rel)}`);
    const destAbs = path.join(path.dirname(abs), newName);
    const destSt = await fsp.lstat(destAbs).catch(() => null);
    if (destSt) {
      const e = new Error(`Target already exists: ${relFromRoot(destAbs)}`);
      e.status = 409;
      throw e;
    }
    await fsp.rename(abs, destAbs);
    res.json({ ok: true, path: relFromRoot(destAbs) });
  } catch (err) {
    next(err);
  }
});

router.post('/move', async (req, res, next) => {
  try {
    const body = req.body || {};
    const { fromAbs, destAbs } = await resolveMoveCopy(body.from, body.toDir, 'move');
    try {
      await fsp.rename(fromAbs, destAbs);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      // temp dir on another filesystem: copy + remove instead
      await copyTree(fromAbs, destAbs);
      await fsp.rm(fromAbs, { recursive: true, force: true });
    }
    res.json({ ok: true, path: relFromRoot(destAbs) });
  } catch (err) {
    next(err);
  }
});

router.post('/copy', async (req, res, next) => {
  try {
    const body = req.body || {};
    const { fromAbs, destAbs } = await resolveMoveCopy(body.from, body.toDir, 'copy');
    await copyTree(fromAbs, destAbs);
    res.json({ ok: true, path: relFromRoot(destAbs) });
  } catch (err) {
    next(err);
  }
});

router.post('/delete', async (req, res, next) => {
  try {
    const body = req.body || {};
    const paths = Array.isArray(body.paths) ? body.paths : null;
    if (!paths || paths.length === 0) {
      throw new PathError('Missing "paths" array in request body');
    }
    const rootAbs = path.resolve(FILES_DIR);
    // Validate everything first so a bad path never half-deletes the batch.
    for (const p of paths) {
      if (typeof p !== 'string' || !p.trim()) {
        throw new PathError('Each path must be a non-empty string');
      }
      const abs = resolveSafe(p, FILES_DIR);
      if (abs === rootAbs) {
        throw new PathError('Refusing to delete the files root');
      }
    }
    let deleted = 0;
    for (const p of paths) {
      const { deleted: gone } = await deleteOne(p, { force: true });
      if (gone) deleted++;
    }
    res.json({ ok: true, deleted });
  } catch (err) {
    next(err);
  }
});

// --- multipart upload (streaming path for big files — no base64) ---

// Stream to a temp file first, then move into place once the text fields
// (to/rel) are known. Cross-device moves fall back to copy + unlink.
const tmpUploads = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename(req, file, cb) {
      cb(null, `mitticloud-upload-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
    },
  }),
  limits: { files: 1, fileSize: MAX_UPLOAD_BYTES },
});

/** Reject anything that is not a clean relative path (no '..', no leading '/'). */
function sanitizeRel(raw) {
  const rel = String(raw ?? '').trim().replace(/\\/g, '/');
  if (!rel) {
    throw new PathError('Missing "rel" field (target path including filename)');
  }
  if (rel.startsWith('/')) {
    throw new PathError('rel must be a relative path (no leading "/")');
  }
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new PathError('rel may not contain ".." or empty path segments: ' + rel);
  }
  return segments.join('/');
}

/** Move an uploaded temp file into the vault (cross-device safe). */
async function moveIntoPlace(tmpPath, destAbs) {
  try {
    await fsp.rename(tmpPath, destAbs);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(tmpPath, destAbs);
    await fsp.unlink(tmpPath).catch(() => {});
  }
}

router.post('/upload-multipart', tmpUploads.single('file'), async (req, res, next) => {
  const tmpPath = req.file ? req.file.path : null;
  try {
    if (!req.file) {
      throw new PathError('Missing file (multipart field "file")');
    }
    const dirRel = typeof req.body?.to === 'string' ? req.body.to : '';
    const dirAbs = resolveSafe(dirRel, FILES_DIR); // '' -> files root
    const targetRel = sanitizeRel(req.body?.rel);
    const abs = resolveSafe(targetRel, dirAbs); // throws PathError on any escape
    try {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
    } catch (err) {
      if (err.code === 'ENOTDIR' || err.code === 'EEXIST') {
        throw new PathError(`Cannot create target folder for: ${targetRel}`);
      }
      throw err;
    }
    const existing = await fsp.lstat(abs).catch(() => null);
    if (existing && existing.isDirectory()) {
      const e = new Error(`Target is a folder: ${relFromRoot(abs)}`);
      e.status = 409;
      throw e;
    }
    await moveIntoPlace(tmpPath, abs);
    res.json({ ok: true, path: relFromRoot(abs) });
  } catch (err) {
    if (tmpPath) await fsp.unlink(tmpPath).catch(() => {});
    next(err);
  }
});

// --- delete (single, legacy shape kept for the live UI) ---

router.delete('/', async (req, res, next) => {
  try {
    const rel = queryPath(req, { required: true });
    const { deleted } = await deleteOne(rel, {
      force: req.query.force === 'true' || req.query.force === '1',
    });
    if (!deleted) {
      const e = new Error(`Not found: ${toPosix(rel)}`);
      e.status = 404;
      throw e;
    }
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// --- content (the code editor): read/put ONE text file, capped + binary-refused ---

const MAX_CONTENT_BYTES = 200 * 1024 * 1024; // generous edit ceiling for on-disk reads
const MAX_EDIT_BYTES = 200 * 1024; // an edit save is capped tighter (textarea reality)

/** Heuristic binary sniff: NUL bytes or a control-char-heavy head = binary. */
function looksBinary(buf) {
  const head = buf.subarray(0, 8000);
  if (head.includes(0)) return true;
  let controls = 0;
  for (const b of head) {
    if (b < 9 || (b > 13 && b < 32)) controls++;
  }
  return head.length > 0 && controls / head.length > 0.06;
}

router.get('/content', async (req, res, next) => {
  try {
    const rel = queryPath(req, { required: true });
    const abs = resolveSafe(rel, FILES_DIR);
    const st = await lstatOr404(abs, `Not found: ${toPosix(rel)}`);
    if (!st.isFile()) {
      throw new PathError(`Not a file: ${toPosix(rel)}`);
    }
    if (st.size > MAX_CONTENT_BYTES) {
      const e = new Error(`Too large to open (over ${Math.round(MAX_CONTENT_BYTES / (1024 * 1024))} MB)`);
      e.status = 413;
      throw e;
    }
    const buf = await fsp.readFile(abs);
    if (looksBinary(buf)) {
      const e = new Error('Binary file — the editor handles text only. Download it instead.');
      e.status = 415;
      throw e;
    }
    res.json({
      path: toPosix(rel),
      size: st.size,
      modifiedAt: st.mtime.toISOString(),
      content: buf.toString('utf8'),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/content', async (req, res, next) => {
  try {
    const rel = typeof req.body?.path === 'string' ? req.body.path : '';
    if (!rel.trim()) throw new PathError('Missing "path" in request body');
    const content = typeof req.body?.content === 'string' ? req.body.content : null;
    if (content === null) throw new PathError('Missing "content" in request body');
    const buf = Buffer.from(content, 'utf8');
    if (buf.length > MAX_EDIT_BYTES) {
      const e = new Error(`Too large to save (over ${Math.round(MAX_EDIT_BYTES / 1024)} KB)`);
      e.status = 413;
      throw e;
    }
    if (looksBinary(buf)) {
      const e = new Error('That content looks binary — saving text only');
      e.status = 415;
      throw e;
    }
    const abs = resolveSafe(rel, FILES_DIR);
    const st = await fsp.lstat(abs).catch(() => null);
    if (st && st.isDirectory()) {
      throw new PathError(`Target is a folder: ${toPosix(rel)}`);
    }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmp = abs + '.mitti-edit-tmp';
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, abs);
    const after = await fsp.stat(abs);
    res.json({ ok: true, path: toPosix(rel), size: after.size, modifiedAt: after.mtime.toISOString() });
  } catch (err) {
    next(err);
  }
});

export default router;
