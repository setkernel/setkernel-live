// Every character the page draws is one its fonts have (setkernel-live#80). The fonts are Latin
// subsets: a character outside them (an arrow, a status shape) would be drawn in whatever system
// font the visitor has. So each @font-face in style.css declares the unicode-range its file has,
// read here from the file's own cmap, and every non-ASCII character in the pages' HTML text or in
// a string in their scripts must be in that range. A string doesn't say which face draws it, so
// each is held to every face. Something the fonts lack is an SVG (.arrow in style.css).
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";

const pub = new URL("../public/", import.meta.url);
const read = (name) => readFileSync(new URL(name, pub), "utf8");
const files = readdirSync(pub, { recursive: true }).map(String).sort();
const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

// ---- a woff2 file's cmap: the code points it has a glyph for
function base128(b, at) {
  let v = 0;
  for (let n = 0; n < 5; n++) {
    const x = b[at.i++];
    v = v * 128 + (x & 127);
    if (!(x & 128)) return v;
  }
  throw new Error("bad UIntBase128");
}
function cmap(woff2) {
  assert.equal(woff2.toString("latin1", 0, 4), "wOF2");
  const at = { i: 48 };
  let off = 0, table;
  for (let n = woff2.readUInt16BE(12); n > 0; n--) {
    const flags = woff2[at.i++], known = flags & 63, version = flags >> 6;
    const tag = known === 63 ? woff2.toString("latin1", at.i, (at.i += 4)) : known;
    const length = base128(woff2, at);
    // glyf (10) and loca (11) are transformed unless version 3; every other table only if not 0
    const stored = (known === 10 || known === 11 ? version !== 3 : version !== 0) ? base128(woff2, at) : length;
    if (tag === 0 || tag === "cmap") table = { off, stored };
    off += stored;
  }
  const c = brotliDecompressSync(woff2.subarray(at.i, at.i + woff2.readUInt32BE(20))).subarray(table.off, table.off + table.stored);
  const subtables = Array.from({ length: c.readUInt16BE(2) }, (_, n) => c.subarray(c.readUInt32BE(8 + 8 * n)));
  const s = subtables.find((t) => t.readUInt16BE(0) === 12) ?? subtables.find((t) => t.readUInt16BE(0) === 4);
  const cps = new Set();
  if (s.readUInt16BE(0) === 12) {
    for (let g = 0; g < s.readUInt32BE(12); g++) {
      const [first, last, glyph] = [16, 20, 24].map((o) => s.readUInt32BE(o + 12 * g));
      for (let cp = first; cp <= last; cp++) if (glyph + cp - first) cps.add(cp);
    }
    return cps;
  }
  const segs = s.readUInt16BE(6) / 2, ends = 14, starts = 16 + 2 * segs, deltas = starts + 2 * segs, offsets = deltas + 2 * segs;
  for (let g = 0; g < segs; g++) {
    const [first, last, delta, ro] = [starts, ends, deltas, offsets].map((o) => s.readUInt16BE(o + 2 * g));
    for (let cp = first; cp <= last && cp !== 0xffff; cp++) {
      let glyph = ro ? s.readUInt16BE(offsets + 2 * g + ro + 2 * (cp - first)) : cp;
      if (glyph) glyph = (glyph + delta) & 0xffff;
      if (glyph) cps.add(cp);
    }
  }
  return cps;
}

// ---- the faces in style.css, each with what it declares and what its file has
function range(text) {
  const cps = new Set();
  for (const part of text.split(",")) {
    const m = part.trim().match(/^U\+([0-9A-F?]{1,6})(?:-([0-9A-F]{1,6}))?$/i);
    assert.ok(m, `unicode-range part "${part.trim()}"`);
    const first = parseInt(m[1].replace(/\?/g, "0"), 16), last = parseInt(m[2] ?? m[1].replace(/\?/g, "F"), 16);
    for (let cp = first; cp <= last; cp++) cps.add(cp);
  }
  return cps;
}
const faces = [...read("style.css").matchAll(/@font-face\s*{([^}]*)}/g)].map(([, f]) => {
  const url = f.match(/url\("?\/([^")]+)"?\)/)[1];
  const declared = f.match(/unicode-range:\s*([^;]+)/)?.[1];
  return { name: `${f.match(/font-family:\s*"([^"]+)"/)[1]} ${f.match(/font-weight:\s*(\d+)/)[1]}`, url, declared: declared && range(declared), has: cmap(readFileSync(new URL(url, pub))) };
});

test("each @font-face declares the unicode-range its file has", () => {
  assert.equal(faces.length, 5, "Manrope 400, 600 and 800, IBM Plex Mono 400 and 500");
  for (const { name, url, declared, has } of faces) {
    assert.ok(declared, `${name} (${url}) declares no unicode-range, so it claims every character`);
    const printable = (set) => [...set].filter((cp) => cp >= 0x20).sort((a, b) => a - b).map(hex);
    assert.deepEqual(printable(declared), printable(has), `${name}: the range is what ${url} has`);
  }
});

