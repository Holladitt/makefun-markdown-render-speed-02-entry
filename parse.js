// A fast, dependency-free CommonMark + GFM renderer written from scratch.
// It returns exactly the HTML that marked 18.1.3 renders with its defaults.
// Design: a line-based block parser (containers are gathered, then parsed
// recursively) plus a two-pass inline parser (tokenize into nodes, resolve
// links, then resolve emphasis with a delimiter stack).

const PUNCT = new Uint8Array(128);
for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') PUNCT[ch.charCodeAt(0)] = 1;

/** ASCII punctuation, plus the common Unicode punctuation marks. */
const UNI_PUNCT = /[\p{P}\p{S}]/u;
function isPunctCh(ch) {
  if (ch === '') return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return PUNCT[c] === 1;
  return UNI_PUNCT.test(ch);
}

/** Unicode whitespace (CommonMark's notion): space, tab, newline, form feed,
 *  carriage return, vertical tab, plus Zs and a few others. */
function isWsCh(ch) {
  if (ch === '') return false;
  const c = ch.charCodeAt(0);
  if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11) return true;
  if (c === 0xa0 || c === 0x1680 || c === 0x202f || c === 0x205f || c === 0x3000) return true;
  return c >= 0x2000 && c <= 0x200a;
}

/** Plain escaping of &, <, >, ", ' with no entity awareness (code content). */
function escRaw(s) {
  // A native character-class test is far cheaper than a JS loop over
  // clean text (the common case); the manual loop only runs when a
  // special character is actually present.
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

/**
 * Try to match an entity reference at s[i] (s[i] is '&').
 * Returns [lengthConsumed, replacement] or null. Named references are kept
 * verbatim (they are valid HTML as written); numeric references are decoded
 * to the character (0, surrogates and > 0x10FFFF become U+FFFD).
 */
function matchEnt(s, i) {
  const n = s.length;
  if (i + 1 >= n) return null;
  if (s[i + 1] === '#') {
    let j = i + 2;
    let hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const ds = j;
    if (hex) { while (j < n && ((s[j] >= '0' && s[j] <= '9') || (s[j] >= 'a' && s[j] <= 'f') || (s[j] >= 'A' && s[j] <= 'F'))) j++; }
    else { while (j < n && s[j] >= '0' && s[j] <= '9') j++; }
    const digits = j - ds;
    if (digits === 0 || digits > (hex ? 6 : 7) || j >= n || s[j] !== ';') return null;
    let v = parseInt(s.slice(ds, j), hex ? 16 : 10);
    if (v === 0 || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) v = 0xfffd;
    return [j + 1 - i, String.fromCodePoint(v)];
  }
  let j = i + 1;
  if (j >= n || !((s[j] >= 'a' && s[j] <= 'z') || (s[j] >= 'A' && s[j] <= 'Z'))) return null;
  j++;
  while (j < n && ((s[j] >= 'a' && s[j] <= 'z') || (s[j] >= 'A' && s[j] <= 'Z') || (s[j] >= '0' && s[j] <= '9'))) j++;
  if (j >= n || s[j] !== ';') return null;
  return [j + 1 - i, s.slice(i, j + 1)];
}

/**
 * Escape text for HTML, with entity awareness: a & that starts a valid
 * entity reference is left alone (named) or decoded (numeric); any other &
 * becomes &amp;. < > " ' are always escaped.
 */
function escText(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const m = matchEnt(s, i);
      if (m) {
        out += s.slice(start, i) + m[1];
        i += m[0] - 1;
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

/** Decode entities and backslash escapes inside a link destination/title. */
function decodeDest(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && PUNCT[s.charCodeAt(i + 1)] === 1) {
      out += s.slice(start, i) + s[i + 1];
      i++;
      start = i + 1;
    } else if (c === '&') {
      const m = matchEnt(s, i);
      if (m) {
        out += s.slice(start, i) + m[1];
        i += m[0] - 1;
        start = i + 1;
      }
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

/** One-pass attribute escaping: backslash escapes, entity references (named
 *  kept verbatim, numeric decoded then escaped), and < > " ' are escaped.
 *  For hrefs, spaces become %20. */
function attrEscape(s, isHref) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && PUNCT[s.charCodeAt(i + 1)] === 1) {
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
      if (m) {
        out += s.slice(start, i) + (s[i + 1] === '#' ? escRaw(m[1]) : m[1]);
        i += m[0] - 1;
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

/** Flanking info for a delimiter run at src[i..i+n): [canOpen, canClose]
 *  using the *-rules (left-flanking opens, right-flanking closes). */
function flankInfo(src, i, n) {
  const prev = i > 0 ? src[i - 1] : '';
  const next = i + n < src.length ? src[i + n] : '';
  const prevWs = prev === '' || isWsCh(prev);
  const nextWs = next === '' || isWsCh(next);
  const prevP = prev !== '' && isPunctCh(prev);
  const nextP = next !== '' && isPunctCh(next);
  const left = !nextWs && (!nextP || prevWs || prevP);
  const right = !prevWs && (!prevP || nextWs || nextP);
  return [left, right];
}

/** Scan a code span starting at src[i] ('`'). Returns [end, content] or null. */
function scanCodeSpan(src, i, depth) {
  const n = src.length;
  let m = 0;
  while (i + m < n && src[i + m] === '`') m++;
  let j = i + m;
  // Inside a link text, a code span's closer may be on a later line only
  // while still inside the link text ("[a `b\nc` d](u)" forms); once
  // the "]" that ends the link text is passed, the closer must be on
  // the same line ("[x ``b`](u)" on the next line leaves "``b`"
  // literal and the link forms, doc-09; cm-342 "[not a `link](/foo`)"
  // still forms because its closer is on the same line).
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
        return [k, content];
      }
      j = k;
    } else if (depth > 0 && src[j] === ']') {
      seenClose = true;
      j++;
    } else if (depth > 0 && seenClose && src[j] === '\n') {
      return null;
    } else j++;
  }
  return null;
}

const ATTR_NAME_START = /[A-Za-z_:]/;
const ATTR_NAME_CHAR = /[A-Za-z0-9_.:-]/;

/** Scan an inline HTML construct at src[i] ('<'). Returns [end, kind] or null. */
function scanHtmlTag(src, i) {
  const n = src.length;
  if (src.startsWith('<!--', i)) {
    if (src.startsWith('<!-->', i)) return [i + 5, 'comment'];
    if (src.startsWith('<!--->', i)) return [i + 6, 'comment'];
    const p = src.indexOf('-->', i + 4);
    return p === -1 ? null : [p + 3, 'comment'];
  }
  if (src.startsWith('<?', i)) {
    const p = src.indexOf('?>', i + 2);
    return p === -1 ? null : [p + 2, 'pi'];
  }
  if (src.startsWith('<!', i)) {
    if (src.startsWith('<![CDATA[', i)) {
      const p = src.indexOf(']]>', i + 9);
      return p === -1 ? null : [p + 3, 'cdata'];
    }
    const c = src[i + 2];
    if (c >= 'A' && c <= 'Z') {
      const p = src.indexOf('>', i + 2);
      return p === -1 ? null : [p + 1, 'decl'];
    }
    return null;
  }
  let j = i + 1;
  const isClose = src[j] === '/';
  if (isClose) j++;
  if (j >= n || !((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z'))) return null;
  while (j < n && ((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z') || (src[j] >= '0' && src[j] <= '9') || src[j] === '-')) j++;
  // A closing tag has no attributes: only whitespace may follow the
  // name before '>' (cm-624: "</a href=\"foo\">" is not a tag).
  if (isClose) {
    while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r' || src[j] === '\f')) j++;
    return src[j] === '>' ? [j + 1, 'tag'] : null;
  }
  let needWs = true;
  for (;;) {
    const c = src[j];
    if (c === undefined) return null;
    if (c === '>') return [j + 1, 'tag'];
    if (c === '/' && src[j + 1] === '>') return [j + 2, 'tag'];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') { j++; needWs = false; continue; }
    if (needWs) return null;
    if (!ATTR_NAME_START.test(c)) return null;
    while (j < n && ATTR_NAME_CHAR.test(src[j])) j++;
    let sawWs = false;
    while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r' || src[j] === '\f')) { j++; sawWs = true; }
    if (src[j] === '=') {
      j++;
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r' || src[j] === '\f')) j++;
      const q = src[j];
      if (q === '"' || q === "'") {
        const p = src.indexOf(q, j + 1);
        if (p === -1) return null;
        j = p + 1;
      } else {
        const s0 = j;
        while (j < n && src[j] !== ' ' && src[j] !== '\t' && src[j] !== '\n' && src[j] !== '\r' && src[j] !== '\f' && src[j] !== '"' && src[j] !== "'" && src[j] !== '=' && src[j] !== '<' && src[j] !== '>' && src[j] !== '`') j++;
        if (j === s0) return null;
      }
      needWs = true;
    } else {
      // No value: the next attribute needs whitespace after the name,
      // and we already consumed it if sawWs (cm-616: "_boolean zoop:33").
      needWs = !sawWs;
    }
  }
}

const EMAIL_LOCAL = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;

/** Scan an autolink <...> at src[i]. Returns [end, href, text] or null. */
function scanAutolink(src, i) {
  const n = src.length;
  let j = i + 1;
  if (j < n && ((src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z'))) {
    let k = j;
    while (k < n && ((src[k] >= 'a' && src[k] <= 'z') || (src[k] >= 'A' && src[k] <= 'Z') || (src[k] >= '0' && src[k] <= '9') || src[k] === '+' || src[k] === '-' || src[k] === '.')) k++;
    const schemeLen = k - j;
    if (schemeLen >= 2 && schemeLen <= 32 && src[k] === ':') {
      let m = k + 1;
      while (m < n && src[m] !== '>' && src[m] !== ' ' && src[m] !== '\t' && src[m] !== '\n' && src[m] !== '<' && src[m].charCodeAt(0) >= 32) m++;
      if (m < n && src[m] === '>' && m > k + 1) {
        const url = src.slice(i + 1, m);
        return [m + 1, url, url];
      }
    }
  }
  // Email form: local@domain (domain labels, at least one char).
  let k = i + 1;
  while (k < n && EMAIL_LOCAL.test(src[k])) k++;
  if (k > i + 1 && k < n && src[k] === '@') {
    let d = k + 1;
    let lastDot = -1;
    let ok = false;
    while (d < n) {
      const c = src[d];
      if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-') { d++; continue; }
      if (c === '.') { lastDot = d; d++; continue; }
      break;
    }
    if (d > k + 1 && src[d] === '>' && lastDot > k + 1 && src[d - 1] !== '.' && src[d - 1] !== '-') {
      const addr = src.slice(i + 1, d);
      return [d + 1, 'mailto:' + addr, addr];
    }
    ok = ok;
  }
  return null;
}

/** Trim trailing punctuation off a GFM autolink candidate, per the spec:
 *  unbalanced ')' go, a trailing ';' that closes an entity drops the whole
 *  entity, other trailing . , ; : ! ? go. */
function trimGfmEnd(s) {
  for (;;) {
    if (s.length === 0) return s;
    const last = s[s.length - 1];
    if (last === ')') {
      // A ")" closes an open "(" only when one precedes it unmatched:
      // scan the string without its trailing ")", tracking depth, and
      // never let depth go below 0 (a ")" before any "(" is a literal,
      // not a closer). If an unmatched "(" remains, the trailing ")"
      // closes it and is kept (doc-22 "...server)](https://.../page=6)"
      // keeps its final ")"); otherwise it is an extra close and is
      // trimmed.
      let depth = 0;
      for (let i = 0; i < s.length - 1; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')' && depth > 0) depth--;
      }
      if (depth > 0) return s;
      s = s.slice(0, -1); continue;
    }
    if (last === ';') {
      const amp = s.lastIndexOf('&');
      if (amp !== -1 && matchEnt(s, amp) && amp + matchEnt(s, amp)[0] === s.length) {
        s = s.slice(0, amp);
        continue;
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

function isGfmTerminator(c) {
  return c === '' || c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '<' || c === '>' || c === '"' || c === "'" || c === '[' || c === ']' || c === '{' || c === '}' || c === '`' || c.charCodeAt(0) < 32;
}

/** A "(" at src[j] is part of a GFM autolink only when its group closes
 *  before the next space (doc-08: "] (https://... (Most))" stops at the
 *  "(" because the group holds a space; "a(b)" and "](https://b.com/c)"
 *  keep it because the ")" comes first). */
function gfmParenOpen(src, j) {
  const n = src.length;
  for (let k = j + 1; k < n; k++) {
    const c = src[k];
    if (c === ')') return true;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') return false;
  }
  return false;
}

/** Scan a GFM autolink URL body from src[j]: stops at a terminator, or
 *  at a "(" whose group does not close before the next space.
 *  When allowBracket is true, "[" and "]" are URL characters (the
 *  bracket they would close contains a link, so it will not form a
 *  link itself — doc-08/12/22/36/37). */
function scanGfmBody(src, j, allowBracket) {
  const n = src.length;
  while (j < n) {
    const c = src[j];
    if (c === '(' && !gfmParenOpen(src, j)) break;
    if (!allowBracket && isGfmTerminator(c)) break;
    if (allowBracket && isGfmTerminator(c) && c !== '[' && c !== ']') break;
    j++;
  }
  return j;
}

/**
 * Try a GFM extended autolink (www., scheme://, email) at src[i].
 * prevOk must already hold (preceded by start, whitespace or punctuation).
 * Returns [end, href, text] or null.
 */
function scanGfmLink(src, i, allowBracket) {
  const n = src.length;
  if (src.startsWith('www.', i)) {
    let j = scanGfmBody(src, i, allowBracket);
    let cand = trimGfmEnd(src.slice(i, j));
    const rest = cand.slice(4);
    if (rest.length > 0 && rest.includes('.') && !rest.endsWith('.') && !rest.endsWith('-')) {
      return [i + cand.length, 'http://' + cand, cand];
    }
    return null;
  }
  // scheme://
  let k = i;
  if (k < n && ((src[k] >= 'a' && src[k] <= 'z') || (src[k] >= 'A' && src[k] <= 'Z'))) {
    let s0 = k;
    while (k < n && ((src[k] >= 'a' && src[k] <= 'z') || (src[k] >= 'A' && src[k] <= 'Z') || (src[k] >= '0' && src[k] <= '9') || src[k] === '+' || src[k] === '-' || src[k] === '.')) k++;
    if (k - s0 >= 2 && k - s0 <= 32 && src[k] === ':') {
      if (src.startsWith('://', k)) {
        let j = scanGfmBody(src, k + 3, allowBracket);
        let cand = trimGfmEnd(src.slice(i, j));
        if (cand.length > k + 3 - i) return [i + cand.length, cand, cand];
      } else {
        // scheme:email — a scheme followed by ':' is an autolink only
        // when what follows is a valid email (gfm-633/635: "foo:bar"
        // is plain text). "mailto:" links the email alone; any other
        // scheme may also take one path segment after the email
        // ("xmpp:foo@bar.baz/txt" links, "/txt/bin" links only "/txt").
        const em = scanEmail(src, k + 1);
        if (em) {
          let e = em[0];
          const scheme = src.slice(i, k).toLowerCase();
          if (scheme !== 'mailto' && src[e] === '/') {
            let j = e + 1;
            while (j < n && src[j] !== '/' && !(isGfmTerminator(src[j]) && !(allowBracket && (src[j] === '[' || src[j] === ']'))) && !(src[j] === '(' && !gfmParenOpen(src, j))) j++;
            e = j;
          }
          let cand = trimGfmEnd(src.slice(i, e));
          if (cand.length > k + 1 - i) return [i + cand.length, cand, cand];
        }
      }
    }
  }
  // email: local@domain with a dot in the domain.
  const em0 = scanEmail(src, i);
  if (em0) return [em0[0], 'mailto:' + em0[1], em0[1]];
  return null;
}

/** Scan a GFM email autolink at src[i]. The candidate is scanned
 *  greedily (a trailing '-', '_' or '.' is part of it); then trailing
 *  '.'s are trimmed and the result must end in a letter or digit — so
 *  "a@b.c." links but "a@b.c-" and "a@b.c_" do not (gfm-632).
 *  Returns [end, email] or null. */
function scanEmail(src, i) {
  const n = src.length;
  if (!((src[i] >= 'a' && src[i] <= 'z') || (src[i] >= 'A' && src[i] <= 'Z') || (src[i] >= '0' && src[i] <= '9'))) return null;
  let j = i;
  while (j < n && EMAIL_LOCAL.test(src[j])) j++;
  if (j === i || j >= n || src[j] !== '@') return null;
  let d = j + 1;
  // The domain uses letters, digits, '-' and '.' only — '_' is not a
  // domain character. A '_' right after the email is part of the email
  // (and invalidates it) unless it is followed by punctuation or
  // whitespace, in which case it is an emphasis delimiter or text
  // (doc-38: "first@sprout.example.com_," links; gfm-632: "a@b.c_"
  // at end-of-line does not).
  while (d < n) {
    const c = src[d];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-' || c === '.') { d++; continue; }
    break;
  }
  if (src[d] === '_') {
    const after = d + 1 < n ? src[d + 1] : '';
    if (after === '' || after === '\n' || after === '\r' || ((after >= 'a' && after <= 'z') || (after >= 'A' && after <= 'Z') || (after >= '0' && after <= '9'))) return null;
  }
  // Trim trailing dots, then the email must end in a letter/digit.
  let e = d;
  while (e > j + 1 && src[e - 1] === '.') e--;
  const last = src[e - 1];
  // The (trimmed) domain must contain a dot that is not trailing.
  const dom = src.slice(j + 1, e);
  if (dom.includes('.') && !dom.startsWith('.') && !dom.includes('..') && ((last >= 'a' && last <= 'z') || (last >= 'A' && last <= 'Z') || (last >= '0' && last <= '9'))) {
    let cand = trimGfmEnd(src.slice(i, e));
    if (cand.includes('@') && cand.includes('.')) return [i + cand.length, cand];
  }
  return null;
}

/** Whether the char before a GFM autolink may precede one. */
function gfmPrevOk(prev) {
  if (prev === '') return true;
  const c = prev.charCodeAt(0);
  if (c < 128) {
    // ASCII whitespace, or one of *_~([{"'< — the only ASCII
    // characters that can precede a GFM autolink.
    return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c === 42 || c === 95 || c === 126 || c === 40 || c === 91 || c === 123 || c === 34 || c === 39 || c === 60;
  }
  return isWsCh(prev);
}

/** The href for an autolink URL: entities are resolved, but backslash
 *  escapes are NOT (a backslash in an autolink is encoded as %5C). */
function hrefOfAuto(raw) {
  let s = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '&') {
      const m = matchEnt(raw, i);
      if (m) {
        if (raw[i + 1] === '#') {
          const d = m[1];
          s += d === '&' ? '&amp;' : d;
        } else {
          s += m[1];
        }
        i += m[0] - 1;
      } else {
        s += '&';
      }
    } else {
      s += c;
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

/** The href for a raw link destination: backslash escapes and entities are
 *  resolved, then the result is URI-encoded (with %25 restored, so an
 *  already-encoded %20 stays %20), then HTML-escaped with entity awareness. */
function hrefOf(raw) {
  let s = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && i + 1 < raw.length && PUNCT[raw.charCodeAt(i + 1)] === 1) {
      const p = raw[i + 1];
      s += p === '&' ? '&amp;' : p;
      i++;
    } else if (c === '&') {
      const m = matchEnt(raw, i);
      if (m) {
        if (raw[i + 1] === '#') {
          const d = m[1];
          s += d === '&' ? '&amp;' : d;
        } else {
          s += m[1];
        }
        i += m[0] - 1;
      } else {
        s += '&';
      }
    } else {
      s += c;
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

function skipInlineWs(src, k) {
  while (k < src.length && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
  return k;
}

/** Parse a link destination at src[k]. Returns [dest, next] or null. */
function parseLinkDest(src, k) {
  const n = src.length;
  if (src[k] === '<') {
    let m = k + 1;
    while (m < n) {
      const c = src[m];
      if (c === '\\' && m + 1 < n) { m += 2; continue; }
      if (c === '>') return [src.slice(k + 1, m), m + 1];
      if (c === '\n' || c === '<') return null;
      m++;
    }
    return null;
  }
  let m = k;
  let depth = 0;
  while (m < n) {
    const c = src[m];
    if (c === '\\' && m + 1 < n && PUNCT[src.charCodeAt(m + 1)] === 1) { m += 2; continue; }
    if (c === '(') { depth++; m++; continue; }
    if (c === ')') { if (depth === 0) break; depth--; m++; continue; }
    if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
    m++;
  }
  return [src.slice(k, m), m];
}

/** Parse a link title at src[k] ('"' or "'" or '('). Returns [title, next] or null. */
function parseLinkTitle(src, k) {
  const n = src.length;
  const q = src[k];
  if (q === '"' || q === "'") {
    let m = k + 1;
    while (m < n) {
      const c = src[m];
      if (c === '\\' && m + 1 < n && PUNCT[src.charCodeAt(m + 1)] === 1) { m += 2; continue; }
      if (c === q) return [src.slice(k + 1, m), m + 1];
      m++;
    }
    return null;
  }
  if (q === '(') {
    let m = k + 1;
    let depth = 1;
    while (m < n) {
      const c = src[m];
      if (c === '\\' && m + 1 < n && PUNCT[src.charCodeAt(m + 1)] === 1) { m += 2; continue; }
      if (c === '(') { depth++; m++; continue; }
      if (c === ')') { depth--; if (depth === 0) return [src.slice(k + 1, m), m + 1]; m++; continue; }
      m++;
    }
    return null;
  }
  return null;
}

/** Normalize a link label: collapse whitespace, trim, Unicode case-fold.
 *  Backslash escapes are NOT resolved in labels (a label "foo\!" differs
 *  from "foo!"). */
function normalizeLabel(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

/** True when the "(" at src[j] has a matching ")" (balanced parens,
 * backslash escapes respected). Detects a link-like "(...)" after a
 * "]" whose link failed to form. */
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

/** Mark the emphasis delimiters among nodes[fromIdx..] as literal, so
 * processEmphasis leaves them as plain text. */
function markDelimitersLiteral(nodes, fromIdx) {
  for (let k = fromIdx; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd && nd.k === 5) nd.lit = true;
  }
}

/** Scan a reference label starting at src[j] ('['). Returns [content, end] or null. */
function scanLabel(src, j) {
  const n = src.length;
  let m = j + 1;
  let depth = 1;
  let len = 0;
  while (m < n) {
    const c = src[m];
    if (c === '\\' && m + 1 < n) { m += 2; len += 2; continue; }
    if (c === '[') { depth++; m++; len++; continue; }
    if (c === ']') {
      depth--;
      if (depth === 0) {
        if (len > 999) return null;
        return [src.slice(j + 1, m), m + 1];
      }
      m++; len++; continue;
    }
    if (c === '\n' && src[m + 1] === '\n') return null;
    m++; len++;
  }
  return null;
}

/**
 * True when a link's bracket text can be consumed by marked's link-label
 * grammar (the label part of its inline/reflink regex): a run of plain
 * chars (not [] \ `), an escape, a nested bracket (at most one inner
 * level, so bracket depth inside the label is at most 2), a code-span
 * token (a maximal backtick run, non-backtick content, the next
 * backtick run — the two runs may differ in length), or a run of 2+
 * backticks immediately before the closing "]". A run that cannot be
 * consumed this way (e.g. "[x ``a ` b`` y]" — the final "``" has no
 * closer and is not at the end) prevents the inline/reflink form;
 * the shortcut form uses a different label pattern (any chars except
 * [] \) and is not gated here.
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
      // A run of 2+ backticks at the very end of the label is literal.
      if (i + m === n) return m >= 2;
      // Code-span token: the content runs to the next backtick run.
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

/**
 * Try to resolve a link for the bracket `brk` whose ']' is at src index
 * brk.closeIdx, looking at what follows it. Returns {href, title, end}
 * with the raw destination/title, or null.
 */
function tryResolveLink(src, j, brk, refs) {
  const n = src.length;
  const textLabel = () => normalizeLabel(src.slice(brk.srcStart, brk.closeIdx));
  if (j < n && src[j] === '(') {
    // An inline link needs a well-formed label (see labelSegmentsOk);
    // a bad label or a bad destination falls back to a shortcut
    // reference, whose label pattern allows any chars except [] \.
    const text = src.slice(brk.srcStart, brk.closeIdx);
    let k = skipInlineWs(src, j + 1);
    let dest = null;
    let next = -1;
    if (src[k] === ')') { dest = ''; next = k; }
    else {
      const d = parseLinkDest(src, k);
      if (d) { dest = d[0]; next = d[1]; }
    }
    if (dest !== null) {
      const k2 = skipInlineWs(src, next);
      if (src[k2] === ')') {
        if (labelSegmentsOk(text)) return { href: dest, title: null, end: k2 + 1 };
      } else if (src[k2] === '"' || src[k2] === "'" || src[k2] === '(') {
        const t = parseLinkTitle(src, k2);
        if (t) {
          const k3 = skipInlineWs(src, t[1]);
          if (src[k3] === ')') {
            if (labelSegmentsOk(text)) return { href: dest, title: t[0], end: k3 + 1 };
          }
        }
      }
    }
    // Inline form failed: fall back to a shortcut reference.
    const ref = refs.get(textLabel());
    if (ref) return { href: ref.dest, title: ref.title, end: j };
    return null;
  }
  if (j < n && src[j] === '[') {
    // A reflink needs a well-formed label; a bad label falls back to
    // a shortcut reference, but an undefined reflink label does not
    // (the "]" stays literal).
    const text = src.slice(brk.srcStart, brk.closeIdx);
    if (!labelSegmentsOk(text)) {
      const ref = refs.get(textLabel());
      if (ref) return { href: ref.dest, title: ref.title, end: j };
      return null;
    }
    const lab = scanLabel(src, j);
    if (lab) {
      const label = lab[0] === '' ? textLabel() : normalizeLabel(lab[0]);
      const ref = refs.get(label);
      if (ref) return { href: ref.dest, title: ref.title, end: lab[1] };
    }
    return null;
  }
  const ref = refs.get(textLabel());
  if (ref) return { href: ref.dest, title: ref.title, end: j };
  return null;
}

/** True when the node list contains a bracket-formed link (autolinks do not count). */
function childrenContainLink(nodes) {
  for (const nd of nodes) {
    if (!nd) continue;
    if (nd.k === 7 && !nd.img && !nd.auto) return true;
    if (nd.k === 7 || nd.k === 8) {
      if (childrenContainLink(nd.ch)) return true;
    }
  }
  return false;
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

/**
 * Tokenize inline source into nodes. Node kinds:
 *  0 text (raw, escaped on render), 1 code span, 2 raw html, 3 hard break,
 *  5 delimiter run, 6 bracket marker, 7 link/image, 8 em/strong/del,
 *  9 entity (final output form).
 */
/** Set while an inline <a> tag is open (no matching </a> yet) — while set,
 * GFM autolinks are not created (marked behaviour: an <a> tag that is not
 * an HTML block, e.g. one spanning two lines, leaves the flag set for the
 * rest of the document; a later inline </a> clears it). Regular links and
 * angle autolinks are unaffected. Reset for each document in parse(). */
let inAnchor = false;
/** Set while tokenizing when an emphasis delimiter node (k=5) was
 *  created — inlineHtml skips processEmphasis entirely when none
 *  exists, since it would be a no-op. Reset per tokenizeInline call. */
let tokHasDelim = false;

function tokenizeInline(src, refs) {
  const nodes = [];
  const brackets = [];
  let buf = '';
  tokHasDelim = false;
  // suppressUntil: an unmatched backtick run inside a link text ("``y`")
  // suppresses emphasis delimiters up to the next backtick run of the
  // same length (or the end of the paragraph): marked treats the region
  // as code-span content for emphasis purposes, so "_a_" between the
  // link and the next "``" stays literal (doc-09, probe38-40).
  let suppressUntil = -1;
  let forceLiteralBt = -1;
  const flush = () => { if (buf !== '') { nodes.push({ k: 0, s: buf }); buf = ''; } };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    // Fast path: a letter or digit in the middle of a word is always
    // plain text — no inline construct can start inside a word, and
    // a GFM autolink cannot start mid-word either. Append the rest
    // of the word in one slice instead of one character at a time.
    const code = c.charCodeAt(0);
    if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      const pc = i > 0 ? src.charCodeAt(i - 1) : 0;
      if ((pc >= 48 && pc <= 57) || (pc >= 65 && pc <= 90) || (pc >= 97 && pc <= 122)) {
        let j = i;
        while (j < n) {
          const cj = src.charCodeAt(j);
          if (!((cj >= 48 && cj <= 57) || (cj >= 65 && cj <= 90) || (cj >= 97 && cj <= 122))) break;
          j++;
        }
        buf += src.slice(i, j);
        i = j;
        continue;
      }
    }
    if (c === '\n') {
      let t = buf.length;
      let spaces = 0;
      while (t > 0 && buf[t - 1] === ' ') { t--; spaces++; }
      if (spaces >= 2) {
        buf = buf.slice(0, t);
        flush();
        nodes.push({ k: 3 });
        i++;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      } else {
        flush();
        nodes.push({ k: 0, s: '\n' });
        i++;
      }
      continue;
    }
    if (c === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') {
        flush();
        nodes.push({ k: 3 });
        i += 2;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      if (nx !== undefined && PUNCT[nx.charCodeAt(0)] === 1) { buf += nx; i += 2; continue; }
      buf += '\\'; i++; continue;
    }
    if (c === '`') {
      const cs = forceLiteralBt === i ? null : scanCodeSpan(src, i, brackets.length);
      if (cs) { flush(); nodes.push({ k: 1, s: cs[1] }); i = cs[0]; continue; }
      // No matching closer: the whole backtick run is literal text, so a
      // shorter run inside it can never start a code span.
      let m = 0;
      while (i + m < n && src[i + m] === '`') m++;
      if (forceLiteralBt === i) forceLiteralBt = -1;
      if (brackets.length > 0) {
        // Find the next backtick run of the same length; emphasis is
        // suppressed up to it. If there is none, do not suppress:
        // extending to the end of the paragraph blocks emphasis that
        // must form (doc-06 "*promise example and*" after a link
        // whose "``" has no later "``" run). Keep the furthest
        // suppression: a shorter run inside the same literal text
        // ("``url`") must not shorten the one set by the longer run.
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
        // The failed run's mismatched closer (the next backtick run
        // before the closing "]") must not start a code span that
        // swallows the "]" and breaks the link (doc-28 "``small`":
        // the "`" after "small" would otherwise pair with a later
        // "`" and swallow the link syntax). Mark it literal.
        for (let k = i + m; k < n; k++) {
          if (src[k] === '`') { forceLiteralBt = k; break; }
          if (src[k] === ']' && (k === 0 || src[k - 1] !== '\\')) break;
          if (src[k] === '\n' && src[k + 1] === '\n') break;
        }
      }
      buf += src.slice(i, i + m); i += m; continue;
    }
    if (c === '<') {
      const tag = scanHtmlTag(src, i);
      if (tag) {
        flush();
        const tagText = src.slice(i, tag[0]);
        // Track <a> / </a> for the GFM-autolink suppression flag.
        // Only the exact "<a/>" (no space, no attributes) is
        // self-closing: "<a />", "<a  />" and "<a href=... />" all
        // open an anchor and suppress later GFM autolinks (doc-06).
        const lo3 = tagText.slice(0, 3).toLowerCase();
        const lo4 = tagText.slice(0, 4).toLowerCase();
        if (lo4 === '</a>' || lo4 === '</a ' || lo4 === '</a\t' || lo4 === '</a\n') inAnchor = false;
        else if ((lo3 === '<a>' || lo3 === '<a ' || lo3 === '<a\t' || lo3 === '<a\n') && tagText.toLowerCase() !== '<a/>') inAnchor = true;
        nodes.push({ k: 2, s: tagText }); i = tag[0]; continue;
      }
      const al = scanAutolink(src, i);
      if (al) {
        flush();
        nodes.push({ k: 7, href: hrefOfAuto(al[1]), title: null, img: false, auto: true, ch: [{ k: 0, s: al[2] }] });
        i = al[0];
        continue;
      }
      buf += '<'; i++; continue;
    }
    if (c === '&') {
      const m = matchEnt(src, i);
      if (m) { flush(); nodes.push({ k: 9, s: src[i + 1] === '#' ? escRaw(m[1]) : m[1] }); i += m[0]; continue; }
      buf += '&'; i++; continue;
    }
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const img = c === '!';
      flush();
      nodes.push({ k: 6, img });
      brackets.push({ nodeIdx: nodes.length - 1, srcStart: img ? i + 2 : i + 1, img });
      i += img ? 2 : 1;
      continue;
    }
    if (c === ']') {
      const top = brackets[brackets.length - 1];
      if (top) {
        flush();
        top.closeIdx = i;
        const res = tryResolveLink(src, i + 1, top, refs);
        if (res) {
          let children = nodes.slice(top.nodeIdx + 1);
          if (!top.img && childrenContainLink(children)) {
            brackets.pop();
            // This bracket's text contains a link, so its parent's
            // text does too (its "]" will not form a link).
            if (top.hasLink && brackets.length > 0) brackets[brackets.length - 1].hasLink = true;
            buf += ']'; i++; continue;
          }
          // A GFM autolink inside link text becomes plain text (angle
          // autolinks stay links — marked nests those). Convert before
          // the link node is built so the autolink's text is preserved.
          children = children.map((nd) => {
            if (nd && nd.k === 7 && nd.gfm) {
              let s = '';
              for (const c of nd.ch || []) if (c && c.k === 0) s += c.s;
              return { k: 0, s };
            }
            return nd;
          });
          nodes.length = top.nodeIdx;
          nodes.push({
            k: 7,
            href: hrefOf(res.href),
            title: res.title === null ? null : attrEscape(res.title, false),
            img: top.img,
            ch: children,
          });
          brackets.pop();
          // A link just formed inside this bracket's parent (if any),
          // so the parent's text contains a link.
          if (brackets.length > 0) brackets[brackets.length - 1].hasLink = true;
          i = res.end;
          continue;
        }
        brackets.pop();
        if (top.hasLink && brackets.length > 0) brackets[brackets.length - 1].hasLink = true;
        // The link did not form. If a link-like "(...)" follows the
        // "]", marked leaves the emphasis delimiters inside the
        // bracket's text literal (its masking hides them), so mark
        // them literal here instead of letting them form emphasis.
        if (src[i + 1] === '(' && hasMatchingParen(src, i + 1)) markDelimitersLiteral(nodes, top.nodeIdx + 1);
        // The bracket failed and it was the outermost open one: if
        // the last non-text child is a GFM autolink, marked extends
        // that autolink past the "]" (a bracket that will not form
        // cannot claim it, and the text between the autolink and the
        // "]" is part of the URL). Re-scan from the autolink's start
        // with brackets allowed; if it reaches past the "]", replace
        // the autolink, drop the text nodes it swallowed, and skip
        // past the extended URL.
        if (brackets.length === 0) {
          let ai = -1;
          for (let k = nodes.length - 1; k > top.nodeIdx; k--) {
            const nd = nodes[k];
            if (!nd) continue;
            if (nd.k === 0) continue;
            if (nd.k === 7 && nd.gfm && nd.srcStart !== undefined) ai = k;
            break;
          }
          if (ai !== -1) {
            const last = nodes[ai];
            const g2 = scanGfmLink(src, last.srcStart, true);
            if (g2 && g2[0] > i) {
              last.href = hrefOfAuto(g2[1]);
              last.ch = [{ k: 0, s: g2[2] }];
              for (let k = ai + 1; k < nodes.length; k++) nodes[k] = null;
              i = g2[0];
              continue;
            }
          }
        }
        buf += ']'; i++; continue;
      }
      buf += ']'; i++; continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let m = 0;
      while (i + m < n && src[i + m] === c) m++;
      // Suppression only applies outside any link text: emphasis
      // inside the same link text ("*export ``open`*" in doc-14)
      // still forms; only delimiters after the link closes are
      // suppressed (doc-09 "_issue table_").
      if (suppressUntil !== -1 && i < suppressUntil && brackets.length === 0) {
        buf += src.slice(i, i + m);
        i += m;
        continue;
      }
      if (suppressUntil !== -1 && i >= suppressUntil) suppressUntil = -1;
      if (c === '~' && m > 2) {
        buf += src.slice(i, i + m);
        i += m;
        continue;
      }
      const [left, right] = flankInfo(src, i, m);
      let o, cl;
      if (c === '_') {
        o = left && (!right || isPunctCh(i > 0 ? src[i - 1] : ''));
        cl = right && (!left || isPunctCh(i + m < n ? src[i + m] : ''));
      } else {
        o = left; cl = right;
      }
      flush();
      nodes.push({ k: 5, c, n: m, o, cl });
      tokHasDelim = true;
      i += m;
      continue;
    }
    if (!inAnchor && (c === 'w' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))) {
      // Mid-word characters cannot start an autolink (the previous
      // character is a letter or digit, never a boundary) — skip the
      // boundary check entirely for them.
      const pc = i > 0 ? src.charCodeAt(i - 1) : 0;
      const prevIsWord = (pc >= 48 && pc <= 57) || (pc >= 65 && pc <= 90) || (pc >= 97 && pc <= 122);
      if (!prevIsWord && gfmPrevOk(i > 0 ? src[i - 1] : '') && gfmMaybe(src, i)) {
      // A "]" may be part of the GFM URL when there is no open
      // bracket (nothing needs the "]") or the innermost open
      // bracket contains a link (so it will not form a link itself).
      const topBr = brackets.length > 0 ? brackets[brackets.length - 1] : null;
      const g = scanGfmLink(src, i, !topBr || topBr.hasLink);
      if (g) {
        flush();
        nodes.push({ k: 7, href: hrefOfAuto(g[1]), title: null, img: false, auto: true, gfm: true, srcStart: i, ch: [{ k: 0, s: g[2] }] });
        i = g[0];
        continue;
      }
      }
    }
    buf += c;
    i++;
  }
  flush();
  return nodes;
}

/** Resolve emphasis / strong / strikethrough in a node list (recursing into
 *  link children first, so inner emphasis is settled before outer). */
function processEmphasis(nodes) {
  for (const nd of nodes) {
    if (!nd) continue;
    if (nd.k === 7 || nd.k === 8) processEmphasis(nd.ch);
  }
  for (let a = 0; a < nodes.length; a++) {
    const nd = nodes[a];
    if (nd && nd.k === 5) nd.idx = a;
  }
  const stack = [];
  // bottom[ch]: {idx, use} — when an emphasis is formed whose closer can
  // also open and is fully consumed, and whose opener cannot close,
  // earlier openers are cut off for later closers, but only for a use
  // different from the one just formed. So "*a **b**c*" (inner use 2,
  // outer would be use 1) leaves the outer asterisks literal, while
  // "**line **same**private**" (inner use 2, outer use 2) and
  // "*a *b*c*" (inner use 1, outer use 1) still form the outer emphasis;
  // "***a *b*c***" falls back to use 1 for the outer pair.
  const bottom = {};
  for (let idx = 0; idx < nodes.length; idx++) {
    const nd = nodes[idx];
    if (!nd || nd.k !== 5 || nd.n === 0 || nd.lit) continue;
    const ch = nd.c;
    if (nd.cl) {
      const odd = new Set();
      while (nd.n > 0) {
        let foundPos = -1;
        let foundUse = 0;
        let foundVMax = 0;
        let foundCloserInside = false;
        let sawPartial = false;
        for (let s = stack.length - 1; s >= 0; s--) {
          const o = stack[s];
          if (!o || o.n === 0 || o.c !== ch || !o.o || odd.has(o)) continue;
          // Determine the use this opener would form with this closer.
          let vMax;
          if (ch === '~') {
            if (o.n !== nd.n) { odd.add(o); continue; }
            vMax = o.n;
          } else {
            vMax = o.n >= 2 && nd.n >= 2 ? 2 : 1;
          }
          // Bottom: an opener below it is usable only for the same use
          // as the emphasis that set the bottom (or a smaller use that
          // matches it, e.g. use 1 when the bottom's use is 1).
          const b = bottom[ch];
          let v = vMax;
          if (b !== undefined && o.idx < b.idx && ch !== '~') {
            if (vMax === b.use) v = vMax;
            // A strong may still form when the opener is fully consumed
            // and the closer keeps a leftover ("**a *b*c***" and
            // "**return that *old*two***" form <strong>, leaving one
            // "*" inside; "**a *b*c**" with nd.n 2 forms nothing).
            else if (vMax === 2 && b.use === 1 && o.n === 2 && nd.n >= 3) v = 2;
            // Fall back to a smaller use only when both sides keep
            // at least 2 delimiters afterwards; otherwise a lone "*"
            // would be left that must stay literal ("**a *b*c**"
            // forms nothing, while "***a *b*c***" forms one <em>).
            else if (vMax === 2 && b.use === 1 && o.n >= 3 && nd.n >= 3) v = 1;
            else continue;
            // An opener below the bottom must be fully consumed by the
            // match: a single "*" may not peel one delimiter off a
            // "**" opener (doc-01 "**public as *so*other* ... **"
            // leaves the "*" literal and the "**" forms a <strong>).
            // A fallback (v < vMax) is exempt — it moves the leftover
            // delimiters inside the emphasis by design.
            if (v === vMax && o.n > vMax) { odd.add(o); sawPartial = true; continue; }
          }
          if (ch !== '~' && ((o.o && o.cl) || (nd.o && nd.cl)) && (o.n + nd.n) % 3 === 0 && !(o.n % 3 === 0 && nd.n % 3 === 0)) {
            odd.add(o);
            continue;
          }
          foundPos = s;
          foundUse = v;
          foundVMax = vMax;
          foundCloserInside = v === 2 && vMax === 2 && b !== undefined && o.idx < b.idx && ch !== '~' && b.use === 1 && o.n === 2 && nd.n >= 3;
          break;
        }
        if (foundPos === -1) {
          // No usable opener: the closer stays literal. The bottom is
          // reset only when the failure was a partial-consumption
          // skip (doc-01: after the "*" after "other" fails, the later
          // "**" forms a <strong> with the outer "**"); a failure by
          // use mismatch leaves the bottom in place, so a later "**"
          // still skips a single-"*" opener and forms the <strong>
          // (doc-11 "**removes example *input **parse**parse* ...**").
          if (sawPartial) delete bottom[ch];
          break;
        }
        const o = stack[foundPos];
        const children = [];
        for (let j = o.idx + 1; j < nd.idx; j++) {
          const m = nodes[j];
          if (m) children.push(m);
        }
        if (children.length === 0) {
          odd.add(o);
          continue;
        }
        const use = foundUse;
        const tag = ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
        const emNode = { k: 8, tag, ch: children };
        for (let j = o.idx + 1; j < nd.idx; j++) nodes[j] = null;
        nodes[o.idx + 1] = emNode;
        o.n -= use;
        nd.n -= use;
        // A fallback (a smaller use than the pair could form) is used
        // once per opener/closer pair: do not re-match the same opener
        // with this closer, or "***a *b*c***" would nest three <em>.
        // The delimiters left over by a fallback stay literal inside
        // the emphasis ("<em>**a ... c**</em>"), so move them in and
        // fully consume both ends.
        if (use < foundVMax) {
          odd.add(o);
          if (o.n > 0) { emNode.ch.unshift({ k: 0, s: ch.repeat(o.n) }); o.n = 0; }
          if (nd.n > 0) { emNode.ch.push({ k: 0, s: ch.repeat(nd.n) }); nd.n = 0; }
        } else if (foundCloserInside && nd.n > 0) {
          // The bottom-exception strong ("**a *b*c***") leaves one
          // "*" of the "***" closer literal inside the <strong>.
          emNode.ch.push({ k: 0, s: ch.repeat(nd.n) });
          nd.n = 0;
        }
        // An emphasis whose closer can also open and is fully consumed,
        // and whose opener cannot close, cuts off earlier openers for
        // later closers of a different use (see bottom).
        if (ch !== '~' && nd.n === 0 && nd.o && !o.cl) bottom[ch] = { idx: o.idx, use };
        for (let s = stack.length - 1; s > foundPos; s--) {
          const x = stack[s];
          if (x && x.idx > o.idx && x.idx < nd.idx) stack.splice(s, 1);
        }
        if (o.n === 0) {
          nodes[o.idx] = null;
          stack.splice(foundPos, 1);
        }
        if (nd.n === 0) {
          nodes[nd.idx] = null;
          break;
        }
      }
    }
    if (nd.n > 0 && nd.o) stack.push(nd);
  }
}

function renderNodes(nodes, out) {
  for (const nd of nodes) {
    if (!nd) continue;
    switch (nd.k) {
      case 0: out.push(escRaw(nd.s)); break;
      case 1: out.push('<code>' + escRaw(nd.s) + '</code>'); break;
      case 2: out.push(nd.s); break;
      case 3: out.push('<br>'); break;
      case 5: out.push(nd.c.repeat(nd.n)); break;
      case 6: out.push(nd.img ? '![' : '['); break;
      case 7: {
        if (nd.img) {
          out.push('<img src="' + nd.href + '" alt="' + plainAlt(nd.ch) + '"');
          if (nd.title !== null) out.push(' title="' + nd.title + '"');
          out.push('>');
        } else {
          out.push('<a href="' + nd.href + '"');
          if (nd.title !== null) out.push(' title="' + nd.title + '"');
          out.push('>');
          renderNodes(nd.ch, out);
          out.push('</a>');
        }
        break;
      }
      case 8:
        out.push('<' + nd.tag + '>');
        renderNodes(nd.ch, out);
        out.push('</' + nd.tag + '>');
        break;
      case 9: out.push(nd.s); break;
    }
  }
}

/** Plain-text form of inline nodes, for image alt attributes (HTML stripped). */
function plainAlt(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (!nd) continue;
    switch (nd.k) {
      case 0: out += escRaw(nd.s); break;
      case 1: out += escRaw(nd.s); break;
      case 2: break;
      case 3: break;
      case 5: out += nd.c.repeat(nd.n); break;
      case 6: out += nd.img ? '![' : '['; break;
      case 7: out += plainAlt(nd.ch); break;
      case 8: out += plainAlt(nd.ch); break;
      case 9: out += nd.s; break;
    }
  }
  return out;
}

/** Fast path: text with no inline structure at all. */
function plainInline(src) {
  if (src.indexOf('&') === -1 && src.indexOf('<') === -1) return escRaw(src);
  return null;
}

/** Render inline markdown to HTML. */
function inlineHtml(src, refs) {
  if (src === '') return '';
  const nodes = tokenizeInline(src, refs);
  if (tokHasDelim) processEmphasis(nodes);
  const out = [];
  renderNodes(nodes, out);
  return out.join('');
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

/** [columns, string index] of the leading spaces/tabs of a line. */
function measureIndent(line) {
  let cols = 0;
  let idx = 0;
  while (idx < line.length) {
    const c = line[idx];
    if (c === ' ') { cols++; idx++; }
    else if (c === '\t') { cols += 4 - (cols % 4); idx++; }
    else break;
  }
  return [cols, idx];
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** Blank line for table-row purposes: a whitespace-only line is blank,
 * except one ending in a tab whose expanded indent is at most 4 — that
 * is a (empty) table row, and the table continues past it (doc-02:
 * a lone "\t" line is a row of empty cells). */
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

/** Remove n columns of indentation, expanding the remaining leading
 *  whitespace to spaces (measured from the original columns, which the
 *  string starts at). Used when the result is re-parsed, so its
 *  indentation stays true to the source. */
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

/** Remove up to n leading whitespace CHARACTERS for fenced code
 *  content. Marked's indent compensation counts characters, not
 *  columns: a tab is one character (cm-006 / the "indented four"
 *  case — a fence opened with 2 spaces strips a leading tab plus one
 *  space from its content lines). */
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
  // A backtick fence's info string may not contain a backtick
  // ("```inner backticks```" is paragraph text, an inline code span,
  // not a fence, doc-05). A tilde fence has no such restriction
  // (cm-146 "~~~ aa ``` ~~~" is a fence with language "aa").
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

/** HTML block type (1-7) starting on this line, or 0. */
function htmlBlockInfo(line) {
  const [ind, idx] = measureIndent(line);
  if (ind > 3 || line[idx] !== '<') return 0;
  const rest = line.slice(idx);
  const m1 = rest.match(/^<(script|pre|style|textarea)([\s>]|$)/i);
  if (m1) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![A-Z]/.test(rest)) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  const m6 = rest.match(/^<\/?([A-Za-z][A-Za-z0-9-]*)/);
  if (m6) {
    const tag = m6[1].toLowerCase();
    const after = rest[m6[0].length];
    if (BLOCK_TAGS.has(tag) && (after === undefined || after === ' ' || after === '\t' || after === '>' || after === '/')) return 6;
    // Type 7: the whole line must be one valid tag (cm-619: a tag
    // with an invalid attribute is not an html block at all).
    if (!BLOCK_TAGS.has(tag)) {
      const t = scanHtmlTag(line, idx);
      if (t && t[1] === 'tag') {
        let r = t[0];
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

/** Split a table row line into cells (pipes in code spans / escaped do not split). */
function splitCells(line) {
  // GFM cell split: only a backslash-escaped pipe "\|" is a literal
  // pipe in the cell (gfm-200); a backtick does NOT protect "|" from
  // splitting (probe52: "| `a | b` |" splits into "`a" and "b`", and
  // "| ``used` | `a \| b` |" splits after "``used`" because the
  // single "`" after "used" is a mismatched closer, not a new code
  // span opener). Other escapes stay for the inline parser.
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

/** If the line is a table delimiter row, the alignments (null/left/center/right). */
function tableDelimCells(line) {
  // Cheap reject: a delimiter row is only | - : space tab. Any other
  // character lands in some cell and makes it fail the delimiter
  // pattern, so the row cannot be a delimiter.
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
    if (!/^:?-+:?$/.test(cell)) return null;
    aligns.push(cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : null);
  }
  return aligns;
}

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

/** Could this raw line be a lazy continuation line inside a container? */
/** Whether a raw line can be a lazy continuation of an open paragraph
 *  inside a container. A setext underline CAN be one (it is added as
 *  text with a 4-space prefix — see lazyPush); a plain line of any
 *  indentation can (cm-238, cm-291). Block starts that end a paragraph
 *  (ATX, fence, hr, html block, quote, table delimiter, a valid list
 *  marker) cannot. */
function isLazyLine(l) {
  if (isBlankLine(l)) return false;
  if (atxInfo(l) || fenceInfo(l)) return false;
  const hb = htmlBlockInfo(l);
  if (hb >= 1 && hb <= 6) return false;
  const [ind, idx] = measureIndent(l);
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

/** The container prefix to prepend to a lazy line so the sub-parse
 *  routes it to the innermost open paragraph of `content` (a sub-line).
 *  E.g. for "1. > Blockquote" the prefix is "    > " (the item's
 *  content indent + the quote marker), so a lazy line becomes part of
 *  the inner quote's paragraph (cm-292/293). */
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

/** True when the container path of `content` (see lazyPrefix) routes
 *  into a list item: a lazy line with such a prefix is the item's
 *  content and must stay in the current blockquote chunk, not start
 *  a new one. Mirrors lazyPrefix's recursion. */
function lazyRoutesToList(content) {
  const mk = markerInfo(content);
  if (mk && !mk.empty) return true;
  const [ind, idx] = measureIndent(content);
  if (ind <= 3 && content[idx] === '>') {
    return lazyRoutesToList(stripQuotePrefix(content, ind, idx));
  }
  return false;
}

/** Push a lazy line into a container's sub-lines: a setext underline is
 *  prefixed with 4 spaces so it stays paragraph text (cm-093), a line
 *  indented 4+ is stripped by 4 columns, otherwise the line is kept.
 *  If the stripped line would start a block when re-parsed (e.g. a
 *  list marker), its first character is backslash-escaped so it stays
 *  paragraph text and renders as the original (cm-238).
 *  `prefix` (default '') is a container path (see lazyPrefix) that
 *  routes the line to a nested paragraph (cm-292/293). */
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

/** Merge one blockquote chunk's blocks into the accumulated blocks,
 *  following marked's blockquote chunk merging: a paragraph merges
 *  into a preceding paragraph, an indented code block merges into a
 *  preceding paragraph (its text keeps its trailing newline, so the
 *  next paragraph starts after a blank line), and a nested quote
 *  merges into a preceding nested quote (recursively). Blocks that a
 *  blank line separated from the previous one (bb) never merge. */
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
  // A definition label runs to the first unescaped ']' (no nesting).
  let m = p + 1;
  let labLen = 0;
  let labelEnd = -1;
  while (m < s.length) {
    const c = s[m];
    if (c === '\\' && m + 1 < s.length) { m += 2; labLen += 2; continue; }
    if (c === ']') { labelEnd = m; break; }
    // A definition label cannot contain an unescaped '[' (cm-546).
    if (c === '[') return null;
    if (c === '\n' && s[m + 1] === '\n') return null;
    m++; labLen++;
  }
  if (labelEnd === -1 || labLen === 0 || labLen > 999) return null;
  if (s[labelEnd + 1] !== ':') return null;
  const labelRaw = s.slice(p + 1, labelEnd);
  // A whitespace-only label is not a definition (cm-552).
  if (normalizeLabel(labelRaw) === '') return null;
  let q = skipWsDef(s, labelEnd + 2);
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
    const d = parseLinkDest(s, q);
    if (!d || d[0] === '') return null;
    dest = d[0];
    q2 = d[1];
  }
  let title = null;
  let r = q2;
  let hadWs = false;
  while (r < s.length && (s[r] === ' ' || s[r] === '\t')) { r++; hadWs = true; }
  if (s[r] === '"' || s[r] === "'" || s[r] === '(') {
    if (!hadWs) return null;
    const t = parseLinkTitle(s, r);
    if (!t || /\n[ \t]*\n/.test(t[0])) return null;
    title = t[0];
    r = t[1];
    while (r < s.length && (s[r] === ' ' || s[r] === '\t')) r++;
  } else if (s[r] === '\n') {
    let j = r + 1;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
    if (j < s.length && (s[j] === '"' || s[j] === "'" || s[j] === '(')) {
      const t = parseLinkTitle(s, j);
      // A title on the next line is optional: if it is malformed or
      // followed by junk, the definition is still valid without it
      // (cm-210) — only the title is dropped, not the definition.
      if (t && !/\n[ \t]*\n/.test(t[0])) {
        let rr = t[1];
        while (rr < s.length && (s[rr] === ' ' || s[rr] === '\t')) rr++;
        if (rr === s.length || s[rr] === '\n') {
          title = t[0];
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

/** Parse a list starting at lines[i] (marker mk). Returns {block, next}. */
function parseList(lines, i, firstMk, refs) {
  const items = [];
  let loose = false;
  let j = i;
  let mk = firstMk;
  const listIndent = mk.indent;
  const ordered = mk.ordered;
  const delim = mk.delim;
  const bullet = mk.bullet;
  const startNum = mk.start;
  for (;;) {
    const firstLine = lines[j];
    let content = mk.contentStr;
    let task = null;
    const tm = content.match(/^\[([ xX])\]( |$)/);
    if (tm) {
      task = tm[1] === ' ' ? ' ' : 'x';
      content = tm[2] === ' ' ? content.slice(4) : content.slice(3);
    }
    const itemLines = [content];
    let paraOpen = classifyPara(content);
    let inFence = null;
    // fenceStarted: the fence has captured at least one indented content
    // line. Only then does it also capture low-indent lines (a fence
    // whose very first content line has less indent than the item's
    // content indent is empty — the line ends the item instead).
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
      // Inside a fenced code block, a properly indented line is fence
      // content and starts the fence; a low-indent line is fence content
      // only once the fence has started, otherwise it ends the item and
      // the fence stays empty.
      if (inFence) {
        if (ind2 >= mk.contentIndent) {
          fenceStarted = true;
          blankRun = 0;
          const sub = stripColsExpand(l, mk.contentIndent, 0);
          itemLines.push(sub);
          if (isFenceClose(sub, inFence)) inFence = null;
          paraOpen = false;
          j++;
          continue;
        }
        if (fenceStarted) {
          blankRun = 0;
          const sub = stripColsExpand(l, mk.contentIndent, 0);
          itemLines.push(sub);
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
        if (blankRun > 0 && !itemLines.some((x) => x !== '')) {
          while (itemLines.length > 0 && itemLines[itemLines.length - 1] === '') itemLines.pop();
          break;
        }
        blankRun = 0;
        const sub = stripColsExpand(l, mk.contentIndent, 0);
        itemLines.push(sub);
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
        const last = lastContent(itemLines);
        lazyPush(itemLines, l, last ? lazyPrefix(last) : '');
        j++;
        continue;
      }
      // A lazy line for a paragraph nested inside a container (e.g. a
      // quote inside this item): the item's own content is a container,
      // not a paragraph, so paraOpen is false — route the line in with
      // the container prefix (cm-293). Only while no blank line has
      // intervened: a blank line ends the paragraph, so the line is a
      // new block in the outer item, not a lazy continuation (doc-07).
      if (blankRun === 0 && !inFence && isLazyLine(l)) {
        const last = lastContent(itemLines);
        const prefix = last ? lazyPrefix(last) : '';
        if (prefix) {
          blankRun = 0;
          lazyPush(itemLines, l, prefix);
          j++;
          continue;
        }
      }
      while (itemLines.length > 0 && itemLines[itemLines.length - 1] === '') itemLines.pop();
      break;
    }
    while (itemLines.length > 0 && itemLines[itemLines.length - 1] === '') itemLines.pop();
    // An item is loose iff its own blocks are separated by a blank
    // line (cm-307/318/319): a blank line inside a nested list does
    // not make the outer item loose.
    const { blocks: itemBlocks, loose: itemLoose } = parseBlocks(itemLines, 0, itemLines.length, refs, false, false, true);
    if (itemLoose) loose = true;
    items.push({ blocks: itemBlocks, task });
    if (j >= lines.length || !endedByNewItem) break;
    const mkN = markerInfo(lines[j]);
    if (!mkN) break;
    mk = mkN;
  }
  return { block: { t: 'list', ordered, start: startNum, tight: !loose, items }, next: j };
}

/** Parse lines[start..end) into blocks. Refs are shared across the document.
 *  endsNl is true only for the top-level call when the input ends with a
 *  newline; a sub-range (quote / list item) never carries one. */
function parseBlocks(lines, start, end, refs, endsNl, wsCont, inItem) {
  const blocks = [];
  // loose: a blank line separated two blocks at this level (used by
  // parseList to decide whether an item is loose — a blank line inside
  // a nested list does not make the outer list loose, cm-307/318/319).
  let loose = false;
  let sawBlank = false;
  // curBb: a blank line separated this block from the previous one at
  // this level. Recorded on each block (bb) so the blockquote chunk
  // merge can tell adjacent blocks from blank-line-separated ones
  // (cm-244: two paragraphs split by a blank quote line must not
  // merge into one).
  let curBb = false;
  const pushB = (b) => { b.bb = curBb; blocks.push(b); };
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) { sawBlank = true; i++; continue; }
    // A block after a blank line is separated from the previous block.
    curBb = sawBlank && blocks.length > 0;
    if (curBb) loose = true;
    sawBlank = false;
    const [ind, cidx] = measureIndent(line);
    // A line starting with a letter (indent < 4) can only be a
    // paragraph: no block start begins with a letter. Skip the
    // block-start checks and fall through to the paragraph branch.
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
      // Trailing blank lines consumed here still separate the code
      // block from the next block at this level.
      if (poppedBlanks > 0) sawBlank = true;
      pushB({ t: 'code', lang: null, text: codeLines.length > 0 ? codeLines.join('\n') + '\n' : '' });
      continue;
    }
    const atx = letterStart ? null : atxInfo(line);
    if (atx) {
      let content = trimSpaces(line.slice(atx.contentIdx));
      if (/^#+$/.test(content)) content = '';
      else content = content.replace(/[ \t]+#+$/, '');
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
        const tag = line.slice(cidx).match(/^<(\/?)(script|pre|style|textarea)/i)[2].toLowerCase();
        const endRe = new RegExp('</' + tag, 'i');
        if (!endRe.test(line)) {
          while (i < end) {
            rawLines.push(lines[i]);
            const done = endRe.test(lines[i]);
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
      // A trailing newline follows the block exactly when the next line in
      // this range is non-blank, or when this is the document's last block
      // and the input itself ends with a newline. For types 1-5 (which
      // end at a closing tag/line) a whitespace-only next line still
      // counts: only a truly empty line suppresses the newline
      // (doc-15/19: a "\t" line after "-->" keeps the "\n"); type 6
      // ends at a blank line, so a whitespace-only line is blank there.
      const trail = i < end ? (hb <= 5 ? lines[i].length > 0 : !isBlankLine(lines[i])) : endsNl;
      pushB({ t: 'html', text: rawLines.join('\n'), trail });
      continue;
    }
/** Innermost open block of a content line: {para, fence, list} where list is
 *  the content indent of the innermost list item, or null. */
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

    if (!letterStart && ind <= 3 && line[cidx] === '>') {
      // Chunked parse, mirroring marked's blockquote tokenizer: the
      // lines are split into chunks at lazy lines that follow ">"
      // lines, each chunk is parsed separately, and the results are
      // merged (see mergeChunkBlocks). A fence opened inside a nested
      // quote stays at that level (innerFence) and does not block the
      // outer quote's lazy lines once a direct line ends its chunk.
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
        // A blank line with no '>' ends the quote (cm-242, cm-252):
        // the next '>' line starts a new quote. A blank quote line
        // (">" with empty content) is a quote line, handled above.
        if (isBlankLine(l)) break;
        // A fence does NOT keep non-quote lines inside the quote: a
        // fence is only continued by quote lines or blank lines
        // (cm-128, cm-237).
        if (st.list !== null && ind2 >= st.list) { chunks[chunks.length - 1].push(l); i++; continue; }
        if (st.para && isLazyLine(l)) {
          // A lazy line after ">" lines starts a new chunk, unless it
          // is routed into a list item (then it is the item's content
          // and stays in the current chunk). It keeps its raw indent:
          // a 4-space lazy line is indented code in the new chunk and
          // merges into the preceding paragraph (doc-21). A setext
          // underline keeps its 4-space prefix so it stays paragraph
          // text (cm-093).
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
      // A quote's sub-lines keep a whitespace-only line as a paragraph
      // continuation (cm-241), so parse them with wsCont.
      const inner = [];
      for (let ci = 0; ci < chunks.length; ci++) {
        let chunk = chunks[ci];
        if (chunk.length === 0) continue;
        // A chunk starting with a link reference definition after a
        // paragraph appends the definition's raw text to that
        // paragraph instead of registering it.
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
        const { blocks: cb } = parseBlocks(chunk, 0, chunk.length, refs, false, true);
        mergeChunkBlocks(inner, cb);
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
      // A list swallows trailing blank lines in its item gathering; if
      // one was swallowed and a non-blank block follows, that blank
      // line still separates the list from the next block at this level
      // (cm-325: it makes the enclosing item loose).
      if (res.next > i && res.next < end && isBlankLine(lines[res.next - 1]) && !isBlankLine(lines[res.next])) sawBlank = true;
      i = res.next;
      continue;
    }
    if (!letterStart && line[cidx] === '[') {
      const defs = tryParseDefs(lines, i, refs);
      if (defs) { i = defs.nextI; continue; }
    }
    // Paragraph (may become a setext heading or a table).
    const paraLines = [line];
    let j = i + 1;
    let headingLevel = 0;
    let table = null;
    while (j < end) {
      const l = lines[j];
      // A whitespace-only line ends a paragraph — except inside a
      // blockquote, where it comes from a non-blank quote line (">  ")
      // and is a paragraph continuation (cm-241: "foo\n ").
      if (isBlankLine(l)) {
        if (wsCont && l.length > 0) { paraLines.push(l); j++; continue; }
        break;
      }
      const se = setextInfo(l);
      if (se !== 0) { headingLevel = se; j++; break; }
      if (j === i + 1) {
        // A table delimiter row must not be indented more than 3
        // spaces (cm-087: "    ---" is paragraph text, not a delimiter).
        const [indT] = measureIndent(l);
        const aligns = indT <= 3 ? tableDelimCells(l) : null;
        // The delimiter row must have the same cell count as the
        // header row, or it is not a table at all (gfm-203).
        if (aligns && cellsOf(paraLines[0]).length === aligns.length) {
          table = { aligns, headerLine: paraLines[0], startRow: j + 1 };
          break;
        }
      }
      if (atxInfo(l) || fenceInfo(l)) break;
      const hb2 = htmlBlockInfo(l);
      if (hb2 >= 1 && hb2 <= 6) break;
      const [ind2, idx2] = measureIndent(l);
      if (ind2 <= 3 && l[idx2] === '>') break;
      if (hrInfo(l)) break;
      const mk2 = markerInfo(l);
      // Inside a list item, any ordered marker interrupts a paragraph
      // (a nested list with any start number); elsewhere only a bullet
      // or an ordered marker starting with 1 does.
      if (mk2 && !mk2.empty && (inItem || !mk2.ordered || mk2.start === 1)) break;
      paraLines.push(l);
      j++;
    }
    if (table) {
      const rows = [];
      let k = table.startRow;
      while (k < end) {
        const l = lines[k];
        if (isTableBlank(l)) break;
        if (atxInfo(l) || fenceInfo(l)) break;
        const hb3 = htmlBlockInfo(l);
        if (hb3 >= 1 && hb3 <= 6) break;
        const [ind3, idx3] = measureIndent(l);
        if (ind3 <= 3 && l[idx3] === '>') break;
        if (hrInfo(l)) break;
        // A list marker starts a new block, it is not a table row
        // (doc-07: "* Lexer ..." ends the table and starts a list).
        const mk3 = markerInfo(l);
        if (mk3 && !mk3.empty && ind3 <= 3) break;
        // A table row is any non-blank line until a block start: it need
        // not contain a pipe (gfm-202 — a bare line is a one-cell row).
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
      // Tight item: the first paragraph renders inline, and the next
      // block follows directly with no newline (gfm-280: "foo<ul>").
      out.push(inlineHtml(first.lines.join('\n'), refs));
    } else {
      if (cb) out.push(cb + ' ');
      renderBlocks([first], refs, out);
    }
    // In a tight item every paragraph renders inline, not just the
    // first (cm-300: a heading followed by a paragraph "baz" renders
    // as bare text, not <p>baz</p>).
    for (let k = 1; k < blocks.length; k++) {
      const b = blocks[k];
      if (b.t === 'p') out.push(inlineHtml(b.lines.join('\n'), refs));
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
    out.push(inlineHtml(first.lines.join('\n'), refs));
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
        // A paragraph's lines can end with an empty line only from a
        // code block merged into it (blockquote chunk merge); marked
        // drops that trailing newline when rendering.
        let ls = b.lines;
        let n = ls.length;
        while (n > 0 && ls[n - 1] === '') n--;
        out.push('<p>' + inlineHtml(n === ls.length ? ls.join('\n') : ls.slice(0, n).join('\n'), refs) + '</p>\n');
        break;
      }
      case 'h':
        out.push('<h' + b.level + '>' + inlineHtml(b.text, refs) + '</h' + b.level + '>\n');
        break;
      case 'code': {
        if (b.lang) {
          const word = b.lang.split(/\s+/)[0];
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
          out.push('<th' + (a ? ' align="' + a + '"' : '') + '>' + inlineHtml(b.header[ci], refs) + '</th>\n');
        }
        // A table with no body rows has no <tbody> at all (gfm-205).
        out.push('</tr>\n</thead>\n');
        if (b.rows.length > 0) {
          out.push('<tbody>');
          for (const row of b.rows) {
            out.push('<tr>\n');
            for (let ci = 0; ci < row.length; ci++) {
              const a = b.aligns[ci];
              out.push('<td' + (a ? ' align="' + a + '"' : '') + '>' + inlineHtml(row[ci], refs) + '</td>\n');
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
  const out = [];
  renderBlocks(blocks, refs, out);
  return out.join('');
}
