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
