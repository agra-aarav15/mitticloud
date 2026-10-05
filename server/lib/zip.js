// Minimal ZIP engine — zero dependencies (Node zlib only).
// write: build a .zip Buffer from {path -> Buffer} entries (deflate, fall back to store).
// read:  parse a .zip Buffer back into {path -> Buffer} (supports store + deflate).
// Enough for folder download, photo download-all, and site ZIP upload. Not a
// general-purpose archiver: no zip64, no encryption, no directories-as-entries.
import zlib from 'node:zlib';

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// DOS date/time (local, 2-second granularity — fine for downloads)
function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

/**
 * Build a ZIP archive.
 * @param {Array<{path: string, data: Buffer, mtime?: Date}>} entries — POSIX-style paths, no leading slash, no '..'
 * @returns {Buffer}
 */
export function zipWrite(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.path.replace(/\\/g, '/'), 'utf8');
    const data = entry.data;
    const { time, day } = dosDateTime(entry.mtime || now);
    const crc = crc32(data);

    let method = 8; // deflate
    let payload = zlib.deflateRawSync(data, { level: 6 });
    if (payload.length >= data.length) {
      method = 0; // store — tiny files don't benefit
      payload = data;
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // no extra

    chunks.push(local, nameBuf, payload);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6); // version needed
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(day, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(payload.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    // extra, comment, disk, internal attrs = 0
    cen.writeUInt32LE(0, 38); // external attrs
    cen.writeUInt32LE(offset, 42);

    central.push(Buffer.concat([cen, nameBuf]));
    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuf, end]);
}

/**
 * Read a ZIP archive.
 * @param {Buffer} buf
 * @param {{maxInflatedBytes?: number}} opts — total uncompressed cap (zip-bomb guard)
 * @returns {Array<{path: string, data: Buffer}>} — entries sorted by name
 */
export function zipRead(buf, opts = {}) {
  const maxInflated = opts.maxInflatedBytes || 100 * 1024 * 1024;
  // find End Of Central Directory (scan back over possible comment)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (no end-of-central-directory)');

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  let inflatedTotal = 0;

  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const uncompSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    inflatedTotal += uncompSize;
    if (inflatedTotal > maxInflated) {
      throw new Error(`Archive inflates past ${Math.round(maxInflated / 1024 / 1024)} MB — refused`);
    }

    // local header: sizes there can differ (streaming writers put 0 here)
    const l = localOffset;
    if (buf.readUInt32LE(l) !== 0x04034b50) throw new Error('Corrupt ZIP local header');
    const lNameLen = buf.readUInt16LE(l + 26);
    const lExtraLen = buf.readUInt16LE(l + 28);
    const dataStart = l + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);

    if (name.endsWith('/')) {
      // directory entry — skip
    } else {
      out.push({ path: name.replace(/\\/g, '/'), data });
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}
