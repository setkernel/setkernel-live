// The baseline and its schema check, against a fake GraphQL endpoint that also answers
// introspection with a schema built from the names src/usage.js asks for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SOURCES, GATEWAYS } from "../src/usage.js";
import { selectionPaths, filterKeys, checkSchema, introspector } from "../tools/schema.mjs";
import { baseline } from "../tools/baseline.mjs";
import { fakeGraphQL, rowsFor, noSleep, ENV } from "./fakes.js";

const NOW = new Date("2026-10-15T12:00:00Z");
const TRY_AGAIN = new Error("unable to execute query, please try again later");
const ref = (name) => ({ kind: "OBJECT", name, ofType: null });
const list = (name) => ({ kind: "LIST", name: null, ofType: { kind: "NON_NULL", name: null, ofType: ref(name) } });

// Every name usage.js uses, minus `drop` (["dataset", "path.to.field"] or ["dataset"]).
function fakeSchema(drop = []) {
  const types = { Query: { fields: [{ name: "viewer", type: ref("viewer") }] }, viewer: { fields: [{ name: "accounts", type: list("account") }] }, account: { fields: [] } };
  const add = (type, name, t) => { types[type] ??= { fields: [] }; if (!types[type].fields.some((f) => f.name === name)) types[type].fields.push({ name, type: t }); };
  for (const s of [...SOURCES, GATEWAYS]) {
    if (drop.some(([d, p]) => d === s.dataset && !p)) continue;
    const row = `${s.dataset}Row`;
    types.account.fields.push({ name: s.dataset, type: list(row), args: [{ name: "filter", type: ref(`${s.dataset}Filter`) }] });
    types[`${s.dataset}Filter`] = { inputFields: filterKeys(s).map((name) => ({ name, type: ref("Time") })) };
    types[row] ??= { fields: [] };
    for (const path of selectionPaths(s.fields)) {
      const dropped = drop.some(([d, p]) => d === s.dataset && p === path.join("."));
      let type = row;
      for (const [i, step] of path.entries()) {
        const last = i === path.length - 1;
        const next = last ? "Leaf" : `${type}_${step}`;
        if (last && dropped) types[type] ??= { fields: [] };
        else add(type, step, ref(next));
        type = next;
      }
    }
  }
  return types;
}

function withSchema(types, rows = {}) {
  const graphql = fakeGraphQL(rows);
  return async (url, init) => {
    const { query, variables } = JSON.parse(init.body);
    if (query.includes("__schema")) return Response.json({ data: { __schema: { queryType: { name: "Query" } } } });
    if (query.includes("__type")) return Response.json({ data: { __type: types[variables.name] ? { name: variables.name, ...types[variables.name] } : null } });
    return graphql(url, init);
  };
}

test("selectionPaths: nested selections become field paths", () => {
  assert.deepEqual(selectionPaths("max { payloadSize metadataSize } dimensions { bucketName }"),
    [["max", "payloadSize"], ["max", "metadataSize"], ["dimensions", "bucketName"]]);
  assert.deepEqual(selectionPaths("count dimensions { gateway provider }"), [["count"], ["dimensions", "gateway"], ["dimensions", "provider"]]);
  assert.deepEqual(filterKeys(SOURCES.find((s) => s.filter)), ["datetime_geq", "datetime_leq", "eventType"]);
});

test("schema check: every name present, no problems", async () => {
  assert.deepEqual(await checkSchema(introspector(ENV, withSchema(fakeSchema())), [...SOURCES, GATEWAYS]), []);
});

test("schema check names a missing field, a missing dataset and a missing filter key, with what is there", async () => {
  const types = fakeSchema([["workersInvocationsAdaptive", "sum.cpuTimeUs"], ["aiInferenceAdaptiveGroups"]]);
  types.workflowsAdaptiveGroupsFilter.inputFields = types.workflowsAdaptiveGroupsFilter.inputFields.filter((f) => f.name !== "eventType");
  const problems = await checkSchema(introspector(ENV, withSchema(types)));
  assert.deepEqual(problems.map((p) => `${p.where}.${p.missing}`).sort(), [
    "aiInferenceAdaptiveGroups.aiInferenceAdaptiveGroups",
    "workersInvocationsAdaptive.sum.cpuTimeUs",
    "workflowsAdaptiveGroups(filter).eventType",
  ]);
  assert.deepEqual(problems.find((p) => p.missing === "cpuTimeUs").has, ["requests"]);
});

