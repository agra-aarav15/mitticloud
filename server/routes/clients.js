// Client keys API: create (full key returned ONCE), list (redacted), revoke.
// The lock guard on /api already covers the mutations (mounted after
// express.json + the global guard in index.js).
import express, { Router } from 'express';

import { createKey, listKeys, revokeKey } from '../lib/clientKeys.js';

const router = Router();

router.get('/keys', (req, res) => {
  res.json({ keys: listKeys() });
});

router.post('/keys', (req, res, next) => {
  try {
    const { key, record } = createKey(req.body?.name);
    res.status(201).json({ key, record });
  } catch (err) {
    next(err);
  }
});

router.delete('/keys/:id', (req, res, next) => {
  try {
    res.json(revokeKey(req.params.id));
  } catch (err) {
    next(err);
  }
});

export default router;
