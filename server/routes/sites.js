// MittiHost — free static website hosting served straight from this phone.
//
// Sites are plain folders of static files under data/sites/<name>/, published
// through the API and served read-only at /s/<name>/... (index.html as the
// default document). A tiny registry at data/sites.json tracks names and
// creation dates; sizes are computed on demand by walking each site folder.
// A whole site can also be replaced in one call by uploading a ZIP to
// POST /api/sites/:name/zip (entry paths sanitized, archive capped at 25 MB).
//
// SECURITY: /s/<name> serves owner-uploaded files to anyone who can reach the
// device — the same trust level as /photos. Every user-supplied path is
// validated (site names must match ^[a-z0-9-]{1,32}$; file paths must be
// relative, with no '..' segments) and resolved through resolveSafe() with a
// containment check; symlinks are never followed. Do not expose this server
// to the public internet without adding authentication first.
//
// MOUNT NOTE: initSites(app) applies its own JSON parsers, so it should be
// called BEFORE app.use(express.json(...)) in index.js — the /files upload
// route needs a ~34 MB body limit (25 MB decoded) while the global parser is
// capped at 1 MB. body-parser's req._body guard prevents double parsing.
import express, { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import badgeRouter from './badge.js';
import { countHit } from '../lib/badgestats.js';
import { DATA_DIR, resolveSafe, PathError } from '../lib/paths.js';
import { zipRead } from '../lib/zip.js';

const SITES_DIR = path.join(DATA_DIR, 'sites');
const SITES_FILE = path.join(DATA_DIR, 'sites.json');

const SITE_NAME_RE = /^[a-z0-9-]{1,32}$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // per uploaded file (decoded)
const MAX_REQUEST_BYTES = 25 * 1024 * 1024; // per /files request (decoded)
// base64 inflates by 4/3; leave headroom for the JSON envelope
const MAX_UPLOAD_BODY = Math.ceil((MAX_REQUEST_BYTES * 4) / 3) + 256 * 1024;
const MAX_ZIP_BYTES = 25 * 1024 * 1024; // per /zip upload (raw archive)
const uploadZip = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ZIP_BYTES },
});

const apiRouter = Router();
const serveRouter = Router();

// --- registry: data/sites.json, temp file + rename (never half-written) ---

function ensureSitesDir() {
  fs.mkdirSync(SITES_DIR, { recursive: true });
}

