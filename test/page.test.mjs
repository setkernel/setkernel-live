// The static page: nothing loaded from other hosts (fonts are self-hosted, the CSP says so),
// colour contrast on the page and on the wall, type sizes, share-preview tags, the live regions,
// keyboard access, and no markup or inline style from script. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";

const pub = new URL("../public/", import.meta.url);
const read = (name) => readFileSync(new URL(name, pub), "utf8");
const scripts = () => ["app.js", "early.js", ...readdirSync(new URL("lib/", pub)).map((n) => `lib/${n}`)];

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

test("CSP allows scripts, styles and fonts only from the page itself", () => {
  const p = csp();
  assert.deepEqual(p["style-src"], ["'self'"]);
  assert.deepEqual(p["font-src"], ["'self'"]);
  assert.deepEqual(p["script-src"], ["'self'"]);
  assert.deepEqual(p["default-src"], ["'none'"]);
  assert.deepEqual(p["connect-src"], ["'self'", "wss://live.setkernel.com"], "the page talks only to its own API and WebSocket");
});

test("index.html and style.css fetch nothing from another host", () => {
  const html = read("index.html");
  for (const m of html.matchAll(/<(link|script|img|iframe)\b[^>]*>/gi)) {
    assert.doesNotMatch(m[0], /(src|href)\s*=\s*["']?(https?:)?\/\//i, m[0]);
  }
  const css = read("style.css");
  assert.doesNotMatch(css, /@import/i);
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)/g)) assert.ok(m[1].startsWith("/") || m[1].startsWith("#"), m[1]);
  assert.doesNotMatch(html + css, /google|gstatic/i);
  for (const f of scripts()) assert.doesNotMatch(read(f), /fetch\(\s*["'`]https?:/, `${f} fetches only from this origin`);
});

test("fonts: Manrope 400 and 600 and IBM Plex Mono 400, self-hosted woff2 with their licences, nothing unused", () => {
  const css = read("style.css");
  const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);
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
  assert.deepEqual([...used].sort(), ["ibm-plex-mono-latin-400-normal.woff2", "manrope-latin-400-normal.woff2", "manrope-latin-600-normal.woff2"]);
  const files = readdirSync(new URL("fonts/", pub));
  assert.deepEqual(files.filter((f) => f.endsWith(".woff2")).sort(), [...used].sort(), "no unused font files");
  for (const licence of ["OFL-Manrope.txt", "OFL-IBM-Plex-Mono.txt"]) {
    assert.match(read(`fonts/${licence}`), /SIL Open Font License, Version 1\.1/, licence);
  }
  // the preloads are the faces the page uses
  for (const m of read("index.html").matchAll(/<link rel="preload" href="\/fonts\/([^"]+)"/g)) assert.ok(used.has(m[1]), m[1]);
  // no weight the page has no face for
  for (const m of css.matchAll(/font(?:-weight)?:\s*(\d00)\b/g)) assert.ok(["400", "600"].includes(m[1]), m[0]);
});

// ---- fonts everywhere (setkernel/hq docs/repo-standard.md, "Fonts"): the page and the design
// mockups name only the self-hosted faces, then one generic family, and load no font CDN
const repo = new URL("../", import.meta.url);
const fontFiles = [
  "public/style.css", "public/index.html",
  ...readdirSync(new URL("docs/design/", repo), { recursive: true }).filter((f) => /\.(html|css)$/.test(f)).map((f) => `docs/design/${f}`),
];
// base64 data could spell anything, so drop data URLs before looking at the words
const fontText = (file) => readFileSync(new URL(file, repo), "utf8").replace(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g, "data:");

test("every font stack is a self-hosted face, then one generic family", () => {
  let stacks = 0;
  for (const file of fontFiles) {
    const text = fontText(file).replace(/@font-face\s*{[^}]*}/g, "");
    for (const m of text.matchAll(/(?:font-family|--[\w-]+)\s*:\s*([^;}]*\b(?:sans-serif|serif|monospace|system-ui|cursive|fantasy)\b[^;}]*)/g)) {
      stacks++;
      assert.match(m[1].trim(), /^\\?"(Manrope|IBM Plex Mono)\\?",\s*(sans-serif|serif|monospace)$/, `${file}: ${m[0]}`);
    }
  }
  assert.ok(stacks >= 6, "found the stacks in style.css and both design mockups");
});

test("no named system font and no font CDN, in the page or the design mockups", () => {
  for (const file of [...fontFiles, "public/app.js"]) {
    const text = fontText(file);
    assert.doesNotMatch(text, /system-ui|-apple-system|BlinkMacSystemFont|Segoe UI|ui-(sans-serif|serif|monospace)|SF Mono|Menlo|Monaco|Consolas|Helvetica|Arial|Roboto|Georgia|Courier/i, file);
    assert.doesNotMatch(text, /fonts\.googleapis\.com|fonts\.gstatic\.com|typekit\.net|fonts\.bunny\.net|fontawesome\.com|fontshare\.com|cdnfonts\.com/i, file);
  }
});

