import { test } from "node:test";
import assert from "node:assert/strict";
import allowances from "../allowances.json" with { type: "json" };
import { evaluate, levelOf, activeDrill, message, signature } from "../src/meter.js";
import { windowFor, elapsed, billingDay } from "../src/windows.js";
import { SOURCES } from "../src/usage.js";

const NOW = new Date("2026-10-15T12:00:00Z");
const usage = (values, errors = {}) => ({ values, errors, gateways: null });
const flagsOn = (r) => ["alert", "degrade", "refuse"].filter((f) => r.flags[f]);

test("allowances.json pins every metric with a positive allowance, a window and a pricing URL", () => {
  for (const [id, m] of Object.entries(allowances.metrics)) {
    assert.ok(m.allowance > 0, id);
    assert.ok(["month", "day", "gauge"].includes(m.window), id);
    assert.match(m.source, /^https:\/\/developers\.cloudflare\.com\/.+pricing/, id);
  }
  assert.deepEqual(allowances.thresholds, { alert: 0.5, degrade: 0.8, refuse: 0.95 });
  assert.equal(allowances.metrics.ai_neurons.allowance, 10000);
  assert.equal(allowances.metrics.ai_neurons.window, "day");
});

test("every metric is read by exactly one query, over the window allowances.json gives it", () => {
  const seen = {};
  for (const s of SOURCES) for (const m of s.metrics) {
    assert.equal(seen[m], undefined, `${m} read twice`);
    seen[m] = s.window;
  }
  for (const [id, m] of Object.entries(allowances.metrics)) assert.equal(seen[id], m.window, id);
  assert.deepEqual(Object.keys(seen).sort(), Object.keys(allowances.metrics).sort());
});

test("levelOf: the boundaries are inclusive", () => {
  const th = allowances.thresholds;
  assert.equal(levelOf(0.4999, th), "ok");
  assert.equal(levelOf(0.5, th), "alert");
  assert.equal(levelOf(0.7999, th), "alert");
  assert.equal(levelOf(0.8, th), "degrade");
  assert.equal(levelOf(0.9499, th), "degrade");
  assert.equal(levelOf(0.95, th), "refuse");
  assert.equal(levelOf(3, th), "refuse");
  assert.equal(levelOf(null, th), "unknown");
});

// The acceptance test: synthetic usage past each threshold, on every metric, flips the right flags.
for (const [id, m] of Object.entries(allowances.metrics)) {
  test(`${id}: synthetic usage past 50/80/95% flips alert, degrade, refuse`, () => {
    const cases = [[0.49, []], [0.51, ["alert"]], [0.81, ["alert", "degrade"]], [0.96, ["alert", "degrade", "refuse"]]];
    for (const [share, want] of cases) {
      const r = evaluate({ allowances, usage: usage({ [id]: m.allowance * share }), now: NOW });
      assert.deepEqual(flagsOn(r), want, `${id} at ${share}`);
      for (const f of want) assert.deepEqual(r.flags[f].metrics, [id]);
    }
  });
}

test("the worst metric decides; each flag lists the metrics holding it", () => {
  const r = evaluate({
    allowances,
    usage: usage({ queues_ops: 600000, ai_neurons: 9600, kv_writes: 850000 }),
    now: NOW,
  });
  assert.deepEqual(r.flags.alert.metrics, ["queues_ops", "kv_writes", "ai_neurons"]);
  assert.deepEqual(r.flags.degrade.metrics, ["kv_writes", "ai_neurons"]);
  assert.deepEqual(r.flags.refuse.metrics, ["ai_neurons"]);
  // refuse lasts until the neurons reset at 00:00 UTC; degrade until the month resets too
  assert.equal(r.flags.refuse.until, "2026-10-16T00:00:00.000Z");
  assert.equal(r.flags.degrade.until, "2026-11-01T00:00:00.000Z");
});

test("a flag held by storage has no reset time", () => {
  const r = evaluate({ allowances, usage: usage({ r2_storage_bytes: 9e9 }), now: NOW });
  assert.equal(r.flags.degrade.until, null);
});

test("a flag keeps its since time while it stays on", () => {
  const first = evaluate({ allowances, usage: usage({ ai_neurons: 8500 }), now: NOW });
  const later = new Date("2026-10-15T13:00:00Z");
  const second = evaluate({ allowances, usage: usage({ ai_neurons: 8700 }), now: later, prev: first });
  assert.equal(second.flags.degrade.since, NOW.toISOString());
});

