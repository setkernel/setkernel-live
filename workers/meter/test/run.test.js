// The hourly run end to end: fake GraphQL in, KV flags and the Buzz webhook out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/index.js";
import worker from "../src/index.js";
import { KEYS, REPORT_KEY, DRILL_KEY, readGuard } from "../src/flags.js";
import { SOURCES, GATEWAYS, buildQuery, readUsage, NO_SCRIPT, R2_CLASS_B } from "../src/usage.js";
import { memoryKV, fakeGraphQL, rowsFor, ENV } from "./fakes.js";

const HOUR = (h) => new Date(Date.UTC(2026, 9, 15, h, 7));
const WEBHOOK = { ALERT_WEBHOOK_URL: "https://alerts.example.test/meter", ALERT_WEBHOOK_TOKEN: "hook-token" };

test("one query per dataset, the account and token on each, nothing else sent", async () => {
  const kv = memoryKV();
  const gql = fakeGraphQL();
  await run({ ...ENV, GUARD: kv }, HOUR(12), { fetchImpl: gql });
  assert.equal(gql.calls.length, SOURCES.length + 1);
  for (const c of gql.calls) {
    assert.equal(c.auth, "Bearer test-token");
    assert.equal(c.body.variables.account, "acct");
    assert.equal(c.body.variables.end, HOUR(12).toISOString());
  }
  const by = Object.fromEntries(gql.calls.map((c) => [c.dataset, c.body.variables.start]));
  assert.equal(by.queueMessageOperationsAdaptiveGroups, "2026-10-01T00:00:00.000Z");
  assert.equal(by.aiInferenceAdaptiveGroups, "2026-10-15T00:00:00.000Z");
  assert.equal(by.r2StorageAdaptiveGroups, "2026-10-14T12:07:00.000Z");
  assert.match(buildQuery(SOURCES.find((s) => s.metrics.includes("workflows_steps"))), /eventType: "STEP_START"/);
  assert.match(buildQuery(GATEWAYS), /aiGatewayRequestsAdaptiveGroups/);
});

test("rows are summed and classified: R2 Class A/B, KV by action, DO duration in GB-s", async () => {
  const kv = memoryKV();
  const gql = fakeGraphQL({
    r2OperationsAdaptiveGroups: [
      { sum: { requests: 10 }, dimensions: { actionType: "PutObject" } },
      { sum: { requests: 5 }, dimensions: { actionType: "SomethingNew" } },
      { sum: { requests: 7 }, dimensions: { actionType: "GetObject" } },
      { sum: { requests: 1 }, dimensions: { actionType: "HeadObject" } },
    ],
    kvOperationsAdaptiveGroups: [
      { sum: { requests: 100 }, dimensions: { actionType: "read" } },
      { sum: { requests: 3 }, dimensions: { actionType: "write" } },
      { sum: { requests: 2 }, dimensions: { actionType: "mystery" } },
      { sum: { requests: 4 }, dimensions: { actionType: "list" } },
      { sum: { requests: 1 }, dimensions: { actionType: "delete" } },
    ],
    durableObjectsPeriodicGroups: [{ sum: { activeTime: 8e6 } }, { sum: { activeTime: 8e6 } }],
    r2StorageAdaptiveGroups: [
      { max: { payloadSize: 1000, metadataSize: 10 }, dimensions: { bucketName: "a" } },
      { max: { payloadSize: 500, metadataSize: 0 }, dimensions: { bucketName: "b" } },
    ],
    workersInvocationsAdaptive: [{ sum: { requests: 40, cpuTimeUs: 2500 } }],
  });
  const r = await run({ ...ENV, GUARD: kv }, HOUR(12), { fetchImpl: gql });
  const used = (id) => r.metrics[id].used;
  assert.equal(used("r2_class_a"), 15); // unknown actions count as Class A
  assert.equal(used("r2_class_b"), 8);
  assert.equal(used("kv_reads"), 100);
  assert.equal(used("kv_writes"), 5); // unknown actions count as writes
  assert.equal(used("kv_lists"), 4);
  assert.equal(used("kv_deletes"), 1);
  assert.equal(used("do_duration_gbs"), 2); // 16 s x 0.125 GB
  assert.equal(used("r2_storage_bytes"), 1510);
  assert.equal(used("workers_requests"), 40);
  assert.equal(used("workers_cpu_ms"), 2.5);
  assert.ok(R2_CLASS_B.has("GetObject") && !R2_CLASS_B.has("PutObject"));
});