/** Read all registry entries. Missing/corrupt file -> []. */
function loadRegistry() {
  ensureSitesDir();
  try {
    const data = JSON.parse(fs.readFileSync(SITES_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Atomically replace the whole registry. */
function saveRegistry(entries) {
  ensureSitesDir();
  const tmp = SITES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n');
  fs.renameSync(tmp, SITES_FILE);
}

const isSiteName = (name) => typeof name === 'string' && SITE_NAME_RE.test(name);

/** Count files + bytes of one site folder (symlinks skipped, missing -> 0). */
async function statSite(name) {
  let fileCount = 0;
  let bytes = 0;
  const walk = async (dir) => {
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // folder missing or unreadable
    }
    for (const ent of dirents) {
      if (ent.isSymbolicLink()) continue; // never follow links out of a site
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else {
        const st = await fsp.stat(full).catch(() => null);
        if (st && st.isFile()) {
          fileCount++;
          bytes += st.size;
        }
      }
    }
  };
  await walk(path.join(SITES_DIR, name));
  return { fileCount, bytes };
}

// --- /api/sites routes ---

apiRouter.get('/', async (req, res, next) => {
  try {
    const sites = [];
    for (const entry of loadRegistry()) {
      if (!isSiteName(entry?.name)) continue; // ignore hand-edited junk
      const { fileCount, bytes } = await statSite(entry.name);
      sites.push({
        name: entry.name,
        fileCount,
        bytes,
        url: '/s/' + entry.name,
        createdAt: entry.createdAt || null,
      });
    }
    res.json({ sites });
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/', express.json(), async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!isSiteName(name)) {
      return res.status(400).json({
        error: 'name must be 1-32 characters of lowercase letters, digits and dashes',
      });
    }
    const registry = loadRegistry();
    if (registry.some((s) => s.name === name) || fs.existsSync(path.join(SITES_DIR, name))) {
      return res.status(409).json({ error: 'Site name already taken: ' + name });
    }
    ensureSitesDir();
    await fsp.mkdir(path.join(SITES_DIR, name));
    const site = { name, createdAt: new Date().toISOString() };
    saveRegistry([...registry, site]);
    res.status(201).json({ site: { ...site, fileCount: 0, bytes: 0, url: '/s/' + name } });
  } catch (err) {
    next(err);
  }
});

// Own body parser: 25 MB decoded = ~34 MB of base64 JSON, far above the
// app-level 1 MB limit. Safe even when the global parser already ran.
apiRouter.post('/:name/files', express.json({ limit: MAX_UPLOAD_BODY }), async (req, res, next) => {
  try {
    const name = req.params.name;
    if (!isSiteName(name)) return res.status(404).json({ error: 'Site not found: ' + name });
    const siteDir = path.join(SITES_DIR, name);
    if (!fs.existsSync(siteDir)) return res.status(404).json({ error: 'Site not found: ' + name });

    const files = Array.isArray(req.body?.files) ? req.body.files : null;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'files must be a non-empty array of {path, contentBase64}' });
    }

    // validate every file BEFORE writing any — an oversized file late in the
    // batch must not leave a half-published site behind
    const staged = [];
    let totalBytes = 0;
    for (const f of files) {
      const rel = typeof f?.path === 'string' ? f.path.trim().replace(/\\/g, '/') : '';
      if (!rel || rel.startsWith('/') || rel.endsWith('/')) {
        throw new PathError('Each file needs a relative path (no leading or trailing "/")');
      }
      if (rel.split('/').some((seg) => seg === '..')) {
        throw new PathError('File paths may not contain "..": ' + rel);
      }
      if (typeof f?.contentBase64 !== 'string') {
        throw new PathError('Each file needs a "contentBase64" string: ' + rel);
      }
      const data = Buffer.from(f.contentBase64, 'base64');
      totalBytes += data.length;
      if (data.length > MAX_FILE_BYTES) {
        return res.status(413).json({ error: 'File too large (max 2 MB): ' + rel });
      }
      if (totalBytes > MAX_REQUEST_BYTES) {
        return res.status(413).json({ error: 'Upload too large (max 25 MB per request)' });
      }
      const abs = resolveSafe(rel, siteDir); // throws PathError on escape
      staged.push({ abs, data });
    }
    for (const { abs, data } of staged) {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, data);
    }
    res.json({ written: staged.length, site: name });
  } catch (err) {
    next(err);
  }
});

// GET /:name/usage -> { bytes, files } for one site (walks the site folder).
apiRouter.get('/:name/usage', async (req, res, next) => {
  try {
    const name = req.params.name;
    if (!isSiteName(name)) return res.status(404).json({ error: 'Site not found: ' + name });
    const siteDir = path.join(SITES_DIR, name);
    if (!fs.existsSync(siteDir)) return res.status(404).json({ error: 'Site not found: ' + name });
    const { fileCount, bytes } = await statSite(name);
    res.json({ bytes, files: fileCount });
  } catch (err) {
    next(err);
  }
});

