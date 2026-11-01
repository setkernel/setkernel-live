// src/usage.js: what /ingest/usage accepts and how it is summed (setkernel-live#66).
import { test } from "node:test";
import assert from "node:assert/strict";
import { COUNTS, SEATS, SURFACES, cleanUsage, hourMs, keepFrom, monthRange, sumByDay } from "../src/usage.js";

const bucket = (extra = {}) => ({ hour: "2026-10-14T15", seat: "vega", model: "claude-opus-5-5", surface: "vm", input: 10, output: 20, cache_read: 30, cache_write: 40, usd_micros: 50, requests: 1, ...extra });
const counts = (n) => Object.fromEntries(COUNTS.map((k) => [k, n]));

test("cleanUsage keeps a good push, field for field, and nothing else", () => {
  assert.deepEqual(cleanUsage({ buckets: [] }), []);
  assert.deepEqual(cleanUsage({ buckets: [{ ...bucket(), note: "dropped", prompt: "secret" }] }), [bucket()]);
  for (const seat of SEATS) assert.ok(cleanUsage({ buckets: [bucket({ seat })] }), seat);
  for (const surface of SURFACES) assert.ok(cleanUsage({ buckets: [bucket({ surface })] }), surface);
  assert.ok(cleanUsage({ buckets: [bucket({ input: 0, usd_micros: Number.MAX_SAFE_INTEGER })] }));
});

test("cleanUsage refuses the whole push for any bad bucket", () => {
  const bad = [
    { seat: "Vega" }, { seat: "raghav" }, { seat: undefined }, { surface: "phone" },
    { hour: "2026-10-14" }, { hour: "2026-10-14T24" }, { hour: "2026-02-30T00" }, { hour: "2026-10-14T03:00" }, { hour: 1 },
    { model: "" }, { model: "a b" }, { model: "x".repeat(101) }, { model: 5 },
    { input: -1 }, { output: 1.5 }, { cache_read: "3" }, { cache_write: null }, { usd_micros: 2 ** 53 }, { requests: undefined },
  ];
  for (const extra of bad) assert.equal(cleanUsage({ buckets: [bucket(), bucket(extra)] }), null, JSON.stringify(extra));
  for (const body of [null, [], "x", {}, { buckets: {} }, { buckets: [null] }, { buckets: ["x"] }]) assert.equal(cleanUsage(body), null, JSON.stringify(body));
});

test("hourMs reads only real UTC hours", () => {
  assert.equal(hourMs("2026-10-14T03"), Date.UTC(2026, 9, 14, 3));
  for (const h of ["2026-13-01T00", "2026-10-14T3", " 2026-10-14T03", "2026-10-14T03Z"]) assert.ok(Number.isNaN(hourMs(h)), h);
});

test("sumByDay puts each hour on its Halifax day, across both clock changes", () => {
  const rows = [
    { hour: "2026-03-08T03", seat: "vega", ...counts(1) }, // 23:00 AST on the 7th, the day the clocks go forward
    { hour: "2026-03-08T04", seat: "vega", ...counts(2) }, // 00:00 AST on the 8th
    { hour: "2026-11-01T03", seat: "lyra", ...counts(4) }, // 00:00 ADT on the 1st, the day they go back
    { hour: "2026-11-02T03", seat: "lyra", ...counts(8) }, // 23:00 AST on the 1st
    { hour: "2026-11-02T04", seat: "orion", ...counts(16) }, // 00:00 AST on the 2nd
  ];
  const { days, totals } = sumByDay(rows);
  assert.deepEqual(days, {
    "2026-03-07": { vega: counts(1) },
    "2026-03-08": { vega: counts(2) },
    "2026-11-01": { lyra: counts(12) },
    "2026-11-02": { orion: counts(16) },
  });
  assert.deepEqual(totals, { vega: counts(3), lyra: counts(12), orion: counts(16) });
  assert.deepEqual(Object.keys(sumByDay(rows, "2026-11").days), ["2026-11-01", "2026-11-02"]);
  assert.deepEqual(sumByDay(rows, "2026-11").totals, { lyra: counts(12), orion: counts(16) });
});

test("monthRange reads a day either side of the month, and only YYYY-MM", () => {
  assert.deepEqual(monthRange("2026-11"), { from: "2026-10-31T00", to: "2026-12-02T00" });
  assert.deepEqual(monthRange("2026-12"), { from: "2026-11-30T00", to: "2027-01-02T00" });
  // the month's first Halifax hour (03:00 or 04:00 UTC) and its last (the next month's 03:00 or 04:00) are inside
  const { from, to } = monthRange("2026-03");
  assert.ok(from <= "2026-03-01T04" && "2026-04-01T02" < to);
  for (const m of [null, "", "2026-13", "2026-00", "2026-1", "2026-10-01", "2026-10 ", "x"]) assert.equal(monthRange(m), null, String(m));
});

test("keepFrom is 400 days back, as an hour", () => {
  assert.equal(keepFrom(Date.UTC(2026, 10, 1, 12, 30)), "2025-09-27T12");
});