test("synthetic usage past each threshold sets exactly the right KV flags, and they clear", async () => {
  const kv = memoryKV();
  const env = { ...ENV, GUARD: kv };
  const steps = [
    [4000, []],
    [5100, ["alert"]],
    [8100, ["alert", "degrade"]],
    [9600, ["alert", "degrade", "refuse"]],
  ];
  let h = 1;
  for (const [neurons, want] of steps) {
    await run(env, HOUR(h++), { fetchImpl: fakeGraphQL(rowsFor("ai_neurons", neurons)) });
    const keys = Object.entries(KEYS).filter(([, k]) => kv.data.has(k)).map(([f]) => f);
    assert.deepEqual(keys, want, `${neurons} neurons`);
    const g = await readGuard(kv);
    assert.deepEqual([g.alert, g.degrade, g.refuse], ["alert", "degrade", "refuse"].map((f) => want.includes(f)));
  }
  const refuse = JSON.parse(kv.data.get(KEYS.refuse));
  assert.deepEqual(refuse.metrics, ["ai_neurons"]);
  assert.equal(refuse.until, "2026-10-16T00:00:00.000Z");
  // the next UTC day: the window has reset
  await run(env, new Date("2026-10-16T00:07:00Z"), { fetchImpl: fakeGraphQL(rowsFor("ai_neurons", 20)) });
  assert.deepEqual(Object.values(KEYS).filter((k) => kv.data.has(k)), []);
});

test("KV writes: one report a run, flags only when they change", async () => {
  const kv = memoryKV();
  const env = { ...ENV, GUARD: kv };
  await run(env, HOUR(1), { fetchImpl: fakeGraphQL(rowsFor("queues_ops", 850000)) });
  const afterFirst = kv.puts;
  assert.equal(afterFirst, 3); // report, alert, degrade
  for (let h = 2; h <= 6; h++) await run(env, HOUR(h), { fetchImpl: fakeGraphQL(rowsFor("queues_ops", 850000 + h)) });
  assert.equal(kv.puts - afterFirst, 5); // the report only
  // first run with no report clears leftover flags; later quiet runs delete nothing
  assert.equal(kv.deletes, 1); // refuse, which was never set
});

test("first run with leftover flags and no report clears them", async () => {
  const kv = memoryKV({ [KEYS.refuse]: JSON.stringify({ since: "x", metrics: ["ai_neurons"], until: null }) });
  await run({ ...ENV, GUARD: kv }, HOUR(1), { fetchImpl: fakeGraphQL() });
  assert.equal(kv.data.has(KEYS.refuse), false);
});

test("a failing query keeps the flag it was holding and reports the error", async () => {
  const kv = memoryKV();
  const env = { ...ENV, GUARD: kv };
  await run(env, HOUR(1), { fetchImpl: fakeGraphQL(rowsFor("d1_rows_written", 41e6)) });
  assert.ok(kv.data.has(KEYS.degrade));
  const r = await run(env, HOUR(2), {
    fetchImpl: fakeGraphQL({ d1AnalyticsAdaptiveGroups: new Error("unknown field rowsWritten") }),
  });
  assert.ok(kv.data.has(KEYS.degrade));
  assert.deepEqual(r.errors, ["d1_rows_read", "d1_rows_written"]);
  assert.equal(r.metrics.d1_rows_written.stale, true);
  assert.match(r.metrics.d1_rows_written.error, /unknown field rowsWritten/);
});

