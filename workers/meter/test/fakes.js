// Test doubles: a KV namespace in memory that counts writes, and a GraphQL endpoint that answers
// each dataset with the rows a test sets.

import { ENDPOINT } from "../src/usage.js";

export function memoryKV(initial = {}) {
  const data = new Map(Object.entries(initial));
  const kv = {
    data,
    puts: 0,
    deletes: 0,
    async get(key, opts) {
      const v = data.get(key);
      if (v == null) return null;
      const type = typeof opts === "string" ? opts : opts?.type;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) { kv.puts++; data.set(key, value); },
    async delete(key) { kv.deletes++; data.delete(key); },
  };
  return kv;
}

// A dataset that fails its first `times` requests with `failure` (an Error, answered as a GraphQL
// error, or an HTTP status number) and then answers with `rows`. Pass it as a fakeGraphQL value.
export const flaky = (times, failure, rows = []) => (attempt) => (attempt <= times ? failure : rows);

// No waiting between retries in tests; records what it was asked to wait.
export const noSleep = () => { const waits = []; const sleep = async (ms) => { waits.push(ms); }; return { waits, retry: { sleep } }; };

// rows: { datasetName: [row, ...] | Error | (attempt) => ... }. Unlisted datasets answer with no rows.
export function fakeGraphQL(rows = {}, { webhook = [] } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    if (url !== ENDPOINT) {
      webhook.push({ url, init, body: JSON.parse(init.body) });
      return new Response("ok", { status: webhook.status ?? 200 });
    }
    const body = JSON.parse(init.body);
    const dataset = body.query.match(/rows: (\w+)\(/)[1];
    calls.push({ dataset, body, auth: init.headers.authorization });
    let r = rows[dataset] ?? [];
    if (typeof r === "function") r = r(calls.filter((c) => c.dataset === dataset).length);
    if (typeof r === "number") return new Response("down", { status: r });
    if (r instanceof Error) return Response.json({ data: null, errors: [{ message: r.message }] });
    return Response.json({ data: { viewer: { accounts: [{ rows: r }] } }, errors: null });
  };
  impl.calls = calls;
  return impl;
}

// Rows that put one metric at `used`, in the shape its dataset returns.
export function rowsFor(metric, used) {
  const table = {
    workers_requests: ["workersInvocationsAdaptive", { sum: { requests: used, cpuTimeUs: 0 }, dimensions: { scriptName: "w" } }],
    workers_cpu_ms: ["workersInvocationsAdaptive", { sum: { requests: 0, cpuTimeUs: used * 1000 }, dimensions: { scriptName: "w" } }],
    do_requests: ["durableObjectsInvocationsAdaptiveGroups", { sum: { requests: used }, dimensions: { scriptName: "w" } }],
    do_duration_gbs: ["durableObjectsPeriodicGroups", { sum: { activeTime: (used / 0.125) * 1e6 } }],
    workflows_steps: ["workflowsAdaptiveGroups", { count: used }],
    queues_ops: ["queueMessageOperationsAdaptiveGroups", { sum: { billableOperations: used } }],
    d1_rows_read: ["d1AnalyticsAdaptiveGroups", { sum: { rowsRead: used, rowsWritten: 0 } }],
    d1_rows_written: ["d1AnalyticsAdaptiveGroups", { sum: { rowsRead: 0, rowsWritten: used } }],
    r2_storage_bytes: ["r2StorageAdaptiveGroups", { max: { payloadSize: used, metadataSize: 0 }, dimensions: { bucketName: "b" } }],
    r2_class_a: ["r2OperationsAdaptiveGroups", { sum: { requests: used }, dimensions: { actionType: "PutObject" } }],
    r2_class_b: ["r2OperationsAdaptiveGroups", { sum: { requests: used }, dimensions: { actionType: "GetObject" } }],
    kv_reads: ["kvOperationsAdaptiveGroups", { sum: { requests: used }, dimensions: { actionType: "read" } }],
    kv_writes: ["kvOperationsAdaptiveGroups", { sum: { requests: used }, dimensions: { actionType: "write" } }],
    kv_deletes: ["kvOperationsAdaptiveGroups", { sum: { requests: used }, dimensions: { actionType: "delete" } }],
    kv_lists: ["kvOperationsAdaptiveGroups", { sum: { requests: used }, dimensions: { actionType: "list" } }],
    ai_neurons: ["aiInferenceAdaptiveGroups", { sum: { totalNeurons: used } }],
  };
  const [dataset, row] = table[metric];
  return { [dataset]: [row] };
}

export const ENV = { CF_ANALYTICS_TOKEN: "test-token", CF_ACCOUNT_ID: "acct", BILLING_DAY: "1" };
