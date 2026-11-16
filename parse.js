// SwiftMark v2 — a fast, dependency-free CommonMark + GFM renderer.
// Returns exactly the HTML that marked 18.1.3 renders with its defaults
// (gfm on, breaks off, pedantic off, async off).
//
// Architecture (written from scratch for this version):
// - Block layer: line-based recursive parser producing small block records.
// - Inline layer: a single-pass scanner that emits a flat event tape
//   (parallel integer arrays, no per-token objects). Emphasis is resolved
//   on the tape as open/close spans; rendering walks the tape once.
// - All scratch (tape, side strings, output chunks) lives in module-level
//   reusable buffers that are reset by integer cursors, so a parse() call
//   allocates almost nothing on the hot path.

const ASCII_PUNCT = new Uint8Array(128);
for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') ASCII_PUNCT[ch.charCodeAt(0)] = 1;

const UNI_PUNCT_RE = /[\p{P}\p{S}]/u;

/** ASCII punctuation test on a char code (0..127). */
function punctCode(c) {
  return c < 128 && ASCII_PUNCT[c] === 1;
}

/** Punctuation test for the character at src[i] (ASCII table, Unicode fallback). */
function punctAt(src, i) {
  if (i < 0 || i >= src.length) return false;
  const c = src.charCodeAt(i);
  if (c < 128) return ASCII_PUNCT[c] === 1;
  return UNI_PUNCT_RE.test(src[i]);
}

/** Whitespace test for the character at src[i] (CommonMark's notion). */
function wsAt(src, i) {
  if (i < 0 || i >= src.length) return false;
  const c = src.charCodeAt(i);
  if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11) return true;
  if (c === 0xa0 || c === 0x1680 || c === 0x202f || c === 0x205f || c === 0x3000) return true;
  return c >= 0x2000 && c <= 0x200a;
}

/** Whitespace test on a char code. */
function wsCode(c) {
  if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11) return true;
  if (c === 0xa0 || c === 0x1680 || c === 0x202f || c === 0x205f || c === 0x3000) return true;
  return c >= 0x2000 && c <= 0x200a;
}

/**
 * Escape &, <, >, ", ' with no entity awareness (code content, alt text).
 * Fast path: a single character-class test skips the loop for clean text.
 */
function escRaw(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

/** Replacement text of the last successful matchEnt call. */
let entOut = '';

/**
 * Try to match an entity reference at s[i] (s[i] is '&').
 * Returns the number of characters consumed, or 0 when there is none.
 * On success entOut holds the replacement: a named reference is kept
 * verbatim, a numeric one is decoded (0, surrogates and > 0x10FFFF
 * become U+FFFD).
 */
function matchEnt(s, i) {
  const n = s.length;
  if (i + 1 >= n) return 0;
  if (s.charCodeAt(i + 1) === 35) {
    let j = i + 2;
    let hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const ds = j;
    if (hex) {
      while (j < n) {
        const c = s.charCodeAt(j);
        if ((c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)) j++;
        else break;
      }
    } else {
      while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    }
    const digits = j - ds;
    if (digits === 0 || digits > (hex ? 6 : 7) || j >= n || s[j] !== ';') return 0;
    let v = parseInt(s.slice(ds, j), hex ? 16 : 10);
    if (v === 0 || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) v = 0xfffd;
    entOut = String.fromCodePoint(v);
    return j + 1 - i;
  }
  let j = i + 1;
  if (j >= n) return 0;
  const c0 = s.charCodeAt(j);
  if (!((c0 >= 97 && c0 <= 122) || (c0 >= 65 && c0 <= 90))) return 0;
  j++;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57)) j++;
    else break;
  }
  if (j >= n || s[j] !== ';') return 0;
  entOut = s.slice(i, j + 1);
  return j + 1 - i;
}

/**
 * Escape text for HTML with entity awareness: a & starting a valid entity
 * reference is left alone (named) or decoded (numeric); any other &
 * becomes &amp;. < > " ' are always escaped.
 */
function escText(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const m = matchEnt(s, i);
      if (m > 0) {
        out += s.slice(start, i) + entOut;
        i += m - 1;
        start = i + 1;
        continue;
      }
      out += s.slice(start, i) + '&amp;';
      start = i + 1;
    } else if (c === 60) { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

/** Decode backslash escapes and entities inside a link destination/title. */
function decodeDest(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && punctCode(s.charCodeAt(i + 1))) {
      out += s.slice(start, i) + s[i + 1];
      i++;
      start = i + 1;
    } else if (c === 38) {
      const m = matchEnt(s, i);
      if (m > 0) {
        out += s.slice(start, i) + entOut;
        i += m - 1;
        start = i + 1;
      }
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

/**
 * One-pass attribute escaping: backslash escapes, entity references
 * (named kept verbatim, numeric decoded then escaped), < > " ' escaped.
 * For hrefs, spaces become %20.
 */
function attrEscape(s, isHref) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && punctCode(s.charCodeAt(i + 1))) {
      const p = s[i + 1];
      let rep = p;
      if (p === '&') rep = '&amp;';
      else if (p === '<') rep = '&lt;';
      else if (p === '>') rep = '&gt;';
      else if (p === '"') rep = '&quot;';
      else if (p === "'") rep = '&#39;';
      out += s.slice(start, i) + rep;
      i++;
      start = i + 1;
    } else if (c === 38) {
      const m = matchEnt(s, i);
      if (m > 0) {
        out += s.slice(start, i) + (s[i + 1] === '#' ? escRaw(entOut) : entOut);
        i += m - 1;
        start = i + 1;
      } else {
        out += s.slice(start, i) + '&amp;';
        start = i + 1;
      }
    } else if (c === 60) { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; start = i + 1; }
    else if (isHref && c === 32) { out += s.slice(start, i) + '%20'; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

/**
 * The href for an autolink URL: entities are resolved, but backslash
 * escapes are NOT (a backslash in an autolink is encoded as %5C).
 * Fast path: a destination with no backslash, entity, space, control,
 * non-ASCII or URI-special character survives encodeURI + escText
 * unchanged, so it is returned as-is.
 */
const HREF_FAST_RE = /[[\\\]&<>"' \u0000-\u0020\u007f-\uffff`{}|^]/;
function hrefOfAuto(raw) {
  if (!HREF_FAST_RE.test(raw)) return raw;
  let s = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 38) {
      const m = matchEnt(raw, i);
      if (m > 0) {
        if (raw[i + 1] === '#') {
          const d = entOut;
          s += d === '&' ? '&amp;' : d;
        } else {
          s += entOut;
        }
        i += m - 1;
      } else {
        s += '&';
      }
    } else {
      s += raw[i];
    }
  }
  let u;
  try {
    u = encodeURI(s).replace(/%25/g, '%');
  } catch {
    u = s;
  }
  return escText(u);
}

/**
 * The href for a raw link destination: backslash escapes and entities are
 * resolved, then the result is URI-encoded (with %25 restored, so an
 * already-encoded %20 stays %20), then HTML-escaped with entity awareness.
 * Fast path: see hrefOfAuto.
 */
function hrefOf(raw) {
  if (!HREF_FAST_RE.test(raw)) return raw;
  let s = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 92 && i + 1 < raw.length && punctCode(raw.charCodeAt(i + 1))) {
      const p = raw[i + 1];
      s += p === '&' ? '&amp;' : p;
      i++;
    } else if (c === 38) {
      const m = matchEnt(raw, i);
      if (m > 0) {
        if (raw[i + 1] === '#') {
          const d = entOut;
          s += d === '&' ? '&amp;' : d;
        } else {
          s += entOut;
        }
        i += m - 1;
      } else {
        s += '&';
      }
    } else {
      s += raw[i];
    }
  }
  let u;
  try {
    u = encodeURI(s).replace(/%25/g, '%');
  } catch {
    u = s;
  }
  return escText(u);
}

/**
 * Flanking info for a delimiter run at src[i..i+n): returns a bitmask,
 * 1 = can open, 2 = can close, using the *-rules (left-flanking opens,
 * right-flanking closes).
 */
function flankMask(src, i, n) {
  const prev = i > 0 ? src[i - 1] : '';
  const next = i + n < src.length ? src[i + n] : '';
  const prevWs = prev === '' || wsAt(src, i - 1);
  const nextWs = next === '' || wsAt(src, i + n);
  const prevP = prev !== '' && punctAt(src, i - 1);
  const nextP = next !== '' && punctAt(src, i + n);
  const left = !nextWs && (!nextP || prevWs || prevP);
  const right = !prevWs && (!prevP || nextWs || nextP);
  return (left ? 1 : 0) | (right ? 2 : 0);
}

// ---------------------------------------------------------------------------
// Inline scanners. Each scanner reports through shared out-registers
// (oEnd / oStr / oStr2 / oKind / oOk) instead of allocating a result,
// because they run on the hot path.
// ---------------------------------------------------------------------------

let oEnd = 0;
let oStr = '';
let oStr2 = '';
let oKind = 0;
let oOk = false;

/**
 * Scan a code span starting at src[i] ('`'). depth is the number of open
 * brackets (it changes how a closer past ']' is treated).
 * Returns the end offset, or 0 when no closer exists; oStr holds content.
 */
function scanCodeSpan(src, i, depth) {
  const n = src.length;
  let m = 0;
  while (i + m < n && src[i + m] === '`') m++;
  let j = i + m;
  let seenClose = false;
  while (j < n) {
    if (src[j] === '`') {
      let k = j;
      while (k < n && src[k] === '`') k++;
      if (k - j === m) {
        let content = src.slice(i + m, j);
        if (content.includes('\n')) content = content.replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        oStr = content;
        return k;
      }
      j = k;
    } else if (depth > 0 && src[j] === ']') {
      seenClose = true;
      j++;
    } else if (depth > 0 && seenClose && src[j] === '\n') {
      return 0;
    } else j++;
  }
  return 0;
}

/** Attribute-name start / continue tests on a char code. */
function attrStartCode(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58;
}
function attrCharCode(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 46 || c === 58 || c === 45;
}
function wsCodeAt(src, i) {
  if (i >= src.length) return false;
  const c = src.charCodeAt(i);
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
}

/**
 * Scan an inline HTML construct at src[i] ('<'). Returns the end offset,
 * or 0; oKind is 1 comment, 2 processing instruction, 3 CDATA,
 * 4 declaration, 5 tag.
 */
function scanHtmlTag(src, i) {
  const n = src.length;
  if (src.startsWith('<!--', i)) {
    if (src.startsWith('<!-->', i)) { oKind = 1; return i + 5; }
    if (src.startsWith('<!--->', i)) { oKind = 1; return i + 6; }
    const p = src.indexOf('-->', i + 4);
    if (p === -1) return 0;
    oKind = 1;
    return p + 3;
  }
  if (src.startsWith('<?', i)) {
    const p = src.indexOf('?>', i + 2);
    if (p === -1) return 0;
    oKind = 2;
    return p + 2;
  }
  if (src.startsWith('<!', i)) {
    if (src.startsWith('<![CDATA[', i)) {
      const p = src.indexOf(']]>', i + 9);
      if (p === -1) return 0;
      oKind = 3;
      return p + 3;
    }
    const c = src[i + 2];
    if (c >= 'A' && c <= 'Z') {
      const p = src.indexOf('>', i + 2);
      if (p === -1) return 0;
      oKind = 4;
      return p + 1;
    }
    return 0;
  }
  let j = i + 1;
  const isClose = src[j] === '/';
  if (isClose) j++;
  if (j >= n) return 0;
  const c0 = src.charCodeAt(j);
  if (!((c0 >= 97 && c0 <= 122) || (c0 >= 65 && c0 <= 90))) return 0;
  while (j < n) {
    const c = src.charCodeAt(j);
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  if (isClose) {
    while (j < n && wsCodeAt(src, j)) j++;
    if (src[j] === '>') { oKind = 5; return j + 1; }
    return 0;
  }
  let needWs = true;
  for (;;) {
    const c = src[j];
    if (c === undefined) return 0;
    if (c === '>') { oKind = 5; return j + 1; }
    if (c === '/' && src[j + 1] === '>') { oKind = 5; return j + 2; }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') { j++; needWs = false; continue; }
    if (needWs) return 0;
    const cc = src.charCodeAt(j);
    if (!attrStartCode(cc)) return 0;
    while (j < n && attrCharCode(src.charCodeAt(j))) j++;
    let sawWs = false;
    while (j < n && wsCodeAt(src, j)) { j++; sawWs = true; }
    if (src[j] === '=') {
      j++;
      while (j < n && wsCodeAt(src, j)) j++;
      const q = src[j];
      if (q === '"' || q === "'") {
        const p = src.indexOf(q, j + 1);
        if (p === -1) return 0;
        j = p + 1;
      } else {
        const s0 = j;
        while (j < n) {
          const d = src[j];
          if (d === ' ' || d === '\t' || d === '\n' || d === '\r' || d === '\f' || d === '"' || d === "'" || d === '=' || d === '<' || d === '>' || d === '`') break;
          j++;
        }
        if (j === s0) return 0;
      }
      needWs = true;
    } else {
      needWs = !sawWs;
    }
  }
}

const EMAIL_LOCAL_RE = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;

/**
 * Scan an autolink <...> at src[i]. Returns the end offset, or 0;
 * oStr is the href, oStr2 the link text.
 */
function scanAutolink(src, i) {
  const n = src.length;
  let j = i + 1;
  if (j < n) {
    const c0 = src.charCodeAt(j);
    if ((c0 >= 97 && c0 <= 122) || (c0 >= 65 && c0 <= 90)) {
      let k = j;
      while (k < n) {
        const c = src.charCodeAt(k);
        if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) k++;
        else break;
      }
      const schemeLen = k - j;
      if (schemeLen >= 2 && schemeLen <= 32 && src[k] === ':') {
        let m = k + 1;
        while (m < n) {
          const c = src[m];
          if (c === '>' || c === ' ' || c === '\t' || c === '\n' || c === '<' || c.charCodeAt(0) < 32) break;
          m++;
        }
        if (m < n && src[m] === '>' && m > k + 1) {
          const url = src.slice(i + 1, m);
          oStr = url;
          oStr2 = url;
          return m + 1;
        }
      }
    }
  }
  let k = i + 1;
  while (k < n && EMAIL_LOCAL_RE.test(src[k])) k++;
  if (k > i + 1 && k < n && src[k] === '@') {
    let d = k + 1;
    let lastDot = -1;
    while (d < n) {
      const c = src[d];
      if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-') { d++; continue; }
      if (c === '.') { lastDot = d; d++; continue; }
      break;
    }
    if (d > k + 1 && src[d] === '>' && lastDot > k + 1 && src[d - 1] !== '.' && src[d - 1] !== '-') {
      const addr = src.slice(i + 1, d);
      oStr = 'mailto:' + addr;
      oStr2 = addr;
      return d + 1;
    }
  }
  return 0;
}

