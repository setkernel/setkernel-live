// The static page: nothing loaded from other hosts (fonts are self-hosted, the CSP says so),
// colour contrast, share-preview tags, favicon, the live regions, and no markup from data.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { skyLayout } from "../public/lib/layout.js";
import { STAGE_NAME } from "../public/lib/line.js";

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
  assert.equal(faces.length, 7, "Manrope 400 to 800 and IBM Plex Mono 400 and 500");
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
  assert.ok(!files.some((f) => /barlow/i.test(f)), "Barlow is gone now nothing uses it");
  for (const licence of ["OFL-Manrope.txt", "OFL-IBM-Plex-Mono.txt"]) {
    assert.match(read(`fonts/${licence}`), /SIL Open Font License, Version 1\.1/, licence);
  }
});

// ---- contrast (WCAG AA): every text colour on the ground it is drawn on
const css = read("style.css");
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

// Text sits on the night sky, from --bg (its darkest) to --panel (the lightest card or panel), so
// every text colour is checked on both. Every new text colour goes in one of these lists.
const GROUNDS = ["bg", "panel"];
test("all text meets WCAG contrast on the night sky and its panels, AAA for body text", () => {
  // ink: headings, numbers, names; ink-2: body and secondary lines; polaris: the pole star's name
  for (const fg of ["ink", "ink-2", "polaris"]) {
    for (const bg of GROUNDS) assert.ok(contrast(fg, bg) >= 7, `--${fg} on --${bg} is ${contrast(fg, bg).toFixed(2)}:1 (AAA)`);
  }
  // ink-3: times, hints, labels; accent: links; the star colours: names in the headline, the feed
  // and the cards; the places: station names and the per-hour labels; ok, fail, warn: LIVE, the
  // failed-run ×, REPLAY
  for (const fg of ["ink-3", "accent", "vega", "rigel", "lyra", "orion", "pole", "claude", "github", "chat", "ok", "fail", "warn"]) {
    for (const bg of GROUNDS) assert.ok(contrast(fg, bg) >= 4.5, `--${fg} on --${bg} is ${contrast(fg, bg).toFixed(2)}:1 (AA)`);
  }
  // dark text on light: a pressed chip (--bg on --ink) and a merged token's letter (--bg on its author's colour)
  for (const fg of ["ink", "vega", "rigel", "lyra", "orion", "polaris", "pole"]) {
    assert.ok(contrast("bg", fg) >= 4.5, `--bg on --${fg} is ${contrast("bg", fg).toFixed(2)}:1`);
  }
});

test("the star colours are the design's, Rigel pink so it stays apart from Vega", () => {
  assert.deepEqual(["vega", "rigel", "lyra", "orion", "polaris", "pole"].map((k) => vars[k]), ["#8ab4ff", "#f472b6", "#f5d06f", "#f59e5b", "#ffffff", "#7dd3fc"]);
});

test("no tiny type: nothing in style.css is set under 13px", () => {
  let checked = 0;
  for (const [decl] of css.matchAll(/\bfont(?:-size)?:[^;}]*/g)) {
    const m = decl.match(/(\d*\.?\d+)(px|rem)\b/); // the size (or a clamp's minimum) comes first
    if (!m) continue;
    const px = m[2] === "rem" ? Number(m[1]) * 16 : Number(m[1]);
    assert.ok(px >= 13, `${decl} is ${px}px`);
    checked++;
  }
  assert.ok(checked > 20, `${checked} font sizes checked`);
});

test("touch targets: buttons are at least 44 px", () => {
  assert.match(css, /button \{[^}]*min-height: 44px;[^}]*min-width: 44px;/);
});

test("share preview tags point at a 1200x630 PNG on this origin", () => {
  const html = read("index.html");
  const meta = (attr, key) => html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`))?.[1];
  for (const k of ["og:title", "og:description", "og:image", "og:url", "og:image:alt"]) assert.ok(meta("property", k), k);
  for (const k of ["twitter:card", "twitter:title", "twitter:description", "twitter:image"]) assert.ok(meta("name", k), k);
  assert.equal(meta("name", "twitter:card"), "summary_large_image");
  for (const url of [meta("property", "og:image"), meta("name", "twitter:image")]) assert.equal(url, "https://live.setkernel.com/og.png");
  const png = readFileSync(new URL("og.png", pub));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]);
  assert.ok(png.length < 300_000, "small enough for every card scraper");
  assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
  assert.match(read("favicon.svg"), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
});

test("share preview words describe the Sky + Line page, with star names only", () => {
  const html = read("index.html");
  const meta = (attr, key) => html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`))?.[1];
  const desc = meta("property", "og:description");
  const alt = meta("property", "og:image:alt");
  assert.equal(meta("name", "twitter:description"), desc);
  assert.equal(meta("name", "twitter:image:alt"), alt);
  for (const text of [desc, alt]) {
    for (const word of ["Vega", "Rigel", "Lyra", "Orion", "Polaris", "Ursa Minor"]) assert.ok(text.includes(word), `${word} in "${text}"`);
    // the line's five columns, in order
    const at = Object.values(STAGE_NAME).map((name) => text.indexOf(name));
    assert.ok(at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1])), `the line's columns in order in "${text}"`);
    assert.doesNotMatch(text, /pulses of light travelling/); // the v1 page
  }
  assert.match(desc, /three Claude sessions/);
  assert.ok(desc.length <= 300, `og:description is ${desc.length} characters`);
});

