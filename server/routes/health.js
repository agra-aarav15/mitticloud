// GET /api/health       -> { ok: true, uptimeSec }
// GET /api/health?deep=1 -> { ok, uptimeSec, mem, vaultWritable, dataOk, checks }
import { Router } from 'express';

import { runSelfCheck } from '../lib/selfcheck.js';

const router = Router();

router.get('/', (req, res) => {
  const uptimeSec = Math.floor(process.uptime());
  if (req.query.deep !== '1') {
    return res.json({ ok: true, uptimeSec });
  }
  const { mem, vaultWritable, dataOk, checks } = runSelfCheck();
  res.json({
    ok: vaultWritable && dataOk,
    uptimeSec,
    mem,
    vaultWritable,
    dataOk,
    checks,
  });
});

export default router;