test("the design mockups embed the page's own font files, whose licences sit beside them", () => {
  const ours = new Set(readdirSync(new URL("fonts/", pub)).filter((f) => f.endsWith(".woff2")).map((f) => readFileSync(new URL(`fonts/${f}`, pub)).toString("base64")));
  for (const file of ["docs/design/v2/reference.html", "docs/design/v3/day/index.html"]) {
    const embedded = [...readFileSync(new URL(file, repo), "utf8").matchAll(/data:font\/woff2;base64,([A-Za-z0-9+/=]+)/g)].map((m) => m[1]);
    assert.ok(embedded.length > 0, `${file} embeds its fonts`);
    for (const data of embedded) assert.ok(ours.has(data), `${file} embeds a font that is not in public/fonts/; rerun its build script`);
  }
});

// ---- contrast (WCAG): every text colour on every ground it is drawn on, on the page and the wall
const css = read("style.css");
const block = (selector) => {
  const at = css.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `style.css has ${selector}`);
  return css.slice(at, css.indexOf("\n}", at));
};
const hexes = (text) => Object.fromEntries([...text.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
const page = hexes(block(":root"));
const wall = { ...page, ...hexes(block("html.wall")) };
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (vars, a, b) => {
  const [hi, lo] = [luminance(vars[a]), luminance(vars[b])].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Text sits on the page ground (--bg) and on the Now column's and Now list's (--surface).
// Every new text colour goes in TEXT; marks and lines that carry data go in MARKS.
const TEXT = ["ink", "ink-2", "ink-3"];
const MARKS = ["ink", "ink-2", "ink-3", "signal", "bar"];
for (const [name, vars] of [["Page", page], ["Wall", wall]]) {
  test(`${name}: every text colour meets WCAG AA on both grounds, AAA for names and body text`, () => {
    const check = (fg, bg, min) => {
      const ratio = contrast(vars, fg, bg);
      assert.ok(ratio >= min, `${name}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1, under ${min}:1`);
    };
    for (const bg of ["bg", "surface"]) {
      for (const fg of ["ink", "ink-2"]) check(fg, bg, 7);
      for (const fg of TEXT) check(fg, bg, 4.5);
    }
    // the scrub cursor's time: the ground's colour on the focus colour
    check("bg", "focus", 4.5);
    // the stage lines, the marks, the ticks and the band's edge: at least 3:1 (WCAG 1.4.11) on the chart's ground
    for (const fg of MARKS) check(fg, "bg", 3);
    check("focus", "bg", 3);
  });
}

test("every text colour in style.css is one the contrast test checks", () => {
  const colours = new Set();
  for (const m of css.matchAll(/(?:^|[\s;{])(?:color|fill):\s*var\(--([\w-]+)\)/g)) colours.add(m[1]);
  const fills = new Set(["surface", "bg", "band", "focus"]); // grounds and shapes, not text: checked above as grounds or marks
  for (const c of colours) assert.ok(TEXT.includes(c) || MARKS.includes(c) || fills.has(c), `--${c} is used as a colour but not checked`);
});

test("the wall has one fixed dark theme; the page has one theme and no toggle", () => {
  assert.ok(luminance(wall.bg) < 0.02, "the wall is dark");
  assert.ok(luminance(page.bg) > 0.85, "the page is light");
  assert.doesNotMatch(css, /prefers-color-scheme/, "neither follows the system's light or dark");
  assert.doesNotMatch(read("index.html"), /data-pick|aria-label="Theme"/, "no Day/Night toggle");
  for (const f of scripts()) assert.doesNotMatch(read(f), /localStorage|sessionStorage/, `${f} stores nothing`);
});

test("early.js picks the wall from ?wall before the first paint, and nothing else", () => {
  const run = (search) => {
    const classes = new Set();
    vm.runInNewContext(read("early.js"), { location: { search }, document: { documentElement: { classList: { add: (c) => classes.add(c) } } } });
    return [...classes];
  };
  assert.deepEqual(run("?wall"), ["wall"]);
  assert.deepEqual(run("?demo&wall"), ["wall"]);
  assert.deepEqual(run("?wall=1"), ["wall"]);
  assert.deepEqual(run(""), []);
  assert.deepEqual(run("?wallpaper"), []);
});

test("no tiny type: nothing in style.css is set under 12px", () => {
  let checked = 0;
  const vars = Object.fromEntries([...css.matchAll(/--(f\d):\s*(\d+)px/g)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual(vars, { f1: 12, f2: 14, f3: 16, f4: 20, f5: 24, f6: 32 }, "the type scale");
  for (const [decl] of css.matchAll(/\bfont(?:-size)?:[^;}]*/g)) {
    const px = decl.match(/(\d*\.?\d+)px\b/)?.[1] ?? vars[decl.match(/var\(--(f\d)\)/)?.[1]];
    if (px === undefined) continue;
    assert.ok(Number(px) >= 12, `${decl} is ${px}px`);
    checked++;
  }
  assert.ok(checked > 25, `${checked} font sizes checked`);
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

test("share preview words describe Day, with star names only and no sky", () => {
  const html = read("index.html");
  const meta = (attr, key) => html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`))?.[1];
  const desc = meta("property", "og:description");
  const alt = meta("property", "og:image:alt");
  assert.equal(meta("name", "twitter:description"), desc);
  assert.equal(meta("name", "twitter:image:alt"), alt);
  for (const text of [desc, alt, meta("name", "description")]) {
    for (const word of ["Vega", "Rigel", "Lyra", "Orion"]) assert.ok(text.includes(word), `${word} in "${text}"`);
    assert.doesNotMatch(text, /\bsky\b|Ursa Minor|\bstars?\b|constellation/i, "star names only, with no star imagery (hq#177)");
  }
  assert.match(desc, /last 24 hours/);
  assert.ok(desc.length <= 300, `og:description is ${desc.length} characters`);
});

test("v2 is gone: no sky, rings, Ursa Minor, board, rail or star card", () => {
  const html = read("index.html");
  assert.doesNotMatch(html, /<canvas|id="sky|scard|id="board|class="rail|Ursa Minor/);
  for (const f of ["lib/sky.js", "lib/card.js"]) assert.ok(!existsSync(new URL(f, pub)), `${f} deleted`);
  assert.doesNotMatch(read("app.js"), /"LIVE"/, "\"About a minute behind\" in place of LIVE");
  assert.match(read("app.js"), /About a minute behind · \$\{fresh\}/);
});

test("screen readers: a polite readout for scrubbing and news, a labelled slider, and the day as a table", () => {
  const html = read("index.html"), chart = read("lib/chart.js"), app = read("app.js");
  assert.match(html, /<p class="sr" id="readout" aria-live="polite"><\/p>/);
  assert.match(html, /<p class="sr" id="announce" aria-live="polite"><\/p>/);
  assert.equal(html.match(/aria-live/g).length, 2);
  assert.match(html, /<details class="table" id="table-box">\s*<summary>The day as a table<\/summary>/);
  assert.match(html, /<ul class="legend" id="legend" aria-label="Key"><\/ul>/);
  assert.match(html, /<svg class="defs" width="0" height="0" aria-hidden="true">/);
  // the chart is a focusable slider whose value is said in words
  assert.match(chart, /tabindex: 0, role: "slider", "aria-label": label, "aria-valuemin": 0, "aria-valuemax": BINS - 1/);
  assert.match(app, /plot\.svg\.setAttribute\("aria-valuetext", i == null \? "Now" : words\)/);
  assert.match(app, /if \(speak\) \$\("readout"\)\.textContent = words;/);
  // the table has a caption and column headers
  assert.match(chart, /el\("caption"/);
  assert.match(chart, /th\.scope = "col"/);
  // every mark carries its words in a <title>
  assert.match(chart, /node\("title", \{\}, g\)\.textContent = title;/);
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
});

test("keyboard: the chart scrubs with the arrow keys and keeps focus when new data redraws it", () => {
  const app = read("app.js"), css2 = css;
  assert.match(app, /svg\.addEventListener\("keydown", \(ev\) => \{\s*const next = scrubKey\(ev\.key, ev\.shiftKey, scrub, D, p\.vertical\);/);
  assert.match(app, /if \(hadFocus\) plot\.svg\.focus\(\{ preventScroll: true \}\);/);
  assert.match(css2, /\.plot svg:focus-visible \.plotframe \{ stroke: var\(--focus\); stroke-width: 1; \}/, "a visible focus frame");
  assert.match(css2, /a:focus-visible, summary:focus-visible \{ outline: 2px solid var\(--focus\);/);
});

test("times are the visitor's own: no hard-coded UTC on the page", () => {
  for (const f of ["index.html", "app.js", "lib/words.js", "lib/day.js", "lib/chart.js", "lib/layout.js", "lib/replay.js", "lib/demo.js", "lib/line.js"]) {
    const text = read(f).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"); // comments may explain
    assert.doesNotMatch(text, /\bUTC\b|getUTC(Hours|Minutes)/, f);
  }
});

test("the page never builds markup from data", () => {
  for (const f of scripts()) {
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
  for (const f of scripts()) {
    assert.doesNotMatch(read(f), /setAttribute\(\s*["']style["']|\.style\.cssText|\.style\s*=|"style":|\bstyle: /, f);
    assert.doesNotMatch(read(f), /var\(--/, `${f} sets no colour itself: style.css's classes do`);
  }
});

test("reduced motion: nothing animates, and nothing loops forever", () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important; transition: none !important;/);
  assert.doesNotMatch(css, /infinite|@keyframes/, "the page has no animation at all");
  for (const f of scripts()) assert.doesNotMatch(read(f), /requestAnimationFrame|\.animate\(|behavior: "smooth"/, f);
});
