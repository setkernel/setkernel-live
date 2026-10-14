// Day and Night (setkernel-live#37): early.js chooses the theme before the first paint, the toggle
// saves the visitor's choice, ?wall starts in Night with its own choice, and the page works when
// storage is missing or refuses. The sky draws Day as a printed chart with no glow.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createSky } from "../public/lib/sky.js";
import { skyLayout } from "../public/lib/layout.js";

const pub = new URL("../public/", import.meta.url);
const read = (name) => readFileSync(new URL(name, pub), "utf8");
const early = read("early.js");

// Runs early.js as a browser would, with the given address, system preference and storage.
// storage: an object of saved values, or "throws" for storage that refuses every call.
function run({ search = "", light = false, storage = {} } = {}) {
  const classes = new Set();
  const root = { dataset: {}, classList: { add: (c) => classes.add(c) } };
  const refuse = () => { throw new Error("SecurityError"); };
  const localStorage = storage === "throws"
    ? { getItem: refuse, setItem: refuse }
    : { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); } };
  const g = {
    document: { documentElement: root },
    location: { search },
    matchMedia: (q) => ({ matches: q === "(prefers-color-scheme: light)" && light }),
    localStorage,
  };
  g.globalThis = g;
  vm.runInNewContext(early, g);
  return { theme: root.dataset.theme, wall: classes.has("wall"), api: g.liveTheme, storage };
}

test("the theme follows the system until the visitor picks one", () => {
  assert.equal(run({ light: true }).theme, "day");
  assert.equal(run({ light: false }).theme, "night");
  assert.equal(run({ light: true }).api.follows(), true);
  assert.equal(run({ light: false, storage: { "sk-live-theme": "day" } }).theme, "day", "a saved Day beats a dark system");
  assert.equal(run({ light: true, storage: { "sk-live-theme": "night" } }).theme, "night", "a saved Night beats a light system");
  assert.equal(run({ light: true, storage: { "sk-live-theme": "night" } }).api.follows(), false);
  assert.equal(run({ light: true, storage: { "sk-live-theme": "sepia" } }).theme, "day", "anything else saved is ignored");
});

test("the toggle's choice is saved, and read back on the next visit", () => {
  const first = run({ light: false });
  first.api.save("day");
  assert.deepEqual(first.storage, { "sk-live-theme": "day" });
  assert.equal(run({ light: false, storage: first.storage }).theme, "day");
});

test("?wall opens in Night whatever the system, and keeps its own choice", () => {
  const wall = run({ search: "?wall", light: true });
  assert.equal(wall.wall, true);
  assert.equal(wall.theme, "night");
  assert.equal(wall.api.follows(), false, "a wall never follows the system");
  assert.equal(run({ search: "?wall", storage: { "sk-live-theme": "day" } }).theme, "night", "the page's choice is not the wall's");
  wall.api.save("day");
  assert.deepEqual(wall.storage, { "sk-live-theme-wall": "day" });
  assert.equal(run({ search: "?demo&wall", storage: wall.storage }).theme, "day");
  assert.equal(run({ search: "?wallpaper", light: true }).theme, "day", "only ?wall is a wall");
});

test("without storage the page still chooses a theme, and saving does not throw", () => {
  const r = run({ light: true, storage: "throws" });
  assert.equal(r.theme, "day");
  assert.equal(r.api.saved(), null);
  assert.doesNotThrow(() => r.api.save("night"));
  assert.equal(run({ search: "?wall", light: true, storage: "throws" }).theme, "night");
});

