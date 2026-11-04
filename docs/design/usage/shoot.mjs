// Takes the /usage page's screenshots (setkernel-live#86) in Playwright's chromium, in Halifax time at
// the v5 prototypes' clock (Wednesday 28 October 2026, 15:04 ADT). It serves public/ itself, with the
// headers from public/_headers, so a CSP violation fails the run, and answers GET /usage/data from the
// sample month below: invented values in the real shapes (src/usage.js sumByDay; the seat limits as
// public/usage/limits.js reads them). Every state is drawn light and dark at 375, 1440 and 2560 and
// checked for errors and sideways scroll; KEEP picks the ones saved beside this file. "before" saves
// the Normal state, without limits, into before/: run it on the base commit, before the change.
// Playwright isn't a dependency of this repo: install it anywhere outside it.
//   npm i --prefix "$TMPDIR/pw" playwright && npx --prefix "$TMPDIR/pw" playwright install chromium
//   PLAYWRIGHT_DIR="$TMPDIR/pw" node docs/design/usage/shoot.mjs [before]
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const dir = process.env.PLAYWRIGHT_DIR;
if (!dir) throw new Error("set PLAYWRIGHT_DIR to a folder with playwright installed");
const { chromium } = createRequire(`${dir}/`)("playwright");
const pub = new URL("../../../public/", import.meta.url);
const before = process.argv[2] === "before";
const out = (name) => fileURLToPath(new URL(before ? `before/${name}` : name, import.meta.url));

