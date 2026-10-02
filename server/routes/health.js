// GET /api/health -> { ok: true, uptimeSec }
import { Router } from 'express';

const router = Router();

router.get('/', (req, res) => {
  res.json({ ok: true, uptimeSec: Math.floor(process.uptime()) });
});

export default router;