test("storage is touched only in early.js, where every call is guarded", () => {
  assert.equal((early.match(/localStorage\.\w+\(/g) || []).length, 2);
  assert.equal((early.match(/try \{/g) || []).length, 2);
  for (const f of ["app.js", "lib/sky.js"]) assert.doesNotMatch(read(f), /localStorage|sessionStorage/, f);
});

test("the Day/Night toggle sits in the top-right HUD and saves through early.js", () => {
  const html = read("index.html");
  const right = html.slice(html.indexOf('<div class="hud-right"'), html.indexOf('<section class="sky"'));
  assert.match(right, /<div class="theme" role="group" aria-label="Theme"><button type="button" data-pick="day" aria-pressed="false">Day<\/button><button type="button" data-pick="night" aria-pressed="false">Night<\/button><\/div>/);
  assert.ok(html.indexOf('<script src="/early.js">') < html.indexOf("</head>"), "early.js runs in <head>, before the first paint");
  const app = read("app.js");
  assert.match(app, /b\.addEventListener\("click", \(\) => setTheme\(b\.dataset\.pick, true\)\)/);
  assert.match(app, /if \(liveTheme\.follows\(\)\) setTheme\(liveTheme\.system\(\), false\)/);
  assert.match(app, /b\.setAttribute\("aria-pressed", String\(b\.dataset\.pick === theme\)\)/);
});

// ---- the canvas: a fake 2D context that records what is drawn
function fakeCanvas() {
  const log = [];
  const ctx = new Proxy({}, {
    get: (t, k) => (k in t ? t[k] : (...a) => {
      log.push([k, ...a]);
      return { addColorStop: () => {} };
    }),
    set: (t, k, v) => { log.push([`=${String(k)}`, v]); return true; },
  });
  return { canvas: { getContext: () => ctx }, log };
}
const COLORS = {
  Vega: "#2f5fb8", Rigel: "#be185d", Lyra: "#85620a", Orion: "#a64a12", Polaris: "#111111", Kochab: "#0b6f96", Pherkad: "#0b6f96", Yildun: "#0b6f96",
  claude: "#a3541c", github: "#3553c9", chat: "#156b3d", pole: "#0b6f96", ink: "#111111", wash: "#efede6",
};
// Draws one frame with a review arc and a pulse half way, and returns what was drawn.
function frame(day) {
  const raf = [];
  globalThis.requestAnimationFrame = (f) => raf.push(f);
  globalThis.cancelAnimationFrame = () => {};
  const { canvas, log } = fakeCanvas();
  const sky = createSky(canvas, { day, colors: COLORS });
  const L = skyLayout(1440, 724);
  sky.resize(L, 1, { claude: { x: 300, y: 700 }, github: { x: 700, y: 700 }, chat: { x: 1100, y: 700 } });
  sky.start();
  sky.review("Rigel", "Vega");
  sky.event("Orion", "github");
  log.length = 0;
  raf.shift()(performance.now() + 900);
  return log;
}
const set = (log, k) => log.filter((e) => e[0] === `=${k}`).map((e) => e[1]);

test("Day draws the sky as a printed chart: ink, a grid round Polaris, no glow", () => {
  const night = frame(false), day = frame(true);
  assert.ok(set(night, "globalCompositeOperation").includes("lighter"), "Night's pulses glow");
  assert.ok(night.some((e) => e[0] === "createRadialGradient"), "Night's pulse heads glow");
  assert.ok(!set(day, "globalCompositeOperation").includes("lighter"), "Day's pulses don't add light");
  assert.ok(!day.some((e) => e[0] === "createRadialGradient"), "Day's pulse heads are printed dots");
  assert.ok(!set(day, "lineWidth").includes(7), "Day's arcs have no glow under them");
  assert.ok(set(night, "lineWidth").includes(7));
  assert.ok(set(day, "fillStyle").includes("#111111"), "the stars are ink");
  assert.ok(!set(day, "fillStyle").some((c) => c === "#dfe8ff" || c === "#ffe2c4"), "no night-sky star colours");
  assert.ok(set(day, "fillStyle").includes("#efede6"), "the ground is a wash of paper");
  // eight rings round Polaris and the twelve hour lines
  const L = skyLayout(1440, 724), P = L.stars.Polaris;
  const rings = day.filter((e) => e[0] === "arc" && e[1] === P.x && e[2] === P.y);
  assert.equal(rings.length, 8);
  const reach = Math.max(L.w, L.h) * 1.3;
  assert.equal(day.filter((e) => e[0] === "lineTo" && Math.abs(Math.hypot(e[1] - P.x, e[2] - P.y) - reach) < 0.01).length, 12);
});

test("switching theme redraws the sky in the new one", () => {
  const { canvas, log } = fakeCanvas();
  const sky = createSky(canvas, { colors: COLORS });
  sky.resize(skyLayout(1440, 724), 1, {});
  log.length = 0;
  sky.setDay(true);
  assert.ok(set(log, "fillStyle").includes("#efede6"));
  log.length = 0;
  sky.setDay(false);
  assert.ok(!set(log, "fillStyle").includes("#efede6"));
});
