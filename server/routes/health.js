// GET /api/health       -> { ok: true, uptimeSec }
// GET /api/health?deep=1 -> { ok, uptimeSec, mem, vaultWritable, dataOk, checks,
//                             sites: { total, up, results }, backup: { ageMs, at, ok } }
import { Router } from 'express';

import { runSelfCheck, checkSites, checkBackupAge } from '../lib/selfcheck.js';

const router = Router();

router.get('/', async (req, res, next) => {
  const uptimeSec = Math.floor(process.uptime());
  if (req.query.deep !== '1') {
    return res.json({ ok: true, uptimeSec });
  }
  try {
    const { mem, vaultWritable, dataOk, checks } = runSelfCheck();
    // the site probe re-enters through this very server, so build the origin
    // from the request — any port (including ephemeral test ports) works
    const origin = `${req.protocol}://${req.get('host')}`;
    const [sites, backup] = await Promise.all([checkSites(origin), checkBackupAge()]);
    res.json({
      ok: vaultWritable && dataOk,
      uptimeSec,
      mem,
      vaultWritable,
      dataOk,
      checks,
      sites,
      backup,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