/**
 * Trim trailing punctuation off a GFM autolink candidate, per the spec:
 * unbalanced ')' go, a trailing ';' that closes an entity drops the whole
 * entity, other trailing . , ; : ! ? * _ ~ go.
 */
function trimGfmEnd(s) {
  for (;;) {
    if (s.length === 0) return s;
    const last = s[s.length - 1];
    if (last === ')') {
      let depth = 0;
      for (let i = 0; i < s.length - 1; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')' && depth > 0) depth--;
      }
      if (depth > 0) return s;
      s = s.slice(0, -1);
      continue;
    }
    if (last === ';') {
      const amp = s.lastIndexOf('&');
      if (amp !== -1) {
        const m = matchEnt(s, amp);
        if (m > 0 && amp + m === s.length) {
          s = s.slice(0, amp);
          continue;
        }
      }
      s = s.slice(0, -1);
      continue;
    }
    if (last === '.' || last === ',' || last === ':' || last === '!' || last === '?' || last === '*' || last === '_' || last === '~') {
      s = s.slice(0, -1);
      continue;
    }
    return s;
  }
}

/** A GFM autolink terminator character (or end of string, ''). */
function gfmTerm(c) {
  if (c === '') return true;
  if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '<' || c === '>' || c === '"' || c === "'" || c === '[' || c === ']' || c === '{' || c === '}' || c === '`') return true;
  return c.charCodeAt(0) < 32;
}

/**
 * A "(" at src[j] is part of a GFM autolink only when its group closes
 * before the next space.
 */
function gfmParenOpen(src, j) {
  const n = src.length;
  for (let k = j + 1; k < n; k++) {
    const c = src[k];
    if (c === ')') return true;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') return false;
  }
  return false;
}

/**
 * Scan a GFM autolink URL body from src[j]: stops at a terminator, or at
 * a "(" whose group does not close before the next space. When
 * allowBracket is true, "[" and "]" are URL characters.
 */
function scanGfmBody(src, j, allowBracket) {
  const n = src.length;
  while (j < n) {
    const c = src[j];
    if (c === '(' && !gfmParenOpen(src, j)) break;
    if (allowBracket) {
      if (gfmTerm(c) && c !== '[' && c !== ']') break;
    } else if (gfmTerm(c)) break;
    j++;
  }
  return j;
}

/**
 * Scan a GFM email autolink at src[i]. The candidate is scanned greedily,
 * trailing '.'s are trimmed, and the result must end in a letter or digit.
 * Returns the end offset, or 0; oStr is the email.
 */
function scanEmail(src, i) {
  const n = src.length;
  const c0 = src.charCodeAt(i);
  if (!((c0 >= 97 && c0 <= 122) || (c0 >= 65 && c0 <= 90) || (c0 >= 48 && c0 <= 57))) return 0;
  let j = i;
  while (j < n && EMAIL_LOCAL_RE.test(src[j])) j++;
  if (j === i || j >= n || src[j] !== '@') return 0;
  let d = j + 1;
  while (d < n) {
    const c = src[d];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-' || c === '.') d++;
    else break;
  }
  if (src[d] === '_') {
    const after = d + 1 < n ? src[d + 1] : '';
    if (after === '' || after === '\n' || after === '\r') return 0;
    const ac = after === '' ? 0 : after.charCodeAt(0);
    if ((ac >= 97 && ac <= 122) || (ac >= 65 && ac <= 90) || (ac >= 48 && ac <= 57)) return 0;
  }
  let e = d;
  while (e > j + 1 && src[e - 1] === '.') e--;
  const last = src[e - 1];
  const dom = src.slice(j + 1, e);
  const lc = last === undefined ? 0 : last.charCodeAt(0);
  if (dom.includes('.') && !dom.startsWith('.') && !dom.includes('..') &&
      ((lc >= 97 && lc <= 122) || (lc >= 65 && lc <= 90) || (lc >= 48 && lc <= 57))) {
    const cand = trimGfmEnd(src.slice(i, e));
    if (cand.includes('@') && cand.includes('.')) {
      oStr = cand;
      return i + cand.length;
    }
  }
  return 0;
}

/** Whether the char before a GFM autolink may precede one. */
function gfmPrevOk(prev) {
  if (prev === '') return true;
  const c = prev.charCodeAt(0);
  if (c < 128) {
    return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 ||
      c === 42 || c === 95 || c === 126 || c === 40 || c === 91 || c === 123 ||
      c === 34 || c === 39 || c === 60;
  }
  return wsAt(prev, 0);
}

/**
 * Try a GFM extended autolink (www., scheme://, email) at src[i].
 * Returns the end offset, or 0; oStr is the href, oStr2 the text.
 */
function scanGfmLink(src, i, allowBracket) {
  const n = src.length;
  if (src.startsWith('www.', i)) {
    const j = scanGfmBody(src, i, allowBracket);
    const cand = trimGfmEnd(src.slice(i, j));
    const rest = cand.slice(4);
    if (rest.length > 0 && rest.includes('.') && !rest.endsWith('.') && !rest.endsWith('-')) {
      oStr = 'http://' + cand;
      oStr2 = cand;
      return i + cand.length;
    }
    return 0;
  }
  let k = i;
  if (k < n) {
    const c0 = src.charCodeAt(k);
    if ((c0 >= 97 && c0 <= 122) || (c0 >= 65 && c0 <= 90)) {
      const s0 = k;
      while (k < n) {
        const c = src.charCodeAt(k);
        if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) k++;
        else break;
      }
      if (k - s0 >= 2 && k - s0 <= 32 && src[k] === ':') {
        if (src.startsWith('://', k)) {
          const j = scanGfmBody(src, k + 3, allowBracket);
          const cand = trimGfmEnd(src.slice(i, j));
          if (cand.length > k + 3 - i) {
            oStr = cand;
            oStr2 = cand;
            return i + cand.length;
          }
        } else {
          const em = scanEmail(src, k + 1);
          if (em > 0) {
            const emStr = oStr;
            let e = em;
            const scheme = src.slice(i, k).toLowerCase();
            if (scheme !== 'mailto' && src[e] === '/') {
              let j = e + 1;
              while (j < n) {
                const c = src[j];
                if (c === '/') break;
                if (c === '(' && !gfmParenOpen(src, j)) break;
                if (gfmTerm(c) && !(allowBracket && (c === '[' || c === ']'))) break;
                j++;
              }
              e = j;
            }
            const cand = trimGfmEnd(src.slice(i, e));
            if (cand.length > k + 1 - i) {
              oStr = cand;
              oStr2 = cand;
              return i + cand.length;
            }
            oStr = emStr;
          }
        }
      }
    }
  }
  const em0 = scanEmail(src, i);
  if (em0 > 0) {
    const emStr = oStr;
    oStr = 'mailto:' + emStr;
    oStr2 = emStr;
    return em0;
  }
  return 0;
}

/** Cheap pre-check: could a GFM autolink start at src[i]? */
function gfmMaybe(src, i) {
  if (src.startsWith('www.', i)) return true;
  const n = src.length;
  const lim = Math.min(n, i + 200);
  for (let j = i; j < lim; j++) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 10 || c === 60 || c === 9) return false;
    if (c === 64) return true;
    if (c === 58 && src[j + 1] === '/' && src[j + 2] === '/') return true;
  }
  return false;
}

