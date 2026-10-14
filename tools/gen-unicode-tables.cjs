// tools/gen-unicode-tables.cjs — regenerate server/lib/mitti-unicode-tables.cjs
//
// The client servers/agents ZCode runs use regexes with \p{...}, which a Node
// WITHOUT ICU cannot compile. This dumps exact class ranges from a full-ICU Node
// so the ICU-less phone can substitute them. Run: node tools/gen-unicode-tables.cjs
const fs = require('fs');
const path = require('path');

const PROPS = [
  'L', 'N', 'M', 'S', 'P', 'Pd', 'White_Space', 'Script=Han',
  'Extended_Pictographic', 'Regional_Indicator', 'Emoji_Component',
];

function rangesFor(prop) {
  const re = new RegExp('\\p{' + prop + '}', 'u');
  const rs = [];
  let start = -1, prev = -1;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) {
      if (start >= 0) { rs.push([start, prev]); start = -1; }
      continue;
    }
    const hit = re.test(String.fromCodePoint(cp));
    if (hit) { if (start < 0) start = cp; prev = cp; }
    else if (start >= 0) { rs.push([start, prev]); start = -1; }
  }
  if (start >= 0) rs.push([start, prev]);
  return rs;
}

const hx4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');
const pairSplit = (cp) => ({ hi: 0xd800 + ((cp - 0x10000) >> 10), lo: 0xdc00 + ((cp - 0x10000) & 0x3ff) });
function astralNoU([a, b]) {
  const A = pairSplit(a), B = pairSplit(b);
  const h = hx4;
  if (a === b) return '\\u' + h(A.hi) + '\\u' + h(A.lo);
  if (A.hi === B.hi) return '\\u' + h(A.hi) + '[\\u' + h(A.lo) + '-\\u' + h(B.lo) + ']';
  let out = '\\u' + h(A.hi) + '[\\u' + h(A.lo) + '-\\uDFFF]';
  if (B.hi - A.hi > 1) out += '|[\\u' + h(A.hi + 1) + '-\\u' + h(B.hi - 1) + '][\\uDC00-\\uDFFF]';
  out += '|\\u' + h(B.hi) + '[\\uDC00-\\u' + h(B.lo) + ']';
  return '(?:' + out + ')';
}

const spec = {};
for (const p of PROPS) {
  const rs = rangesFor(p);
  const bmp = rs.filter(([a]) => a <= 0xffff);
  const astral = rs.filter(([a]) => a > 0xffff);
  const encBmp = (list) => list.map(([a, b]) => (a === b ? '\\u' + hx4(a) : '\\u' + hx4(a) + '-\\u' + hx4(b))).join('');
  const encAstralU = (list) => list.map(([a, b]) => (a === b ? '\\u{' + a.toString(16) + '}' : '\\u{' + a.toString(16) + '}-\\u{' + b.toString(16) + '}')).join('');
  spec[p] = { u: encBmp(bmp) + encAstralU(astral), n: encBmp(bmp) + astral.map(astralNoU).join('') };
}

const body =
  '// mitti-unicode-tables.cjs — GENERATED FILE, do not edit by hand.\n' +
  '//\n' +
  '// Exact Unicode class ranges, dumped from a full-ICU Node, so a Node WITHOUT\n' +
  '// ICU (nodejs-mobile\'s Node 18 in the APK) can substitute the \\p{...} escapes\n' +
  '// that the client\'s servers and agents use. `u` is the code-point form (valid\n' +
  '// with the /u flag, which every such regex sets); `n` is the surrogate-pair\n' +
  '// form for a regex without the flag. Regenerate: node tools/gen-unicode-tables.cjs\n' +
  "'use strict';\n\n" +
  'module.exports = ' + JSON.stringify(spec) + ';\n';
const out = path.join(__dirname, '..', 'server', 'lib', 'mitti-unicode-tables.cjs');
fs.writeFileSync(out, body);
console.log('wrote', out, body.length, 'bytes;', PROPS.length, 'classes');