// src/usage.js: what /ingest/usage accepts and how /usage/data sums it (setkernel-live#66).
import { test } from "node:test";
import assert from "node:assert/strict";
import { COUNTS, SEATS, SURFACES, cleanUsage, hourMs, keepFrom, monthRange, sumByDay } from "../src/usage.js";
import { LIMIT_SEATS, cleanLimits, isoTime, limitSeats, usageSeats } from "../src/usage.js";
import { render } from "../scripts/copy-hq-registry.mjs";
import registry from "../src/hq-registry.json" with { type: "json" };

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

// A scratch registry/people.csv, in hq's columns, with made-up logins and ids.
const people = (...rows) => ["handle,kind,github_login,github_id,status,persona,lane", "boss,owner,boss-login,1,active,no,", ...rows].join("\n") + "\n";
const employee = (handle, status = "active", n = 2) => `${handle},employee,${handle}-login,${n},${status},yes,`;

test("the seats are the registry copy's employees, then polaris, codex and other; anyone else is refused", () => {
  assert.deepEqual(Object.keys(registry), ["employees"], "handles only: this repo is public");
  assert.ok(registry.employees.length > 0 && registry.employees.every((h) => /^[a-z][a-z0-9-]{0,31}$/.test(h)), JSON.stringify(registry));
  assert.deepEqual(SEATS, [...registry.employees, "polaris", "codex", "other"]);
  assert.deepEqual(LIMIT_SEATS, [...registry.employees, "polaris"]);
  const stranger = registry.employees.join("-").slice(0, 31) + "x"; // a handle the copy doesn't hold, whoever it holds
  assert.equal(cleanUsage({ buckets: [bucket({ seat: stranger })] }), null, stranger);
  assert.equal(cleanLimits({ [stranger]: {} }), null, stranger);
});

test("a fifth employee row in a scratch registry copy is a seat with no code change; owner and removed rows are not", () => {
  const csv = people(employee("vega"), employee("rigel"), employee("lyra"), employee("orion"), employee("vela"), employee("nova", "removed"), employee("pax", "paused"));
  const { employees } = JSON.parse(render(csv));
  assert.deepEqual(employees, ["vega", "rigel", "lyra", "orion", "vela", "pax"]);
  assert.ok(!render(csv).includes("login"), "no logins or ids in the copy");
  assert.deepEqual(cleanUsage({ buckets: [bucket({ seat: "vela" })] }, usageSeats(employees)), [bucket({ seat: "vela" })]);
  assert.deepEqual(cleanLimits({ vela: {} }, limitSeats(employees)), { vela: { five_hour: null, seven_day: null, event: null } });
  for (const s of ["nova", "boss", "Vela"]) {
    assert.equal(cleanUsage({ buckets: [bucket({ seat: s })] }, usageSeats(employees)), null, s);
    assert.equal(cleanLimits({ [s]: {} }, limitSeats(employees)), null, s);
  }
  assert.equal(cleanLimits({ codex: {} }, limitSeats(employees)), null);
  // A row that isn't a plain handle is left out, and the same handle twice counts once.
  assert.deepEqual(JSON.parse(render(people(employee("vega"), employee("Bad Name"), employee("vega")))).employees, ["vega"]);
  for (const bad of ["", 'handle,kind,status\n"vega",employee,active\n', "handle,kind,status\nvega,employee\n", "handle,kind\nvega,employee\n"]) {
    assert.throws(() => render(bad), JSON.stringify(bad));
  }
});

const win = (extra = {}) => ({ utilization: 0.84, resets_at: "2026-11-04T16:10:00.000Z", observed_at: "2026-11-04T14:55:00.000Z", ...extra });
const ev = (extra = {}) => ({ status: "rejected", rate_limit_type: "five_hour", resets_at: "2026-11-04T16:10:00.000Z", received_at: "2026-11-04T14:47:00.000Z", ...extra });
const seat = (extra = {}) => ({ five_hour: win(), seven_day: win({ utilization: 0.52 }), event: ev(), ...extra });

