// MittiCloud server entrypoint.
// Express app: JSON body parsing, static /photos mount (vault/photos),
// static frontend (public/), the six API routers, MittiOps hooks, listen 7333.
// Also: optional lock-token guard on all API writes, /api/backup/run, deep
// health, graceful shutdown. Imports `app` to reuse it (tests): the server
// only listens when this file is the entrypoint (`npm start`).
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import healthRouter from './routes/health.js';
import statusRouter from './routes/status.js';
import photosRouter from './routes/photos.js';
import filesRouter from './routes/files.js';
import hostRouter from './routes/host.js';
import badgeRouter from './routes/badge.js';
import lockRouter from './routes/lock.js';
import { initTasks } from './routes/tasks.js';
import { initSites } from './routes/sites.js';
import { initAgent } from './routes/agent.js';
import bridgeRouter from './routes/bridge.js';
import { lockWrites } from './lib/auth.js';
import { initBackup, runBackupNow } from './lib/backup.js';
import {
  DATA_DIR,
  PUBLIC_DIR,
  VAULT_DIR,
  PHOTOS_DIR,
  FILES_DIR,
} from './lib/paths.js';
import { getLanIPs } from './lib/net.js';
import { set as storeSet } from './lib/store.js';

const PORT = Number.parseInt(process.env.PORT || '', 10) || 7333;

// Runtime dirs (vault + data) are created on boot and never committed.
for (const dir of [DATA_DIR, VAULT_DIR, PHOTOS_DIR, FILES_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const app = express();
app.disable('x-powered-by');

// --- LOCK (scoped): guard writes on the two routers mounted below the global
//     parser. Registered BEFORE them so it runs first; the global guard after
//     express.json covers everything else. Running twice is safe. ---
app.use('/api/sites', lockWrites);
app.use('/api/bridge/sessions', lockWrites);

// --- MittiHost (/s, /api/sites) + Cloud Mode (/api/bridge/sessions) mount
//     BEFORE the global 1MB JSON parser: site and context uploads carry
//     multi-MB bodies and both modules set their own larger limits ---
initSites(app);
app.use('/api/bridge/sessions', bridgeRouter);

app.use(express.json({ limit: '1mb' }));

// --- LOCK (global): while a lock token is set, every state-changing API call
//     needs the x-mitti-token header (or ?token=) — see server/lib/auth.js.
//     GET/HEAD/OPTIONS and /api/lock(-status) + /api/health stay open. ---
app.use('/api', lockWrites);

// --- API ---
app.use('/api/health', healthRouter);
app.use('/api/status', statusRouter);
app.use('/api', lockRouter); // router paths: GET /lock-status, PUT /lock
app.use('/api/photos', photosRouter);
app.use('/api/files', filesRouter);
app.use('/api/host', hostRouter); // LAN URLs + Cloudflare tunnel + load test

// --- backup: one-shot settings snapshot (lock-protected via the guard above)
app.post('/api/backup/run', (req, res, next) => {
  try {
    res.json({ ok: true, folder: runBackupNow() });
  } catch (err) {
    next(err);
  }
});

// --- MittiOps: /api/tasks CRUD + scheduler, POST /hook/<webhookId> triggers ---
// (must mount before the 404 catch-alls below; /hook is a WRITE — a webhook
// runs task code — so it sits under the lock guard like every other mutation)
app.use('/hook', lockWrites);
initTasks(app);

// --- MittiAgent: /api/agent + 60s scheduler (mounts its own router) ---
initAgent(app);

// --- static: photo vault ---
app.use('/photos', express.static(PHOTOS_DIR, { maxAge: '1h' }));

// --- static: frontend (owned by the frontend agent; may not exist yet) ---
app.use(express.static(PUBLIC_DIR));

// --- 404s ---
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// --- error handler ---
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const isMulterError =
    (typeof multer.MulterError === 'function' && err instanceof multer.MulterError) ||
    (err && err.name === 'MulterError');
  if (isMulterError) {
    return res.status(400).json({ error: `Upload failed: ${err.message}` });
  }
  const status =
    Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599
      ? err.status
      : 500;
  if (status >= 500) console.error('[mitticloud] error:', err);
  res.status(status).json({ error: err?.message || 'Internal server error' });
});

// --- boot: listen, shutdown hooks, backup timer — only as the main module.
//     Tests import { app } and listen on their own port. ---
const IS_MAIN =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (IS_MAIN) {
  const server = app.listen(PORT, () => {
    console.log(`MittiCloud v0.10.0 running at http://localhost:${PORT}`);
    for (const { iface, address } of getLanIPs()) {
      console.log(`  also on http://${address}:${PORT} (${iface})`);
    }
    try {
      storeSet('lastStartedAt', new Date().toISOString());
    } catch {
      // never block boot on the state file
    }
  });

  // Graceful shutdown: SIGINT/SIGTERM stop accepting connections, finish
  // in-flight requests, exit; a 5s force-exit covers stuck sockets.
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`[mitticloud] ${signal} received — closing server...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  initBackup(); // daily settings backup (boot snapshot + every 6h)
}

export { app };
