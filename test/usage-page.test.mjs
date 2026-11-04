// The /usage page's month (setkernel-live#71, v5 in #86): a fixture month through the real sumByDay
// and buildMonth, with the November day the clocks go back; the box's text; the trend; the limit
// windows' rules (the alert, a limit hit, a stale or missing reading, Codex); and the Worker running
// first for /usage. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { hourOf, sumByDay } from "../src/usage.js";
import { asOf, buildMonth, changeWords, dayName, firstDay, monthName, seatsOf, shiftDay, shiftMonth, short, tip, trend } from "../public/usage/table.js";
import { alertOf, meter, mini, needs, windowOf } from "../public/usage/limits.js";

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

test("fixture month: a row per Halifax day up to today, newest first, a column per seat with data", () => {
  assert.equal(v.name, "November 2026");
  assert.deepEqual(v.seats, ["Vega", "Rigel", "Codex"]);
  assert.deepEqual(v.rows.map((r) => `${r.d} ${r.wd}`), ["2 Mon", "1 Sun"], "31 October is the day before, in Halifax");
  assert.deepEqual(v.rows.map((r) => [r.today, r.weekend]), [[true, false], [false, true]]);
});

test("the day the clocks go back has 25 hours: 1 November's cells", () => {
  const [vega, rigel, codex] = v.rows[1].cells;
  assert.equal(vega.f, "25,000,000"); // 25 hours of 1,000,000 fresh (input, output, cache writes)
  assert.equal(vega.text, "25M");
  assert.equal(vega.heat, 8);
  assert.equal(rigel.text, "1.3M"); // 25 x 50,000
  assert.equal(rigel.heat, 1);
  assert.equal(codex, null, "no data is a dash, not zero");
  assert.equal(v.rows[1].all.text, "26M");
  assert.equal(v.rows[1].all.usd, "$2,625");
  assert.equal(v.rows[1].all.bar, 100);
  // today so far: 04:00 UTC on the 2nd to 02:00 UTC on the 3rd, 23 hours
  assert.equal(v.rows[0].cells[0].f, "23,000,000");
  assert.equal(v.rows[0].cells[2].text, "420");
  assert.deepEqual(v.today.map((c) => c?.text), ["23M", undefined, "420"]);
});

test("a number's box and aria-label carry its exact fresh tokens, cache reads and dollars", () => {
  const vega = v.rows[1].cells[0];
  assert.deepEqual(tip(vega), { head: "Vega · Sun 1 Nov", rows: [["Fresh tokens", "25,000,000"], ["Cache reads", "75,000,000"], ["At API prices", "about $2,500"]] });
  assert.equal(vega.label, "Vega, Sun 1 Nov: 25,000,000 fresh tokens, 75,000,000 cache reads, about $2,500");
  assert.equal(tip(v.rows[0].cells[0]).head, "Vega · Mon 2 Nov, so far");
});

test("the month row: fresh tokens and dollars per seat, and the cache reads for all seats", () => {
  assert.deepEqual(v.total.cells.map((c) => c && `${c.text} ${c.usd}`), ["48M $4,800", "1.3M $125", "420 $0"]);
  assert.deepEqual([v.total.all.text, v.total.all.cached, v.total.all.usd], ["49M", "148M", "$4,925"]);
  assert.deepEqual(v.busiest, { name: "Vega", text: "48M" });
  assert.equal(buildMonth({ month: "2026-10", days: {}, totals: {} }, "2026-11-01").empty, true);
});

test("the seats come from the data: usage, and the limits on the current month only, in the team's order", () => {
  assert.deepEqual(seatsOf({ codex: {}, zeta: {}, vega: {}, other: {} }, { polaris: null, rigel: {} }), ["vega", "rigel", "polaris", "codex", "other", "zeta"]);
  assert.deepEqual(buildMonth({ ...data, limits: { lyra: null } }, "2026-11-02").keys, ["vega", "rigel", "lyra", "codex"]);
  const past = buildMonth({ ...data, limits: { lyra: null } }, "2026-12-01");
  assert.deepEqual([past.keys, past.limits, past.current, past.today], [["vega", "rigel", "codex"], null, false, null], "limits are live: a past month has none");
});