test("status and news reach screen readers; the sky has a text alternative", () => {
  const html = read("index.html");
  // only the state is a live region; the age beside it ticks every second and is not read out
  assert.match(html, /<p class="status" id="status"><i aria-hidden="true"><\/i><span id="status-text" role="status">[^<]*<\/span><span id="status-age"><\/span><\/p>/);
  assert.equal(html.match(/role="status"/g).length, 1);
  assert.match(html, /<p class="visually-hidden" id="announce" aria-live="polite"><\/p>/);
  assert.match(html, /<canvas id="sky-canvas" aria-hidden="true">/);
  assert.match(html, /<section class="sky" id="sky" aria-label="[^"]{40,}">/);
  // the star card is a labelled dialog with a close button
  assert.match(html, /<div class="scard" id="scard" role="dialog" aria-labelledby="sc-title" hidden>/);
  assert.match(html, /<button type="button" class="x" id="sc-close" aria-label="Close details">/);
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  // test runs: each mark carries its words for screen readers; the key gives the colours a name
  assert.match(html, /<ol class="ticks" id="ci-runs" aria-label="[^"]+">/);
  assert.match(html, /<span class="pass"><i><\/i>passed<\/span> <span class="fail"><i><\/i>failed \(×\)<\/span>/);
});

test("times are the visitor's own: no hard-coded UTC on the page", () => {
  for (const f of ["index.html", "app.js", "lib/words.js", "lib/replay.js", "lib/demo.js", "lib/card.js", "lib/line.js"]) {
    const text = read(f).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"); // comments may explain
    assert.doesNotMatch(text, /\bUTC\b|getUTC(Hours|Minutes)/, f);
  }
});

test("the status dot pulses once per arrival, and not at all under reduced motion", () => {
  assert.match(css, /\.status i\.pulse \{ animation: beat [^;]* 1; \}/);
  assert.doesNotMatch(css, /infinite/);
  assert.match(css, /@keyframes beat \{ 0% \{ box-shadow: 0 0 0 0 currentColor; \}/, "rings in the dot's own colour, so the demo dot rings in the accent");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.status i\.pulse \{ animation: none; \} \}/);
  assert.match(read("app.js"), /if \(msg\.t === "hello" \|\| msg\.t === "batch"\) pulse\(\);/, "the first data on connect pulses too");
});

test("the page never builds markup from data", () => {
  for (const f of ["app.js", ...readdirSync(new URL("lib/", pub)).map((n) => `lib/${n}`)]) {
    assert.doesNotMatch(read(f), /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/, f);
  }
});

test("no inline style or script: the CSP would block them", () => {
  const html = read("index.html");
  assert.doesNotMatch(html, /<style\b|\sstyle\s*=/i, "no <style> or style attributes");
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    assert.match(m[0], /\bsrc="\/[\w./-]+"/, "every script is a file");
    assert.equal(m[1].trim(), "", "with nothing inline");
  }
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "no inline event handlers");
  for (const f of ["app.js", ...readdirSync(new URL("lib/", pub)).map((n) => `lib/${n}`)]) {
    assert.doesNotMatch(read(f), /setAttribute\(\s*["']style["']|\.style\.cssText|\.style\s*=/, f);
  }
});

test("reduced motion: nothing animates, and nothing loops forever", () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important; transition: none !important;/);
  assert.match(read("app.js"), /if \(!reduced\) \{\s*for \(const name of ENGINEERS\)/, "board cards move instantly");
  assert.match(read("lib/sky.js"), /reduced \|\| !running/, "no pulse travels");
});

test("stars and board cards can be reached and used from the keyboard", () => {
  const app = read("app.js");
  assert.match(app, /make\("button", \{ type: "button", class: `star \$\{kind\}`/, "a star is a button");
  assert.match(app, /make\("div", \{ class: "card", role: "button", tabindex: "0"/, "a board card is focusable");
  assert.match(app, /ev\.key === "Escape" && openName\) return closeCard\(true\)/, "Esc closes the card, focus back on the star");
  assert.match(app, /\(ev\.key === "Enter" \|\| ev\.key === " "\) && ev\.target\?\.dataset\?\.card/);
});

test("the sky lays out narrow on phones and wide everywhere else", () => {
  assert.equal(skyLayout(343, 500).mode, "narrow");
  for (const [w, h] of [[812, 351], [768, 594], [1440, 724], [1536, 1340]]) assert.equal(skyLayout(w, h).mode, "wide", `${w}x${h}`);
});