function skipInlineWs(src, k) {
  while (k < src.length && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
  return k;
}

/**
 * Parse a link destination at src[k]. Sets oOk, oStr (dest), oEnd (next).
 */
function parseLinkDest(src, k) {
  const n = src.length;
  oOk = false;
  if (src[k] === '<') {
    let m = k + 1;
    while (m < n) {
      const c = src[m];
      if (c === '\\' && m + 1 < n) { m += 2; continue; }
      if (c === '>') { oStr = src.slice(k + 1, m); oEnd = m + 1; oOk = true; return; }
      if (c === '\n' || c === '<') return;
      m++;
    }
    return;
  }
  let m = k;
  let depth = 0;
  while (m < n) {
    const c = src[m];
    if (c === '\\' && m + 1 < n && punctCode(src.charCodeAt(m + 1))) { m += 2; continue; }
    if (c === '(') { depth++; m++; continue; }
    if (c === ')') { if (depth === 0) break; depth--; m++; continue; }
    if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
    m++;
  }
  oStr = src.slice(k, m);
  oEnd = m;
  oOk = true;
}

/**
 * Parse a link title at src[k] ('"' or "'" or '(').
 * Sets oOk, oStr (title), oEnd (next).
 */
function parseLinkTitle(src, k) {
  const n = src.length;
  oOk = false;
  const q = src[k];
  if (q === '"' || q === "'") {
    let m = k + 1;
    while (m < n) {
      const c = src[m];
      if (c === '\\' && m + 1 < n && punctCode(src.charCodeAt(m + 1))) { m += 2; continue; }
      if (c === q) { oStr = src.slice(k + 1, m); oEnd = m + 1; oOk = true; return; }
      m++;
    }
    return;
  }
  if (q === '(') {
    let m = k + 1;
    let depth = 1;
    while (m < n) {
      const c = src[m];
      if (c === '\\' && m + 1 < n && punctCode(src.charCodeAt(m + 1))) { m += 2; continue; }
      if (c === '(') { depth++; m++; continue; }
      if (c === ')') {
        depth--;
        if (depth === 0) { oStr = src.slice(k + 1, m); oEnd = m + 1; oOk = true; return; }
        m++;
        continue;
      }
      m++;
    }
  }
}

/**
 * Normalize a link label: collapse whitespace, trim, Unicode case-fold.
 * Backslash escapes are NOT resolved in labels.
 */
function normalizeLabel(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

/** True when the "(" at src[j] has a matching ")" (balanced parens). */
function hasMatchingParen(src, j) {
  const n = src.length;
  let depth = 1;
  let i = j + 1;
  while (i < n) {
    const c = src[i];
    if (c === '\\' && i + 1 < n) { i += 2; continue; }
    if (c === '(') { depth++; i++; continue; }
    if (c === ')') {
      depth--;
      if (depth === 0) return true;
      i++;
      continue;
    }
    i++;
  }
  return false;
}

/**
 * Scan a reference label starting at src[j] ('[').
 * Sets oOk, oStr (content), oEnd (end offset).
 */
function scanLabel(src, j) {
  const n = src.length;
  let m = j + 1;
  let depth = 1;
  let len = 0;
  oOk = false;
  while (m < n) {
    const c = src[m];
    if (c === '\\' && m + 1 < n) { m += 2; len += 2; continue; }
    if (c === '[') { depth++; m++; len++; continue; }
    if (c === ']') {
      depth--;
      if (depth === 0) {
        if (len > 999) return;
        oStr = src.slice(j + 1, m);
        oEnd = m + 1;
        oOk = true;
        return;
      }
      m++; len++; continue;
    }
    if (c === '\n' && src[m + 1] === '\n') return;
    m++; len++;
  }
}

/**
 * True when a link's bracket text can be consumed by the label grammar:
 * plain chars, escapes, nested brackets (depth at most 2), code-span
 * tokens, or a run of 2+ backticks at the very end. A run that cannot
 * be consumed prevents the inline/reflink form (the shortcut form uses
 * a different label pattern and is not gated here).
 */
function labelSegmentsOk(text) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '\\') {
      if (i + 1 >= n) return false;
      i += 2;
      continue;
    }
    if (c === '[') {
      let depth = 1;
      let j = i + 1;
      let ok = false;
      while (j < n) {
        const d = text[j];
        if (d === '\\' && j + 1 < n) { j += 2; continue; }
        if (d === '[') {
          depth++;
          if (depth > 2) return false;
          j++;
          continue;
        }
        if (d === ']') {
          depth--;
          if (depth === 0) { ok = true; break; }
          j++;
          continue;
        }
        j++;
      }
      if (!ok) return false;
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let m = 0;
      while (i + m < n && text[i + m] === '`') m++;
      if (i + m === n) return m >= 2;
      let k = i + m;
      while (k < n && text[k] !== '`') k++;
      if (k >= n) return false;
      let m2 = 0;
      while (k + m2 < n && text[k + m2] === '`') m2++;
      i = k + m2;
      continue;
    }
    if (c === ']') return false;
    i++;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Inline event tape. A tokenized paragraph is a flat list of entries in
// parallel integer arrays; payload strings live in the side table.
// Kinds: 0 text, 1 code span, 2 raw html, 3 hard break, 4 delimiter run,
// 5 bracket marker, 6 link/image, 7 entity.
// Text: a=start, b=end in curSrc (a=-1 means b is a side-table index).
// Code: c=side index of content. Html: a=start, b=end.
// Delimiter: a=char code, b=count remaining, f bits 1=open 2=close 4=literal.
// Bracket: a=label start in src, b=1 for image; f bit 1 = text has a link.
// Link: a=first child tape index, b=one past last child, c=href side index,
//   d=title side index (-1 none), e=src start for GFM autolinks,
//   f bits 1=image 2=autolink 4=gfm. Entity: c=side index of output.
// ---------------------------------------------------------------------------

const TK_TEXT = 0, TK_CODE = 1, TK_HTML = 2, TK_BR = 3, TK_DELIM = 4, TK_BRACKET = 5, TK_LINK = 6, TK_ENTITY = 7;
const FL_OPEN = 1, FL_CLOSE = 2, FL_LITERAL = 4;
const LK_IMG = 1, LK_AUTO = 2, LK_GFM = 4;

let tkCap = 256;
let tkLen = 0;
let tkK = new Int32Array(tkCap);
let tkA = new Int32Array(tkCap);
let tkB = new Int32Array(tkCap);
let tkC = new Int32Array(tkCap);
let tkD = new Int32Array(tkCap);
let tkE = new Int32Array(tkCap);
let tkF = new Int32Array(tkCap);
let tkLive = new Int32Array(tkCap);

let side = [];
let sideLen = 0;

/** Emphasis spans, created while resolving delimiters. */
let spCap = 64;
let spanCount = 0;
let spanOpen = new Int32Array(spCap);
let spanClose = new Int32Array(spCap);
let spanTag = new Int32Array(spCap);
let spanChar = new Int32Array(spCap);
let spanOpenLeft = new Int32Array(spCap);
let spanCloseLeft = new Int32Array(spCap);
let spanNextO = new Int32Array(spCap);
let spanNextC = new Int32Array(spCap);
let spanDone = new Uint8Array(spCap);
/** Head span id opening/closing at each tape position (-1 none). */
let spanOpenAt = new Int32Array(tkCap);
let spanCloseAt = new Int32Array(tkCap);

/** Delimiter stack for emphasis resolution (indices into the tape). */
let emCap = 64;
let emStack = new Int32Array(emCap);
let emSp = 0;
/** Bottom rule: per delimiter char, the cut-off opener index and use. */
let botIdx = new Int32Array(128).fill(-1);
let botUse = new Int32Array(128);
/** Openers skipped for the current closer (multiple-of-three etc.). */
let oddCap = 32;
let oddArr = new Int32Array(oddCap);

/** Open-bracket stack: tape indices of bracket markers. */
let brCap = 32;
let brStack = new Int32Array(brCap);
let brLen = 0;

/** The inline source currently being tokenized/rendered. */
let curSrc = '';
/** Start offset of the pending text run, or -1. */
let txtStart = -1;
/** Set while an inline <a> tag is open (GFM autolinks are suppressed). */
let inAnchor = false;
/** Set while tokenizing when a delimiter entry was created. */
let tokHasDelim = false;
/** Backtick-run emphasis suppression (see tokenizeInline). */
let suppressUntil = -1;
let forceLiteralBt = -1;

function tapeGrow() {
  const nc = tkCap * 2;
  const nk = new Int32Array(nc), na = new Int32Array(nc), nb = new Int32Array(nc),
    ncc = new Int32Array(nc), nd = new Int32Array(nc), ne = new Int32Array(nc),
    nf = new Int32Array(nc), nl = new Int32Array(nc),
    no = new Int32Array(nc), ncl = new Int32Array(nc);
  nk.set(tkK); na.set(tkA); nb.set(tkB); ncc.set(tkC); nd.set(tkD); ne.set(tkE);
  nf.set(tkF); nl.set(tkLive); no.set(spanOpenAt); ncl.set(spanCloseAt);
  tkK = nk; tkA = na; tkB = nb; tkC = ncc; tkD = nd; tkE = ne; tkF = nf; tkLive = nl;
  spanOpenAt = no; spanCloseAt = ncl;
  tkCap = nc;
}

function tPush(kind, a, b, c, d, e, f) {
  if (tkLen >= tkCap) tapeGrow();
  const p = tkLen++;
  tkK[p] = kind; tkA[p] = a; tkB[p] = b; tkC[p] = c; tkD[p] = d; tkE[p] = e; tkF[p] = f;
  tkLive[p] = 1;
  return p;
}

function sidePush(s) {
  side[sideLen] = s;
  return sideLen++;
}

/** Flush the pending text run [txtStart, end) as a text entry. */
function flushText(end) {
  if (txtStart !== -1 && end > txtStart) tPush(TK_TEXT, txtStart, end, 0, 0, 0, 0);
  txtStart = -1;
}

/**
 * Try to resolve a link for the bracket at tape index brkIdx, whose ']'
 * is at src index closeIdx, looking at what follows it.
 * Sets oOk, oStr (href), oStr2 (title or null), oEnd (end offset).
 */
function tryResolveLink(src, j, brkIdx, closeIdx, refs) {
  const n = src.length;
  const srcStart = tkA[brkIdx];
  oOk = false;
  if (j < n && src[j] === '(') {
    const text = src.slice(srcStart, closeIdx);
    let k = skipInlineWs(src, j + 1);
    let dest = null;
    let next = -1;
    if (src[k] === ')') { dest = ''; next = k; }
    else {
      parseLinkDest(src, k);
      if (oOk) { dest = oStr; next = oEnd; }
    }
    if (dest !== null) {
      const k2 = skipInlineWs(src, next);
      if (src[k2] === ')') {
        if (labelSegmentsOk(text)) {
          oStr = dest; oStr2 = null; oEnd = k2 + 1; oOk = true;
          return;
        }
      } else if (src[k2] === '"' || src[k2] === "'" || src[k2] === '(') {
        parseLinkTitle(src, k2);
        if (oOk) {
          const title = oStr;
          const k3 = skipInlineWs(src, oEnd);
          if (src[k3] === ')') {
            if (labelSegmentsOk(text)) {
              oStr = dest; oStr2 = title; oEnd = k3 + 1; oOk = true;
              return;
            }
          }
        }
      }
    }
    // Inline form failed: fall back to a shortcut reference. Note the
    // sub-parsers above leave oOk set from their own outcome, so reset
    // it here: only a found reference may report success.
    oOk = false;
    const ref = refs.get(normalizeLabel(text));
    if (ref) {
      oStr = ref.dest; oStr2 = ref.title; oEnd = j; oOk = true;
    }
    return;
  }
  if (j < n && src[j] === '[') {
    const text = src.slice(srcStart, closeIdx);
    if (!labelSegmentsOk(text)) {
      const ref = refs.get(normalizeLabel(text));
      if (ref) {
        oStr = ref.dest; oStr2 = ref.title; oEnd = j; oOk = true;
      }
      return;
    }
    scanLabel(src, j);
    if (oOk) {
      const labStr = oStr;
      const labEnd = oEnd;
      const label = labStr === '' ? normalizeLabel(text) : normalizeLabel(labStr);
      const ref = refs.get(label);
      if (ref) {
        oStr = ref.dest; oStr2 = ref.title; oEnd = labEnd; oOk = true;
        return;
      }
    }
    // A scanned label without a matching reference is a failure, and
    // scanLabel left oOk set from its own success: reset it.
    oOk = false;
    return;
  }
  const ref = refs.get(normalizeLabel(src.slice(srcStart, closeIdx)));
  if (ref) {
    oStr = ref.dest; oStr2 = ref.title; oEnd = j; oOk = true;
  }
}

/** True when the tape range [lo, hi) contains a bracket-formed link. */
function childrenContainLink(lo, hi) {
  for (let p = lo; p < hi; p++) {
    if (tkLive[p] === 0) continue;
    if (tkK[p] === TK_LINK) {
      if ((tkF[p] & LK_IMG) === 0 && (tkF[p] & LK_AUTO) === 0) return true;
      if (childrenContainLink(tkA[p], tkB[p])) return true;
    }
  }
  return false;
}

/** Mark the emphasis delimiters in [lo, hi) as literal text. */
function markDelimitersLiteral(lo, hi) {
  for (let k = lo; k < hi; k++) {
    if (tkLive[k] !== 0 && tkK[k] === TK_DELIM) tkF[k] |= FL_LITERAL;
  }
}

/**
 * Turn GFM autolinks inside a link's text into plain text (angle
 * autolinks stay links). Their child text is folded into one text entry.
 */
function convertGfmInRange(lo, hi) {
  for (let p = lo; p < hi; p++) {
    if (tkLive[p] === 0 || tkK[p] !== TK_LINK || (tkF[p] & LK_GFM) === 0) continue;
    const cs = tkA[p];
    const ce = tkB[p];
    let s = '';
    for (let q = cs; q < ce; q++) {
      if (tkLive[q] === 0) continue;
      if (tkK[q] === TK_TEXT) s += tkA[q] === -1 ? side[tkB[q]] : curSrc.slice(tkA[q], tkB[q]);
    }
    tkK[p] = TK_TEXT;
    tkA[p] = -1;
    tkB[p] = sidePush(s);
    for (let q = cs; q < ce; q++) tkLive[q] = 0;
  }
}

/** ASCII characters that are plain text in the inline scanner: not a
 *  construct starter (\n \ ` < & [ ! ] * _ ~) and not a letter/digit
 *  (those need the GFM-autolink check at a word start). */
const PLAIN_CH = new Uint8Array(128);
for (let k = 0; k < 128; k++) {
  const alnum = (k >= 48 && k <= 57) || (k >= 65 && k <= 90) || (k >= 97 && k <= 122);
  const special = k === 10 || k === 33 || k === 38 || k === 42 || k === 60 || k === 91 ||
    k === 92 || k === 93 || k === 95 || k === 96 || k === 126;
  PLAIN_CH[k] = !alnum && !special ? 1 : 0;
}

/**
 * Tokenize inline source into the tape. Node kinds are documented above.
 * The scanner is a single pass with index jumps; text is accumulated as
 * source ranges (txtStart..i) and flushed only when a construct starts.
 */
function tokenizeInline(src, refs) {
  curSrc = src;
  tkLen = 0;
  sideLen = 0;
  spanCount = 0;
  brLen = 0;
  tokHasDelim = false;
  txtStart = -1;
  suppressUntil = -1;
  forceLiteralBt = -1;
  const n = src.length;
  let i = 0;
  while (i < n) {
    const code = src.charCodeAt(i);
    // Plain characters (space, punctuation that starts nothing) are
    // literal text: skip the whole construct chain for them.
    if (code < 128 && PLAIN_CH[code] === 1) {
      if (txtStart === -1) txtStart = i;
      i++;
      continue;
    }
    // A letter or digit: either the middle of a word (consume the rest
    // of the word in one jump) or a word start (try a GFM autolink).
    if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      const pc = i > 0 ? src.charCodeAt(i - 1) : 0;
      if ((pc >= 48 && pc <= 57) || (pc >= 65 && pc <= 90) || (pc >= 97 && pc <= 122)) {
        if (txtStart === -1) txtStart = i;
        let j = i;
        while (j < n) {
          const cj = src.charCodeAt(j);
          if (!((cj >= 48 && cj <= 57) || (cj >= 65 && cj <= 90) || (cj >= 97 && cj <= 122))) break;
          j++;
        }
        i = j;
        continue;
      }
      if (!inAnchor && gfmPrevOk(i > 0 ? src[i - 1] : '') && gfmMaybe(src, i)) {
        const topBr = brLen > 0 ? brStack[brLen - 1] : -1;
        const allowBr = topBr === -1 || (tkF[topBr] & 1) !== 0;
        const g = scanGfmLink(src, i, allowBr);
        if (g > 0) {
          const hrefRaw = oStr;
          const textRaw = oStr2;
          flushText(i);
          const li = tPush(TK_LINK, 0, 0, sidePush(hrefOfAuto(hrefRaw)), -1, i, LK_GFM | LK_AUTO);
          tkA[li] = li + 1;
          tkB[li] = li + 2;
          tPush(TK_TEXT, -1, sidePush(textRaw), 0, 0, 0, 0);
          i = g;
          continue;
        }
      }
      if (txtStart === -1) txtStart = i;
      i++;
      continue;
    }
    if (code === 10) {
      let sp = 0;
      let t = i - 1;
      while (t >= 0 && src[t] === ' ') { sp++; t--; }
      if (sp >= 2) {
        flushText(i - sp);
        tPush(TK_BR, 0, 0, 0, 0, 0, 0);
        i++;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      } else {
        if (txtStart === -1) txtStart = i;
        i++;
      }
      continue;
    }
    if (code === 92) {
      const nxCode = i + 1 < n ? src.charCodeAt(i + 1) : -1;
      if (nxCode === 10) {
        flushText(i);
        tPush(TK_BR, 0, 0, 0, 0, 0, 0);
        i += 2;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      if (nxCode !== -1 && punctCode(nxCode)) {
        flushText(i);
        tPush(TK_TEXT, -1, sidePush(src[i + 1]), 0, 0, 0, 0);
        i += 2;
        continue;
      }
      if (txtStart === -1) txtStart = i;
      i++;
      continue;
    }
    if (code === 96) {
      const csEnd = forceLiteralBt === i ? 0 : scanCodeSpan(src, i, brLen);
      if (csEnd > 0) {
        flushText(i);
        tPush(TK_CODE, 0, 0, sidePush(oStr), 0, 0, 0);
        i = csEnd;
        continue;
      }
      let m = 0;
      while (i + m < n && src.charCodeAt(i + m) === 96) m++;
      if (forceLiteralBt === i) forceLiteralBt = -1;
      if (brLen > 0) {
        let su = -1;
        for (let k = i + m; k < n; k++) {
          if (src[k] === '`') {
            let r = 0;
            while (k + r < n && src[k + r] === '`') r++;
            if (r === m) { su = k; break; }
            k += r - 1;
          }
        }
        if (su !== -1 && (suppressUntil === -1 || su > suppressUntil)) suppressUntil = su;
        for (let k = i + m; k < n; k++) {
          if (src[k] === '`') { forceLiteralBt = k; break; }
          if (src[k] === ']' && (k === 0 || src[k - 1] !== '\\')) break;
          if (src[k] === '\n' && src[k + 1] === '\n') break;
        }
      }
      if (txtStart === -1) txtStart = i;
      i += m;
      continue;
    }
    if (code === 60) {
      const tagEnd = scanHtmlTag(src, i);
      if (tagEnd > 0) {
        flushText(i);
        const tagText = src.slice(i, tagEnd);
        const lo3 = tagText.slice(0, 3).toLowerCase();
        const lo4 = tagText.slice(0, 4).toLowerCase();
        if (lo4 === '</a>' || lo4 === '</a ' || lo4 === '</a\t' || lo4 === '</a\n') inAnchor = false;
        else if ((lo3 === '<a>' || lo3 === '<a ' || lo3 === '<a\t' || lo3 === '<a\n') && tagText.toLowerCase() !== '<a/>') inAnchor = true;
        tPush(TK_HTML, i, tagEnd, 0, 0, 0, 0);
        i = tagEnd;
        continue;
      }
      const alEnd = scanAutolink(src, i);
      if (alEnd > 0) {
        const hrefRaw = oStr;
        const textRaw = oStr2;
        flushText(i);
        const li = tPush(TK_LINK, 0, 0, sidePush(hrefOfAuto(hrefRaw)), -1, -1, LK_AUTO);
        tkA[li] = li + 1;
        tkB[li] = li + 2;
        tPush(TK_TEXT, -1, sidePush(textRaw), 0, 0, 0, 0);
        i = alEnd;
        continue;
      }
      if (txtStart === -1) txtStart = i;
      i++;
      continue;
    }
    if (code === 38) {
      const m = matchEnt(src, i);
      if (m > 0) {
        const rep = entOut;
        flushText(i);
        tPush(TK_ENTITY, 0, 0, sidePush(src[i + 1] === '#' ? escRaw(rep) : rep), 0, 0, 0);
        i += m;
        continue;
      }
      if (txtStart === -1) txtStart = i;
      i++;
      continue;
    }
    if (code === 91 || (code === 33 && src.charCodeAt(i + 1) === 91)) {
      const img = code === 33;
      flushText(i);
      const bi = tPush(TK_BRACKET, img ? i + 2 : i + 1, img ? 1 : 0, 0, 0, 0, 0);
      if (brLen >= brCap) {
        const nb = new Int32Array(brCap * 2);
        nb.set(brStack);
        brStack = nb;
        brCap *= 2;
      }
      brStack[brLen++] = bi;
      i += img ? 2 : 1;
      continue;
    }
    if (code === 93) {
      const top = brLen > 0 ? brStack[brLen - 1] : -1;
      if (top >= 0) {
        flushText(i);
        const img = tkB[top] === 1;
        tryResolveLink(src, i + 1, top, i, refs);
        if (oOk) {
          const hrefRaw = oStr;
          const titleRaw = oStr2;
          const endPos = oEnd;
          if (!img && childrenContainLink(top + 1, tkLen)) {
            brLen--;
            if ((tkF[top] & 1) !== 0 && brLen > 0) tkF[brStack[brLen - 1]] |= 1;
            if (txtStart === -1) txtStart = i;
            i++;
            continue;
          }
          convertGfmInRange(top + 1, tkLen);
          const titleIdx = titleRaw === null ? -1 : sidePush(attrEscape(titleRaw, false));
          tkK[top] = TK_LINK;
          tkA[top] = top + 1;
          tkB[top] = tkLen;
          tkC[top] = sidePush(hrefOf(hrefRaw));
          tkD[top] = titleIdx;
          tkE[top] = -1;
          tkF[top] = img ? LK_IMG : 0;
          brLen--;
          if (brLen > 0) tkF[brStack[brLen - 1]] |= 1;
          i = endPos;
          continue;
        }
        brLen--;
        if ((tkF[top] & 1) !== 0 && brLen > 0) tkF[brStack[brLen - 1]] |= 1;
        if (src[i + 1] === '(' && hasMatchingParen(src, i + 1)) markDelimitersLiteral(top + 1, tkLen);
        if (brLen === 0) {
          let ai = -1;
          for (let k = tkLen - 1; k > top; k--) {
            if (tkLive[k] === 0) continue;
            if (tkK[k] === TK_TEXT) continue;
            if (tkK[k] === TK_LINK && (tkF[k] & LK_GFM) !== 0) ai = k;
            break;
          }
          if (ai !== -1) {
            const g2 = scanGfmLink(src, tkE[ai], true);
            if (g2 > 0 && g2 > i) {
              const hrefRaw = oStr;
              const textRaw = oStr2;
              tkC[ai] = sidePush(hrefOfAuto(hrefRaw));
              const ci = tkA[ai];
              tkA[ci] = -1;
              tkB[ci] = sidePush(textRaw);
              for (let k = ai + 1; k < tkLen; k++) tkLive[k] = 0;
              i = g2;
              continue;
            }
          }
        }
        if (txtStart === -1) txtStart = i;
        i++;
        continue;
      }
      if (txtStart === -1) txtStart = i;
      i++;
      continue;
    }
    if (code === 42 || code === 95 || code === 126) {
      let m = 0;
      while (i + m < n && src.charCodeAt(i + m) === code) m++;
      if (suppressUntil !== -1 && i < suppressUntil && brLen === 0) {
        if (txtStart === -1) txtStart = i;
        i += m;
        continue;
      }
      if (suppressUntil !== -1 && i >= suppressUntil) suppressUntil = -1;
      if (code === 126 && m > 2) {
        if (txtStart === -1) txtStart = i;
        i += m;
        continue;
      }
      const fm = flankMask(src, i, m);
      let o = false;
      let cl = false;
      if (code === 95) {
        o = (fm & 1) !== 0 && ((fm & 2) === 0 || punctAt(src, i - 1));
        cl = (fm & 2) !== 0 && ((fm & 1) === 0 || punctAt(src, i + m));
      } else {
        o = (fm & 1) !== 0;
        cl = (fm & 2) !== 0;
      }
      flushText(i);
      tPush(TK_DELIM, code, m, 0, 0, 0, (o ? FL_OPEN : 0) | (cl ? FL_CLOSE : 0));
      tokHasDelim = true;
      i += m;
      continue;
    }
    if (txtStart === -1) txtStart = i;
    i++;
  }
  flushText(n);
}

/**
 * Resolve emphasis / strong / strikethrough on the tape range [lo, hi).
 * Delimiter pairs become spans recorded in the span tables; the tape
 * entries themselves keep only their remaining (unconsumed) counts.
 * Link children are resolved first, each with its own delimiter stack
 * and bottom rule, exactly as a fresh node list would be.
 */
function procEmph(lo, hi) {
  for (let p = lo; p < hi; p++) {
    if (tkLive[p] === 0) continue;
    if (tkK[p] === TK_LINK) {
      procEmph(tkA[p], tkB[p]);
      p = tkB[p] - 1;
    }
  }
  const b42i = botIdx[42], b42u = botUse[42];
  const b95i = botIdx[95], b95u = botUse[95];
  const b126i = botIdx[126], b126u = botUse[126];
  botIdx[42] = -1; botIdx[95] = -1; botIdx[126] = -1;
  const base = emSp;
  for (let idx = lo; idx < hi; idx++) {
    if (tkLive[idx] === 0) continue;
    // Delimiters inside a link's children belong to that link's own
    // level (resolved by the recursion above); skip the whole range.
    if (tkK[idx] === TK_LINK) { idx = tkB[idx] - 1; continue; }
    if (tkK[idx] !== TK_DELIM || tkB[idx] === 0 || (tkF[idx] & FL_LITERAL) !== 0) continue;
    const ch = tkA[idx];
    if ((tkF[idx] & FL_CLOSE) !== 0) {
      let oddLen = 0;
      let sawPartial = false;
      while (tkB[idx] > 0) {
        let foundPos = -1;
        let foundUse = 0;
        let foundVMax = 0;
        let foundCloserInside = false;
        for (let s = emSp - 1; s >= base; s--) {
          const o = emStack[s];
          if (tkLive[o] === 0 || tkB[o] === 0 || tkA[o] !== ch || (tkF[o] & FL_OPEN) === 0) continue;
          let inOdd = false;
          for (let q = 0; q < oddLen; q++) {
            if (oddArr[q] === o) { inOdd = true; break; }
          }
          if (inOdd) continue;
          let vMax;
          if (ch === 126) {
            if (tkB[o] !== tkB[idx]) {
              if (oddLen >= oddCap) {
                const no = new Int32Array(oddCap * 2);
                no.set(oddArr);
                oddArr = no;
                oddCap *= 2;
              }
              oddArr[oddLen++] = o;
              continue;
            }
            vMax = tkB[o];
          } else {
            vMax = tkB[o] >= 2 && tkB[idx] >= 2 ? 2 : 1;
          }
          const b = botIdx[ch];
          let v = vMax;
          if (b !== -1 && o < b && ch !== 126) {
            if (vMax === botUse[ch]) {
              v = vMax;
            } else if (vMax === 2 && botUse[ch] === 1 && tkB[o] === 2 && tkB[idx] >= 3) {
              v = 2;
              foundCloserInside = true;
            } else if (vMax === 2 && botUse[ch] === 1 && tkB[o] >= 3 && tkB[idx] >= 3) {
              v = 1;
            } else {
              continue;
            }
            if (v === vMax && tkB[o] > vMax) {
              if (oddLen >= oddCap) {
                const no = new Int32Array(oddCap * 2);
                no.set(oddArr);
                oddArr = no;
                oddCap *= 2;
              }
              oddArr[oddLen++] = o;
              sawPartial = true;
              continue;
            }
          }
          if (ch !== 126 && ((tkF[o] & 3) === 3 || (tkF[idx] & 3) === 3) &&
              (tkB[o] + tkB[idx]) % 3 === 0 && !(tkB[o] % 3 === 0 && tkB[idx] % 3 === 0)) {
            if (oddLen >= oddCap) {
              const no = new Int32Array(oddCap * 2);
              no.set(oddArr);
              oddArr = no;
              oddCap *= 2;
            }
            oddArr[oddLen++] = o;
            continue;
          }
          foundPos = s;
          foundUse = v;
          foundVMax = vMax;
          break;
        }
        if (foundPos === -1) {
          if (sawPartial) botIdx[ch] = -1;
          break;
        }
        const o = emStack[foundPos];
        let anyLive = false;
        for (let j = o + 1; j < idx; j++) {
          if (tkLive[j] !== 0) { anyLive = true; break; }
        }
        if (!anyLive) {
          if (oddLen >= oddCap) {
            const no = new Int32Array(oddCap * 2);
            no.set(oddArr);
            oddArr = no;
            oddCap *= 2;
          }
          oddArr[oddLen++] = o;
          continue;
        }
        const use = foundUse;
        const tag = ch === 126 ? 2 : use === 2 ? 1 : 0;
        if (spanCount >= spCap) {
          const nc = spCap * 2;
          const a1 = new Int32Array(nc), a2 = new Int32Array(nc), a3 = new Int32Array(nc),
            a4 = new Int32Array(nc), a5 = new Int32Array(nc), a6 = new Int32Array(nc),
            a7 = new Int32Array(nc), a8 = new Int32Array(nc);
          const a9 = new Uint8Array(nc);
          a1.set(spanOpen); a2.set(spanClose); a3.set(spanTag); a4.set(spanChar);
          a5.set(spanOpenLeft); a6.set(spanCloseLeft); a7.set(spanNextO); a8.set(spanNextC);
          a9.set(spanDone);
          spanOpen = a1; spanClose = a2; spanTag = a3; spanChar = a4;
          spanOpenLeft = a5; spanCloseLeft = a6; spanNextO = a7; spanNextC = a8;
          spanDone = a9;
          spCap = nc;
        }
        const sp = spanCount++;
        spanOpen[sp] = o + 1;
        spanClose[sp] = idx;
        spanTag[sp] = tag;
        spanChar[sp] = ch;
        spanOpenLeft[sp] = 0;
        spanCloseLeft[sp] = 0;
        spanDone[sp] = 0;
        spanNextO[sp] = spanOpenAt[o + 1];
        spanOpenAt[o + 1] = sp;
        spanNextC[sp] = spanCloseAt[idx];
        spanCloseAt[idx] = sp;
        tkB[o] -= use;
        tkB[idx] -= use;
        if (use < foundVMax) {
          if (oddLen >= oddCap) {
            const no = new Int32Array(oddCap * 2);
            no.set(oddArr);
            oddArr = no;
            oddCap *= 2;
          }
          oddArr[oddLen++] = o;
          if (tkB[o] > 0) { spanOpenLeft[sp] = tkB[o]; tkB[o] = 0; }
          if (tkB[idx] > 0) { spanCloseLeft[sp] = tkB[idx]; tkB[idx] = 0; }
        } else if (foundCloserInside && tkB[idx] > 0) {
          spanCloseLeft[sp] = tkB[idx];
          tkB[idx] = 0;
        }
        if (ch !== 126 && tkB[idx] === 0 && (tkF[idx] & FL_OPEN) !== 0 && (tkF[o] & FL_CLOSE) === 0) {
          botIdx[ch] = o;
          botUse[ch] = use;
        }
        emSp = foundPos + (tkB[o] > 0 ? 1 : 0);
        if (tkB[o] === 0) tkLive[o] = 0;
        if (tkB[idx] === 0) {
          tkLive[idx] = 0;
          break;
        }
      }
    }
    if (tkB[idx] > 0 && (tkF[idx] & FL_OPEN) !== 0) {
      if (emSp >= emCap) {
        const ne = new Int32Array(emCap * 2);
        ne.set(emStack);
        emStack = ne;
        emCap *= 2;
      }
      emStack[emSp++] = idx;
    }
  }
  emSp = base;
  botIdx[42] = b42i; botUse[42] = b42u;
  botIdx[95] = b95i; botUse[95] = b95u;
  botIdx[126] = b126i; botUse[126] = b126u;
}

/** Render one emphasis span (its open/close tags plus leftover text). */
function renderSpan(s, out) {
  const tag = spanTag[s];
  out.push(tag === 0 ? '<em>' : tag === 1 ? '<strong>' : '<del>');
  if (spanOpenLeft[s] > 0) out.push(String.fromCharCode(spanChar[s]).repeat(spanOpenLeft[s]));
  renderRange(spanOpen[s], spanClose[s], out);
  if (spanCloseLeft[s] > 0) out.push(String.fromCharCode(spanChar[s]).repeat(spanCloseLeft[s]));
  out.push(tag === 0 ? '</em>' : tag === 1 ? '</strong>' : '</del>');
}

/** Render the tape range [lo, hi) into the chunk array. */
function renderRange(lo, hi, out) {
  let p = lo;
  while (p < hi) {
    let s = spanOpenAt[p];
    while (s !== -1 && spanDone[s] === 1) s = spanNextO[s];
    if (s !== -1) {
      spanDone[s] = 1;
      renderSpan(s, out);
      p = spanClose[s];
      continue;
    }
    if (tkLive[p] === 0) { p++; continue; }
    const k = tkK[p];
    if (k === TK_TEXT) {
      out.push(tkA[p] === -1 ? escRaw(side[tkB[p]]) : escRaw(curSrc.slice(tkA[p], tkB[p])));
      p++;
    } else if (k === TK_CODE) {
      out.push('<code>' + escRaw(side[tkC[p]]) + '</code>');
      p++;
    } else if (k === TK_HTML) {
      out.push(curSrc.slice(tkA[p], tkB[p]));
      p++;
    } else if (k === TK_BR) {
      out.push('<br>');
      p++;
    } else if (k === TK_DELIM) {
      if (tkB[p] > 0) out.push(String.fromCharCode(tkA[p]).repeat(tkB[p]));
      p++;
    } else if (k === TK_BRACKET) {
      out.push(tkB[p] === 1 ? '![' : '[');
      p++;
    } else if (k === TK_LINK) {
      if ((tkF[p] & LK_IMG) !== 0) {
        out.push('<img src="' + side[tkC[p]] + '" alt="' + plainAlt(tkA[p], tkB[p]) + '"');
        if (tkD[p] !== -1) out.push(' title="' + side[tkD[p]] + '"');
        out.push('>');
      } else {
        out.push('<a href="' + side[tkC[p]] + '"');
        if (tkD[p] !== -1) out.push(' title="' + side[tkD[p]] + '"');
        out.push('>');
        renderRange(tkA[p], tkB[p], out);
        out.push('</a>');
      }
      p = tkB[p];
    } else if (k === TK_ENTITY) {
      out.push(side[tkC[p]]);
      p++;
    } else {
      p++;
    }
  }
}

/** Plain-text form of a tape range, for image alt attributes. */
function plainAltInner(lo, hi) {
  let out = '';
  let p = lo;
  const rev = [];
  while (p < hi) {
    // Spans closing here: their close-leftover chars belong before the
    // closer entry, innermost span first (the chain is newest-first,
    // so walk it in reverse).
    rev.length = 0;
    let cs = spanCloseAt[p];
    while (cs !== -1) { rev.push(cs); cs = spanNextC[cs]; }
    for (let q = rev.length - 1; q >= 0; q--) {
      const s = rev[q];
      if (spanCloseLeft[s] > 0) out += String.fromCharCode(spanChar[s]).repeat(spanCloseLeft[s]);
    }
    let os = spanOpenAt[p];
    while (os !== -1) {
      if (spanOpenLeft[os] > 0) out += String.fromCharCode(spanChar[os]).repeat(spanOpenLeft[os]);
      os = spanNextO[os];
    }
    if (tkLive[p] === 0) { p++; continue; }
    const k = tkK[p];
    if (k === TK_TEXT) {
      out += tkA[p] === -1 ? escRaw(side[tkB[p]]) : escRaw(curSrc.slice(tkA[p], tkB[p]));
      p++;
    } else if (k === TK_CODE) {
      out += escRaw(side[tkC[p]]);
      p++;
    } else if (k === TK_ENTITY) {
      out += side[tkC[p]];
      p++;
    } else if (k === TK_DELIM) {
      if (tkB[p] > 0) out += String.fromCharCode(tkA[p]).repeat(tkB[p]);
      p++;
    } else if (k === TK_BRACKET) {
      out += tkB[p] === 1 ? '![' : '[';
      p++;
    } else if (k === TK_LINK) {
      out += plainAltInner(tkA[p], tkB[p]);
      p = tkB[p];
    } else {
      p++;
    }
  }
  return out;
}

function plainAlt(lo, hi) {
  return plainAltInner(lo, hi);
}

/** Render inline markdown to HTML, appending chunks to out. */
/** Patterns that force the full inline tape: construct starters
 *  (* _ ~ [ ` < & \) and GFM-autolink triggers (www., @, ://). A
 *  ']' or '!' alone is plain text (a '[' would trigger the tape),
 *  so they are deliberately absent. */
const INLINE_TRIG_RE = /[*_~[`&\\<]|www\.|@|:\/\//;

function inlineHtml(src, refs, out) {
  if (src === '') return;
  if (!INLINE_TRIG_RE.test(src)) {
    // Plain inline text: no constructs, no autolinks. Escape > " '
    // (the other escapers cannot occur here) and turn 2+ trailing
    // spaces before a newline into a hard break, exactly as the tape
    // would: '<br>' replaces the spaces AND the newline, and the
    // spaces/tabs that start the next line are dropped too.
    const esc = /[>"']/.test(src) ? escText(src) : src;
    out.push(esc.replace(/  +\n[ \t]*/g, '<br>'));
    return;
  }
  tokenizeInline(src, refs);
  spanOpenAt.fill(-1, 0, tkLen);
  spanCloseAt.fill(-1, 0, tkLen);
  if (tokHasDelim) procEmph(0, tkLen);
  renderRange(0, tkLen, out);
}

// ---------------------------------------------------------------------------
// Block parsing. Lines are plain strings; blocks are small records
// {t, ...} produced by parseBlocks and rendered by renderBlocks.
// ---------------------------------------------------------------------------

/** [columns, string index] of the leading spaces/tabs of a line. */
/** Reused out-array for measureIndent: every caller destructures the
 *  two numbers immediately, so sharing one array is safe. */
const miOut = [0, 0];
function measureIndent(line) {
  let cols = 0;
  let idx = 0;
  while (idx < line.length) {
    const c = line[idx];
    if (c === ' ') { cols++; idx++; }
    else if (c === '\t') { cols += 4 - (cols % 4); idx++; }
    else break;
  }
  miOut[0] = cols;
  miOut[1] = idx;
  return miOut;
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/**
 * Blank line for table-row purposes: a whitespace-only line is blank,
 * except one ending in a tab whose expanded indent is at most 4 — that
 * is a (empty) table row, and the table continues past it.
 */
function isTableBlank(line) {
  if (!isBlankLine(line)) return false;
  if (line.endsWith('\t') && measureIndent(line)[0] <= 4) return false;
  return true;
}

/** Remove n columns of indentation (a tab cut in half becomes spaces). */
function stripCols(line, n) {
  if (n <= 0) return line;
  let cols = 0;
  let idx = 0;
  while (idx < line.length && cols < n) {
    const c = line[idx];
    if (c === ' ') { cols++; idx++; }
    else if (c === '\t') {
      const w = 4 - (cols % 4);
      if (cols + w <= n) { cols += w; idx++; }
      else return ' '.repeat(cols + w - n) + line.slice(idx + 1);
    } else break;
  }
  return line.slice(idx);
}

/**
 * Remove n columns of indentation, expanding the remaining leading
 * whitespace to spaces (measured from the original columns).
 * Used when the result is re-parsed, so its indentation stays true.
 */
function stripColsExpand(line, n, startCol) {
  let cols = startCol || 0;
  let idx = 0;
  while (idx < line.length && (line[idx] === ' ' || line[idx] === '\t')) {
    if (line[idx] === ' ') cols++;
    else cols += 4 - (cols % 4);
    idx++;
  }
  const rest = line.slice(idx);
  const total = cols - (startCol || 0);
  if (total <= n) return rest;
  return ' '.repeat(total - n) + rest;
}

/**
 * Remove up to n leading whitespace CHARACTERS for fenced code content.
 * Indent compensation counts characters, not columns: a tab is one.
 */
function stripFenceIndent(line, n) {
  let idx = 0;
  while (idx < line.length && idx < n && (line[idx] === ' ' || line[idx] === '\t')) idx++;
  return line.slice(idx);
}

function trimSpaces(s) {
  const n = s.length;
  if (n === 0) return s;
  if (s.charCodeAt(0) !== 32 && s.charCodeAt(0) !== 9 && s.charCodeAt(n - 1) !== 32 && s.charCodeAt(n - 1) !== 9) return s;
  let a = 0, b = n;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === n ? s : s.slice(a, b);
}

/** ATX heading: {level, contentIdx} or null. */
function atxInfo(line) {
  const [ind, idx] = measureIndent(line);
  if (ind > 3 || line[idx] !== '#') return null;
  let n = 0;
  while (line[idx + n] === '#') n++;
  if (n > 6) return null;
  const after = line[idx + n];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  return { level: n, contentIdx: idx + n };
}

/** Fenced code opening: {ch, len, infoIdx} or null. */
function fenceInfo(line) {
  const [ind, idx] = measureIndent(line);
  if (ind > 3) return null;
  const c = line[idx];
  if (c !== '`' && c !== '~') return null;
  let n = 0;
  while (line[idx + n] === c) n++;
  if (n < 3) return null;
  if (c === '`' && line.slice(idx + n).includes('`')) return null;
  return { ch: c, len: n, infoIdx: idx + n };
}

/** Is the line a closing fence for the given opening fence? */
function isFenceClose(line, fence) {
  const [ind, idx] = measureIndent(line);
  if (ind > 3 || line[idx] !== fence.ch) return false;
  let m = 0;
  while (line[idx + m] === fence.ch) m++;
  if (m < fence.len) return false;
  let r = idx + m;
  while (r < line.length && (line[r] === ' ' || line[r] === '\t')) r++;
  return r === line.length;
}

/** Thematic break? */
function hrInfo(line) {
  const [ind, idx] = measureIndent(line);
  if (ind > 3) return false;
  let i = idx;
  let count = 0;
  let ch = '';
  while (i < line.length) {
    const c = line[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (ch === '') {
      if (c !== '*' && c !== '-' && c !== '_') return false;
      ch = c; count = 1; i++; continue;
    }
    if (c === ch) { count++; i++; continue; }
    return false;
  }
  return count >= 3;
}

/** Setext underline level (1 for =, 2 for -) or 0. */
function setextInfo(line) {
  const [ind, idx] = measureIndent(line);
  if (ind > 3) return 0;
  const c = line[idx];
  if (c !== '=' && c !== '-') return 0;
  let i = idx;
  while (i < line.length && line[i] === c) i++;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  if (i !== line.length) return 0;
  return c === '=' ? 1 : 2;
}

const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul']);

/** Case-insensitive prefix test for the type-1 html block tags. */
function isType1Tag(rest) {
  const tags = ['script', 'pre', 'style', 'textarea'];
  for (const t of tags) {
    if (rest.length < t.length) continue;
    let ok = true;
    for (let k = 0; k < t.length; k++) {
      if (rest[k].toLowerCase() !== t[k]) { ok = false; break; }
    }
    if (!ok) continue;
    const after = rest[t.length];
    if (after === undefined || after === ' ' || after === '\t' || after === '\n' || after === '\r' || after === '>' || after === '/') return true;
  }
  return false;
}

/** HTML block type (1-7) starting on this line, or 0. */
function htmlBlockInfo(line) {
  const [ind, idx] = measureIndent(line);
  if (ind > 3 || line[idx] !== '<') return 0;
  const rest = line.slice(idx);
  if (rest[1] === '!' && rest[2] === '-' && rest[3] === '-') return 2;
  if (rest.startsWith('<?')) return 3;
  if (rest.startsWith('<![CDATA[')) return 5;
  if (rest[1] === '!' && rest[2] >= 'A' && rest[2] <= 'Z') return 4;
  if (rest[1] !== '/') {
    const c1 = rest[1];
    if ((c1 >= 'a' && c1 <= 'z') || (c1 >= 'A' && c1 <= 'Z')) {
      if (isType1Tag(rest.slice(1))) return 1;
    }
  }
  const m6 = rest.match(/^<\/?([A-Za-z][A-Za-z0-9-]*)/);
  if (m6) {
    const tag = m6[1].toLowerCase();
    const after = rest[m6[0].length];
    if (BLOCK_TAGS.has(tag) && (after === undefined || after === ' ' || after === '\t' || after === '>' || after === '/')) return 6;
    if (!BLOCK_TAGS.has(tag)) {
      const t = scanHtmlTag(line, idx);
      if (t > 0 && oKind === 5) {
        let r = t;
        while (r < line.length && (line[r] === ' ' || line[r] === '\t')) r++;
        if (r === line.length) return 7;
      }
    }
  }
  return 0;
}

/** List marker at the start of a line, or null. */
function markerInfo(line) {
  const [ind, idx] = measureIndent(line);
  if (ind > 3) return null;
  const c = line[idx];
  let ordered = false;
  let bullet = '';
  let delim = '';
  let start = 0;
  let mEnd = idx;
  if (c === '-' || c === '*' || c === '+') {
    bullet = c;
    mEnd = idx + 1;
  } else if (c >= '0' && c <= '9') {
    let j = idx;
    while (j < line.length && line[j] >= '0' && line[j] <= '9') j++;
    if (j - idx > 9) return null;
    const d = line[j];
    if (d !== '.' && d !== ')') return null;
    ordered = true;
    delim = d;
    start = parseInt(line.slice(idx, j), 10);
    mEnd = j + 1;
  } else return null;
  const after = line[mEnd];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  const markerCols = ind + (mEnd - idx);
  let cols = markerCols;
  let j = mEnd;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
    if (line[j] === ' ') cols++;
    else cols += 4 - (cols % 4);
    j++;
  }
  const spaces = cols - markerCols;
  const empty = j >= line.length;
  let contentIndent;
  let contentStr;
  if (empty) {
    contentIndent = markerCols + 1;
    contentStr = '';
  } else if (spaces <= 4) {
    contentIndent = cols;
    contentStr = line.slice(j);
  } else {
    contentIndent = markerCols + 1;
    contentStr = stripColsExpand(line.slice(mEnd), 1, markerCols);
  }
  return { ordered, bullet, delim, start, indent: ind, contentIndent, empty, contentStr };
}

/**
 * Split a table row line into cells. Only a backslash-escaped pipe is a
 * literal pipe; a backtick does NOT protect "|" from splitting.
 */
function splitCells(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === '\\' && i + 1 < n && line[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (c === '\\' && i + 1 < n) { cur += line[i] + line[i + 1]; i += 2; continue; }
    if (c === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += c;
    i++;
  }
  cells.push(cur);
  return cells;
}

/** Cells of a table row line, trimmed, edge pipes dropped. */
function cellsOf(line) {
  const t = trimSpaces(line);
  let cells = splitCells(t).map((s) => trimSpaces(s));
  if (t.startsWith('|') && cells.length > 0 && cells[0] === '') cells = cells.slice(1);
  if (t.endsWith('|') && cells.length > 0 && cells[cells.length - 1] === '') cells = cells.slice(0, -1);
  return cells;
}

/** One delimiter cell's alignment, or 'bad' when it is not a delimiter. */
function delimAlign(cell) {
  const n = cell.length;
  if (n === 0) return 'bad';
  let a = 0, b = n;
  let left = false, right = false;
  if (cell[0] === ':') { left = true; a = 1; }
  if (b > a && cell[b - 1] === ':') { right = true; b--; }
  if (b - a < 1) return 'bad';
  for (let i = a; i < b; i++) if (cell[i] !== '-') return 'bad';
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
}

/** If the line is a table delimiter row, the alignments. */
function tableDelimCells(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== '|' && c !== '-' && c !== ':' && c !== ' ' && c !== '\t') return null;
  }
  const t = trimSpaces(line);
  if (t === '') return null;
  let cells = splitCells(t).map((s) => trimSpaces(s));
  if (t.startsWith('|') && cells.length > 0 && cells[0] === '') cells = cells.slice(1);
  if (t.endsWith('|') && cells.length > 0 && cells[cells.length - 1] === '') cells = cells.slice(0, -1);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const a = delimAlign(cell);
    if (a === 'bad') return null;
    aligns.push(a);
  }
  return aligns;
}

