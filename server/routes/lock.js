// Lock management API.
//
//   GET /api/lock-status -> { locked, source }   (never the token itself)
//   PUT /api/lock {token} -> set/clear the settings lockToken ('' disables);
//                            while locked, changing it needs the CURRENT
//                            token in the x-mitti-token header (or ?token=),
//                            otherwise 401.
//
// MOUNT NOTE: mounted as app.use('/api', router) in server/index.js.
import { Router } from 'express';

import { isLocked, tokenSource, verify, setLockToken } from '../lib/auth.js';

const router = Router();

router.get('/lock-status', (req, res) => {
  res.json({ locked: isLocked(), source: tokenSource() });
});

router.put('/lock', (req, res) => {
  const token = req.body?.token;
  if (typeof token !== 'string') {
    return res.status(400).json({
      error: 'token must be a string (empty string "" disables the lock)',
    });
  }
  // Already locked? Changing the lock needs the current token first.
  if (isLocked() && !verify(req)) {
    return res.status(401).json({
      error: 'Locked — send the current token in the x-mitti-token header to change it',
    });
  }
  setLockToken(token);
  res.json({ ok: true, locked: isLocked(), source: tokenSource() });
});

export default router;
