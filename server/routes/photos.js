// Photo vault routes:
//   GET    /api/photos          list (newest first, max 500)
//   POST   /api/photos/upload   multipart, field "photos", multiple allowed
//   DELETE /api/photos?path=    delete one photo (rel path under vault/photos)
// Uploaded files live at vault/photos/YYYY/MM/DD/<timestamp>-<random6>.<ext>
// and are served statically at /photos/... (mounted in index.js).
import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { PHOTOS_DIR, resolveSafe, PathError } from '../lib/paths.js';

const router = Router();

const MAX_PHOTOS = 500;

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

router.get('/', async (req, res, next) => {
  try {
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
      photos.push(toShape(f, st.size, st.mtime.toISOString()));
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