/** True when the line has a pipe outside any code span. */
function hasPipeOutsideCode(line) {
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === '`') {
      let m = 0;
      while (i + m < n && line[i + m] === '`') m++;
      let j = i + m;
      let found = -1;
      while (j < n) {
        if (line[j] === '`') {
          let k = j;
          while (k < n && line[k] === '`') k++;
          if (k - j === m) { found = k; break; }
          j = k;
        } else j++;
      }
      if (found === -1) return false;
      i = found;
      continue;
    }
    if (c === '\\' && i + 1 < n) { i += 2; continue; }
    if (c === '|') return true;
    i++;
  }
  return false;
}

/** Could this line continue a paragraph (not start another block)? */
function classifyPara(content) {
  if (isBlankLine(content)) return false;
  const [ind, idx] = measureIndent(content);
  if (ind >= 4) return false;
  // A line starting with a letter cannot be a setext underline, a table
  // delimiter, or any other block start.
  const fc = content.charCodeAt(idx);
  if (ind < 4 && ((fc >= 65 && fc <= 90) || (fc >= 97 && fc <= 122))) return true;
  if (setextInfo(content) !== 0) return false;
  if (tableDelimCells(content)) return false;
  if (atxInfo(content)) return false;
  if (fenceInfo(content)) return false;
  const hb = htmlBlockInfo(content);
  if (hb >= 1 && hb <= 6) return false;
  if (ind <= 3 && content[idx] === '>') return false;
  if (hrInfo(content)) return false;
  const mk = markerInfo(content);
  if (mk && !mk.empty && (!mk.ordered || mk.start === 1)) return false;
  return true;
}