test("per-script rows come from the same two queries: summed into the totals, kept per script", async () => {
  const gql = fakeGraphQL({
    workersInvocationsAdaptive: [
      { sum: { requests: 10, cpuTimeUs: 3000 }, dimensions: { scriptName: "setkernel-ops" } },
      { sum: { requests: 5, cpuTimeUs: 1000 }, dimensions: { scriptName: "sk-meter" } },
      { sum: { requests: 1, cpuTimeUs: 500 }, dimensions: { scriptName: null } },
    ],
    durableObjectsInvocationsAdaptiveGroups: [
      { sum: { requests: 7 }, dimensions: { scriptName: "setkernel-ops" } },
      { sum: { requests: 2 }, dimensions: { scriptName: "sk-status" } },
    ],
  });
  const u = await readUsage(ENV, HOUR(12), 1, gql);
  assert.equal(u.values.workers_cpu_ms, 4.5);
  assert.equal(u.values.do_requests, 9);
  assert.deepEqual(u.scripts.workers_cpu_ms, { "setkernel-ops": 3, "sk-meter": 1, [NO_SCRIPT]: 0.5 });
  assert.deepEqual(u.scripts.do_requests, { "setkernel-ops": 7, "sk-status": 2 });
  assert.equal(u.scripts.workers_requests["sk-meter"], 5);
  for (const c of gql.calls.filter((c) => /workersInvocations|durableObjectsInvocations/.test(c.dataset))) {
    assert.match(c.body.query, /dimensions \{ scriptName \}/);
  }
  assert.equal(gql.calls.length, SOURCES.length + 1);
});

test("a failing per-script dataset leaves its metrics out of scripts, and nothing else", async () => {
  const gql = fakeGraphQL({ durableObjectsInvocationsAdaptiveGroups: new Error("unknown field scriptName") });
  const u = await readUsage(ENV, HOUR(12), 1, gql);
  assert.match(u.errors.do_requests, /unknown field scriptName/);
  assert.equal(u.scripts.do_requests, undefined);
  assert.ok(u.scripts.workers_cpu_ms);
});

test("the token never appears in the report or an error", async () => {
  const kv = memoryKV();
  const failing = async () => new Response("denied", { status: 403 });
  await run({ ...ENV, CF_ANALYTICS_TOKEN: "s3cret-token-value", GUARD: kv }, HOUR(1), { fetchImpl: failing });
  const stored = [...kv.data.values()].join("\n");
  assert.doesNotMatch(stored, /s3cret-token-value/);
  assert.match(stored, /HTTP 403/);
});

