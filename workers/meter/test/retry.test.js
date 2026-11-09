// A transient GraphQL failure on one dataset: retried, then unknown for this run (flags kept, run
// not failed); a schema error is still an error. Retry waits are recorded, never slept.

import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/index.js";
import { evaluate, message, signature } from "../src/meter.js";
import allowances from "../allowances.json" with { type: "json" };
import { readUsage, queryRows, RETRY_DELAYS_MS, SOURCES } from "../src/usage.js";
import { memoryKV, fakeGraphQL, flaky, noSleep, rowsFor, ENV } from "./fakes.js";
import { KEYS } from "../src/flags.js";

const NOW = new Date("2026-10-15T12:00:00Z");
const TRY_AGAIN = new Error("unable to execute query, please try again later");
const WORKFLOWS = SOURCES.find((s) => s.dataset === "workflowsAdaptiveGroups");
const WINDOW = { start: new Date("2026-10-01T00:00:00Z"), end: NOW };

test("the retry waits are 2 s, 5 s and 10 s", () => {
  assert.deepEqual(RETRY_DELAYS_MS, [2000, 5000, 10000]);
});

test("a dataset that fails twice with 'try again' and then answers is read, after two waits", async () => {
  const { waits, retry } = noSleep();
  const gql = fakeGraphQL({ workflowsAdaptiveGroups: flaky(2, TRY_AGAIN, [{ count: 7 }]) });
  const usage = await readUsage(ENV, NOW, 1, gql, retry);
  assert.equal(usage.values.workflows_steps, 7);
  assert.deepEqual(usage.unknown, {});
  assert.deepEqual(usage.errors, {});
  assert.deepEqual(waits, [2000, 5000]);
  assert.equal(gql.calls.filter((c) => c.dataset === "workflowsAdaptiveGroups").length, 3);
});

test("HTTP 5xx, 429 and a network error are transient too", async () => {
  for (const failure of [502, 429]) {
    const { retry } = noSleep();
    const usage = await readUsage(ENV, NOW, 1, fakeGraphQL({ workflowsAdaptiveGroups: flaky(1, failure, [{ count: 3 }]) }), retry);
    assert.equal(usage.values.workflows_steps, 3, `HTTP ${failure}`);
  }
  const { retry } = noSleep();
  let n = 0;
  const gql = fakeGraphQL({ workflowsAdaptiveGroups: [{ count: 4 }] });
  const dropped = async (url, init) => {
    if (JSON.parse(init.body).query.includes("workflowsAdaptiveGroups") && n++ === 0) throw new TypeError("fetch failed");
    return gql(url, init);
  };
  assert.equal((await readUsage(ENV, NOW, 1, dropped, retry)).values.workflows_steps, 4);
});

test("a dataset that always says 'try again' is unknown after four requests, and nothing else is affected", async () => {
  const { waits, retry } = noSleep();
  const gql = fakeGraphQL({ ...rowsFor("kv_reads", 5), workflowsAdaptiveGroups: TRY_AGAIN });
  const usage = await readUsage(ENV, NOW, 1, gql, retry);
  assert.deepEqual(Object.keys(usage.unknown), ["workflows_steps"]);
  assert.match(usage.unknown.workflows_steps, /try again later/);
  assert.deepEqual(usage.errors, {});
  assert.equal(usage.values.kv_reads, 5);
  assert.deepEqual(waits, [2000, 5000, 10000]);
  assert.equal(gql.calls.filter((c) => c.dataset === "workflowsAdaptiveGroups").length, 4);
});

test("a schema error is not retried and stays an error", async () => {
  const { waits, retry } = noSleep();
  const gql = fakeGraphQL({ workflowsAdaptiveGroups: new Error('unknown field "count"') });
  const usage = await readUsage(ENV, NOW, 1, gql, retry);
  assert.deepEqual(Object.keys(usage.errors), ["workflows_steps"]);
  assert.deepEqual(usage.unknown, {});
  assert.deepEqual(waits, []);
  assert.equal(gql.calls.filter((c) => c.dataset === "workflowsAdaptiveGroups").length, 1);
});

test("a 403 is not retried", async () => {
  const { waits, retry } = noSleep();
  await assert.rejects(queryRows(ENV, WORKFLOWS, WINDOW, async () => new Response("no", { status: 403 }), retry), /HTTP 403/);
  assert.deepEqual(waits, []);
});

test("an empty workflows dataset reads as 0", async () => {
  const usage = await readUsage(ENV, NOW, 1, fakeGraphQL({ workflowsAdaptiveGroups: [] }), noSleep().retry);
  assert.equal(usage.values.workflows_steps, 0);
  assert.deepEqual(usage.errors, {});
  assert.deepEqual(usage.unknown, {});
});

test("cron: an unknown metric keeps its flag and last value, is listed in the report, and a blip sends no new alert", async () => {
  const kv = memoryKV();
  const env = { ...ENV, GUARD: kv };
  const { retry } = noSleep();
  const at = (h) => new Date(Date.UTC(2026, 9, 15, h, 7));
  await run(env, at(1), { fetchImpl: fakeGraphQL({ ...rowsFor("workflows_steps", 300000) }), retry });
  assert.ok(kv.data.has(KEYS.alert));
  const r = await run(env, at(2), { fetchImpl: fakeGraphQL({ workflowsAdaptiveGroups: TRY_AGAIN }), retry });
  assert.ok(kv.data.has(KEYS.alert));
  assert.deepEqual(r.unknown, ["workflows_steps"]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.metrics.workflows_steps.used, 300000);
  assert.equal(r.metrics.workflows_steps.stale, true);
  assert.match(message(r).text, /Unknown this run .*Workflows steps.*flags keep their last known values/s);
  assert.doesNotMatch(message(r).text, /Can't read/);
});

test("signature: an unknown metric with a last known value is quiet, one never read is not", () => {
  const usage = { values: {}, errors: {}, unknown: { workflows_steps: "try again" }, gateways: null };
  const fresh = evaluate({ allowances, usage, now: NOW });
  assert.deepEqual(JSON.parse(signature(fresh)).unknown, ["workflows_steps"]);
  const prev = evaluate({ allowances, usage: { values: { workflows_steps: 10 }, errors: {}, gateways: null }, now: NOW });
  const known = evaluate({ allowances, usage, now: NOW, prev });
  assert.deepEqual(JSON.parse(signature(known)).unknown, []);
});