/**
 * Whether a raw line can be a lazy continuation of an open paragraph
 * inside a container. Block starts that end a paragraph cannot.
 */
function isLazyLine(l) {
  if (isBlankLine(l)) return false;
  const [ind, idx] = measureIndent(l);
  // A line starting with a letter cannot be any block start, and a
  // setext underline (the only non-letter case that stays lazy) is
  // handled by the checks below.
  if (ind < 4) {
    const fc = l.charCodeAt(idx);
    if ((fc >= 65 && fc <= 90) || (fc >= 97 && fc <= 122)) return true;
  }
  if (atxInfo(l) || fenceInfo(l)) return false;
  const hb = htmlBlockInfo(l);
  if (hb >= 1 && hb <= 6) return false;
  if (ind <= 3 && l[idx] === '>') return false;
  if (hrInfo(l)) return false;
  if (tableDelimCells(l)) return false;
  const mk = markerInfo(l);
  if (mk) return false;
  return true;
}

/** Whether a line would start a block when re-parsed (indent < 4). */
function isBlockStart(s) {
  const [ind] = measureIndent(s);
  if (ind >= 4) return false;
  if (atxInfo(s) || fenceInfo(s) || hrInfo(s)) return true;
  const hb = htmlBlockInfo(s);
  if (hb >= 1 && hb <= 6) return true;
  const mk = markerInfo(s);
  if (mk && !mk.empty) return true;
  if (setextInfo(s) !== 0) return true;
  if (tableDelimCells(s)) return true;
  return false;
}

