// Remote — the SSH door ZCode's "Remote connection → SSH" method connects to.
// GET reports the real state (the port actually listening, the fingerprint).
// POST enable/disable starts or stops the embedded server. Writes sit under the
// global /api lock guard, so an owner-locked cloud needs the token to change them.
import { Router } from 'express';
import net from 'node:net';

import {
  startSsh,
  stopSsh,
  sshState,
  sshPort,
  sshUser,
  hostFingerprint,
  authorizedKeys,
  SSH_DIR,
} from '../lib/sshserver.js';
import { isLocked } from '../lib/auth.js';

const router = Router();

/** True when something already accepts TCP on this port (a system sshd, or ours). */
function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    sock.setTimeout(400, () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => resolve(false));
  });
}

function describe(state) {
  const port = state.port || sshPort();
  return {
    enabled: state.running,
    listening: state.listening,
    error: state.error,
    host: '127.0.0.1',
    port,
    username: sshUser(),
    authMode: isLocked() ? 'lock-token' : 'locked-off',
    authorizedKeys: authorizedKeys().length,
    fingerprint: state.running ? hostFingerprint() : null,
    hostKeyDir: SSH_DIR,
    // ZCode's SSH fields, exactly as its wizard asks for them
    zcode: { host: '<your-phone-or-vps-address>', port, username: sshUser(), password: 'your MittiCloud lock token' },
  };
}

router.get('/ssh', async (req, res, next) => {
  try {
    const state = sshState();
    const port = state.port || sshPort();
    const systemSshd = !state.running && (await portOpen(port));
    res.json({ ...describe(state), source: state.running ? 'embedded' : systemSshd ? 'system' : null, systemSshdOnPort: systemSshd });
  } catch (err) {
    next(err);
  }
});

router.post('/ssh/enable', (req, res, next) => {
  try {
    startSsh({ host: req.body?.lan === true ? '0.0.0.0' : '127.0.0.1', port: sshPort() });
    res.json({ ok: true, ...describe(sshState()) });
  } catch (err) {
    next(err);
  }
});

router.post('/ssh/disable', (req, res, next) => {
  try {
    stopSsh();
    res.json({ ok: true, ...describe(sshState()) });
  } catch (err) {
    next(err);
  }
});

export default router;