apiRouter.post('/:name/zip', uploadZip.single('zip'), async (req, res, next) => {
  try {
    const name = req.params.name;
    if (!isSiteName(name)) return res.status(404).json({ error: 'Site not found: ' + name });
    if (!req.file || !Buffer.isBuffer(req.file.buffer)) {
      // checked BEFORE anything is created — a bad upload must not leave an
      // empty site behind
      return res.status(400).json({ error: 'Send the archive as multipart form field "zip"' });
    }
    const siteDir = path.join(SITES_DIR, name);

    let entries;
    try {
      entries = zipRead(req.file.buffer); // zip-bomb cap lives in zipRead
    } catch (err) {
      return res.status(400).json({ error: 'Not a readable ZIP file: ' + err.message });
    }

    const planned = [];
    for (const e of entries) {
      const rel = e.path.trim().replace(/\\/g, '/');
      if (!rel || rel.startsWith('/') || rel.split('/').some((seg) => seg === '..')) {
        return res.status(400).json({ error: 'Unsafe path in ZIP: ' + e.path });
      }
      planned.push({ rel, data: e.data });
    }
    if (planned.length === 0) {
      return res.status(400).json({ error: 'The archive holds no files' });
    }

    // GitHub-style archives nest the whole site under one top folder
    // ("repo-main/index.html") — unwrap it so index.html lands at the site
    // root and /s/<name>/ actually serves. Mirrors the folder-upload behavior.
    let unwrapped = null;
    const first = planned[0].rel.split('/')[0];
    if (first && planned.every((p) => p.rel.startsWith(first + '/'))) {
      for (const p of planned) p.rel = p.rel.slice(first.length + 1);
      unwrapped = first;
    }

    for (const p of planned) {
      try {
        resolveSafe(p.rel, siteDir); // containment check (throws PathError on escape)
      } catch {
        return res.status(400).json({ error: 'Unsafe path in ZIP: ' + p.rel });
      }
    }

    // all entries validated — stage into a sibling folder, then swap: the old
    // site stays intact until the new one is fully on disk
    const stageDir = siteDir + '.staging';
    const oldDir = siteDir + '.previous';
    await fsp.rm(stageDir, { recursive: true, force: true });
    await fsp.rm(oldDir, { recursive: true, force: true });
    for (const p of planned) {
      const abs = path.join(stageDir, p.rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, p.data);
    }
    const registry = loadRegistry();
    if (!registry.some((s) => s.name === name)) {
      ensureSitesDir();
      saveRegistry([...registry, { name, createdAt: new Date().toISOString() }]);
    }
    await fsp.mkdir(SITES_DIR, { recursive: true });
    await fsp.rename(siteDir, oldDir).catch(() => {});
    await fsp.rename(stageDir, siteDir);
    await fsp.rm(oldDir, { recursive: true, force: true });

    res.json({ ok: true, site: name, files: planned.length, unwrapped });
  } catch (err) {
    next(err);
  }
});