test("short numbers, days, months and the as-of time in Halifax", () => {
  assert.deepEqual([13_698_537, 2_372_363, 816_743, 15_045_054_434, 9_960_000, 999_700, 950].map(short), ["14M", "2.4M", "817K", "15.0B", "10M", "1.0M", "950"]);
  assert.deepEqual([shiftMonth("2026-01", -1), shiftMonth("2026-12", 1), shiftMonth("2026-11", 0)], ["2025-12", "2027-01", "2026-11"]);
  assert.deepEqual([shiftDay("2026-03-01", -1), shiftDay("2028-03-01", -1), shiftDay("2026-12-31", 1)], ["2026-02-28", "2028-02-29", "2027-01-01"]);
  assert.deepEqual(["2025-12", "2027-01"].map(monthName), ["December", "January"]);
  assert.deepEqual(["2026-10-27", "2026-11-01"].map(dayName), ["Tue 27 Oct", "Sun 1 Nov"]);
  assert.equal(asOf("2026-10-31T14"), "31 Oct, 12:00 ADT");
  assert.equal(asOf("2026-11-01T04"), "1 Nov, 01:00 AST"); // the hour the clocks went back
});

// ---- the trend (Ledger): a day stored without the seat is 0, a day before the store began is nothing
test("the trend: the span's days to the last, and the change on the span before, per day, over the days stored", () => {
  const day = (n) => ({ vega: counts(n / 10) }); // n fresh tokens
  const days = { "2026-10-20": day(100), "2026-10-21": day(100), "2026-10-22": {}, "2026-10-23": day(100), "2026-10-24": day(100), "2026-10-25": day(100), "2026-10-26": day(100), "2026-10-27": day(100), "2026-10-28": day(150), "2026-10-29": day(150), "2026-10-30": day(150), "2026-10-31": day(150), "2026-11-01": day(150), "2026-11-02": day(150), "2026-11-03": day(150) };
  // 28 Oct to 3 Nov is 1,050; 21 to 27 Oct is 600 (22 Oct stored without vega is 0): per day 150 against 600 / 7
  assert.deepEqual(trend(days, "vega", "2026-11-03", 7, "2026-10-20"), { points: [150, 150, 150, 150, 150, 150, 150], change: 75 });
  // the store began on 23 October: four days before the span, at least half of seven, all 100
  assert.equal(trend(days, "vega", "2026-11-03", 7, "2026-10-23").change, 50);
  // it began on 25 October: three days before, fewer than half: nothing to compare
  assert.equal(trend(days, "vega", "2026-11-03", 7, "2026-10-25").change, null);
  assert.deepEqual(trend(days, "vega", "2026-10-26", 7, "2026-10-23").points, [null, null, null, 100, 100, 100, 100], "nothing before the store began");
  assert.equal(trend(days, "rigel", "2026-11-03", 7, "2026-10-20").change, null, "the days before sum to nothing");
  assert.equal(firstDay([{ days: { "2026-10-02": {}, "2026-10-05": { vega: {} } } }, { days: { "2026-09-30": { rigel: {} } } }]), "2026-09-30");
  assert.equal(firstDay([{ days: {} }]), null);
  assert.deepEqual([changeWords(75, 7), changeWords(-8, 30), changeWords(0, 7), changeWords(null, 7)], ["Up 75% on the previous 7 days", "Down 8% on the previous 30 days", "No change on the previous 7 days", "No earlier days to compare with"]);
});

// ---- the limit windows: the rules the wall uses (setkernel/hq observability/wall/limits.py)
const NOW = Date.UTC(2026, 9, 28, 18, 4); // Wednesday 28 October, 15:04 ADT
const at = (h, min, d = 28) => new Date(Date.UTC(2026, 9, d, h + 3, min)).toISOString(); // a Halifax clock time in October
const w = (utilization, resets_at = at(16, 10), observed_at = at(14, 55)) => ({ utilization, resets_at, observed_at });
const seat = (five_hour, seven_day = w(0.3, at(9, 0, 31)), event = null) => ({ five_hour, seven_day, event });
const win = (limits, s = "rigel", name = "five_hour") => windowOf(limits, s, name, NOW);

