// tools/gen-unicode-tables.cjs — regenerate server/lib/mitti-unicode-tables.cjs
//
// The client servers/agents ZCode runs use regexes with \p{...}, which a Node
// WITHOUT ICU cannot compile. This dumps exact class ranges from a full-ICU Node
// so the ICU-less phone can substitute them. Run: node tools/gen-unicode-tables.cjs
const fs = require('fs');
const path = require('path');

// Every property a client server, agent or hosted package may put in a \p{...}
// escape. The first group is what ZCode itself used; the rest are the binary
// properties, general categories and scripts that real npm packages (Next.js's
// bundled zod and @edge-runtime, for one) rely on. Adding a name here is the
// whole fix for "Invalid property name" on the ICU-less phone.
const PROPS = [
  // what the client's own servers and agents use
  'L', 'N', 'M', 'S', 'P', 'Pd', 'White_Space', 'Script=Han',
  'Extended_Pictographic', 'Regional_Indicator', 'Emoji_Component',
  // identifier + text properties (parsers, validators, the edge runtime)
  'ID_Start', 'ID_Continue', 'XID_Start', 'XID_Continue', 'Alphabetic',
  'Lowercase', 'Uppercase', 'Cased', 'Case_Ignorable', 'Dash',
  'Quotation_Mark', 'Terminal_Punctuation', 'Diacritic', 'Extender', 'Join_Control',
  'Default_Ignorable_Code_Point', 'Ideographic', 'Math', 'Hex_Digit',
  'ASCII_Hex_Digit', 'Bidi_Control', 'Pattern_Syntax', 'Pattern_White_Space',
  'Radical', 'Soft_Dotted', 'Unified_Ideograph', 'Variation_Selector',
  'Noncharacter_Code_Point',
  // emoji
  'Emoji', 'Emoji_Presentation', 'Emoji_Modifier', 'Emoji_Modifier_Base',
  // general categories
  'Lu', 'Ll', 'Lt', 'Lm', 'Lo', 'Mn', 'Mc', 'Me', 'Nd', 'Nl', 'No',
  'Pc', 'Ps', 'Pe', 'Pi', 'Pf', 'Po', 'Sm', 'Sc', 'Sk', 'So', 'Zs', 'Zl',
  'Zp', 'Cc', 'Cf', 'Co', 'Cs', 'Cn',
  // scripts — India-first and the common ones
  'Script=Latin', 'Script=Greek', 'Script=Cyrillic', 'Script=Arabic',
  'Script=Hebrew', 'Script=Hiragana', 'Script=Katakana', 'Script=Hangul',
  'Script=Thai', 'Script=Devanagari', 'Script=Bengali', 'Script=Tamil',
  'Script=Telugu', 'Script=Gujarati', 'Script=Gurmukhi', 'Script=Kannada',
  'Script=Malayalam', 'Script=Oriya', 'Script=Common', 'Script=Inherited',
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
const skipped = [];
for (const p of PROPS) {
  let rs;
  try {
    rs = rangesFor(p);
  } catch (err) {
    // A name this V8 does not accept (not an ECMAScript property) is skipped
    // rather than killing the whole run — only properties a regex can legally
    // name are worth a table.
    skipped.push(p + ' (' + err.message + ')');
    continue;
  }
  const bmp = rs.filter(([a]) => a <= 0xffff);
  const astral = rs.filter(([a]) => a > 0xffff);
  const encBmp = (list) => list.map(([a, b]) => (a === b ? '\\u' + hx4(a) : '\\u' + hx4(a) + '-\\u' + hx4(b))).join('');
  const encAstralU = (list) => list.map(([a, b]) => (a === b ? '\\u{' + a.toString(16) + '}' : '\\u{' + a.toString(16) + '}-\\u{' + b.toString(16) + '}')).join('');
  spec[p] = { u: encBmp(bmp) + encAstralU(astral), n: encBmp(bmp) + astral.map(astralNoU).join('') };
}

// Alias names for the same set of code points. Bundled tools spell the general
// categories in their LONG form — webpack's parser uses \p{Uppercase_Letter}
// where V8 also accepts \p{Lu} — and V8's loose matching makes any casing of
// any spelling legal, so the tables must answer every spelling. Each alias
// maps to a canonical name already in spec; its entry is copied verbatim.
const ALIASES = {
  // general categories, long form
  Uppercase_Letter: 'Lu', Lowercase_Letter: 'Ll', Titlecase_Letter: 'Lt',
  Modifier_Letter: 'Lm', Other_Letter: 'Lo', Letter: 'L',
  Nonspacing_Mark: 'Mn', Spacing_Mark: 'Mc', Enclosing_Mark: 'Me', Mark: 'M',
  Decimal_Number: 'Nd', Letter_Number: 'Nl', Other_Number: 'No', Number: 'N',
  Connector_Punctuation: 'Pc', Dash_Punctuation: 'Pd', Open_Punctuation: 'Ps',
  Close_Punctuation: 'Pe', Initial_Punctuation: 'Pi', Final_Punctuation: 'Pf',
  Other_Punctuation: 'Po', Punctuation: 'P',
  Math_Symbol: 'Sm', Currency_Symbol: 'Sc', Modifier_Symbol: 'Sk',
  Other_Symbol: 'So', Symbol: 'S',
  Space_Separator: 'Zs', Line_Separator: 'Zl', Paragraph_Separator: 'Zp',
  Separator: 'Z',
  Control: 'Cc', Format: 'Cf', Surrogate: 'Cs', Private_Use: 'Co',
  Unassigned: 'Cn',
  // binary-property short forms
  Alpha: 'Alphabetic', Lower: 'Lowercase', Upper: 'Uppercase',
  WhiteSpace: 'White_Space', IDS: 'ID_Start', IDC: 'ID_Continue',
  XIDS: 'XID_Start', XIDC: 'XID_Continue',
};
// the gc= prefix form (V8 accepts \p{gc=Lu} and friends)
for (const short of ['Lu', 'Ll', 'Lt', 'Lm', 'Lo', 'L', 'Mn', 'Mc', 'Me', 'M', 'Nd', 'Nl', 'No', 'N', 'Pc', 'Pd', 'Ps', 'Pe', 'Pi', 'Pf', 'Po', 'P', 'Sm', 'Sc', 'Sk', 'So', 'S', 'Zs', 'Zl', 'Zp', 'Z', 'Cc', 'Cf', 'Cs', 'Co', 'Cn']) {
  ALIASES['gc=' + short] = short;
}
// the script short forms (sc=, scx=) for every script the tables cover
for (const p of PROPS) {
  if (p.startsWith('Script=')) {
    const name = p.slice(7);
    ALIASES['sc=' + name] = p;
    ALIASES['scx=' + name] = p;
  }
}
for (const [alias, canon] of Object.entries(ALIASES)) {
  if (spec[canon] && !spec[alias]) spec[alias] = spec[canon];
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
console.log('wrote', out, body.length, 'bytes;', Object.keys(spec).length, 'classes');
if (skipped.length) console.log('skipped (not an ECMAScript property):', skipped.join(', '));