test("cleanLimits keeps the seats' windows and event, field for field, and drops everything else", () => {
  assert.deepEqual(cleanLimits({}), {});
  assert.deepEqual(cleanLimits({ rigel: seat() }), { rigel: seat() });
  const extra = { rigel: { ...seat({ five_hour: { ...win(), name: "five_hour", login: "rigel-setkernel" }, event: { ...ev(), prompt: "secret", utilization: 1 } }), id: 7, seven_day_opus: win() } };
  assert.deepEqual(cleanLimits(extra), { rigel: seat() });
  // a part null or absent is null; a reset time may be unknown
  assert.deepEqual(cleanLimits({ lyra: {} }), { lyra: { five_hour: null, seven_day: null, event: null } });
  assert.deepEqual(cleanLimits({ lyra: seat({ seven_day: null, event: ev({ resets_at: null }) }) }).lyra, { five_hour: win(), seven_day: null, event: ev({ resets_at: null }) });
  assert.deepEqual(cleanLimits({ lyra: { five_hour: { utilization: 0, observed_at: "2026-11-04T14:55:00.000Z" } } }).lyra.five_hour, { utilization: 0, resets_at: null, observed_at: "2026-11-04T14:55:00.000Z" });
  // times come back as toISOString gives them, whatever zone and precision they were sent in
  assert.deepEqual(cleanLimits({ vega: { five_hour: win({ resets_at: "2026-11-04T13:10:00-03:00", observed_at: "2026-11-04T14:55:00.123456+00:00" }) } }).vega.five_hour, win({ observed_at: "2026-11-04T14:55:00.123Z" }));
  for (const s of LIMIT_SEATS) assert.ok(cleanLimits({ [s]: seat() }), s);
  for (const status of ["allowed", "allowed_warning"]) assert.ok(cleanLimits({ vega: seat({ event: ev({ status, rate_limit_type: "seven_day" }) }) }), status);
  assert.ok(cleanLimits({ vega: seat({ five_hour: win({ utilization: 1.2 }) }) }), "over 100% is a reading too");
});

test("cleanLimits refuses the whole push for any bad seat, window or event", () => {
  const bad = [
    { codex: seat() }, { other: seat() }, { raghav: seat() }, { Vega: seat() }, { vega: null }, { vega: [] }, { vega: "x" },
    { vega: seat({ five_hour: win({ utilization: -0.01 }) }) }, { vega: seat({ five_hour: win({ utilization: "0.5" }) }) },
    { vega: seat({ seven_day: win({ utilization: Infinity }) }) }, { vega: seat({ seven_day: win({ utilization: NaN }) }) },
    { vega: seat({ five_hour: win({ utilization: undefined }) }) }, { vega: seat({ five_hour: [] }) }, { vega: seat({ five_hour: 0.5 }) },
    { vega: seat({ five_hour: win({ observed_at: null }) }) }, { vega: seat({ five_hour: win({ observed_at: "2026-11-04" }) }) },
    { vega: seat({ five_hour: win({ resets_at: "soon" }) }) }, { vega: seat({ five_hour: win({ resets_at: 1793793600000 }) }) },
    { vega: seat({ event: ev({ status: "blocked" }) }) }, { vega: seat({ event: ev({ rate_limit_type: "seven_day_opus" }) }) },
    { vega: seat({ event: ev({ rate_limit_type: null }) }) }, { vega: seat({ event: ev({ received_at: undefined }) }) },
    { vega: seat({ event: ev({ resets_at: "2026-02-30T00:00:00Z" }) }) }, { vega: seat({ event: "rejected" }) },
  ];
  for (const body of bad) assert.equal(cleanLimits({ rigel: seat(), ...body }), null, JSON.stringify(body));
  for (const body of [null, [], "x", 5, [seat()]]) assert.equal(cleanLimits(body), null, JSON.stringify(body));
});

test("isoTime reads only real times with a zone", () => {
  assert.equal(isoTime("2026-11-04T12:00Z"), "2026-11-04T12:00:00.000Z");
  assert.equal(isoTime("2026-11-01T01:30:00-03:00"), "2026-11-01T04:30:00.000Z");
  assert.equal(isoTime("2028-02-29T00:00:00Z"), "2028-02-29T00:00:00.000Z");
  for (const t of ["2026-02-29T00:00:00Z", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-11-04T24:00:00Z", "2026-11-04T12:60:00Z",
    "2026-11-04T12:00:00", "2026-11-04", "2026-11-04 12:00:00Z", "2026-11-04T12:00:00+24:00", ` 2026-11-04T12:00:00Z`, `2026-11-04T12:00:00.${"1".repeat(30)}Z`, 1793793600000, null]) {
    assert.equal(isoTime(t), null, String(t));
  }
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
