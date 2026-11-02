// The /usage page's month (setkernel-live#71): a fixture month through the real sumByDay and
// buildMonth, with the November day the clocks go back; the box's text; and the Worker running
// first for /usage. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hourOf, sumByDay } from "../src/usage.js";
import { asOf, buildMonth, monthName, shiftMonth, short, tip } from "../public/usage/table.js";

const counts = (n) => ({ input: n, output: 2 * n, cache_read: 30 * n, cache_write: 7 * n, usd_micros: 1_000 * n, requests: 1 });
// Every hour from 03:00 UTC on 31 October to 02:00 UTC on 3 November: vega 100,000 an hour, rigel
// on 1 November only, codex once. 1 November in Halifax runs 03:00 UTC to 04:00 UTC the next day: 25 hours.
const rows = [];
for (let t = Date.UTC(2026, 9, 31, 3); t < Date.UTC(2026, 10, 3, 3); t += 3_600_000) {
  rows.push({ hour: hourOf(t), seat: "vega", ...counts(100_000) });
  if (t >= Date.UTC(2026, 10, 1, 3) && t < Date.UTC(2026, 10, 2, 4)) rows.push({ hour: hourOf(t), seat: "rigel", ...counts(5_000) });
}
rows.push({ hour: "2026-11-02T15", seat: "codex", ...counts(42) });
const data = { month: "2026-11", ...sumByDay(rows, "2026-11") };
const v = buildMonth(data, "2026-11-02");

test("fixture month: a row per Halifax day up to today, newest first, a column per seat and codex when present", () => {
  assert.equal(v.name, "November 2026");
  assert.deepEqual(v.seats, ["Vega", "Rigel", "Lyra", "Orion", "Polaris", "Codex"]);
  assert.deepEqual(v.rows.map((r) => `${r.d} ${r.wd}`), ["2 Mon", "1 Sun"], "31 October is the day before, in Halifax");
  assert.deepEqual(v.rows.map((r) => [r.today, r.weekend]), [[true, false], [false, true]]);
});

test("the day the clocks go back has 25 hours: 1 November's cells", () => {
  const [vega, rigel, lyra] = v.rows[1].cells;
  assert.equal(vega.f, "25,000,000"); // 25 hours of 1,000,000 fresh (input, output, cache writes)
  assert.equal(vega.text, "25M");
  assert.equal(vega.heat, 8);
  assert.equal(rigel.text, "1.3M"); // 25 x 50,000
  assert.equal(rigel.heat, 1);
  assert.equal(lyra, undefined, "no data is a dash, not zero");
  assert.equal(v.rows[1].all.text, "26M");
  assert.equal(v.rows[1].all.usd, "$2,625");
  assert.equal(v.rows[1].all.bar, 96);
  // today so far: 04:00 UTC on the 2nd to 02:00 UTC on the 3rd, 23 hours
  assert.equal(v.rows[0].cells[0].f, "23,000,000");
  assert.equal(v.rows[0].cells[5].text, "420");
});

test("a number's box and aria-label carry its exact fresh tokens, cache reads and dollars", () => {
  const vega = v.rows[1].cells[0];
  assert.deepEqual(tip(vega), { head: "Vega · Sun 1 Nov", rows: [["Fresh tokens", "25,000,000"], ["Cache reads", "75,000,000"], ["At API prices", "about $2,500"]] });
  assert.equal(vega.label, "Vega, Sun 1 Nov: 25,000,000 fresh tokens, 75,000,000 cache reads, about $2,500");
  assert.equal(tip(v.rows[0].cells[0]).head, "Vega · Mon 2 Nov, so far");
});

test("the month row: fresh tokens and dollars per seat, and the cache reads for all seats", () => {
  assert.deepEqual(v.total.cells.map((c) => c && `${c.text} ${c.usd}`), ["48M $4,800", "1.3M $125", undefined, undefined, undefined, "420 $0"]);
  assert.deepEqual([v.total.all.text, v.total.all.cached, v.total.all.usd], ["49M", "148M", "$4,925"]);
  assert.equal(v.busiest, "Vega");
  assert.equal(buildMonth({ month: "2026-10", days: {}, totals: {} }, "2026-11-01").empty, true);
});

test("short numbers, months and the as-of time in Halifax", () => {
  assert.deepEqual([13_698_537, 2_372_363, 816_743, 15_045_054_434, 9_960_000, 999_700, 950].map(short), ["14M", "2.4M", "817K", "15.0B", "10M", "1.0M", "950"]);
  assert.deepEqual([shiftMonth("2026-01", -1), shiftMonth("2026-12", 1), shiftMonth("2026-11", 0)], ["2025-12", "2027-01", "2026-11"]);
  assert.deepEqual(["2025-12", "2027-01"].map(monthName), ["December", "January"]);
  assert.equal(asOf("2026-10-31T14"), "31 Oct, 12:00 ADT");
  assert.equal(asOf("2026-11-01T04"), "1 Nov, 01:00 AST"); // the hour the clocks went back
});