/** The text of a lazy line (see lazyPush). */
function lazyText(l) {
  const [ind2] = measureIndent(l);
  if (setextInfo(l) !== 0) return '    ' + l;
  const s = ind2 >= 4 ? stripCols(l, 4) : l;
  if (isBlockStart(s)) return '\\' + s;
  return s;
}

/** The last non-blank line in a list, or null. */
function lastContent(lines) {
  for (let k = lines.length - 1; k >= 0; k--) {
    if (lines[k] !== '') return lines[k];
  }
  return null;
}

/**
 * The container prefix to prepend to a lazy line so the sub-parse
 * routes it to the innermost open paragraph of `content`.
 */
function lazyPrefix(content) {
  const mk = markerInfo(content);
  if (mk && !mk.empty) {
    return ' '.repeat(mk.contentIndent) + lazyPrefix(mk.contentStr);
  }
  const [ind, idx] = measureIndent(content);
  if (ind <= 3 && content[idx] === '>') {
    const qc = stripQuotePrefix(content, ind, idx);
    return '> ' + lazyPrefix(qc);
  }
  return '';
}

/** True when the container path of `content` routes into a list item. */
function lazyRoutesToList(content) {
  const mk = markerInfo(content);
  if (mk && !mk.empty) return true;
  const [ind, idx] = measureIndent(content);
  if (ind <= 3 && content[idx] === '>') {
    return lazyRoutesToList(stripQuotePrefix(content, ind, idx));
  }
  return false;
}

/** Push a lazy line into a container's sub-lines (see lazyText). */
function lazyPush(sub, l, prefix) {
  sub.push((prefix || '') + lazyText(l));
}

/** Strip every leading ">" level from a line (for nested-fence checks). */
function stripAllQuotes(s) {
  let cur = s;
  for (;;) {
    const [a, b] = measureIndent(cur);
    if (a <= 3 && cur[b] === '>') cur = stripQuotePrefix(cur, a, b);
    else return cur;
  }
}

/**
 * Merge one blockquote chunk's blocks into the accumulated blocks:
 * a paragraph merges into a preceding paragraph, an indented code block
 * merges into a preceding paragraph, and a nested quote merges into a
 * preceding nested quote. Blank-line-separated blocks never merge.
 */
function mergeChunkBlocks(acc, nb) {
  for (const b of nb) {
    const last = acc.length > 0 ? acc[acc.length - 1] : null;
    if (last && !b.bb && last.t === 'p' && b.t === 'p') {
      for (const ln of b.lines) last.lines.push(ln);
      continue;
    }
    if (last && !b.bb && last.t === 'p' && b.t === 'code' && b.lang === null && b.text !== '') {
      const parts = b.text.split('\n');
      for (const ln of parts) last.lines.push(ln);
      continue;
    }
    if (last && !b.bb && last.t === 'quote' && b.t === 'quote') {
      mergeChunkBlocks(last.blocks, b.blocks);
      continue;
    }
    acc.push(b);
  }
}

/** Strip the '>' prefix of a blockquote line (one optional space after it). */
function stripQuotePrefix(l, ind, idx) {
  const j = idx + 1;
  if (l[j] === ' ') return stripColsExpand(l.slice(j + 1), 0, ind + 2);
  if (l[j] === '\t') {
    const w = 4 - ((ind + 1) % 4);
    const rest = l.slice(j + 1);
    return ' '.repeat(Math.max(0, w - 1)) + stripColsExpand(rest, 0, ind + 1 + w);
  }
  return l.slice(j);
}

/** Skip spaces/tabs and at most one newline to a non-blank line; -1 on failure. */
function skipWsDef(s, k) {
  while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
  if (s[k] === '\n') {
    let j = k + 1;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
    if (j >= s.length || s[j] === '\n') return -1;
    return j;
  }
  return k;
}

/** True when s holds a blank line (two newlines with only spaces/tabs between). */
function hasBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\n') continue;
    let j = i + 1;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
    if (j < s.length && s[j] === '\n') return true;
  }
  return false;
}