apiRouter.delete('/:name', async (req, res, next) => {
  try {
    const name = req.params.name;
    if (!isSiteName(name)) return res.status(404).json({ error: 'Site not found: ' + name });
    const registry = loadRegistry();
    const known = registry.some((s) => s.name === name);
    const dir = path.join(SITES_DIR, name);
    const dirExists = fs.existsSync(dir);
    if (!known && !dirExists) return res.status(404).json({ error: 'Site not found: ' + name });
    if (dirExists) await fsp.rm(dir, { recursive: true, force: true });
    saveRegistry(registry.filter((s) => s.name !== name));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// --- public serving: GET /s (index) and GET /s/:name(/...) ---

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

// Tiny monochrome page shell — matches the dashboard: black, white, grey.
const PAGE_CSS = [
  '*{box-sizing:border-box}',
  'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#fafafa;',
  "font-family:system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;padding:24px}",
  'main{width:100%;max-width:440px}',
  'h1{margin:0;font-size:17px;font-weight:700;letter-spacing:-0.02em}',
  '.meta{margin:4px 0 0;color:#a3a3a3;font-size:13px}',
  'ul{margin:18px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}',
  'a{display:block;padding:11px 14px;border:1px solid rgba(255,255,255,0.12);border-radius:10px;',
  'color:#fafafa;text-decoration:none;font-size:14px;transition:border-color 0.15s,background 0.15s}',
  'a:hover{border-color:rgba(255,255,255,0.3);background:rgba(255,255,255,0.04)}',
  '.home{margin-top:18px;text-align:center}',
  '.err{margin:0;font-size:56px;font-weight:700;letter-spacing:-0.03em}',
].join('');

function page(title, bodyHtml) {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + esc(title) + '</title><style>' + PAGE_CSS + '</style></head>' +
    '<body><main>' + bodyHtml + '</main></body></html>'
  );
}

function send404(res) {
  res
    .status(404)
    .type('html')
    .send(
      page(
        'Not found — MittiHost',
        '<p class="err">404</p>' +
          '<p class="meta">This page is not hosted here.</p>' +
          '<p class="home"><a href="/s">All hosted sites</a></p>'
      )
    );
}

const ENTRY_NAMES = ['index.html', 'index.htm', 'default.html', 'home.html'];

async function listHtmlPages(dirAbs) {
  const ents = await fsp.readdir(dirAbs, { withFileTypes: true }).catch(() => []);
  return ents
    .filter((e) => e.isFile() && /\.html?$/i.test(e.name))
    .map((e) => e.name)
    .sort();
}

/**
 * The page a folder answers with: a usual entry name first, then the only HTML
 * file in the folder when there is exactly one. Null otherwise.
 */
async function findEntryPage(dirAbs) {
  for (const n of ENTRY_NAMES) {
    const st = await fsp.lstat(path.join(dirAbs, n)).catch(() => null);
    if (st && st.isFile()) return { abs: path.join(dirAbs, n), st };
  }
  const htmls = await listHtmlPages(dirAbs);
  if (htmls.length !== 1) return null;
  const abs = path.join(dirAbs, htmls[0]);
  return { abs, st: await fsp.lstat(abs) };
}

/** Plain links to the HTML pages of a folder that has several and no entry page. */
async function sendPageList(res, name, dirAbs, rel) {
  const htmls = await listHtmlPages(dirAbs);
  if (htmls.length === 0) return send404(res);
  const base = '/s/' + encodeURIComponent(name) + (rel ? '/' + rel.split('/').map(encodeURIComponent).join('/') : '');
  const items = htmls
    .map((f) => '<li><a href="' + esc(base.replace(/\/$/, '') + '/' + encodeURIComponent(f)) + '">' + esc(f) + '</a></li>')
    .join('');
  res.type('html').send(page('Pages — MittiHost', '<h1>Pages in this site</h1><ul>' + items + '</ul>'));
}

/** Serve one file, or the folder's entry page when the target is a directory. */
async function serveSiteFile(req, res, rel) {
  const name = req.params.name;
  if (!isSiteName(name)) return send404(res);
  const siteDir = path.join(SITES_DIR, name);

  let abs;
  try {
    abs = resolveSafe(rel, siteDir);
  } catch {
    return send404(res); // escape attempt: answer like any other miss
  }

  let st = await fsp.lstat(abs).catch(() => null);
  if (st && st.isDirectory()) {
    const entry = await findEntryPage(abs);
    if (!entry) return sendPageList(res, name, abs, rel);
    abs = entry.abs;
    st = entry.st;
  }
  if (!st || st.isSymbolicLink() || !st.isFile()) return send404(res);

  const type = CONTENT_TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  if (type.startsWith('text/html')) countHit(name); // real page loads feed the MittiBadge
  const buf = await fsp.readFile(abs);
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', buf.length);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(buf);
}

serveRouter.get('/', async (req, res, next) => {
  try {
    const entries = loadRegistry().filter((s) => isSiteName(s?.name));
    const list =
      entries.length === 0
        ? '<p class="meta">No sites hosted yet.</p>'
        : '<ul>' +
          entries
            .map(
              (s) =>
                '<li><a href="/s/' + encodeURIComponent(s.name) + '">' + esc(s.name) + '</a></li>'
            )
            .join('') +
          '</ul>';
    res
      .type('html')
      .send(
        page(
          'MittiHost',
          '<h1>MittiHost</h1><p class="meta">Websites hosted from this phone, free.</p>' + list
        )
      );
  } catch (err) {
    next(err);
  }
});

serveRouter.get('/:name', async (req, res, next) => {
  try {
    await serveSiteFile(req, res, '');
  } catch (err) {
    next(err);
  }
});

serveRouter.get('/:name/*', async (req, res, next) => {
  try {
    await serveSiteFile(req, res, req.params[0] || '');
  } catch (err) {
    next(err);
  }
});

// --- mounting ---

function initSites(app) {
  app.use('/api/sites', apiRouter);
  app.use('/s', serveRouter);
  app.use('/badge', badgeRouter);
}

export default apiRouter;
export { serveRouter, initSites };