// Without this the assets are served before the Worker runs, token or not (checked with wrangler
// dev: /usage/ answers 200); test/worker/ calls the Worker directly, so it can't see the difference.
test("wrangler.jsonc runs the Worker first for /usage and everything under it", () => {
  const assets = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").match(/"assets":\s*(\{[^}]*\})/)[1];
  assert.deepEqual(JSON.parse(assets).run_worker_first, ["/usage", "/usage/*"]);
});

// ---- the page script (setkernel-live#78), run in node against a stand-in document built from
// index.html's ids: just enough DOM for page.js, with fetch answering from the fixture month
class Node {
  constructor(tag) { Object.assign(this, { tag, kids: [], attrs: {}, dataset: {}, style: {}, on: {}, hidden: false, className: "", text: "" }); }
  get classList() { const cls = () => this.className.split(" ").filter(Boolean); return { add: (c) => { this.className = [...cls(), c].join(" "); }, remove: (c) => { this.className = cls().filter((x) => x !== c).join(" "); } }; }
  get children() { return this.kids; }
  get textContent() { return this.text + this.kids.map((k) => k.textContent).join(""); }
  set textContent(t) { this.kids = []; this.text = String(t); }
  append(...kids) { for (const k of kids) { k.parentNode = this; this.kids.push(k); } }
  replaceChildren(...kids) { this.kids = []; this.text = ""; this.append(...kids); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(type, f) { (this.on[type] ??= []).push(f); }
  closest(sel) { const [tag, cls] = sel.split("."); for (let n = this; n; n = n.parentNode) if (n.tag === tag && n.className.split(" ").includes(cls)) return n; return null; }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  getBoundingClientRect() { return { left: 300, top: 200, width: 60, height: 40, bottom: 240 }; }
  get offsetWidth() { return 220; }
  get offsetHeight() { return 90; }
  *all() { yield this; for (const k of this.kids) yield* k.all(); }
}
const html = readFileSync(new URL("../public/usage/index.html", import.meta.url), "utf8");
async function runPage(answer) {
  const doc = new Node("document"), ids = {};
  for (const [, tag, id, rest] of html.matchAll(/<(\w+) [^>]*?id="([^"]+)"([^>]*)>/g)) doc.append(Object.assign(ids[id] = new Node(tag), { hidden: /\shidden\b/.test(rest) }));
  Object.assign(doc, { documentElement: { clientWidth: 375 }, getElementById: (id) => ids[id], createElement: (t) => new Node(t), createElementNS: (_, t) => new Node(t) });
  const fire = (type, target, more = {}) => { for (let n = target; n; n = n.parentNode) for (const f of n.on[type] ?? []) f({ type, target, ...more }); };
  const asked = [];
  Object.assign(globalThis, { document: doc, location: { search: "?month=2026-11" }, fetch: async (url) => { asked.push(url); return answer(); } });
  test.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 2, 16) }); // noon in Halifax
  try {
    await (await import(`../public/usage/page.js?${Math.random()}`)).ready;
  } finally {
    test.mock.timers.reset();
  }
  return { ids, fire, asked, cells: [...ids.usage.all()].filter((n) => n.tag === "td") };
}
const month = () => new Response(JSON.stringify(data), { headers: { "Usage-Newest-Hour": "2026-11-02T15" } });

test("the page draws the fixture month: rows, a dash for no data, today so far, the months, the as-of time", async () => {
  const { ids, cells, asked } = await runPage(month);
  assert.deepEqual(asked, ["/usage/data?month=2026-11"]);
  assert.equal(ids.title.textContent, "Tokens per seat, November 2026");
  assert.equal(ids.asof.textContent, "Newest hour ends 2 Nov, 12:00 AST");
  assert.deepEqual([ids.status.hidden, ids.scroll.hidden, ids.sum.hidden], [true, false, false]);
  assert.equal(ids.sum.textContent, "Fresh tokens this month49MCache reads148MAt API prices, about$4,925Busiest seatVega");
  assert.deepEqual(ids.months.kids.map((k) => [k.tag, k.textContent, k.href]), [["a", "← October", "?month=2026-10"], ["b", "November 2026", undefined], ["span", "December →", undefined]]);
  const [head, body, foot] = ids.usage.kids;
  assert.equal(head.textContent, "DayVegaRigelLyraOrionPolarisCodexAll seats");
  assert.deepEqual(body.kids.map((r) => [r.className, r.kids[0].textContent]), [["today", "2 Monso far"], ["we", "1 Sun"]]);
  assert.deepEqual(body.kids[1].kids.map((td) => [td.className, td.textContent]), [["", "1 Sun"], ["h t8", "25M"], ["h t1", "1.3M"], ["none ", "–"], ["none ", "–"], ["none ", "–"], ["none ", "–"], ["h tot", "26M $2,625"]]);
  assert.deepEqual(body.kids[1].kids[7].kids[1].attrs, { class: "bar", width: "96", height: "4", "aria-hidden": "true" });
  assert.equal(foot.textContent, "November48M$4,8001.3M$125–––420$049M148M cached$4,925");
  assert.ok(cells.filter((td) => td.className.startsWith("h")).every((td) => td.tabIndex === 0 && td.attrs["aria-label"]));
});