/** Parse one link reference definition starting at lines[i]. */
function parseOneDef(lines, i) {
  const avail = [];
  for (let k = 0; k < 50 && i + k < lines.length; k++) {
    if (isBlankLine(lines[i + k])) break;
    avail.push(lines[i + k]);
  }
  if (avail.length === 0) return null;
  const s = avail.join('\n');
  let p = 0;
  let ind = 0;
  while (p < s.length && s[p] === ' ') { ind++; p++; }
  if (ind > 3 || s[p] !== '[') return null;
  let m = p + 1;
  let labLen = 0;
  let labelEnd = -1;
  while (m < s.length) {
    const c = s[m];
    if (c === '\\' && m + 1 < s.length) { m += 2; labLen += 2; continue; }
    if (c === ']') { labelEnd = m; break; }
    if (c === '[') return null;
    if (c === '\n' && s[m + 1] === '\n') return null;
    m++; labLen++;
  }
  if (labelEnd === -1 || labLen === 0 || labLen > 999) return null;
  if (s[labelEnd + 1] !== ':') return null;
  const labelRaw = s.slice(p + 1, labelEnd);
  if (normalizeLabel(labelRaw) === '') return null;
  const q = skipWsDef(s, labelEnd + 2);
  if (q === -1) return null;
  let dest;
  let q2;
  if (s[q] === '<') {
    let r = q + 1;
    let ok = false;
    while (r < s.length) {
      const c = s[r];
      if (c === '\\' && r + 1 < s.length) { r += 2; continue; }
      if (c === '>') { dest = s.slice(q + 1, r); q2 = r + 1; ok = true; break; }
      if (c === '\n' || c === '<') return null;
      r++;
    }
    if (!ok) return null;
  } else {
    parseLinkDest(s, q);
    if (!oOk || oStr === '') return null;
    dest = oStr;
    q2 = oEnd;
  }
  let title = null;
  let r = q2;
  let hadWs = false;
  while (r < s.length && (s[r] === ' ' || s[r] === '\t')) { r++; hadWs = true; }
  if (s[r] === '"' || s[r] === "'" || s[r] === '(') {
    if (!hadWs) return null;
    parseLinkTitle(s, r);
    if (!oOk || hasBlankLine(oStr)) return null;
    title = oStr;
    r = oEnd;
    while (r < s.length && (s[r] === ' ' || s[r] === '\t')) r++;
  } else if (s[r] === '\n') {
    let j = r + 1;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
    if (j < s.length && (s[j] === '"' || s[j] === "'" || s[j] === '(')) {
      parseLinkTitle(s, j);
      if (oOk && !hasBlankLine(oStr)) {
        let rr = oEnd;
        while (rr < s.length && (s[rr] === ' ' || s[rr] === '\t')) rr++;
        if (rr === s.length || s[rr] === '\n') {
          title = oStr;
          r = rr;
        }
      }
    }
  }
  if (r < s.length && s[r] !== '\n') return null;
  const linesUsed = s.slice(0, r).split('\n').length;
  return { label: normalizeLabel(labelRaw), dest, title, linesUsed };
}

/** Parse a run of link reference definitions at lines[i]; null if none. */
function tryParseDefs(lines, i, refs) {
  let count = 0;
  let cur = i;
  while (cur < lines.length) {
    const d = parseOneDef(lines, cur);
    if (!d) break;
    if (!refs.has(d.label)) refs.set(d.label, { dest: d.dest, title: d.title });
    cur += d.linesUsed;
    count++;
  }
  if (count === 0) return null;
  return { nextI: cur };
}

/**
 * Innermost open block of a content line: {para, fence, list} where list
 * is the content indent of the innermost list item, or null.
 */
function contentState(content) {
  const f = fenceInfo(content);
  if (f && !(f.ch === '`' && content.slice(f.infoIdx).includes('`'))) return { para: false, fence: f, list: null };
  const mk = markerInfo(content);
  if (mk) {
    const inner = contentState(mk.contentStr);
    return { para: inner.para, fence: inner.fence, list: inner.list !== null ? inner.list : mk.contentIndent };
  }
  const [ind, idx] = measureIndent(content);
  if (ind <= 3 && content[idx] === '>') return contentState(stripQuotePrefix(content, ind, idx));
  return { para: classifyPara(content), fence: null, list: null };
}

/** Parse a list starting at lines[i] (marker mk). Returns {block, next}. */
function parseList(lines, i, firstMk, refs) {
  const items = [];
  let loose = false;
  let j = i;
  let mk = firstMk;
  const ordered = mk.ordered;
  const delim = mk.delim;
  const bullet = mk.bullet;
  const startNum = mk.start;
  for (;;) {
    const firstLine = lines[j];
    let content = mk.contentStr;
    let task = null;
    if (content.length >= 3 && content[0] === '[' &&
        (content[1] === ' ' || content[1] === 'x' || content[1] === 'X') &&
        content[2] === ']' && (content[3] === undefined || content[3] === ' ')) {
      task = content[1] === ' ' ? ' ' : 'x';
      content = content[3] === ' ' ? content.slice(4) : content.slice(3);
    }
    const itemLines = [content];
    // hasContent / lastNB track what itemLines.some() and
    // lastContent(itemLines) used to scan for on every line: whether any
    // non-blank line has been seen, and the last non-blank line.
    let hasContent = content !== '';
    let lastNB = content !== '' ? content : null;
    let paraOpen = classifyPara(content);
    let inFence = null;
    let fenceStarted = false;
    {
      const f0 = fenceInfo(content);
      if (f0 && !(f0.ch === '`' && content.slice(f0.infoIdx).includes('`'))) { inFence = f0; paraOpen = false; }
    }
    j++;
    let blankRun = 0;
    let endedByNewItem = false;
    while (j < lines.length) {
      const l = lines[j];
      if (isBlankLine(l)) {
        blankRun++;
        itemLines.push('');
        if (!inFence) paraOpen = false;
        j++;
        continue;
      }
      const [ind2] = measureIndent(l);
      const mk2 = markerInfo(l);
      if (inFence) {
        if (ind2 >= mk.contentIndent) {
          fenceStarted = true;
          blankRun = 0;
          const sub = stripColsExpand(l, mk.contentIndent, 0);
          itemLines.push(sub);
          hasContent = true;
          lastNB = sub;
          if (isFenceClose(sub, inFence)) inFence = null;
          paraOpen = false;
          j++;
          continue;
        }
        if (fenceStarted) {
          blankRun = 0;
          const sub = stripColsExpand(l, mk.contentIndent, 0);
          itemLines.push(sub);
          hasContent = true;
          lastNB = sub;
          if (isFenceClose(sub, inFence)) inFence = null;
          paraOpen = false;
          j++;
          continue;
        }
        while (itemLines.length > 0 && itemLines[itemLines.length - 1] === '') itemLines.pop();
        break;
      }
      if (hrInfo(l) && ind2 < mk.contentIndent) {
        while (itemLines.length > 0 && itemLines[itemLines.length - 1] === '') itemLines.pop();
        break;
      }
      if (mk2 && mk2.ordered === ordered && (ordered ? mk2.delim === delim : mk2.bullet === bullet) && ind2 < mk.contentIndent) {
        if (blankRun > 0) loose = true;
        while (itemLines.length > 0 && itemLines[itemLines.length - 1] === '') itemLines.pop();
        endedByNewItem = true;
        break;
      }
      if (ind2 >= mk.contentIndent) {
        if (blankRun > 0 && !hasContent) {
          while (itemLines.length > 0 && itemLines[itemLines.length - 1] === '') itemLines.pop();
          break;
        }
        blankRun = 0;
        const sub = stripColsExpand(l, mk.contentIndent, 0);
        itemLines.push(sub);
        hasContent = true;
        lastNB = sub;
        if (inFence) {
          if (isFenceClose(sub, inFence)) inFence = null;
          paraOpen = false;
        } else {
          const ff = fenceInfo(sub);
          if (ff && !(ff.ch === '`' && sub.slice(ff.infoIdx).includes('`'))) { inFence = ff; fenceStarted = false; paraOpen = false; }
          else paraOpen = classifyPara(sub);
        }
        j++;
        continue;
      }
      if (paraOpen && !inFence && isLazyLine(l)) {
        blankRun = 0;
        const last = lastNB;
        lazyPush(itemLines, l, last ? lazyPrefix(last) : '');
        hasContent = true;
        lastNB = itemLines[itemLines.length - 1];
        j++;
        continue;
      }
      if (blankRun === 0 && !inFence && isLazyLine(l)) {
        const last = lastNB;
        const prefix = last ? lazyPrefix(last) : '';
        if (prefix) {
          blankRun = 0;
          lazyPush(itemLines, l, prefix);
          hasContent = true;
          lastNB = itemLines[itemLines.length - 1];
          j++;
          continue;
        }
      }
      while (itemLines.length > 0 && itemLines[itemLines.length - 1] === '') itemLines.pop();
      break;
    }
    while (itemLines.length > 0 && itemLines[itemLines.length - 1] === '') itemLines.pop();
    // Fast path: an item whose lines are all plain paragraph
    // continuations is a single paragraph — no need to run the whole
    // block parser on it. A line qualifies when it is not blank, is
    // indented less than 4, and starts with a letter or a character
    // that cannot open a block (* - _ + digit # ` < > [ | : = and a
    // blank line all disqualify, conservatively).
    let simpleBlocks = null;
    if (itemLines.length > 0) {
      let simple = true;
      for (let q = 0; q < itemLines.length; q++) {
        const ln = itemLines[q];
        if (isBlankLine(ln)) { simple = false; break; }
        const [indq, idxq] = measureIndent(ln);
        if (indq >= 4) { simple = false; break; }
        const fcq = ln.charCodeAt(idxq);
        const ok = (fcq >= 65 && fcq <= 90) || (fcq >= 97 && fcq <= 122) ||
          fcq === 40 || fcq === 41 || fcq === 34 || fcq === 39 || fcq === 46 ||
          fcq === 44 || fcq === 59 || fcq === 63 || fcq === 33 || fcq === 36 ||
          fcq === 37 || fcq === 94 || fcq === 38 || fcq === 123 || fcq === 125 ||
          fcq === 47 || fcq === 92;
        if (!ok) { simple = false; break; }
      }
      if (simple) simpleBlocks = [{ t: 'p', lines: itemLines, bb: false }];
    }
    const parsed = simpleBlocks
      ? { blocks: simpleBlocks, loose: false }
      : parseBlocks(itemLines, 0, itemLines.length, refs, false, false, true);
    if (parsed.loose) loose = true;
    items.push({ blocks: parsed.blocks, task });
    if (j >= lines.length || !endedByNewItem) break;
    const mkN = markerInfo(lines[j]);
    if (!mkN) break;
    mk = mkN;
  }
  return { block: { t: 'list', ordered, start: startNum, tight: !loose, items }, next: j };
}

/** Strip a closing ATX hash run ("foo ##" -> "foo"); all-hash input -> ''. */
function stripAtxClose(content) {
  let e = content.length;
  while (e > 0 && content[e - 1] === '#') e--;
  if (e === 0) return '';
  if (e === content.length) return content;
  let s = e;
  while (s > 0 && (content[s - 1] === ' ' || content[s - 1] === '\t')) s--;
  if (s === e) return content;
  return content.slice(0, s);
}

/**
 * Parse lines[start..end) into blocks. Refs are shared across the document.
 * endsNl is true only for the top-level call when the input ends with a
 * newline; a sub-range (quote / list item) never carries one.
 */