// ---- what the pages draw: the text of each HTML page's body, and every string in its scripts
// HTML: comments, scripts, styles and tags blanked (attributes aren't drawn), lines kept
function htmlText(html) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  const body = html.search(/<body\b/i);
  return (blank(html.slice(0, body)) + html.slice(body))
    .replace(/<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1>|<[^>]*>/gi, blank)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .split("\n");
}

// JS: each string and template literal's text, escapes decoded, with the line it starts on.
// Comments and regular expressions are skipped; a template's ${...} is code, so strings inside it count.
const KEYWORDS = new Set(["return", "typeof", "case", "of", "in", "do", "else", "void", "yield", "await", "delete", "new", "instanceof", "throw"]);
const unescape = (raw) => raw.replace(/\\(u\{[0-9a-f]+\}|u[0-9a-f]{4}|x[0-9a-f]{2}|[\s\S])/gi, (_, e) =>
  /^[ux]/i.test(e) && e.length > 1 ? String.fromCodePoint(parseInt(e.replace(/^u\{?|^x|\}$/gi, ""), 16)) : e);
function strings(src) {
  const out = [], open = []; // open: the brace depth at each unfinished ${
  let i = 0, depth = 0, prev = "";
  const lineAt = (n) => src.slice(0, n).split("\n").length;
  const scan = (j, stop) => { while (j < src.length && !stop(j)) j += src[j] === "\\" ? 2 : 1; return j; };
  const template = (from) => {
    const j = scan(from, (k) => src[k] === "`" || (src[k] === "$" && src[k + 1] === "{"));
    out.push([unescape(src.slice(from, j)), lineAt(from)]);
    if (src[j] === "`") { i = j + 1; prev = "x"; } else { open.push(depth); i = j + 2; prev = "{"; }
  };
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") i = src.includes("\n", i) ? src.indexOf("\n", i) : src.length;
    else if (c === "/" && d === "*") i = src.includes("*/", i + 2) ? src.indexOf("*/", i + 2) + 2 : src.length;
    else if (c === '"' || c === "'") {
      const j = scan(i + 1, (k) => src[k] === c);
      out.push([unescape(src.slice(i + 1, j)), lineAt(i)]);
      i = j + 1; prev = "x";
    } else if (c === "`") template(i + 1);
    else if (c === "}" && open.length && open.at(-1) === depth) { open.pop(); template(i + 1); }
    else if (c === "/" && (prev === "" || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || KEYWORDS.has(prev))) {
      let cls = false, j = i + 1; // a regular expression
      for (; j < src.length && (cls || src[j] !== "/"); j++) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
      }
      i = j + 1; prev = "x";
      while (/[a-z]/.test(src[i] ?? "")) i++;
    } else if (/[\w$]/.test(c)) {
      const word = src.slice(i).match(/^[\w$]+/)[0];
      i += word.length; prev = word;
    } else {
      if (c === "{") depth++;
      if (c === "}") depth--;
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  assert.deepEqual([open.length, depth], [0, 0], "every string, template and brace closes");
  return out;
}

function drawn() {
  const out = [];
  for (const f of files) {
    if (f.endsWith(".html")) htmlText(read(f)).forEach((text, n) => out.push([text, `public/${f}:${n + 1}`]));
    if (f.endsWith(".js")) for (const [text, line] of strings(read(f))) out.push([text, `public/${f}:${line}`]);
  }
  return out;
}

test("every character the pages draw is in each face's unicode-range, or it is an SVG", () => {
  const ok = (cp) => faces.every(({ declared, has }) => has.has(cp) && (!declared || declared.has(cp)));
  const bad = [];
  let seen = 0;
  for (const [text, where] of drawn()) {
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) continue;
      seen++;
      if (!ok(cp)) bad.push(`${where}: "${ch}" (${hex(cp)})`);
    }
  }
  assert.deepEqual(bad, [], "not in the fonts, so a system font would draw it: draw it as an SVG (.arrow in style.css)");
  assert.ok(seen > 20, `${seen} non-ASCII characters checked, the · and … the pages use among them`);
});

test("the string reader keeps strings and skips comments and regular expressions", () => {
  const src = "const a = \"·\" + '\\u2190'; // ●\n/* ○ */ x = /[\"/]●/g.test(b) ? `→ ${c ? \"✕\" : `‖${d}`} ◎` : a / 2 / 3;";
  assert.deepEqual(strings(src), [["·", 1], ["←", 1], ["→ ", 2], ["✕", 2], ["‖", 2], ["", 2], [" ◎", 2]]);
});
