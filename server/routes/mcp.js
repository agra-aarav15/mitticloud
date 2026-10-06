// HTTP MCP transport: POST /mcp with `Authorization: Bearer mitti_...` (a
// client key from /api/clients/keys). Lets AI apps connect over the network —
// LAN, tunnel or Tailscale — not just from this machine. The stdio script
// (scripts/mitti-mcp.mjs) proxies into this endpoint for local clients.
import express, { Router } from 'express';

import { verifyKey } from '../lib/clientKeys.js';
import { handleRpc } from '../lib/mcpCore.js';

const router = Router();

router.post('/mcp', async (req, res) => {
  const auth = String(req.headers.authorization || '');
  const client = verifyKey(auth.replace(/^Bearer\s+/i, '').trim());
  if (!client) {
    return res.status(401).json({
      error:
        'Missing or unknown client key. Create one in MittiCloud → Remote → Apps, then send: Authorization: Bearer mitti_...',
    });
  }
  const body = Array.isArray(req.body) ? req.body : [req.body];
  const replies = [];
  for (const one of body) {
    // eslint-disable-next-line no-await-in-loop
    const reply = await handleRpc(one, client);
    if (reply) replies.push(reply);
  }
  if (!replies.length) return res.status(202).json({}); // only notifications
  res.json(replies.length === 1 ? replies[0] : replies);
});

export default router;