// public/_headers' rules for /*, as the Worker's assets serve them
const headers = Object.fromEntries((await readFile(new URL("_headers", pub), "utf8")).split("\n")
  .filter((l) => /^\s+\S+:/.test(l)).map((l) => [l.trim().slice(0, l.trim().indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
const TYPES = { html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml", woff2: "font/woff2", png: "image/png" };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname.replace(/^\/usage\/?$/, "/usage/index.html");
  try {
    const body = await readFile(new URL(`.${path}`, pub));
    res.writeHead(200, { ...headers, "Content-Type": TYPES[path.split(".").pop()] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const origin = `http://localhost:${server.address().port}`;

// ---- the sample: every Halifax day from 1 August to today, per seat, seeded so each run is the same
const NOW = Date.UTC(2026, 9, 28, 18, 4); // Wednesday 28 October 2026, 15:04 ADT
const SCALE = { vega: 7.2e6, rigel: 8.1e6, lyra: 8.8e6, orion: 9.4e6, polaris: 6.0e6, codex: 0.9e6 }; // fresh tokens a weekday
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
function counts(fresh) {
  const input = Math.round(fresh * 0.1), output = Math.round(fresh * 0.15), cache_write = fresh - input - output;
  const cache_read = Math.round(fresh * (10 + 4 * rnd()));
  return { input, output, cache_read, cache_write, usd_micros: Math.round(15 * input + 75 * output + 18.75 * cache_write + 1.5 * cache_read), requests: Math.round(fresh / 9000) };
}
const DAYS = {};
for (let t = Date.UTC(2026, 7, 1); t <= Date.UTC(2026, 9, 28); t += 86_400_000) {
  const key = new Date(t).toISOString().slice(0, 10), weekend = [0, 6].includes(new Date(t).getUTCDay());
  const growth = 0.8 + (0.4 * (t - Date.UTC(2026, 7, 1))) / (88 * 86_400_000);
  DAYS[key] = {};
  for (const [seat, scale] of Object.entries(SCALE)) {
    if (rnd() < (weekend ? 0.35 : 0.04)) continue; // a day off: no data, not zero
    DAYS[key][seat] = counts(Math.round(scale * growth * (weekend ? 0.3 : 1) * (0.6 + 0.8 * rnd())));
  }
}
const scaled = (day, f) => Object.fromEntries(Object.entries(day).map(([s, c]) => [s, Object.fromEntries(Object.entries(c).map(([k, n]) => [k, Math.round(n * f)]))]));
// GET /usage/data?month= as the Worker answers it; today holds the hours up to the newest one
function month(m, hours, limits) {
  const days = Object.fromEntries(Object.entries(DAYS).filter(([k]) => k.startsWith(m)).map(([k, d]) => [k, k === "2026-10-28" ? scaled(d, hours / 24) : d]));
  const totals = {};
  for (const d of Object.values(days)) for (const [s, c] of Object.entries(d)) totals[s] = Object.fromEntries(Object.entries(c).map(([k, n]) => [k, (totals[s]?.[k] ?? 0) + n]));
  return { month: m, days, totals, ...(limits && { limits }) };
}

// the seats' limit windows, at a Halifax (ADT) clock time on a day of October
const at = (h, min, d = 28) => new Date(Date.UTC(2026, 9, d, h + 3, min)).toISOString();
const w = (utilization, resets_at, observed_at) => ({ utilization, resets_at, observed_at });
const NORMAL = {
  vega: { five_hour: w(0.42, at(17, 30), at(14, 58)), seven_day: w(0.38, at(21, 0, 30), at(14, 58)), event: null },
  rigel: { five_hour: w(0.84, at(16, 10), at(14, 55)), seven_day: w(0.52, at(9, 0, 31), at(14, 55)), event: null },
  lyra: { five_hour: w(0.31, at(18, 40), at(14, 57)), seven_day: w(0.73, at(6, 0, 29), at(14, 57)), event: null },
  orion: { five_hour: w(0.56, at(16, 50), at(14, 59)), seven_day: w(0.47, at(13, 0, 30), at(14, 59)), event: null },
  polaris: { five_hour: w(0.12, at(19, 20), at(14, 31)), seven_day: w(0.21, at(8, 0, 31), at(14, 31)), event: null },
};
const LIMIT = {
  ...NORMAL,
  rigel: { five_hour: w(1, at(16, 10), at(14, 47)), seven_day: w(0.66, at(9, 0, 31), at(14, 47)), event: { status: "rejected", rate_limit_type: "five_hour", resets_at: at(16, 10), received_at: at(14, 47) } },
  orion: { ...NORMAL.orion, seven_day: w(0.91, at(13, 0, 30), at(14, 59)) },
  lyra: { ...NORMAL.lyra, seven_day: w(0.78, at(6, 0, 29), at(14, 57)) },
};
const STALE = { ...NORMAL, orion: { ...NORMAL.orion, five_hour: w(0.62, at(12, 30), at(10, 14)) }, polaris: null };

// [name, ?query, the newest hour, the hours of today stored, limits, or how /usage/data answers]
const STATES = [
  ["normal", "", "2026-10-28T17", 15, NORMAL],
  ["limit", "", "2026-10-28T17", 15, LIMIT],
  ["stale", "", "2026-10-28T13", 11, STALE],
  ["unread", "", "2026-10-28T17", 15, null], // /usage/data without limits: what the Worker answers until a reading is stored
  ["past", "?month=2026-09", "2026-10-28T17", 15, NORMAL],
  ["loading", "", null, 0, "hang"],
  ["refused", "", null, 0, 403],
];
const SIZES = [[375, 812], [1440, 900], [2560, 1440]];
const KEEP = before
  ? (s) => s === "unread"
  : (s, theme, width) => s === "normal" || (["limit", "stale", "unread"].includes(s) && ((width === 1440 && theme === "light") || (width === 375 && theme === "dark"))) || (s === "past" && width === 1440 && theme === "dark") || (s === "loading" && width === 1440 && theme === "light");

if (before) await mkdir(new URL("before/", import.meta.url), { recursive: true });
const browser = await chromium.launch();
for (const [state, query, newest, hours, limits] of STATES) {
  for (const theme of ["light", "dark"]) {
    for (const [width, height] of SIZES) {
      const ctx = await browser.newContext({ viewport: { width, height }, timezoneId: "America/Halifax", locale: "en-CA", colorScheme: theme });
      const p = await ctx.newPage();
      await p.clock.setFixedTime(NOW);
      const errors = [];
      p.on("pageerror", (e) => errors.push(e.message));
      p.on("console", (m) => {
        if (typeof limits === "number" && /status of 403/.test(m.text())) return; // the refusal itself
        if (m.type() === "error" || /Content Security Policy/.test(m.text())) errors.push(m.text());
      });
      p.on("request", (r) => { if (!r.url().startsWith(origin)) errors.push(`network: ${r.url()}`); });
      await p.route("**/usage/data?month=*", (r) => {
        if (limits === "hang") return; // never answered: the page as it first loads
        if (typeof limits === "number") return r.fulfill({ status: limits, body: "Forbidden" });
        const m = new URL(r.request().url()).searchParams.get("month");
        return r.fulfill({ json: month(m, hours, limits), headers: { "Usage-Newest-Hour": newest, "Cache-Control": "no-store" } });
      });
      await p.goto(`${origin}/usage/${query}`);
      await p.waitForFunction((hang) => document.fonts.status === "loaded" && (hang || !/^Loading/.test(document.getElementById("status")?.textContent ?? "") || document.getElementById("status").hidden), limits === "hang");
      await p.waitForTimeout(300);
      const sw = await p.evaluate(() => document.documentElement.scrollWidth);
      if (sw > width) errors.push(`horizontal scroll: ${sw} > ${width}`);
      const name = before ? `usage-${width}-${theme}.png` : `usage-${state}-${width}-${theme}.png`;
      if (KEEP(state, theme, width)) await p.screenshot({ path: out(name) });
      if (state === "normal" && width === 375 && theme === "light" && !before) await p.screenshot({ path: out("usage-normal-375-light-full.png"), fullPage: true });
      // scrolled into the table: its head stuck to the top, each seat's strip showing
      if (["normal", "stale"].includes(state) && width === 1440 && !before) {
        await p.evaluate(() => scrollTo(0, document.getElementById("usage").getBoundingClientRect().top + scrollY + 420));
        await p.waitForFunction(() => document.getElementById("usage").classList.contains("stuck"), null, { timeout: 3000 }).catch(() => errors.push("the table's strip didn't show once scrolled"));
        await p.waitForTimeout(300);
        await p.screenshot({ path: out(`usage-${state}-1440-${theme}-table.png`) });
      }
      // a seat whose reading is stale, dashed, at 375
      if (state === "stale" && width === 375 && !before) {
        await p.evaluate(() => document.getElementById("seat-orion").scrollIntoView());
        await p.waitForTimeout(300);
        await p.screenshot({ path: out(`usage-stale-375-${theme}-seat.png`) });
      }
      if (errors.length) { console.error(state, theme, width, errors); process.exitCode = 1; }
      else console.log("ok", state, theme, width, KEEP(state, theme, width) ? name : "");
      await ctx.close();
    }
  }
}
await browser.close();
server.close();