test("the alert is at the figure the page shows: 80% for 5 hours, 70% for the week, rounded down", () => {
  assert.deepEqual([0.79, 0.7999, 0.8, 0.84, 0.999].map((u) => [win({ rigel: seat(w(u)) }).pct, win({ rigel: seat(w(u)) }).level]), [[79, "ok"], [79, "ok"], [80, "over"], [84, "over"], [99, "over"]]);
  assert.deepEqual([0.69, 0.7].map((u) => win({ rigel: seat(w(0.1), w(u, at(9, 0, 31))) }, "rigel", "seven_day").level), ["ok", "over"]);
  assert.deepEqual([win({ rigel: seat(w(1)) }).level, win({ rigel: seat(w(1.2)) }).pct], ["limit", 120]);
});

test("a limit hit: 100%, or a request rejected for this window since it last opened and not yet reset", () => {
  const rejected = (type, received_at, resets_at = at(16, 10)) => ({ status: "rejected", rate_limit_type: type, resets_at, received_at });
  assert.deepEqual([win({ rigel: seat(w(0.5), undefined, rejected("five_hour", at(14, 47))) }).level, win({ rigel: seat(w(0.5), undefined, rejected("five_hour", at(14, 47))) }).hit], ["limit", Date.parse(at(14, 47))]);
  assert.equal(win({ rigel: seat(w(0.5), undefined, rejected("seven_day", at(14, 47))) }).level, "ok", "another window's rejection");
  assert.equal(win({ rigel: seat(w(0.5), undefined, rejected("five_hour", at(11, 0))) }).level, "ok", "rejected in the window before (it opened at 11:10)");
  assert.equal(win({ rigel: seat(w(0.5), undefined, rejected("five_hour", at(14, 47), at(15, 0))) }).level, "ok", "its own reset has passed");
  assert.equal(win({ rigel: seat(w(0.5), undefined, { ...rejected("five_hour", at(14, 47)), status: "allowed" }) }).level, "ok");
});

test("a stale reading is one from before its window reset: no figure, and when it was read", () => {
  const stale = win({ orion: seat(w(0.62, at(12, 30), at(10, 14))) }, "orion");
  assert.deepEqual(stale, { kind: "stale", read: Date.parse(at(10, 14)) });
  assert.equal(win({ orion: seat(w(0.62, at(15, 4), at(10, 14))) }, "orion").kind, "stale", "resetting now is reset");
  // with no reset time, the window is taken to reset its length after the reading, as on the wall
  assert.equal(win({ orion: seat(w(0.62, null, at(10, 4))) }, "orion").kind, "stale");
  assert.deepEqual([win({ orion: seat(w(0.62, null, at(10, 5))) }, "orion").kind, win({ orion: seat(w(0.62, null, at(10, 5))) }, "orion").resets], ["fresh", Date.parse(at(15, 5))]);
  assert.deepEqual(meter(stale, "orion", "five_hour", "5-hour", NOW), { flag: "no fresh reading since 10:14", meta: ["it reset since; the old figure is not shown"], label: "Orion 5-hour: no fresh reading since 10:14" });
  assert.equal(mini(stale), "stale");
});

test("a missing or malformed reading is not reported, Codex has no Claude limits, and no limits at all is unread", () => {
  for (const bad of [null, w(null), w(-0.1), w("0.5"), w(0.5, at(16, 10), null), w(0.5, at(16, 10), "yesterday")]) assert.equal(win({ rigel: seat(bad) }).kind, "none", JSON.stringify(bad));
  assert.deepEqual([win({ rigel: null }).kind, win({}).kind], ["none", "none"]);
  assert.deepEqual([win({ codex: seat(w(0)) }, "codex").kind, win({ other: seat(w(0)) }, "other").kind, win(null).kind, win(null, "codex").kind], ["nolimits", "nolimits", "unread", "nolimits"]);
  assert.deepEqual(meter(win({ rigel: null }), "rigel", "seven_day", "weekly", NOW), { flag: "not reported", meta: ["no reading from this seat"], label: "Rigel weekly: not reported" });
});

