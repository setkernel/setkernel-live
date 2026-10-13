// The page loads nothing from other hosts: fonts are self-hosted, the CSP says so. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const pub = new URL("../public/", import.meta.url);
const read = (name) => readFileSync(new URL(name, pub), "utf8");

function csp() {
  const line = read("_headers").split("\n").find((l) => l.trim().startsWith("Content-Security-Policy:"));
  assert.ok(line, "_headers sets a Content-Security-Policy");
  const out = {};
  for (const part of line.slice(line.indexOf(":") + 1).split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out[name] = values;
  }
  return out;
}

test("CSP allows styles and fonts only from the page itself", () => {
  const p = csp();
  assert.deepEqual(p["style-src"], ["'self'"]);
  assert.deepEqual(p["font-src"], ["'self'"]);
  assert.deepEqual(p["script-src"], ["'self'"]);
  assert.deepEqual(p["default-src"], ["'none'"]);
});

test("index.html and style.css fetch nothing from another host", () => {
  const html = read("index.html");
  for (const m of html.matchAll(/<(link|script|img|iframe)\b[^>]*>/gi)) {
    assert.doesNotMatch(m[0], /(src|href)\s*=\s*["']?(https?:)?\/\//i, m[0]);
  }
  const css = read("style.css");
  assert.doesNotMatch(css, /@import/i);
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)/g)) assert.ok(m[1].startsWith("/"), m[1]);
  assert.doesNotMatch(html + css, /google|gstatic/i);
});

test("every @font-face file exists, is woff2 and swaps, and ships with its licence", () => {
  const css = read("style.css");
  const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);
  assert.equal(faces.length, 7);
  const used = new Set();
  for (const face of faces) {
    assert.match(face, /font-display:\s*swap/);
    const url = face.match(/url\("?(\/fonts\/[^")]+\.woff2)"?\)/)?.[1];
    assert.ok(url, face);
    const file = new URL(url.slice(1), pub);
    assert.ok(existsSync(file), url);
    assert.equal(readFileSync(file).subarray(0, 4).toString("latin1"), "wOF2", url);
    used.add(url.slice("/fonts/".length));
  }
  const files = readdirSync(new URL("fonts/", pub));
  assert.deepEqual(files.filter((f) => f.endsWith(".woff2")).sort(), [...used].sort(), "no unused font files");
  for (const licence of ["OFL-Barlow-Condensed.txt", "OFL-Barlow.txt", "OFL-IBM-Plex-Mono.txt"]) {
    assert.match(read(`fonts/${licence}`), /SIL Open Font License, Version 1\.1/, licence);
  }
});