test("the token never appears in the report when per-script rows are read", async () => {
  const kv = memoryKV();
  const gql = fakeGraphQL({ workersInvocationsAdaptive: [{ sum: { requests: 1, cpuTimeUs: 2e13 }, dimensions: { scriptName: "setkernel-ops" } }] });
  await run({ ...ENV, CF_ANALYTICS_TOKEN: "s3cret-token-value", GUARD: kv }, HOUR(12), { fetchImpl: gql });
  const stored = [...kv.data.values()].join("\n");
  assert.match(stored, /"topScripts":\{"workers_cpu_ms":\{"script":"setkernel-ops"/);
  assert.doesNotMatch(stored, /s3cret-token-value/);
});

test("alerts: the baseline on the first run, then only on change, retried until delivered", async () => {
  const kv = memoryKV();
  const hook = [];
  const env = { ...ENV, ...WEBHOOK, GUARD: kv };
  const gw = { aiGatewayRequestsAdaptiveGroups: [{ count: 3, dimensions: { gateway: "brief", provider: "workers-ai" } }, { count: 9, dimensions: { gateway: "chat", provider: "openai" } }] };
  await run(env, HOUR(1), { fetchImpl: fakeGraphQL({ ...gw, ...rowsFor("queues_ops", 1000) }, { webhook: hook }) });
  assert.equal(hook.length, 1);
  assert.equal(hook[0].url, WEBHOOK.ALERT_WEBHOOK_URL);
  assert.equal(hook[0].init.headers.authorization, "Bearer hook-token");
  assert.match(hook[0].body.text, /Queues operations: 1,000 of 1,000,000/);
  assert.match(hook[0].body.text, /AI Gateways sending requests to Workers AI: brief/);

  await run(env, HOUR(2), { fetchImpl: fakeGraphQL({ ...gw, ...rowsFor("queues_ops", 2000) }, { webhook: hook }) });
  assert.equal(hook.length, 1, "nothing changed, nothing sent");

  hook.status = 502;
  const failed = await run(env, HOUR(3), { fetchImpl: fakeGraphQL({ ...gw, ...rowsFor("queues_ops", 810000) }, { webhook: hook }) });
  assert.equal(hook.length, 2);
  assert.match(failed.notifyError, /HTTP 502/);
  assert.ok(kv.data.has(KEYS.degrade), "the flag is set even when the alert fails");

  hook.status = 200;
  await run(env, HOUR(4), { fetchImpl: fakeGraphQL({ ...gw, ...rowsFor("queues_ops", 820000) }, { webhook: hook }) });
  assert.equal(hook.length, 3, "retried");
  assert.match(hook[2].body.text, /DEGRADE/);
  assert.equal(hook[2].body.mention, true);

  await run(env, HOUR(5), { fetchImpl: fakeGraphQL({ ...gw, ...rowsFor("queues_ops", 830000) }, { webhook: hook }) });
  assert.equal(hook.length, 3, "delivered once");
});

test("no webhook configured: the flags still act and the alert is logged", async () => {
  const kv = memoryKV();
  const r = await run({ ...ENV, GUARD: kv }, HOUR(1), { fetchImpl: fakeGraphQL(rowsFor("ai_neurons", 9000)) });
  assert.ok(kv.data.has(KEYS.degrade));
  assert.equal(r.notified, null);
});

test("an http:// webhook is refused so the token isn't sent in the clear", async () => {
  const kv = memoryKV();
  const hook = [];
  const r = await run({ ...ENV, ALERT_WEBHOOK_URL: "http://alerts.example.test/", ALERT_WEBHOOK_TOKEN: "t", GUARD: kv }, HOUR(1), {
    fetchImpl: fakeGraphQL({}, { webhook: hook }),
  });
  assert.equal(hook.length, 0);
  assert.match(r.notifyError, /must be https/);
});

test("the drill: a lowered allowance drives one metric past 80% and degrade is observed, then it expires", async () => {
  const kv = memoryKV();
  const env = { ...ENV, GUARD: kv };
  // 500 real neurons used today: 5% of the 10,000 allowance
  const usage = rowsFor("ai_neurons", 500);
  await run(env, HOUR(9), { fetchImpl: fakeGraphQL(usage) });
  assert.equal((await readGuard(kv)).degrade, false);

  kv.data.set(DRILL_KEY, JSON.stringify({ metric: "ai_neurons", allowance: 600, expiresAt: "2026-10-15T12:00:00Z" }));
  const r = await run(env, HOUR(10), { fetchImpl: fakeGraphQL(usage) });
  assert.equal(r.metrics.ai_neurons.level, "degrade"); // 500 of 600 = 83%
  const g = await readGuard(kv);
  assert.equal(g.degrade, true);
  assert.equal(g.refuse, false);

  await run(env, HOUR(12), { fetchImpl: fakeGraphQL(usage) });
  assert.equal((await readGuard(kv)).degrade, false, "the drill expired at 12:00");
});

test("the scheduled handler runs at the cron's time and stores the report", async () => {
  const kv = memoryKV();
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeGraphQL(rowsFor("kv_lists", 10));
  try {
    await worker.scheduled({ scheduledTime: HOUR(3).getTime(), cron: "7 * * * *" }, { ...ENV, GUARD: kv });
  } finally {
    globalThis.fetch = realFetch;
  }
  const report = JSON.parse(kv.data.get(REPORT_KEY));
  assert.equal(report.at, HOUR(3).toISOString());
  assert.equal(report.metrics.kv_lists.used, 10);
});

test("no BILLING_DAY (the sync isn't set up yet): the run fails before touching KV or the API", async () => {
  const kv = memoryKV();
  const f = fakeGraphQL();
  const { BILLING_DAY, ...env } = ENV;
  assert.equal(BILLING_DAY, "1");
  await assert.rejects(run({ ...env, GUARD: kv }, HOUR(1), { fetchImpl: f }), /BILLING_DAY is not set/);
  assert.equal(f.calls.length, 0);
  assert.equal(kv.puts, 0);
});
