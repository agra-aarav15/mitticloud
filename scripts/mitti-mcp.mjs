#!/usr/bin/env node
// mitti-mcp — stdio MCP proxy for MittiCloud.
//
// Any MCP-capable AI app on THIS machine (ZCode, Claude Desktop, ...) gets the
// cloud as tools. It speaks line-delimited JSON-RPC on stdin/stdout and
// forwards every request to the cloud's HTTP MCP endpoint, so all tool logic
// and auth live server-side (server/lib/mcpCore.js). Zero dependencies.
//
//   MITTI_URL=https://your-cloud.example  MITTI_KEY=mitti_... node mitti-mcp.mjs
//
// ZCode config snippet:
//   "mcpServers": { "mitticloud": { "command": "node",
//     "args": ["<path-to>/mitti-mcp.mjs"],
//     "env": { "MITTI_URL": "http://<phone-ip>:7333", "MITTI_KEY": "mitti_..." } } }

const URL_BASE = (process.env.MITTI_URL || 'http://127.0.0.1:7333').replace(/\/+$/, '');
const KEY = process.env.MITTI_KEY || '';

if (!KEY) {
  process.stderr.write(
    '[mitti-mcp] No MITTI_KEY set. Create a client key in MittiCloud → Remote → Apps and put it in this config.\n'
  );
  process.exit(1);
}

const ENDPOINT = URL_BASE + '/mcp';

async function forward(line) {
  let body;
  try {
    body = JSON.parse(line);
  } catch {
    return; // not JSON — stdin noise; MCP clients don't send this
  }
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: line,
      signal: AbortSignal.timeout(8000), // a hung cloud settles, never freezes the client
    });
    if (res.status === 204 || res.status === 202) return; // notification — no reply
    const text = await res.text();
    if (!text) return;
    // the endpoint answers one reply per request; forward it verbatim
    process.stdout.write(text.replace(/\n+$/, '') + '\n');
  } catch (err) {
    // request with an id deserves an honest protocol-level failure
    if (body && body.id != null && body.jsonrpc === '2.0') {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32000, message: `Cannot reach MittiCloud at ${ENDPOINT}: ${err.message}` },
        }) + '\n'
      );
    }
  }
}

let buf = '';
let chain = Promise.resolve(); // answers go out in the order requests came in
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) chain = chain.then(() => forward(line));
  }
});
// stdin closing must not kill in-flight requests: wait for the chain to drain
// and let the process exit naturally (unref'd cap covers a wedged chain)
process.stdin.on('end', () => {
  const bail = setTimeout(() => {
    process.stderr.write('[mitti-mcp] gave up waiting for the cloud — exiting\n');
    process.exit(1);
  }, 10000);
  bail.unref?.();
  chain.then(() => {
    clearTimeout(bail);
  });
});

process.stderr.write(`[mitti-mcp] bridging stdio → ${ENDPOINT}\n`);
