// LAN address helpers: used by the startup banner and the tunnel hint.
import os from 'node:os';

/**
 * All non-internal IPv4 addresses of this machine.
 * Returns [{ iface, address }].
 */
export function getLanIPs() {
  const out = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.internal) continue;
      if (addr.family !== 'IPv4') continue;
      out.push({ iface, address: addr.address });
    }
  }
  return out;
}