test("what a meter says, and the worst of a seat's windows", () => {
  const hit = { status: "rejected", rate_limit_type: "five_hour", resets_at: at(16, 10), received_at: at(14, 47) };
  assert.deepEqual(meter(win({ rigel: seat(w(1), undefined, hit) }), "rigel", "five_hour", "5-hour", NOW), { pct: 100, flag: "LIMIT HIT", meta: ["resets 16:10", "read 14:55", "rejected 14:47"], label: "Rigel 5-hour: 100%, limit hit, resets 16:10, read 14:55, rejected 14:47" });
  assert.deepEqual(meter(win({ rigel: seat(w(0.84)) }), "rigel", "five_hour", "5-hour", NOW).flag, "over 80%");
  assert.deepEqual(meter(win({ rigel: seat(w(0.1), w(0.42, at(21, 0, 30))) }, "rigel", "seven_day"), "rigel", "seven_day", "weekly", NOW), { pct: 42, flag: "under 70%", meta: ["resets Fri 21:00", "read 14:55"], label: "Rigel weekly: 42%, under 70%, resets Fri 21:00, read 14:55" });
  const views = (...k) => k.map((kind) => (kind === "limit" || kind === "over" || kind === "ok" ? { kind: "fresh", level: kind } : { kind }));
  assert.deepEqual([alertOf(views("ok", "limit")), alertOf(views("over", "stale")), alertOf(views("ok", "none")), alertOf(views("ok", "ok"))], ["limit", "over", "gap", null]);
});

test("Needs a look: worst first, then the team's order; all clear is empty; no limits is null", () => {
  const hit = { status: "rejected", rate_limit_type: "five_hour", resets_at: at(16, 10), received_at: at(14, 47) };
  const limits = {
    vega: seat(w(0.42)),
    rigel: seat(w(1), undefined, hit),
    lyra: seat(w(0.31), w(0.73, at(6, 0, 29))),
    orion: seat(w(0.62, at(12, 30), at(10, 14)), w(0.91, at(13, 0, 30))),
    polaris: null,
    codex: seat(w(0.99)),
  };
  assert.deepEqual(needs(limits, ["vega", "rigel", "lyra", "orion", "polaris", "codex"], NOW).map((i) => [i.kind, i.seat, i.text]), [
    ["limit", "rigel", "Rigel hit the 5-hour limit at 14:47, resets 16:10"],
    ["over", "lyra", "Lyra's weekly is at 73%, resets Thu 06:00"],
    ["over", "orion", "Orion's weekly is at 91%, resets Fri 13:00"],
    ["gap", "orion", "Orion's 5-hour has no fresh reading since 10:14"],
    ["gap", "polaris", "Polaris is not reporting"],
  ]);
  assert.deepEqual(needs({ vega: seat(w(0.5), null) }, ["vega"], NOW).map((i) => i.text), ["Vega's weekly is not reported"]);
  assert.deepEqual(needs({ vega: seat(w(0.5)) }, ["vega", "codex"], NOW), []);
  assert.equal(needs(null, ["vega"], NOW), null);
});

// Without this the assets are served before the Worker runs, token or not (checked with wrangler
// dev: /usage/ answers 200); test/worker/ calls the Worker directly, so it can't see the difference.
test("wrangler.jsonc runs the Worker first for /usage and everything under it", () => {
  const assets = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").match(/"assets":\s*(\{[^}]*\})/)[1];
  assert.deepEqual(JSON.parse(assets).run_worker_first, ["/usage", "/usage/*"]);
});

