// The static page: colour contrast (WCAG AA), share-preview tags, favicon and the live region.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../public/${p}`, import.meta.url));
const html = read("index.html").toString();
const css = read("style.css").toString();
const vars = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(vars[a]), luminance(vars[b])].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Every text colour on every background it is drawn on (style.css and the SVG built by app.js).
// 4.5:1 for text (AA, normal size); 3:1 for the focus ring (non-text, WCAG 1.4.11).
const TEXT = [
  ["ink", "bg"], ["ink", "panel"], ["ink", "panel-2"],             // body, offline notice, tile names
  ["ink-dim", "bg"], ["ink-dim", "panel"], ["ink-dim", "panel-2"], // lede, status, card headings, feed times, tile subtitles
  ["github", "bg"], ["github", "panel"], ["github", "panel-2"],    // links, repo on a tile
  ["claude", "bg"],                                                // "Live" in the heading
  ["bg", "claude"], ["bg", "chat"], ["bg", "github"], ["bg", "warn"], // WORKING, REVIEWING, DISCUSSING, PAUSED pills
  ["ink", "line"],                                                 // IDLE pill
];

test("all text meets WCAG AA contrast", () => {
  for (const [fg, bg] of TEXT) {
    assert.ok(vars[fg] && vars[bg], `--${fg} and --${bg} are defined`);
    assert.ok(contrast(fg, bg) >= 4.5, `--${fg} on --${bg} is ${contrast(fg, bg).toFixed(2)}:1`);
  }
});

test("links show a visible keyboard focus ring", () => {
  assert.match(css, /a:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--github\)/);
  for (const bg of ["bg", "panel"]) assert.ok(contrast("github", bg) >= 3, `focus ring on --${bg}`);
});

test("the IDLE pill uses --ink, not the low-contrast --ink-dim, on --line", () => {
  const app = read("app.js").toString();
  assert.match(app, /color === "line" \? C\("ink"\)/);
  assert.doesNotMatch(app, /fill: C\("ink-dim"\)/);
  assert.doesNotMatch(app, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML/);
});

test("share preview tags point at a 1200x630 PNG on this origin", () => {
  const meta = (attr, key) => html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`))?.[1];
  for (const k of ["og:title", "og:description", "og:image", "og:url", "og:image:alt"]) assert.ok(meta("property", k), k);
  for (const k of ["twitter:card", "twitter:title", "twitter:description", "twitter:image"]) assert.ok(meta("name", k), k);
  assert.equal(meta("name", "twitter:card"), "summary_large_image");
  for (const url of [meta("property", "og:image"), meta("name", "twitter:image")]) assert.equal(url, "https://live.setkernel.com/og.png");
  assert.equal(meta("property", "og:image:width"), "1200");
  assert.equal(meta("property", "og:image:height"), "630");

  const png = read("og.png");
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]); // IHDR width, height
  assert.ok(png.length < 300_000, "small enough for every card scraper");
});

test("favicon is a same-origin SVG", () => {
  assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
  assert.match(read("favicon.svg").toString(), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
});

test("new activity is summarised in a polite live region", () => {
  assert.match(html, /<p class="visually-hidden" id="announce" aria-live="polite"><\/p>/);
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
});

test("the CSP still allows images and scripts from this origin only", () => {
  const csp = read("_headers").toString().match(/Content-Security-Policy: (.*)/)[1];
  assert.match(csp, /(^|; )img-src 'self' data:(;|$)/);
  assert.match(csp, /(^|; )script-src 'self'(;|$)/);
  assert.match(csp, /(^|; )default-src 'none'(;|$)/);
});
