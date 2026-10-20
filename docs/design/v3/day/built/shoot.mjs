// Takes the built page's screenshots on ?demo, beside the prototype's in docs/design/v3/day, with
// Playwright's chromium in Halifax time at the prototype's clock (Wednesday 14 October 2026,
// 16:40 ADT). It serves public/ itself, with the headers from public/_headers, so a CSP violation
// fails the run. Playwright isn't a dependency of this repo: install it anywhere outside it.
//   npm i --prefix "$TMPDIR/pw" playwright && npx --prefix "$TMPDIR/pw" playwright install chromium
//   PLAYWRIGHT_DIR="$TMPDIR/pw" node docs/design/v3/day/built/shoot.mjs [name filter]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { view } from "../../../../../public/lib/state.js";
import { busyDay, runDay } from "../../../../../public/lib/demo.js";

const dir = process.env.PLAYWRIGHT_DIR;
if (!dir) throw new Error("set PLAYWRIGHT_DIR to a folder with playwright installed");
const { chromium } = createRequire(`${dir}/`)("playwright");
const pub = new URL("../../../../../public/", import.meta.url);
const out = (name) => fileURLToPath(new URL(name, import.meta.url));

// public/_headers' rules for /*, as the Worker's assets serve them
const headers = Object.fromEntries((await readFile(new URL("_headers", pub), "utf8")).split("\n")
  .filter((l) => /^\s+\S+:/.test(l)).map((l) => [l.trim().slice(0, l.trim().indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
const TYPES = { html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml", woff2: "font/woff2", png: "image/png" };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname.replace(/^\/$/, "/index.html");
  try {
    const body = await readFile(new URL(`.${path}`, pub));
    res.writeHead(200, { ...headers, "Content-Type": TYPES[path.split(".").pop()] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const origin = `http://localhost:${server.address().port}`;

const NOW = Date.UTC(2026, 9, 14, 19, 40, 0); // 16:40 ADT

// The live page without ?demo: /api/state, /api/replay and /ws answered with the busy day, built
// by the same reducers as the Durable Object, the office's last word 6 s before the clock.
const live = runDay(busyDay(NOW / 1000).batches);
const liveState = { ...view(live.state, live.replay, NOW), lastIngest: NOW - 6000, version: "dev" };
async function mockLive(p) {
  await p.route("**/api/state", (r) => r.fulfill({ json: liveState }));
  await p.route("**/api/replay?h=24", (r) => r.fulfill({ json: { ...live.replay, now: NOW } }));
  await p.routeWebSocket("**/ws", (ws) => ws.send(JSON.stringify({ t: "hello", ...liveState })));
}
export const SHOTS = [
  ["day-live-1440x900.png", 1440, 900, "?demo"],
  ["day-live-api-1440x900.png", 1440, 900, "", "api"],
  ["day-quiet-1440x900.png", 1440, 900, "?demo=quiet"],
  ["day-offline-1440x900.png", 1440, 900, "?demo=offline"],
  ["day-waiting-1440x900.png", 1440, 900, "?demo=waiting"],
  ["day-scrub-1440x900.png", 1440, 900, "?demo", "scrub"],
  ["day-live-375x812.png", 375, 812, "?demo"],
  ["day-quiet-375x812.png", 375, 812, "?demo=quiet"],
  ["day-live-375-full.png", 375, 812, "?demo", "full"],
  ["day-live-1024x768.png", 1024, 768, "?demo"],
  ["day-wall-live-2560x1440.png", 2560, 1440, "?demo&wall"],
  ["day-wall-live-1920x1080.png", 1920, 1080, "?demo&wall"],
  ["day-wall-live-1440x810.png", 1440, 810, "?demo&wall"],
  ["day-wall-quiet-1920x1080.png", 1920, 1080, "?demo=quiet&wall"],
  ["day-wall-live-1280x1024.png", 1280, 1024, "?demo&wall"],
  // the share preview (public/og.png): the wide page at 1440 x 756, scaled to 1200 x 630
  ["og.png", 1440, 756, "?demo", "og"],
];
const only = process.argv.slice(2);
const browser = await chromium.launch();
for (const [name, width, height, query, extra] of SHOTS) {
  if (only.length && !only.some((o) => name.includes(o))) continue;
  const ctx = await browser.newContext({ viewport: { width, height }, timezoneId: "America/Halifax", locale: "en-CA", deviceScaleFactor: extra === "og" ? 1200 / 1440 : 1 });
  const p = await ctx.newPage();
  await p.clock.setFixedTime(NOW);
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error" || /Content Security Policy/.test(m.text())) errors.push(m.text()); });
  p.on("request", (r) => { if (!r.url().startsWith(origin)) errors.push(`network: ${r.url()}`); });
  if (extra === "api") await mockLive(p);
  await p.goto(`${origin}/${query}`);
  await p.waitForFunction(() => document.querySelector("#plot svg") && document.fonts.status === "loaded");
  await p.waitForTimeout(300);
  if (extra === "scrub") {
    // keyboard: focus the chart, back to 10:20 (from the 16:30 column, 37 steps of ten minutes)
    await p.focus("#plot svg");
    for (let i = 0; i < 37; i++) await p.keyboard.press("ArrowLeft");
  }
  const fit = await p.evaluate(() => {
    const d = document.getElementById("day"), r = d.getBoundingClientRect();
    return { sh: d.scrollHeight, sw: d.scrollWidth, r: [r.left, r.top, r.right, r.bottom], w: innerWidth, h: innerHeight, page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight] };
  });
  if (fit.page[0] > fit.w) errors.push(`horizontal scroll: ${fit.page[0]} > ${fit.w}`);
  if (query.includes("wall")) {
    // the canvas must hold everything, and its scaled box must sit inside the window
    const ok = fit.sh <= 810 && fit.sw <= 1440 && fit.r[0] >= -0.5 && fit.r[1] >= -0.5 && fit.r[2] <= fit.w + 0.5 && fit.r[3] <= fit.h + 0.5 && fit.page[1] <= fit.h;
    if (!ok) errors.push(`wall does not fit: ${JSON.stringify(fit)}`);
  }
  await p.screenshot({ path: extra === "og" ? fileURLToPath(new URL("og.png", pub)) : out(name), fullPage: extra === "full" });
  if (errors.length) { console.error(name, errors); process.exitCode = 1; }
  console.log(name);
  await ctx.close();
}
await browser.close();
server.close();
