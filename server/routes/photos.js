// Photo vault routes:
//   GET    /api/photos                 list (newest first, max 500, with favorite flag)
//   POST   /api/photos/one             multipart, field "photo" — sha1-deduped single upload
//   POST   /api/photos/upload          multipart, field "photos", multiple allowed
//   PATCH  /api/photos/:id/favorite    body { favorite: bool } (:id = url-encoded rel path)
//   GET    /api/photos/archive         whole vault as photos.zip (cap 300 MB)
//   DELETE /api/photos?path=           delete one photo (rel path under vault/photos)
// Uploaded files live at vault/photos/YYYY/MM/DD/<timestamp>-<random6>.<ext>
// and are served statically at /photos/... (mounted in index.js).
// The sha1 dedup index and per-photo favorites live in data/photos-meta.json,
// always written atomically (temp file + rename).
import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { DATA_DIR, PHOTOS_DIR, resolveSafe, PathError } from '../lib/paths.js';
import { buildDirZip } from '../lib/dirzip.js';

const router = Router();

const MAX_PHOTOS = 500;
const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024; // photos.zip cap
const PHOTOS_META_FILE = path.join(DATA_DIR, 'photos-meta.json');

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/bmp': '.bmp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
};
const ALLOWED_EXT = new Set(Object.values(MIME_EXT));

/** Pick an extension from the original name, else the mimetype, else .bin. */
function pickExt(file) {
  const fromName = path.extname(file.originalname || '').toLowerCase();
  if (fromName && ALLOWED_EXT.has(fromName)) return fromName;
  return MIME_EXT[file.mimetype] || '.bin';
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      const now = new Date();
      const yyyy = String(now.getFullYear());
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const dir = path.join(PHOTOS_DIR, yyyy, mm, dd);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename(req, file, cb) {
    const rand = crypto.randomBytes(3).toString('hex'); // 6 chars
    cb(null, `${Date.now()}-${rand}${pickExt(file)}`);
  },
});

const upload = multer({
  storage,
  limits: { files: 50, fileSize: 200 * 1024 * 1024 },
});

// --- photo metadata: data/photos-meta.json (temp file + rename, never half-written) ---

/** Read the meta store. Missing/corrupt file -> empty { bySha1, favorites }. */
function loadPhotosMeta() {
  try {
    const data = JSON.parse(fs.readFileSync(PHOTOS_META_FILE, 'utf8'));
    return {
      bySha1: data.bySha1 && typeof data.bySha1 === 'object' ? data.bySha1 : {},
      favorites: data.favorites && typeof data.favorites === 'object' ? data.favorites : {},
    };
  } catch {
    return { bySha1: {}, favorites: {} };
  }
}

/** Atomically replace the whole meta store. */
function savePhotosMeta(meta) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = PHOTOS_META_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n');
  fs.renameSync(tmp, PHOTOS_META_FILE);
}

/** sha1 of a file's bytes, streamed (photos can be 200 MB). */
async function sha1File(absPath) {
  const hash = crypto.createHash('sha1');
  await pipeline(fs.createReadStream(absPath), hash);
  return hash.digest('hex');
}

function toShape(absPath, size, uploadedAt) {
  const rel = path.relative(PHOTOS_DIR, absPath).split(path.sep).join('/');
  return {
    name: path.basename(absPath),
    path: rel,
    url: `/photos/${rel}`,
    size,
    uploadedAt,
  };
}

async function walk(dir, out) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing/unreadable subtree -> just skip it
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await walk(full, out);
    } else if (ent.isFile()) {
      out.push(full); // symlinks skipped (neither file nor dir)
    }
  }
}

// --- routes ---

router.get('/', async (req, res, next) => {
  try {
    const meta = loadPhotosMeta();
    const files = [];
    await walk(PHOTOS_DIR, files);
    const photos = [];
    for (const f of files) {
      let st;
      try {
        st = await fsp.stat(f);
      } catch {
        continue; // vanished mid-walk
      }
      const shape = toShape(f, st.size, st.mtime.toISOString());
      shape.favorite = Boolean(meta.favorites[shape.path]);
      photos.push(shape);
    }
    photos.sort((a, b) => {
      const t = Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt);
      return t !== 0 ? t : b.path.localeCompare(a.path);
    });
    res.json({ photos: photos.slice(0, MAX_PHOTOS) });
  } catch (err) {
    next(err);
  }
});