test("the window reset clears the flags", () => {
  const before = evaluate({ allowances, usage: usage({ ai_neurons: 9900 }), now: NOW });
  const after = evaluate({ allowances, usage: usage({ ai_neurons: 10 }), now: new Date("2026-10-16T00:07:00Z"), prev: before });
  assert.deepEqual(flagsOn(after), []);
});

test("an unreadable metric keeps its last value in the same window, so a flag can't drop", () => {
  const first = evaluate({ allowances, usage: usage({ queues_ops: 900000 }), now: NOW });
  const failed = evaluate({
    allowances,
    usage: usage({}, { queues_ops: "queueMessageOperationsAdaptiveGroups: HTTP 500" }),
    now: new Date("2026-10-15T13:00:00Z"),
    prev: first,
  });
  assert.deepEqual(flagsOn(failed), ["alert", "degrade"]);
  assert.equal(failed.metrics.queues_ops.stale, true);
  assert.deepEqual(failed.errors, ["queues_ops"]);
});

test("an unreadable metric from a previous window is unknown, not zero", () => {
  const first = evaluate({ allowances, usage: usage({ queues_ops: 900000 }), now: NOW });
  const failed = evaluate({
    allowances,
    usage: usage({}, { queues_ops: "boom" }),
    now: new Date("2026-11-01T01:00:00Z"),
    prev: first,
  });
  assert.equal(failed.metrics.queues_ops.used, null);
  assert.equal(failed.metrics.queues_ops.level, "unknown");
  assert.deepEqual(failed.errors, ["queues_ops"]);
});

test("pro-rating: projected use at the end of the window, once 10% of it has passed", () => {
  // 15 Oct 12:00 is 14.5 days into a 31-day month
  const r = evaluate({ allowances, usage: usage({ queues_ops: 480000 }), now: NOW });
  assert.equal(r.metrics.queues_ops.level, "ok");
  assert.ok(Math.abs(r.metrics.queues_ops.projected - 480000 / (14.5 / 31)) < 1);
  assert.deepEqual(r.overPace, ["queues_ops"]);
  // two hours into the day, Workers AI's window is under 10% gone: no projection yet
  const early = evaluate({ allowances, usage: usage({ ai_neurons: 2000 }), now: new Date("2026-10-15T02:00:00Z") });
  assert.equal(early.metrics.ai_neurons.projected, null);
  assert.deepEqual(early.overPace, []);
});

test("a drill lowers one allowance until it expires and can never raise one", () => {
  const drill = { metric: "ai_neurons", allowance: 100, expiresAt: "2026-10-15T14:00:00Z" };
  const r = evaluate({ allowances, usage: usage({ ai_neurons: 85 }), now: NOW, drill });
  assert.deepEqual(flagsOn(r), ["alert", "degrade"]);
  assert.equal(r.metrics.ai_neurons.allowance, 100);
  assert.equal(r.drill.metric, "ai_neurons");
  assert.match(message(r).text, /^\[DRILL\] /);

  assert.equal(activeDrill({ ...drill, expiresAt: "2026-10-15T11:59:59Z" }, allowances, NOW), null);
  assert.equal(activeDrill({ ...drill, allowance: 1e9 }, allowances, NOW), null);
  assert.equal(activeDrill({ ...drill, allowance: 10000 }, allowances, NOW), null);
  assert.equal(activeDrill({ ...drill, allowance: -1 }, allowances, NOW), null);
  assert.equal(activeDrill({ ...drill, metric: "nope" }, allowances, NOW), null);
  assert.equal(activeDrill("garbage", allowances, NOW), null);
});