// ---- the page script (setkernel-live#78, #86), run in node against a stand-in document built from
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
async function runPage(answer, now = Date.UTC(2026, 10, 2, 16)) { // noon in Halifax
  const doc = new Node("document"), ids = {};
  for (const [, tag, id, rest] of html.matchAll(/<(\w+) [^>]*?id="([^"]+)"([^>]*)>/g)) doc.append(Object.assign(ids[id] = new Node(tag), { hidden: /\shidden\b/.test(rest) }));
  Object.assign(doc, { documentElement: { clientWidth: 375 }, getElementById: (id) => ids[id], createElement: (t) => new Node(t), createElementNS: (_, t) => new Node(t) });
  const fire = (type, target, more = {}) => { for (let n = target; n; n = n.parentNode) for (const f of n.on[type] ?? []) f({ type, target, ...more }); };
  const asked = [];
  Object.assign(globalThis, { document: doc, location: { search: "?month=2026-11" }, fetch: async (url) => { asked.push(url); return answer(new URL(url, "https://x").searchParams.get("month")); } });
  test.mock.timers.enable({ apis: ["Date"], now });
  try {
    await (await import(`../public/usage/page.js?${Math.random()}`)).ready;
  } finally {
    test.mock.timers.reset();
  }
  const find = (n, f) => [...n.all()].filter(f);
  return { ids, fire, asked, find, cells: find(ids.usage, (n) => n.tag === "td") };
}
// November is the fixture; October and September are stored but empty
const month = (extra = {}) => (m) => Response.json(m === "2026-11" ? { ...data, ...extra } : { month: m, days: {}, totals: {} }, { headers: m === "2026-11" ? { "Usage-Newest-Hour": "2026-11-02T15" } : {} });

