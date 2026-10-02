// MittiCloud server entrypoint.
// Express app: JSON body parsing, static /photos mount (vault/photos),
// static frontend (public/), the five API routers, listen 7333.
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';

import healthRouter from './routes/health.js';
import statusRouter from './routes/status.js';
import photosRouter from './routes/photos.js';
import filesRouter from './routes/files.js';
import sandboxRouter from './routes/sandbox.js';
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
app.use(express.json({ limit: '1mb' }));

// --- API ---
app.use('/api/health', healthRouter);
app.use('/api/status', statusRouter);
app.use('/api/photos', photosRouter);
app.use('/api/files', filesRouter);
app.use('/api/sandbox', sandboxRouter);

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

app.listen(PORT, () => {
  console.log(`MittiCloud v0.3.0 running at http://localhost:${PORT}`);
  for (const { iface, address } of getLanIPs()) {
    console.log(`  also on http://${address}:${PORT} (${iface})`);
  }
  try {
    storeSet('lastStartedAt', new Date().toISOString());
  } catch {
    // never block boot on the state file
  }
});
