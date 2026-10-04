// BLAKE3 — plain hash mode only, pure JS, zero dependencies.
// Needed because Cloudflare Pages direct upload hashes every asset with
// blake3(base64(content) + extension) — see wrangler's @cloudflare/deploy-helpers.
// Implements the official reference algorithm (chunk tree, 1024-byte chunks,
// 64-byte blocks). Verified against the official BLAKE3 test vectors in
// server/test/cfpages.test.js — if this file changes, those vectors re-run.
const IV = Uint32Array.from([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const MSG_PERMUTATION = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
const CHUNK_START = 1;
const CHUNK_END = 2;
const PARENT = 4;
const ROOT = 8;
const BLOCK_LEN = 64;
const CHUNK_LEN = 1024;

function rotr(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function g(s, a, b, c, d, mx, my) {
  s[a] = (s[a] + s[b] + mx) >>> 0;
  s[d] = rotr(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotr(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b] + my) >>> 0;
  s[d] = rotr(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotr(s[b] ^ s[c], 7);
}

function round(s, m) {
  g(s, 0, 4, 8, 12, m[0], m[1]);
  g(s, 1, 5, 9, 13, m[2], m[3]);
  g(s, 2, 6, 10, 14, m[4], m[5]);
  g(s, 3, 7, 11, 15, m[6], m[7]);
  g(s, 0, 5, 10, 15, m[8], m[9]);
  g(s, 1, 6, 11, 12, m[10], m[11]);
  g(s, 2, 7, 8, 13, m[12], m[13]);
  g(s, 3, 4, 9, 14, m[14], m[15]);
}

function permute(m) {
  const old = m.slice();
  for (let i = 0; i < 16; i++) m[i] = old[MSG_PERMUTATION[i]];
}

function compress(cv, blockWords16, blockLen, counter, flags) {
  const s = new Uint32Array(16);
  s.set(cv.subarray ? cv.subarray(0, 8) : cv.slice(0, 8), 0);
  s.set(IV, 8);
  s[12] = counter >>> 0;
  s[13] = Math.floor(counter / 0x100000000) >>> 0;
  s[14] = blockLen;
  s[15] = flags;
  const m = blockWords16;
  round(s, m);
  permute(m);
  round(s, m);
  permute(m);
  round(s, m);
  permute(m);
  round(s, m);
  permute(m);
  round(s, m);
  permute(m);
  round(s, m);
  permute(m);
  round(s, m);
  for (let i = 0; i < 8; i++) s[i] = (s[i] ^ s[i + 8]) >>> 0;
  return s.slice(0, 8);
}

function wordsFromBlock(bytes /* 64-byte Uint8Array */) {
  const w = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    w[i] =
      (bytes[i * 4] |
        (bytes[i * 4 + 1] << 8) |
        (bytes[i * 4 + 2] << 16) |
        (bytes[i * 4 + 3] << 24)) >>>
      0;
  }
  return w;
}

class Output {
  constructor(inputCv, blockWords, counter, blockLen, flags) {
    this.inputCv = inputCv;
    this.blockWords = blockWords;
    this.counter = counter;
    this.blockLen = blockLen;
    this.flags = flags;
  }
  chainingValue() {
    return compress(this.inputCv, this.blockWords, this.blockLen, this.counter, this.flags);
  }
  rootBytes(outLen) {
    const out = new Uint8Array(outLen);
    let made = 0;
    let outputCounter = 0;
    while (made < outLen) {
      const words = compress(
        this.inputCv,
        this.blockWords,
        this.blockLen,
        outputCounter,
        this.flags | ROOT
      );
      for (let i = 0; i < 8 && made < outLen; i++) {
        const w = words[i];
        out[made++] = w & 0xff;
        if (made < outLen) out[made++] = (w >>> 8) & 0xff;
        if (made < outLen) out[made++] = (w >>> 16) & 0xff;
        if (made < outLen) out[made++] = (w >>> 24) & 0xff;
      }
      outputCounter++;
    }
    return out;
  }
}

class ChunkState {
  constructor(keyWords, chunkCounter, flags) {
    this.cv = keyWords.slice(0, 8);
    this.chunkCounter = chunkCounter;
    this.flags = flags;
    this.block = new Uint8Array(BLOCK_LEN);
    this.blockLen = 0;
    this.blocksCompressed = 0;
  }
  len() {
    return BLOCK_LEN * this.blocksCompressed + this.blockLen;
  }
  startFlag() {
    return this.blocksCompressed === 0 ? CHUNK_START : 0;
  }
  update(input, start, end) {
    let pos = start;
    while (pos < end) {
      if (this.blockLen === BLOCK_LEN) {
        this.cv = compress(
          this.cv,
          wordsFromBlock(this.block),
          BLOCK_LEN,
          this.chunkCounter,
          this.flags | this.startFlag()
        );
        this.block.fill(0);
        this.blockLen = 0;
        this.blocksCompressed++;
      }
      const want = BLOCK_LEN - this.blockLen;
      const take = Math.min(want, end - pos);
      this.block.set(input.subarray(pos, pos + take), this.blockLen);
      this.blockLen += take;
      pos += take;
    }
  }
  output() {
    return new Output(
      this.cv,
      wordsFromBlock(this.block),
      this.chunkCounter,
      this.blockLen,
      this.flags | CHUNK_END | this.startFlag()
    );
  }
}

function parentOutput(leftCv, rightCv, keyWords, flags) {
  const blockWords = new Uint32Array(16);
  blockWords.set(leftCv.subarray ? leftCv.subarray(0, 8) : leftCv.slice(0, 8), 0);
  blockWords.set(rightCv.subarray ? rightCv.subarray(0, 8) : rightCv.slice(0, 8), 8);
  return new Output(keyWords, blockWords, 0, BLOCK_LEN, PARENT | flags);
}

class Hasher {
  constructor() {
    this.chunkState = new ChunkState(IV, 0, 0);
    this.keyWords = IV;
    this.cvStack = [];
    this.flags = 0;
    this.totalChunks = 0;
  }
  update(input, start = 0, end = input.length) {
    let pos = start;
    while (pos < end) {
      if (this.chunkState.len() === CHUNK_LEN) {
        const chunkCv = this.chunkState.output().chainingValue();
        this.totalChunks += 1;
        this.addChunkCv(chunkCv, this.totalChunks);
        this.chunkState = new ChunkState(IV, this.totalChunks, 0);
      }
      const want = CHUNK_LEN - this.chunkState.len();
      const take = Math.min(want, end - pos);
      this.chunkState.update(input, pos, pos + take);
      pos += take;
    }
  }
  addChunkCv(newCv, totalChunks) {
    while ((totalChunks & 1) === 0) {
      const left = this.cvStack.pop();
      newCv = parentOutput(left, newCv, IV, 0).chainingValue();
      totalChunks = Math.floor(totalChunks / 2);
    }
    this.cvStack.push(newCv);
  }
  finalizeHex() {
    let output = this.chunkState.output();
    for (let i = this.cvStack.length - 1; i >= 0; i--) {
      output = parentOutput(this.cvStack[i], output.chainingValue(), IV, 0);
    }
    return toHex(output.rootBytes(32));
  }
}

function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/** BLAKE3 hash of a byte array, hex-encoded (32 bytes = 64 hex chars). */
export function blake3hex(bytes) {
  const h = new Hasher();
  h.update(bytes);
  return h.finalizeHex();
}

/**
 * The exact asset hash Cloudflare Pages direct upload expects:
 * blake3( base64(file bytes) + extension-without-dot ).hex()[0..32].
 * Files without an extension hash with the empty-string suffix.
 */
export function pagesAssetHash(contentBuffer, filename) {
  const base64 = Buffer.from(contentBuffer).toString('base64');
  const dot = filename.lastIndexOf('.');
  const ext = dot > 0 ? filename.slice(dot + 1) : '';
  return blake3hex(Buffer.from(base64 + ext, 'utf8')).slice(0, 32);
}