test("a number's box: hover, focus or tap shows its exact values; Esc or a tap elsewhere closes it", async () => {
  const { ids, fire, cells } = await runPage(month);
  const vega = cells.find((td) => td.dataset.who === "Vega" && td.dataset.when === "Sun 1 Nov"), box = ids.tip;
  assert.equal(box.hidden, true);
  fire("focusin", vega.kids[0]);
  assert.equal(box.hidden, false);
  assert.equal(box.textContent, "Vega · Sun 1 NovFresh tokens25,000,000Cache reads75,000,000At API pricesabout $2,500");
  assert.deepEqual(box.style, { left: "147px", top: "102px" }, "centred above the number, inside a 375 px screen");
  fire("keydown", ids.usage, { key: "Escape" });
  assert.equal(box.hidden, true);
  fire("click", vega); // a tap pins it: moving the mouse off doesn't close it
  fire("mouseout", vega, { relatedTarget: ids.hint });
  assert.deepEqual([box.hidden, vega.className], [false, "h t8 on"]);
  fire("click", ids.hint);
  assert.deepEqual([box.hidden, vega.className], [true, "h t8"]);
  fire("mouseover", cells.find((td) => td.dataset.who === "All seats" && td.dataset.when === "November"));
  assert.equal(box.kids[0].textContent, "All seats · November");
});

test("a refused, failed or empty month shows a plain message, not a blank page", async () => {
  for (const [answer, words] of [
    [() => new Response("Forbidden", { status: 403 }), /can't read usage/],
    [() => new Response("Usage is not configured", { status: 503 }), /isn't set up/],
    [() => Promise.reject(new TypeError("Failed to fetch")), /no answer/],
    [() => new Response(null, { status: 500 }), /HTTP 500/],
  ]) {
    const { ids } = await runPage(answer);
    assert.match(ids.status.textContent, words);
    assert.deepEqual([ids.status.hidden, ids.scroll.hidden, ids.sum.hidden], [false, true, true]);
  }
  const { ids, cells } = await runPage(() => Response.json({ month: "2026-11", days: {}, totals: {} }));
  assert.equal(ids.status.textContent, "Nothing is stored for November 2026 yet.");
  assert.deepEqual([ids.asof.textContent, ids.hint.hidden], ["Nothing stored yet", true]);
  assert.ok(cells.length > 2 && cells.filter((td) => td.className.startsWith("none")).length === cells.length - 3, "every number is a dash");
});

test("the page follows the CSP and the site's rules: no inline style or script, no markup from data, site fonts only", () => {
  assert.doesNotMatch(html, /<style\b|\sstyle\s*=|\son[a-z]+\s*=/i);
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) assert.deepEqual([/\bsrc="\/usage\/page\.js"/.test(m[0]), m[1]], [true, ""]);
  assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]), ["/style.css", "/usage/usage.css"]);
  for (const f of ["page.js", "table.js"]) {
    const js = readFileSync(new URL(`../public/usage/${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|setAttribute\(\s*["']style|\.style\s*=|var\(--/, f);
  }
  const css = readFileSync(new URL("../public/usage/usage.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /@font-face|@import|font-family|url\(|\b\d+(\.\d+)?px\s*\/|font-size:\s*\d/, "fonts and sizes are style.css's");
  // the dark theme is the wall's colours, which test/page.test.mjs checks for contrast
  const site = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
  const hexes = (t) => Object.fromEntries([...t.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
  assert.deepEqual(hexes(css.slice(css.indexOf("prefers-color-scheme: dark"))), hexes(site.slice(site.indexOf("html.wall {"), site.indexOf("}", site.indexOf("html.wall {")))));
  for (const n of css.matchAll(/td\.t(\d) \{/g)) assert.ok(Number(n[1]) >= 1 && Number(n[1]) <= 8);
  assert.equal(css.match(/td\.t\d \{/g).length, 8, "one class per shading step");
});