test("baseline: exit 0 and every metric listed when everything reads", async () => {
  const out = [];
  const code = await baseline({ ...ENV, BILLING_DAY: "13" }, { now: NOW, fetchImpl: withSchema(fakeSchema(), rowsFor("kv_reads", 42)), log: (l) => out.push(l) });
  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(text, /billing day 13/);
  assert.match(text, /^kv_reads \| 42 \| 10000000 \|/m);
  assert.doesNotMatch(text, /Can't read/);
});

test("baseline: CPU-ms and DO requests by script, the top five unless --scripts asks for all", async () => {
  const rows = {
    workersInvocationsAdaptive: Array.from({ length: 7 }, (_, i) => ({ sum: { requests: 1, cpuTimeUs: (i + 1) * 1000 }, dimensions: { scriptName: `w${i + 1}` } })),
    durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 40 }, dimensions: { scriptName: "setkernel-ops" } }, { sum: { requests: 2 }, dimensions: { scriptName: "sk-status" } }],
  };
  const run = async (opts) => {
    const out = [];
    const code = await baseline({ ...ENV, CF_ANALYTICS_TOKEN: "s3cret-token-value" }, { now: NOW, fetchImpl: withSchema(fakeSchema(), rows), log: (l) => out.push(l), ...opts });
    return { code, text: out.join("\n") };
  };
  const top = await run();
  assert.equal(top.code, 0);
  assert.match(top.text, /^workers_cpu_ms by script \(5 of 7\) \| CPU ms\nw7 \| 7\nw6 \| 6\nw5 \| 5\nw4 \| 4\nw3 \| 3$/m);
  assert.doesNotMatch(top.text, /^w2 \|/m);
  assert.match(top.text, /^do_requests by script \(2 of 2\) \| requests\nsetkernel-ops \| 40\nsk-status \| 2$/m);
  assert.doesNotMatch(top.text, /s3cret/);
  const all = await run({ allScripts: true });
  assert.match(all.text, /^workers_cpu_ms by script \(7 of 7\)/m);
  assert.match(all.text, /^w1 \| 1$/m);
});

test("baseline: any Can't read line fails it, and the token is never printed", async () => {
  const out = [];
  const env = { ...ENV, CF_ANALYTICS_TOKEN: "s3cret-token-value" };
  const types = fakeSchema([["durableObjectsPeriodicGroups", "sum.activeTime"]]);
  const code = await baseline(env, { now: NOW, fetchImpl: withSchema(types, { durableObjectsPeriodicGroups: new Error("unknown field activeTime") }), log: (l) => out.push(l) });
  assert.equal(code, 1);
  const text = out.join("\n");
  assert.match(text, /^Can't read durableObjectsPeriodicGroups\.sum\.activeTime: not in the schema/m);
  assert.match(text, /^Can't read do_duration_gbs: durableObjectsPeriodicGroups: unknown field/m);
  assert.doesNotMatch(text, /s3cret/);
});

test("baseline: an introspection failure is a Can't read line, not a pass", async () => {
  const out = [];
  const refused = async () => new Response("no", { status: 403 });
  assert.equal(await baseline(ENV, { now: NOW, fetchImpl: refused, log: (l) => out.push(l) }), 1);
  assert.match(out.join("\n"), /^Can't read the schema: introspection: HTTP 403/m);
});

test("baseline: no token or account, exit 2 before any request", async () => {
  let called = false;
  const code = await baseline({ BILLING_DAY: "13" }, { fetchImpl: async () => { called = true; }, log: () => {} });
  assert.equal(code, 2);
  assert.equal(called, false);
});

test("baseline: one transient dataset exits 0, the metric is '?', and the line says so", async () => {
  const out = [];
  const { retry } = noSleep();
  const code = await baseline(ENV, {
    now: NOW, retry, log: (l) => out.push(l),
    fetchImpl: withSchema(fakeSchema(), ({ ...rowsFor("kv_reads", 42), workflowsAdaptiveGroups: TRY_AGAIN })),
  });
  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(text, /^Unknown workflows_steps: .*try again later/m);
  assert.match(text, /^workflows_steps \| \? \|/m);
  assert.match(text, /^kv_reads \| 42 \|/m);
  assert.doesNotMatch(text, /Can't read/);
});

test("baseline: a schema error alongside a transient one still exits 1", async () => {
  const out = [];
  const code = await baseline(ENV, {
    now: NOW, retry: noSleep().retry, log: (l) => out.push(l),
    fetchImpl: withSchema(fakeSchema(), ({ workflowsAdaptiveGroups: TRY_AGAIN, d1AnalyticsAdaptiveGroups: new Error("unknown field rowsRead") })),
  });
  assert.equal(code, 1);
  const text = out.join("\n");
  assert.match(text, /^Can't read d1_rows_read: /m);
  assert.match(text, /^Unknown workflows_steps: /m);
});

test("baseline: a transient AI Gateway read exits 0 and is not called a 'Can't read'", async () => {
  const out = [];
  const code = await baseline(ENV, {
    now: NOW, retry: noSleep().retry, log: (l) => out.push(l),
    fetchImpl: withSchema(fakeSchema(), ({ aiGatewayRequestsAdaptiveGroups: new Error("unable to execute query, please try again later") })),
  });
  assert.equal(code, 0);
  assert.doesNotMatch(out.join("\n"), /Can't read/);
  assert.match(out.join("\n"), /AI Gateway traffic is unknown this run/);
});