test("the page draws the fixture month: the totals, a row per seat, the table, the day list, the months", async () => {
  const { ids, cells, asked, find, fire } = await runPage(month());
  assert.deepEqual(asked, ["/usage/data?month=2026-11", "/usage/data?month=2026-10", "/usage/data?month=2026-09"]);
  assert.equal(ids.title.textContent, "Usage per seat, November 2026");
  assert.equal(ids.asof.textContent, "Newest hour ends 2 Nov, 12:00 AST");
  assert.doesNotMatch(ids.fresh.className, /late/);
  assert.deepEqual([ids.status.hidden, ids.need.hidden, ids.sum.hidden, ids.seats.hidden, ids.days.hidden], [true, false, false, false, false]);
  assert.deepEqual([ids.need.dataset.sev, ids.needs.textContent], ["wait", "Seat limits aren't sent to this page yet, so it can't check them. Usage is below."]);
  assert.equal(ids.sum.textContent, "Fresh tokens49Mthis month so farCache reads148Mcounted apartAt API prices, about$4,925a size guide, not a billBusiest seatVega48M fresh tokens");
  assert.deepEqual(ids.months.kids.map((k) => [k.tag, k.textContent, k.href]), [["a", "October", "?month=2026-10"], ["b", "November 2026", undefined], ["span", "December", undefined]]);

  const [cols, vega, rigel, codex] = ids.rows.kids;
  assert.equal(cols.textContent, "Seat5-hourWeeklyTodayThis monthTrend, 7 days");
  assert.deepEqual([vega, rigel, codex].map((r) => [r.id, r.className]), [["seat-vega", "seat k-vega"], ["seat-rigel", "seat k-rigel"], ["seat-codex", "seat k-codex"]]);
  assert.equal(vega.textContent, "VegaNo limit readings yetToday23Mso far · about $2,300This month48M144M cache reads · about $4,800Trend, 7 daysNo earlier days to compare with");
  assert.match(rigel.textContent, /^RigelNo limit readings yetToday–no data, not zero/);
  assert.match(codex.textContent, /^Codexnot a Claude seatNo Claude limits: Codex isn't a Claude seatToday420/);
  assert.doesNotMatch(codex.textContent, /\d%/, "Codex never shows a percentage");
  assert.equal(ids.since.textContent, "Each line is a seat's fresh tokens a day over the 7 days to Sun 1 Nov, from zero; the hollow dot is today so far.");
  const spark = find(vega, (n) => n.tag === "svg" && n.attrs.class === "spark")[0];
  assert.equal(spark.attrs["aria-label"], "Vega, fresh tokens a day: No earlier days to compare with");
  assert.deepEqual(find(spark, (n) => n.tag === "circle").map((c) => [c.attrs.class, c.attrs.cx, c.attrs.cy]), [["end", "125", "5"], ["now", "145", "7.2"]], "1 November's 25M at the top, today's 23M so far apart");
  fire("click", ids.span30);
  assert.deepEqual([ids.span7.attrs["aria-pressed"], ids.span30.attrs["aria-pressed"], vega.kids.at(-1).kids[0].textContent], ["false", "true", "Trend, 30 days"]);

  const [, head, body, foot] = ids.usage.kids;
  assert.equal(head.textContent, "DayVegaRigelCodexAll seats");
  assert.deepEqual(body.kids.map((r) => [r.className, r.kids[0].textContent]), [["today", "Mon 2 Novso far"], ["we", "Sun 1 Nov"]]);
  assert.deepEqual(body.kids[1].kids.map((td) => [td.className, td.textContent]), [["", "Sun 1 Nov"], ["h t8", "25M"], ["h t1", "1.3M"], ["none", "–"], ["h tot", "26M$2,625"]]);
  assert.deepEqual(find(body.kids[1].kids[4], (n) => n.tag === "rect")[0].attrs, { width: "100", height: "4" });
  assert.equal(foot.textContent, "November48M$4,8001.3M$125420$049M148M cache reads$4,925");
  assert.ok(cells.filter((td) => td.className.startsWith("h")).every((td) => td.tabIndex === 0 && td.attrs["aria-label"]));

  const [today, sunday] = ids.daylist.kids.map((li) => li.kids[0]);
  assert.deepEqual([today.open, sunday.open], [true, false], "the newest day is open");
  assert.equal(sunday.kids[1].textContent, "Vega25M$2,50075M cache reads · 25 requestsRigel1.3M$1253.8M cache reads · 25 requestsCodex–no data, not zero");
});

test("with limits: Needs a look links each line to its seat, the meters say the level, the strip names both", async () => {
  const limits = {
    vega: { five_hour: { utilization: 0.84, resets_at: "2026-11-02T17:30:00Z", observed_at: "2026-11-02T15:55:00Z" }, seven_day: { utilization: 0.2, resets_at: "2026-11-05T13:00:00Z", observed_at: "2026-11-02T15:55:00Z" }, event: null },
    rigel: null,
  };
  const { ids, find } = await runPage(month({ limits }));
  assert.equal(ids.need.dataset.sev, "over");
  assert.deepEqual(ids.needs.kids.map((li) => [li.dataset.k, li.kids[1].tag, li.kids[1].href, li.kids[1].textContent]), [
    ["over", "a", "#seat-vega", "Vega's 5-hour is at 84%, resets 13:30"],
    ["gap", "a", "#seat-rigel", "Rigel is not reporting"],
  ]);
  const [, vega, rigel, codex] = ids.rows.kids;
  assert.deepEqual([vega.dataset.alert, rigel.dataset.alert, codex.dataset.alert], ["over", "gap", undefined]);
  const meters = find(vega, (n) => n.className.startsWith("meter"));
  assert.deepEqual(meters.map((m) => [m.className, m.dataset.kind, m.dataset.level, m.textContent]), [
    ["meter m5", "fresh", "over", "5-hour84%over 80%alert 80%resets 13:30read 11:55"],
    ["meter mw", "fresh", "ok", "Weekly20%under 70%alert 70%resets Thu 09:00read 11:55"],
  ]);
  assert.deepEqual(find(rigel, (n) => n.className.startsWith("meter")).map((m) => [m.dataset.kind, m.textContent]), [["none", "5-hournot reportedalert 80%no reading from this seat"], ["none", "Weeklynot reportedalert 70%no reading from this seat"]]);
  assert.equal(find(meters[0], (n) => n.attrs.class === "m-fill")[0].attrs.width, "84");
  assert.deepEqual(find(meters[0], (n) => /^m-(tick|tl)/.test(n.className)).map((n) => n.className), ["m-tick at80", "m-tl at80"]);
  assert.equal(ids.usage.kids[1].textContent, "DayVega5h 84%wk 20%Rigelnot reportingCodexno Claude limitsAll seats");
});

test("a number's box: hover, focus or tap shows its exact values; Esc or a tap elsewhere closes it", async () => {
  const { ids, fire, cells } = await runPage(month());
  const vega = cells.find((td) => td.dataset.who === "Vega" && td.dataset.when === "Sun 1 Nov"), box = ids.tip;
  assert.equal(box.hidden, true);
  fire("focusin", vega.kids[0]);
  assert.equal(box.hidden, false);
  assert.equal(box.textContent, "Vega · Sun 1 NovFresh tokens25,000,000Cache reads75,000,000At API pricesabout $2,500");
  assert.deepEqual(box.style, { left: "147px", top: "102px" }, "centred above the number, inside a 375 px screen");
  fire("scroll", ids.scroll); // the browser scrolls a focused number into view: its box stays
  assert.equal(box.hidden, false);
  fire("keydown", ids.usage, { key: "Escape" });
  assert.equal(box.hidden, true);
  fire("scroll", ids.scroll); // and stays closed after Esc, though the number keeps focus
  assert.equal(box.hidden, true);
  fire("click", vega); // a tap pins it: moving the mouse off doesn't close it
  fire("mouseout", vega, { relatedTarget: ids.hint });
  assert.deepEqual([box.hidden, vega.className], [false, "h t8 on"]);
  fire("click", ids.hint);
  assert.deepEqual([box.hidden, vega.className], [true, "h t8"]);
  fire("mouseover", cells.find((td) => td.dataset.who === "All seats" && td.dataset.when === "November"));
  assert.equal(box.kids[0].textContent, "All seats · November");
  fire("scroll", ids.scroll); // a hovered box drops when the page moves under it
  assert.equal(box.hidden, true);
});

test("a past month: no meters and no today, Needs a look says limits are read live, and a late store says so", async () => {
  const { ids, find } = await runPage(month({ limits: { vega: null } }), Date.UTC(2026, 11, 2, 16));
  assert.equal(ids.rows.className, "rows past");
  assert.deepEqual([ids.need.dataset.sev, ids.needs.textContent], ["wait", "Limits are read live, so they show on the current month only."]);
  const [cols, vega, rigel, codex] = ids.rows.kids;
  assert.equal(cols.textContent, "SeatMonthTrend, 7 days");
  assert.equal(find(ids.rows, (n) => n.className.startsWith("meter")).length, 0);
  assert.equal(vega.textContent, "VegaMonth48M144M cache reads · about $4,800Trend, 7 daysNo earlier days to compare with");
  assert.deepEqual([rigel.id, codex.id], ["seat-rigel", "seat-codex"], "no limits: no seat added from them");
  assert.match(ids.usage.kids[1].textContent, /^DayVegaRigelCodexAll seats$/, "no strip");
  assert.equal(ids.asof.textContent, "Newest hour ends 2 Nov, 12:00 AST, 720 hours ago");
  assert.match(ids.fresh.className, /late/);
});

test("a refused, failed or empty month shows a plain message, not a blank page", async () => {
  for (const [answer, words] of [
    [() => new Response("Forbidden", { status: 403 }), /can't read usage/],
    [() => new Response("Usage is not configured", { status: 503 }), /isn't set up/],
    [() => Promise.reject(new TypeError("Failed to fetch")), /no answer/],
    [() => new Response(null, { status: 500 }), /HTTP 500/],
    [(m) => (m === "2026-11" ? month()(m) : new Response(null, { status: 500 })), /HTTP 500/],
  ]) {
    const { ids } = await runPage(answer);
    assert.match(ids.status.textContent, words);
    assert.deepEqual([ids.status.hidden, ids.need.hidden, ids.sum.hidden, ids.seats.hidden, ids.days.hidden, ids.asof.textContent], [false, true, true, true, true, "Not loaded"]);
  }
  const { ids } = await runPage((m) => Response.json({ month: m, days: {}, totals: {} }));
  assert.equal(ids.status.textContent, "Nothing is stored for November 2026 yet.");
  assert.deepEqual([ids.asof.textContent, ids.need.hidden, ids.sum.hidden, ids.seats.hidden, ids.days.hidden], ["Nothing stored yet", false, true, true, true]);
});

test("the page follows the CSP and the site's rules: no inline style or script, no markup from data, its own fonts", () => {
  assert.doesNotMatch(html, /<style\b|\sstyle\s*=|\son[a-z]+\s*=/i);
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) assert.deepEqual([/\bsrc="\/usage\/page\.js"/.test(m[0]), m[1]], [true, ""]);
  assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]), ["/usage/usage.css"]);
  for (const f of ["page.js", "table.js", "limits.js"]) {
    const js = readFileSync(new URL(`../public/usage/${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage|setAttribute\(\s*["']style|\.style\s*=|var\(--/, f);
  }
  const css = readFileSync(new URL("../public/usage/usage.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /@import/);
  // every face is a file under /usage/fonts/ with its licence beside it; every stack is one of them, then a generic family
  const urls = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.equal(urls.length, 5);
  for (const u of urls) {
    assert.match(u, /^\/usage\/fonts\/[\w-]+\.woff2$/);
    assert.equal(readFileSync(new URL(`../public${u}`, import.meta.url)).subarray(0, 4).toString(), "wOF2", u);
  }
  for (const l of ["OFL-Manrope.txt", "OFL-IBM-Plex-Mono.txt"]) assert.ok(existsSync(new URL(`../public/usage/fonts/${l}`, import.meta.url)), l);
  for (const [, f] of css.matchAll(/font-family:\s*([^;]+);/g)) assert.match(f, /^("(Manrope|IBM Plex Mono)"|var\(--(sans|mono)\))$/);
  assert.deepEqual([...css.matchAll(/--(sans|mono):\s*([^;]+);/g)].map((m) => m[2]), ['"Manrope", sans-serif', '"IBM Plex Mono", monospace']);
  // nothing under 12 px: rem sizes (the root is never under 16 px) and no px sizes but the root's floor
  for (const [, n] of css.matchAll(/font(?:-size)?:[^;]*?(\d*\.?\d+)rem/g)) assert.ok(Number(n) >= 0.75, `${n}rem is under 12 px`);
  assert.match(css, /html \{ font-size: clamp\(16px,/);
  assert.equal([...css.matchAll(/font(?:-size)?:[^;]*\d+px/g)].length, 1);
  for (const n of css.matchAll(/td\.t(\d),/g)) assert.ok(Number(n[1]) >= 1 && Number(n[1]) <= 8);
  assert.equal(css.match(/td\.t\d,/g).length, 8, "one class per shading step");
});

// ---- contrast (WCAG): every text colour on every ground, light and dark, and the numbers on the shading
test("every text colour meets WCAG AA on every ground in both themes", () => {
  const css = readFileSync(new URL("../public/usage/usage.css", import.meta.url), "utf8");
  const hexes = (text) => Object.fromEntries([...text.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
  const dark = css.indexOf("@media (prefers-color-scheme: dark)");
  const light = hexes(css.slice(0, dark));
  const themes = [["light", light], ["dark", { ...light, ...hexes(css.slice(dark, css.indexOf("\n}\n", dark))) }]];
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const [name, vars] of themes) {
    const check = (fg, bg, min) => {
      const [hi, lo] = [luminance(vars[fg]), luminance(vars[bg])].sort((x, y) => y - x);
      assert.ok((hi + 0.05) / (lo + 0.05) >= min, `${name}: --${fg} on --${bg} is under ${min}:1`);
    };
    for (const bg of ["bg", "panel", "raise"]) for (const fg of ["ink", "ink-2", "ink-3", "signal", "ok", "warn", "focus"]) check(fg, bg, 4.5);
    for (let i = 1; i <= 8; i++) check("ink", `h${i}`, 4.5);
    check("bg", "ink", 4.5); // the box, and the pressed trend button
    // a seat's colour beside its name, the bar's fill and the dashed edges: at least 3:1 (WCAG 1.4.11)
    for (const s of ["vega", "rigel", "lyra", "orion", "polaris", "codex"]) check(`c-${s}`, "panel", 3);
    for (const fg of ["fill", "warn", "signal"]) check(fg, "raise", 3);
    check("rule-2", "panel", 3);
  }
  // the text colours usage.css draws with are the ones above; the sparkline's currentColor is a seat's, a graphic
  for (const [, sel, body] of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const [, c] of body.matchAll(/(?:^|[\s;])color:\s*var\(--([\w-]+)\)/g)) if (!/^\.spark\b/.test(sel.trim())) assert.ok(["ink", "ink-2", "ink-3", "signal", "ok", "warn", "focus", "bg"].includes(c), `${sel.trim()}: --${c} is a text colour the test doesn't check`);
  }
});
