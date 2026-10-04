// MittiBadge — the genuinely unique feature: a live, embeddable badge that
// proves a real website is being served from a real drawer phone.
//   GET /badge/<site>.svg   -> tiny monochrome SVG with REAL numbers only
//   GET /badge/<site>       -> copy-paste HTML snippet
// Numbers come from badge-stats (real HTML hits) and the real battery read.
import { Router } from 'express';
import { statsFor } from '../lib/badgestats.js';
import { readBattery } from '../lib/battery.js';

const router = Router();

const SITE_RE = /^[a-z0-9-]{1,32}$/;
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function humanUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((sec % 3600) / 60)}m`;
}

router.get('/:site.svg', async (req, res, next) => {
  try {
    const site = req.params.site.replace(/\.svg$/, '');
    if (!SITE_RE.test(site)) return res.status(404).type('text').send('no such site');
    const stats = statsFor(site);
    const battery = await readBattery();
    const power =
      !battery || battery.present === false
        ? 'AC power'
        : battery.charging
          ? 'charging'
          : `${Math.round(Number(battery.level)) || '?'}% battery`;

    const line2 = `${stats.hits} visits today · up ${humanUptime(process.uptime())} · ${power}`;
    const w = 460;
    const h = 56;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="MittiCloud badge">` +
      `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="#0a0a0a" stroke="rgba(255,255,255,0.18)"/>` +
      `<rect x="14" y="14" width="28" height="28" rx="8" fill="#fafafa"/>` +
      `<text x="20" y="34" font-family="monospace" font-size="16" font-weight="bold" fill="#0a0a0a">M</text>` +
      `<text x="56" y="25" font-family="monospace" font-size="12" font-weight="bold" fill="#fafafa" letter-spacing="1">MITTICLOUD · SERVED FROM A DRAWER PHONE</text>` +
      `<text x="56" y="42" font-family="monospace" font-size="11" fill="#a3a3a3">${esc(line2)}</text>` +
      `</svg>`;
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('image/svg+xml').send(svg);
  } catch (err) {
    next(err);
  }
});

router.get('/:site', (req, res) => {
  const site = req.params.site;
  if (!SITE_RE.test(site)) return res.status(404).type('text').send('no such site');
  const base = `${req.protocol}://${req.get('host')}`;
  res.type('html').send(
    '<!doctype html><meta charset="utf-8"><title>MittiBadge</title>' +
      '<body style="background:#0a0a0a;color:#fafafa;font-family:monospace;padding:24px;line-height:1.7">' +
      '<p>Paste this line into any page this phone serves:</p>' +
      `<pre style="border:1px solid #333;padding:12px;white-space:pre-wrap">&lt;img src="${base}/badge/${site}.svg" alt="Served from a drawer phone" width="460"&gt;</pre>` +
      `<p>Live preview:</p><img src="/badge/${site}.svg" width="460" alt="MittiBadge">`
  );
});

export default router;