// Single upload with sha1 dedup: a second upload of the same bytes answers
// duplicate:true and keeps the original file (the temp copy is discarded).
router.post('/one', upload.single('photo'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No photo uploaded (multipart field "photo")' });
    }
    const sha1 = await sha1File(req.file.path);
    const rel = path.relative(PHOTOS_DIR, req.file.path).split(path.sep).join('/');
    const meta = loadPhotosMeta();
    const known = meta.bySha1[sha1];
    if (known) {
      const knownAbs = resolveSafe(known, PHOTOS_DIR);
      const knownSt = await fsp.lstat(knownAbs).catch(() => null);
      if (knownSt && knownSt.isFile()) {
        await fsp.unlink(req.file.path).catch(() => {}); // discard the temp copy
        return res.json({ ok: true, duplicate: true, path: known });
      }
      // stale index entry (original was deleted) — fall through and re-point
    }
    meta.bySha1[sha1] = rel;
    savePhotosMeta(meta);
    res.json({ ok: true, duplicate: false, path: rel });
  } catch (err) {
    next(err);
  }
});

router.post('/upload', upload.array('photos'), async (req, res, next) => {
  try {
    const uploaded = [];
    for (const f of req.files || []) {
      const st = await fsp.stat(f.path).catch(() => null);
      uploaded.push(
        toShape(f.path, f.size, (st ? st.mtime : new Date()).toISOString())
      );
    }
    res.json({ uploaded });
  } catch (err) {
    next(err);
  }
});

router.get('/archive', async (req, res, next) => {
  try {
    const { buffer } = await buildDirZip(PHOTOS_DIR, { maxBytes: MAX_ARCHIVE_BYTES });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="photos.zip"');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// :id is the url-encoded vault-relative photo path, e.g. 2026%2F10%2F03%2FIMG.jpg
router.patch('/:id/favorite', async (req, res, next) => {
  try {
    const rel = req.params.id || '';
    if (!rel.trim()) {
      throw new PathError('Missing photo path');
    }
    const fav = req.body ? req.body.favorite : undefined;
    if (typeof fav !== 'boolean') {
      throw new PathError('"favorite" must be true or false');
    }
    const abs = resolveSafe(rel, PHOTOS_DIR);
    const st = await fsp.lstat(abs).catch(() => null);
    if (!st || !st.isFile()) {
      const e = new Error(`Photo not found: ${rel}`);
      e.status = 404;
      throw e;
    }
    const meta = loadPhotosMeta();
    if (fav) meta.favorites[rel] = true;
    else delete meta.favorites[rel];
    savePhotosMeta(meta);
    res.json({ ok: true, favorite: fav });
  } catch (err) {
    next(err);
  }
});

router.delete('/', async (req, res, next) => {
  try {
    const rel = req.query.path;
    if (!rel || typeof rel !== 'string' || !rel.trim()) {
      throw new PathError('Missing required query parameter: path');
    }
    const abs = resolveSafe(rel, PHOTOS_DIR);
    const st = await fsp.lstat(abs).catch(() => null);
    if (!st) {
      const e = new Error(`Photo not found: ${rel}`);
      e.status = 404;
      throw e;
    }
    if (!st.isFile()) {
      throw new PathError(`Not a photo file: ${rel}`);
    }
    await fsp.unlink(abs);

    // Prune now-empty day/month/year dirs to keep the vault tidy.
    const rootAbs = path.resolve(PHOTOS_DIR);
    let parent = path.dirname(abs);
    while (parent.startsWith(rootAbs + path.sep)) {
      try {
        await fsp.rmdir(parent); // only succeeds when empty
      } catch {
        break;
      }
      parent = path.dirname(parent);
    }
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;
