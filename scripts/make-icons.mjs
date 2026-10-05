// Render the MittiCloud app icons (monochrome: #0a0a0a field, #fafafa pot
// glyph) to PNGs with zero dependencies — a hand-rolled PNG encoder over
// zlib. Run once:  node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public', 'icons');

// --- minimal PNG (8-bit RGBA, no interlace) ---

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // raw scanlines: one filter byte (0) then RGBA rows
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- geometry: the pot/heart glyph scaled into the canvas ---

// Normalized glyph (from the favicon path, 0..32 box): a rounded "pot" whose
// top is the lid and whose tail comes to a point.
const GLYPH = [
  // [x from, x to, y from, y to] rectangles approximating the glass-pot shape
  [10, 22, 7, 11], // lid
  [9, 23, 11, 14], // shoulders
  [9, 23, 14, 17], // body
  [11, 21, 17, 20], // lower body
  [13.5, 18.5, 20, 23], // tail
];

function colorAt(nx, ny) {
  // nx, ny in 0..32 space
  for (const [x0, x1, y0, y1] of GLYPH) {
    if (nx >= x0 && nx <= x1 && ny >= y0 && ny <= y1) return 'fg';
  }
  return 'bg';
}

function render(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  // maskable icons must keep art inside the safe zone (80% center)
  const scale = maskable ? 0.62 : 0.78;
  const off = (32 - 32 * scale) / 2; // glyph-space offset to center
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // map pixel to the 32-unit glyph space
      const gx = ((x + 0.5) / size) * 32;
      const gy = ((y + 0.5) / size) * 32;
      const sx = (gx - off) / scale;
      const sy = (gy - off) / scale;
      const inside = sx >= 0 && sx <= 32 && sy >= 0 && sy <= 32;
      const which = inside ? colorAt(sx, sy) : 'bg';
      const i = (y * size + x) * 4;
      const fg = which === 'fg';
      rgba[i] = fg ? 0xfa : 0x0a;
      rgba[i + 1] = fg ? 0xfa : 0x0a;
      rgba[i + 2] = fg ? 0xfa : 0x0a;
      rgba[i + 3] = 0xff;
    }
  }
  return png(size, size, rgba);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const files = [
  ['icon-192.png', render(192)],
  ['icon-512.png', render(512)],
  ['icon-180.png', render(180)],
  ['icon-maskable-192.png', render(192, { maskable: true })],
  ['icon-maskable-512.png', render(512, { maskable: true })],
];
for (const [name, buf] of files) {
  fs.writeFileSync(path.join(OUT_DIR, name), buf);
  console.log('wrote', name, buf.length, 'bytes');
}