test("message: the highest flag leads, degrade and refuse mention Raghav, the baseline lists everything", () => {
  const values = Object.fromEntries(Object.keys(allowances.metrics).map((id) => [id, 0]));
  const quiet = evaluate({ allowances, usage: { ...usage({ ...values, queues_ops: 12000 }), gateways: { all: ["a", "b"], workersAi: [] } }, now: NOW });
  const base = message(quiet, { full: true });
  assert.match(base.text, /every metric is under 50%/);
  assert.match(base.text, /Queues operations: 12,000 of 1,000,000 operations this month \(1%\)/);
  assert.match(base.text, /none send requests to Workers AI/);
  assert.equal(base.mention, false);
  assert.equal(message(quiet).text.split("\n").length, 1);

  const hot = evaluate({ allowances, usage: { ...usage({ ai_neurons: 9700 }), gateways: { all: ["g"], workersAi: ["g"] } }, now: NOW });
  const m = message(hot);
  assert.match(m.text, /^🔴 \*\*sk-meter: REFUSE\*\*/);
  assert.match(m.text, /Workers AI neurons: 9,700 of 10,000 neurons a day \(97%\), resets 2026-10-16 00:00 UTC/);
  assert.match(m.text, /AI Gateways sending requests to Workers AI: g/);
  assert.equal(m.mention, true);
});

test("signature changes with the flags, errors, pace and Workers AI gateways, not with usage inside a level", () => {
  const a = evaluate({ allowances, usage: usage({ kv_writes: 510000 }), now: NOW });
  const b = evaluate({ allowances, usage: usage({ kv_writes: 520000 }), now: NOW, prev: a });
  const c = evaluate({ allowances, usage: usage({ kv_writes: 810000 }), now: NOW, prev: b });
  assert.equal(signature(a), signature(b));
  assert.notEqual(signature(b), signature(c));
  const g = evaluate({ allowances, usage: { ...usage({ kv_writes: 510000 }), gateways: { workersAi: ["x"] } }, now: NOW });
  assert.notEqual(signature(a), signature(g));
});

test("the top script is named for a metric projected at 50%, and stays out of the signature", () => {
  // NOW is 14.5 days into a 31-day month, so 10M CPU ms used projects to ~21M of 30M: 71%.
  const scripts = (top) => ({ workers_cpu_ms: { [top]: 6e6, other: 4e6 }, do_requests: { a: 1 } });
  const hot = (top) => evaluate({ allowances, usage: { ...usage({ workers_cpu_ms: 1e7, do_requests: 1 }), scripts: scripts(top) }, now: NOW });
  const a = hot("alpha");
  assert.deepEqual(a.topScripts, { workers_cpu_ms: { script: "alpha", used: 6e6, share: 0.6 } });
  assert.match(message(a).text, /^Top script for Workers CPU time: `alpha`, 6,000,000 CPU ms \(60% of the account's\)\.$/m);
  assert.equal(signature(a), signature(hot("zeta")));
  assert.equal(hot("zeta").topScripts.workers_cpu_ms.script, "zeta");
  // below 50% projected, or no per-script rows this run: nothing named
  const low = evaluate({ allowances, usage: { ...usage({ workers_cpu_ms: 1e6 }), scripts: scripts("alpha") }, now: NOW });
  assert.deepEqual(low.topScripts, {});
  assert.doesNotMatch(message(low).text, /Top script/);
  assert.deepEqual(evaluate({ allowances, usage: usage({ workers_cpu_ms: 1e7 }), now: NOW }).topScripts, {});
  // a script name can't carry markdown or a mention into the chat message
  const odd = evaluate({ allowances, usage: { ...usage({ workers_cpu_ms: 1e7 }), scripts: { workers_cpu_ms: { "`@here`**x": 5 } } }, now: NOW });
  assert.match(message(odd).text, /Top script for Workers CPU time: `\?\?here\?\?\?x`/);
});

test("windows: billing day, the daily UTC reset, elapsed share", () => {
  assert.deepEqual(windowFor("month", NOW, 1), { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-11-01T00:00:00Z") });
  assert.deepEqual(windowFor("month", NOW, 20), { start: new Date("2026-09-20T00:00:00Z"), end: new Date("2026-10-20T00:00:00Z") });
  assert.deepEqual(windowFor("month", new Date("2026-01-05T00:00:00Z"), 10), { start: new Date("2025-12-10T00:00:00Z"), end: new Date("2026-01-10T00:00:00Z") });
  assert.deepEqual(windowFor("day", NOW), { start: new Date("2026-10-15T00:00:00Z"), end: new Date("2026-10-16T00:00:00Z") });
  assert.equal(elapsed(windowFor("day", NOW), NOW), 0.5);
  assert.throws(() => billingDay(undefined), /not set/);
  assert.throws(() => billingDay(""), /not set/);
  assert.equal(billingDay("13"), 13);
  assert.equal(billingDay("28"), 28);
  assert.throws(() => billingDay("29"));
  assert.throws(() => billingDay("x"));
});
