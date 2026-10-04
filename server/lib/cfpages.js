// Cloudflare Pages direct upload — the "publish to my own domain" engine.
// Zero dependencies: plain fetch against the api.cloudflare.com client API,
// following the same flow wrangler uses:
//   ensure project -> upload-token (JWT) -> hash every file with BLAKE3
//   -> check-missing -> upload missing (base64) -> upsert-hashes
//   -> POST deployment with the manifest -> live on <project>.pages.dev
// The API token is stored in data/cf-token.json and never returned by any
// route (status reports booleans only). The hash primitive lives in
// lib/blake3.js and is verified against the official BLAKE3 test vectors.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';
import { pagesAssetHash } from './blake3.js';

const API = 'https://api.cloudflare.com/client/v4';
const TOKEN_FILE = path.join(DATA_DIR, 'cf-token.json');
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 1000;

// --- token storage (write-only from the API's point of view) ---

export function loadToken() {
  try {
    const j = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    return typeof j.token === 'string' && j.token ? j.token : null;
  } catch {
    return null;
  }
}

export function saveToken(token) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = TOKEN_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ token }) + '\n');
  fs.renameSync(tmp, TOKEN_FILE);
}

export function clearToken() {
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch {
    // already gone
  }
}

// --- low-level call helper ---

async function cfCall(fetchImpl, token, urlPath, opts = {}) {
  const res = await fetchImpl(API + urlPath, {
    ...opts,
    headers: {
      authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(120 * 1000),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok || !body || body.success !== true) {
    const err = body?.errors?.[0];
    const e = new Error(
      err ? `Cloudflare ${err.code}: ${err.message}` : `Cloudflare API error (${res.status})`
    );
    e.code = err?.code;
    e.status = res.status;
    throw e;
  }
  return body.result;
}

// --- accounts ---

/** Verify the token and list accounts: [{id, name}]. */
export async function accountsList(fetchImpl, token) {
  const result = await cfCall(fetchImpl, token, '/accounts?per_page=5');
  return (Array.isArray(result) ? result : []).map((a) => ({ id: a.id, name: a.name }));
}

// --- project ---

async function projectEnsure(fetchImpl, token, accountId, projectName) {
  try {
    await cfCall(fetchImpl, token, `/accounts/${accountId}/pages/projects/${projectName}`);
    return { created: false };
  } catch (err) {
    if (err.code !== 8000007 && err.status !== 404) throw err;
    await cfCall(fetchImpl, token, `/accounts/${accountId}/pages/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: projectName, production_branch: 'main' }),
    });
    return { created: true };
  }
}

// --- files -> hashes ---

const CONTENT_TYPES = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  txt: 'text/plain',
  md: 'text/plain',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  webmanifest: 'application/manifest+json',
};

export function contentTypeFor(filename) {
  const dot = filename.lastIndexOf('.');
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

/** Walk `dir` and return [{rel, abs, size}] sorted by path (rel uses '/'). */
export function collectFiles(dir) {
  const out = [];
  const walk = (cur, rel) => {
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, ent.name);
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(abs, childRel);
      else if (ent.isFile()) out.push({ rel: childRel, abs, size: ent.isDirectory() ? 0 : fs.statSync(abs).size });
    }
  };
  walk(dir, '');
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

/**
 * Deploy a folder of static files as a Pages project.
 * files: [{rel, abs}] from collectFiles. Returns the live URLs.
 */
export async function deploySite(fetchImpl, token, accountId, projectName, files) {
  if (!files.length) throw new Error('The site has no files to publish');
  if (files.length > MAX_FILES) throw new Error(`Too many files (${files.length}); the limit is ${MAX_FILES}`);
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) throw new Error(`${f.rel} is over 20 MB — Pages refuses it`);
  }

  await projectEnsure(fetchImpl, token, accountId, projectName);
  const { jwt } = await cfCall(
    fetchImpl,
    token,
    `/accounts/${accountId}/pages/projects/${projectName}/upload-token`
  );

  // hash everything: blake3(base64(content) + extension), hex-truncated
  const hashed = files.map((f) => {
    const content = fs.readFileSync(f.abs);
    return { ...f, hash: pagesAssetHash(content, f.rel), content };
  });

  const assetAuth = { authorization: `Bearer ${jwt}` };

  // ask which hashes the project is missing, upload only those
  const missing = await cfCall(fetchImpl, token, `/accounts/${accountId}/pages/assets/check-missing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...assetAuth },
    body: JSON.stringify({ hashes: hashed.map((f) => f.hash) }),
  });

  const missingSet = new Set(Array.isArray(missing) ? missing : []);
  const toUpload = hashed.filter((f) => missingSet.has(f.hash));
  if (toUpload.length) {
    // one bucket is plenty for MittiHost-sized sites (wrangler buckets at
    // 25 MB / 1000 files); base64 payload, sorted largest-first like wrangler
    const payload = toUpload
      .slice()
      .sort((a, b) => b.content.length - a.content.length)
      .map((f) => ({
        key: f.hash,
        value: f.content.toString('base64'),
        metadata: { contentType: contentTypeFor(f.rel) },
        base64: true,
      }));
    await cfCall(fetchImpl, token, `/accounts/${accountId}/pages/assets/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...assetAuth },
      body: JSON.stringify(payload),
    });
    await cfCall(fetchImpl, token, `/accounts/${accountId}/pages/assets/upsert-hashes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...assetAuth },
      body: JSON.stringify({ hashes: toUpload.map((f) => f.hash) }),
    });
  }

  // create the deployment: multipart with the manifest (path -> hash)
  const manifest = {};
  for (const f of hashed) manifest['/' + f.rel] = f.hash;
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));
  form.append('branch', 'main');
  const deployment = await cfCall(
    fetchImpl,
    token,
    `/accounts/${accountId}/pages/projects/${projectName}/deployments`,
    { method: 'POST', body: form }
  );

  return {
    project: projectName,
    url: `https://${projectName}.pages.dev`,
    deploymentUrl: deployment?.url || null,
    deploymentId: deployment?.id || null,
    files: hashed.length,
    uploaded: toUpload.length,
  };
}