function parseBlocks(lines, start, end, refs, endsNl, wsCont, inItem) {
  const blocks = [];
  let loose = false;
  let sawBlank = false;
  let curBb = false;
  const pushB = (b) => { b.bb = curBb; blocks.push(b); };
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) { sawBlank = true; i++; continue; }
    curBb = sawBlank && blocks.length > 0;
    if (curBb) loose = true;
    sawBlank = false;
    const [ind, cidx] = measureIndent(line);
    const fc = line.charCodeAt(cidx);
    const letterStart = ind < 4 && ((fc >= 65 && fc <= 90) || (fc >= 97 && fc <= 122));
    if (ind >= 4) {
      const codeLines = [];
      let poppedBlanks = 0;
      while (i < end) {
        const l = lines[i];
        const [ind2] = measureIndent(l);
        if (isBlankLine(l)) {
          if (ind2 >= 4) codeLines.push(stripCols(l, 4));
          else codeLines.push('');
          i++;
          continue;
        }
        if (ind2 >= 4) { codeLines.push(stripCols(l, 4)); i++; continue; }
        break;
      }
      while (codeLines.length > 0 && isBlankLine(codeLines[codeLines.length - 1])) { codeLines.pop(); poppedBlanks++; }
      if (poppedBlanks > 0) sawBlank = true;
      pushB({ t: 'code', lang: null, text: codeLines.length > 0 ? codeLines.join('\n') + '\n' : '' });
      continue;
    }
    const atx = letterStart ? null : atxInfo(line);
    if (atx) {
      let content = trimSpaces(line.slice(atx.contentIdx));
      content = stripAtxClose(content);
      pushB({ t: 'h', level: atx.level, text: content });
      i++;
      continue;
    }
    const fence = letterStart ? null : fenceInfo(line);
    if (fence) {
      const infoRaw = line.slice(fence.infoIdx);
      if (!(fence.ch === '`' && infoRaw.includes('`'))) {
        const info = trimSpaces(infoRaw);
        const contentLines = [];
        i++;
        while (i < end) {
          const l = lines[i];
          if (isFenceClose(l, fence)) { i++; break; }
          contentLines.push(fence.ch === '`' ? stripFenceIndent(l, cidx) : l);
          i++;
        }
        let text = '';
        if (contentLines.length > 0) {
          text = contentLines.join('\n') + (contentLines[contentLines.length - 1] === '' ? '' : '\n');
        }
        pushB({ t: 'code', lang: info, text });
        continue;
      }
    }
    const hb = letterStart ? 0 : htmlBlockInfo(line);
    if (hb !== 0) {
      const rawLines = [line];
      i++;
      if (hb === 1) {
        let tp = cidx + 1;
        if (line[tp] === '/') tp++;
        let te = tp;
        while (te < line.length) {
          const cc = line.charCodeAt(te);
          if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122)) te++;
          else break;
        }
        const tag = line.slice(tp, te).toLowerCase();
        const needle = '</' + tag;
        if (line.toLowerCase().indexOf(needle) === -1) {
          while (i < end) {
            rawLines.push(lines[i]);
            const done = lines[i].toLowerCase().indexOf(needle) !== -1;
            i++;
            if (done) break;
          }
        }
      } else if (hb === 2) {
        if (!line.includes('-->')) {
          while (i < end) {
            rawLines.push(lines[i]);
            const done = lines[i].includes('-->');
            i++;
            if (done) break;
          }
        }
      } else if (hb === 3) {
        if (!line.includes('?>')) {
          while (i < end) {
            rawLines.push(lines[i]);
            const done = lines[i].includes('?>');
            i++;
            if (done) break;
          }
        }
      } else if (hb === 4) {
        if (!line.includes('>')) {
          while (i < end) {
            rawLines.push(lines[i]);
            const done = lines[i].includes('>');
            i++;
            if (done) break;
          }
        }
      } else if (hb === 5) {
        if (!line.includes(']]>')) {
          while (i < end) {
            rawLines.push(lines[i]);
            const done = lines[i].includes(']]>');
            i++;
            if (done) break;
          }
        }
      } else {
        while (i < end && !isBlankLine(lines[i])) {
          rawLines.push(lines[i]);
          i++;
        }
      }
      const trail = i < end ? (hb <= 5 ? lines[i].length > 0 : !isBlankLine(lines[i])) : endsNl;
      pushB({ t: 'html', text: rawLines.join('\n'), trail });
      continue;
    }
    if (!letterStart && ind <= 3 && line[cidx] === '>') {
      const chunks = [[]];
      let curHasQuote = false;
      const st = { para: false, fence: null, innerFence: null, list: null };
      while (i < end) {
        const l = lines[i];
        const [ind2, idx2] = measureIndent(l);
        if (!isBlankLine(l) && ind2 <= 3 && l[idx2] === '>') {
          const content = stripQuotePrefix(l, ind2, idx2);
          chunks[chunks.length - 1].push(content);
          curHasQuote = true;
          const [indC, idxC] = measureIndent(content);
          const isNested = indC <= 3 && content[idxC] === '>';
          if (!isNested) st.innerFence = null;
          if (st.fence) {
            if (isFenceClose(content, st.fence)) st.fence = null;
            st.para = false;
          } else if (isNested && st.innerFence) {
            if (isFenceClose(stripAllQuotes(content), st.innerFence)) st.innerFence = null;
            st.para = false;
          } else {
            const ns = contentState(content);
            st.para = ns.para;
            if (isNested) {
              if (ns.fence) st.innerFence = ns.fence;
            } else {
              st.fence = ns.fence;
            }
            if (ns.list !== null) st.list = ns.list;
          }
          i++;
          continue;
        }
        if (isBlankLine(l)) break;
        if (st.list !== null && ind2 >= st.list) { chunks[chunks.length - 1].push(l); i++; continue; }
        if (st.para && isLazyLine(l)) {
          const cur = chunks[chunks.length - 1];
          const prev = cur.length > 0 ? cur : (chunks.length > 1 ? chunks[chunks.length - 2] : []);
          const last = lastContent(prev);
          const prefix = last ? lazyPrefix(last) : '';
          if (curHasQuote && !(last && lazyRoutesToList(last))) { chunks.push([]); curHasQuote = false; }
          chunks[chunks.length - 1].push(prefix + (setextInfo(l) !== 0 ? '    ' + l : l));
          i++;
          continue;
        }
        break;
      }
      const inner = [];
      for (let ci = 0; ci < chunks.length; ci++) {
        let chunk = chunks[ci];
        if (chunk.length === 0) continue;
        if (ci > 0) {
          const lastB = inner.length > 0 ? inner[inner.length - 1] : null;
          if (lastB && lastB.t === 'p') {
            let off = 0;
            while (off < chunk.length) {
              const d = parseOneDef(chunk, off);
              if (!d) break;
              for (let k = 0; k < d.linesUsed; k++) lastB.lines.push(chunk[off + k]);
              off += d.linesUsed;
            }
            if (off > 0) chunk = chunk.slice(off);
          }
        }
        if (chunk.length === 0) continue;
        const parsed = parseBlocks(chunk, 0, chunk.length, refs, false, true);
        mergeChunkBlocks(inner, parsed.blocks);
      }
      pushB({ t: 'quote', blocks: inner });
      continue;
    }
    if (!letterStart && hrInfo(line)) {
      pushB({ t: 'hr' });
      i++;
      continue;
    }
    const mk = letterStart ? null : markerInfo(line);
    if (mk) {
      const res = parseList(lines, i, mk, refs);
      pushB(res.block);
      if (res.next > i && res.next < end && isBlankLine(lines[res.next - 1]) && !isBlankLine(lines[res.next])) sawBlank = true;
      i = res.next;
      continue;
    }
    if (!letterStart && line[cidx] === '[') {
      const defs = tryParseDefs(lines, i, refs);
      if (defs) { i = defs.nextI; continue; }
    }
    const paraLines = [line];
    let j = i + 1;
    let headingLevel = 0;
    let table = null;
    while (j < end) {
      const l = lines[j];
      const [ind2, idx2] = measureIndent(l);
      if (idx2 === l.length) {
        if (wsCont && l.length > 0) { paraLines.push(l); j++; continue; }
        break;
      }
      if (ind2 <= 3 && l[idx2] === '>') break;
      // A line starting with a letter cannot be a setext underline, a
      // table delimiter, or any other block start.
      const fc2 = l.charCodeAt(idx2);
      const letter2 = ind2 < 4 && ((fc2 >= 65 && fc2 <= 90) || (fc2 >= 97 && fc2 <= 122));
      if (!letter2) {
        const se = setextInfo(l);
        if (se !== 0) { headingLevel = se; j++; break; }
        if (j === i + 1) {
          const aligns = ind2 <= 3 ? tableDelimCells(l) : null;
          if (aligns && cellsOf(paraLines[0]).length === aligns.length) {
            table = { aligns, headerLine: paraLines[0], startRow: j + 1 };
            break;
          }
        }
        if (atxInfo(l) || fenceInfo(l)) break;
        const hb2 = htmlBlockInfo(l);
        if (hb2 >= 1 && hb2 <= 6) break;
        if (hrInfo(l)) break;
        const mk2 = markerInfo(l);
        if (mk2 && !mk2.empty && (inItem || !mk2.ordered || mk2.start === 1)) break;
      }
      paraLines.push(l);
      j++;
    }
    if (table) {
      const rows = [];
      let k = table.startRow;
      while (k < end) {
        const l = lines[k];
        if (isTableBlank(l)) break;
        const [ind3, idx3] = measureIndent(l);
        if (ind3 <= 3 && l[idx3] === '>') break;
        const fc3 = l.charCodeAt(idx3);
        const letter3 = ind3 < 4 && ((fc3 >= 65 && fc3 <= 90) || (fc3 >= 97 && fc3 <= 122));
        if (!letter3) {
          if (atxInfo(l) || fenceInfo(l)) break;
          const hb3 = htmlBlockInfo(l);
          if (hb3 >= 1 && hb3 <= 6) break;
          if (hrInfo(l)) break;
          const mk3 = markerInfo(l);
          if (mk3 && !mk3.empty && ind3 <= 3) break;
        }
        rows.push(l);
        k++;
      }
      let header = cellsOf(table.headerLine);
      while (header.length < table.aligns.length) header.push('');
      header = header.slice(0, table.aligns.length);
      const body = rows.map((r) => {
        let cells = cellsOf(r);
        while (cells.length < table.aligns.length) cells.push('');
        return cells.slice(0, table.aligns.length);
      });
      pushB({ t: 'table', aligns: table.aligns, header, rows: body });
      i = k;
      continue;
    }
    if (headingLevel !== 0) {
      pushB({ t: 'h', level: headingLevel, text: trimSpaces(paraLines.join('\n')) });
      i = j;
      continue;
    }
    pushB({ t: 'p', lines: paraLines });
    i = j;
  }
  return { blocks, loose };
}

/** Reusable chunk array for the document-level render. */
const docOut = [];

function renderItem(it, tight, refs, out) {
  const cb = it.task === null ? '' : it.task === 'x' ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">';
  const blocks = it.blocks;
  if (tight) {
    out.push('<li>');
    if (blocks.length === 0) {
      if (cb) out.push(cb);
      out.push('</li>\n');
      return;
    }
    const first = blocks[0];
    if (first.t === 'p') {
      if (cb) out.push(cb + ' ');
      inlineHtml(first.lines.join('\n'), refs, out);
    } else {
      if (cb) out.push(cb + ' ');
      renderBlocks([first], refs, out);
    }
    for (let k = 1; k < blocks.length; k++) {
      const b = blocks[k];
      if (b.t === 'p') inlineHtml(b.lines.join('\n'), refs, out);
      else renderBlocks([b], refs, out);
    }
    out.push('</li>\n');
    return;
  }
  out.push('<li>');
  if (blocks.length === 0) {
    if (cb) out.push(cb);
    out.push('</li>\n');
    return;
  }
  const first = blocks[0];
  if (first.t === 'p') {
    out.push('<p>');
    if (cb) out.push(cb + ' ');
    inlineHtml(first.lines.join('\n'), refs, out);
    out.push('</p>\n');
  } else {
    if (cb) out.push(cb + ' ');
    renderBlocks([first], refs, out);
  }
  for (let k = 1; k < blocks.length; k++) renderBlocks([blocks[k]], refs, out);
  out.push('</li>\n');
}

function renderBlocks(blocks, refs, out) {
  for (const b of blocks) {
    switch (b.t) {
      case 'p': {
        let ls = b.lines;
        let n = ls.length;
        while (n > 0 && ls[n - 1] === '') n--;
        out.push('<p>');
        inlineHtml(n === ls.length ? ls.join('\n') : ls.slice(0, n).join('\n'), refs, out);
        out.push('</p>\n');
        break;
      }
      case 'h':
        out.push('<h' + b.level + '>');
        inlineHtml(b.text, refs, out);
        out.push('</h' + b.level + '>\n');
        break;
      case 'code': {
        if (b.lang) {
          let w = 0;
          while (w < b.lang.length && b.lang[w] !== ' ' && b.lang[w] !== '\t') w++;
          const word = b.lang.slice(0, w);
          out.push('<pre><code class="language-' + attrEscape(word, false) + '">' + escRaw(b.text) + '</code></pre>\n');
        } else {
          out.push('<pre><code>' + escRaw(b.text) + '</code></pre>\n');
        }
        break;
      }
      case 'html':
        out.push(b.text + (b.trail ? '\n' : ''));
        break;
      case 'hr':
        out.push('<hr>\n');
        break;
      case 'quote':
        out.push('<blockquote>\n');
        renderBlocks(b.blocks, refs, out);
        out.push('</blockquote>\n');
        break;
      case 'list': {
        if (b.ordered) out.push(b.start !== 1 ? '<ol start="' + b.start + '">\n' : '<ol>\n');
        else out.push('<ul>\n');
        for (const it of b.items) renderItem(it, b.tight, refs, out);
        out.push(b.ordered ? '</ol>\n' : '</ul>\n');
        break;
      }
      case 'table': {
        out.push('<table>\n<thead>\n<tr>\n');
        for (let ci = 0; ci < b.header.length; ci++) {
          const a = b.aligns[ci];
          out.push('<th' + (a ? ' align="' + a + '"' : '') + '>');
          inlineHtml(b.header[ci], refs, out);
          out.push('</th>\n');
        }
        out.push('</tr>\n</thead>\n');
        if (b.rows.length > 0) {
          out.push('<tbody>');
          for (const row of b.rows) {
            out.push('<tr>\n');
            for (let ci = 0; ci < row.length; ci++) {
              const a = b.aligns[ci];
              out.push('<td' + (a ? ' align="' + a + '"' : '') + '>');
              inlineHtml(row[ci], refs, out);
              out.push('</td>\n');
            }
            out.push('</tr>\n');
          }
          out.push('</tbody>');
        }
        out.push('</table>\n');
        break;
      }
    }
  }
}

/** Render markdown to HTML, exactly as marked 18.1.3 does with its defaults. */
export function parse(markdown) {
  let src = typeof markdown === 'string' ? markdown : String(markdown);
  if (src.includes('\r')) src = src.replace(/\r\n?/g, '\n');
  if (src.includes('\0')) src = src.replace(/\0/g, '\uFFFD');
  inAnchor = false;
  const refs = new Map();
  const lines = src.split('\n');
  const endsWithNl = lines.length > 0 && lines[lines.length - 1] === '';
  if (endsWithNl) lines.pop();
  const { blocks } = parseBlocks(lines, 0, lines.length, refs, endsWithNl);
  docOut.length = 0;
  renderBlocks(blocks, refs, docOut);
  return docOut.join('');
}
