// Account usage from Cloudflare's GraphQL Analytics API. One query per dataset, so a field the API
// rejects costs that dataset's metrics only (they are reported as errors and keep their last
// value), never the whole run. A server-side "try again" (HTTP 5xx or 429, a network error, or a
// GraphQL "try again later") is retried, then reported as unknown for this run; only a rejection
// that retrying can't fix (a missing field, a 403) is an error. Each query covers the metric's whole window, so a missed hour is
// caught up on the next run and nothing drifts.
//
// The two datasets behind the metrics hq#243 can't place (Workers CPU, Durable Object requests) are
// also grouped by script, in the same query, so the totals don't change: no `datetime` dimension, so
// a query returns one row per script. `perScript` maps a metric to what one row contributes to it.
//
// Dataset and field names come from the product docs' analytics pages (2026-10-15). Names marked
// "unconfirmed" were not on those pages; `node tools/baseline.mjs` checks every name here
// against the live schema before the first deploy.

import { windowFor } from "./windows.js";

export const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

// R2 operation classes, from https://developers.cloudflare.com/r2/pricing/. Anything not Class B
// counts as Class A, the smaller allowance, so an action we don't know about errs high.
export const R2_CLASS_B = new Set([
  "HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption",
  "GetBucketLocation", "GetBucketCors", "GetBucketLifecycleConfiguration",
]);

const total = (rows, pick) => rows.reduce((n, r) => n + (Number(pick(r)) || 0), 0);

export const SOURCES = [
  {
    // unconfirmed: sum.cpuTimeUs (the tutorial shows only quantiles of CPU time) and
    // dimensions.scriptName on this dataset
    dataset: "workersInvocationsAdaptive", window: "month",
    fields: "sum { requests cpuTimeUs } dimensions { scriptName }",
    metrics: ["workers_requests", "workers_cpu_ms"],
    perScript: {
      workers_requests: (r) => r.sum?.requests,
      workers_cpu_ms: (r) => (Number(r.sum?.cpuTimeUs) || 0) / 1000,
    },
    read: (rows) => ({
      workers_requests: total(rows, (r) => r.sum?.requests),
      workers_cpu_ms: total(rows, (r) => r.sum?.cpuTimeUs) / 1000,
    }),
  },
  {
    // unconfirmed: dimensions.scriptName on this dataset
    dataset: "durableObjectsInvocationsAdaptiveGroups", window: "month",
    fields: "sum { requests } dimensions { scriptName }",
    metrics: ["do_requests"],
    perScript: { do_requests: (r) => r.sum?.requests },
    read: (rows) => ({ do_requests: total(rows, (r) => r.sum?.requests) }),
  },
  {
    // unconfirmed: sum.activeTime in microseconds. Duration bills 128 MB per active object, so
    // GB-s = seconds active x 0.125.
    dataset: "durableObjectsPeriodicGroups", window: "month",
    fields: "sum { activeTime }",
    metrics: ["do_duration_gbs"],
    read: (rows) => ({ do_duration_gbs: (total(rows, (r) => r.sum?.activeTime) / 1e6) * 0.125 }),
  },
  {
    // A billed step is a step run; retries (ATTEMPT_*) and rollbacks don't count.
    dataset: "workflowsAdaptiveGroups", window: "month",
    filter: 'eventType: "STEP_START"',
    fields: "count",
    metrics: ["workflows_steps"],
    read: (rows) => ({ workflows_steps: total(rows, (r) => r.count) }),
  },
  {
    dataset: "queueMessageOperationsAdaptiveGroups", window: "month",
    fields: "sum { billableOperations }",
    metrics: ["queues_ops"],
    read: (rows) => ({ queues_ops: total(rows, (r) => r.sum?.billableOperations) }),
  },
  {
    dataset: "d1AnalyticsAdaptiveGroups", window: "month",
    fields: "sum { rowsRead rowsWritten }",
    metrics: ["d1_rows_read", "d1_rows_written"],
    read: (rows) => ({
      d1_rows_read: total(rows, (r) => r.sum?.rowsRead),
      d1_rows_written: total(rows, (r) => r.sum?.rowsWritten),
    }),
  },
  {
    dataset: "r2OperationsAdaptiveGroups", window: "month",
    fields: "sum { requests } dimensions { actionType }",
    metrics: ["r2_class_a", "r2_class_b"],
    read: (rows) => ({
      r2_class_a: total(rows.filter((r) => !R2_CLASS_B.has(r.dimensions?.actionType)), (r) => r.sum?.requests),
      r2_class_b: total(rows.filter((r) => R2_CLASS_B.has(r.dimensions?.actionType)), (r) => r.sum?.requests),
    }),
  },
  {
    // The largest size each bucket reached in the last day, summed over buckets.
    dataset: "r2StorageAdaptiveGroups", window: "gauge",
    fields: "max { payloadSize metadataSize } dimensions { bucketName }",
    metrics: ["r2_storage_bytes"],
    read: (rows) => ({
      r2_storage_bytes: total(rows, (r) => (Number(r.max?.payloadSize) || 0) + (Number(r.max?.metadataSize) || 0)),
    }),
  },
  {
    // actionType is read, write, delete or list; anything else counts as a write (smallest allowance).
    dataset: "kvOperationsAdaptiveGroups", window: "month",
    fields: "sum { requests } dimensions { actionType }",
    metrics: ["kv_reads", "kv_writes", "kv_deletes", "kv_lists"],
    read: (rows) => {
      const out = { kv_reads: 0, kv_writes: 0, kv_deletes: 0, kv_lists: 0 };
      const key = { read: "kv_reads", delete: "kv_deletes", list: "kv_lists" };
      for (const r of rows) out[key[r.dimensions?.actionType] ?? "kv_writes"] += Number(r.sum?.requests) || 0;
      return out;
    },
  },
  {
    // unconfirmed: dataset aiInferenceAdaptiveGroups and sum.totalNeurons
    dataset: "aiInferenceAdaptiveGroups", window: "day",
    fields: "sum { totalNeurons }",
    metrics: ["ai_neurons"],
    read: (rows) => ({ ai_neurons: total(rows, (r) => r.sum?.totalNeurons) }),
  },
];

// Not a metric: which AI Gateways send requests to Workers AI. Any that do spend neurons, which
// the rule allows only inside the free 10,000 a day.
export const GATEWAYS = {
  dataset: "aiGatewayRequestsAdaptiveGroups", window: "month",
  fields: "count dimensions { gateway provider }",
  read: (rows) => {
    const all = new Set();
    const workersAi = new Set();
    for (const r of rows) {
      const g = r.dimensions?.gateway;
      if (!g) continue;
      all.add(g);
      if (String(r.dimensions?.provider).toLowerCase() === "workers-ai") workersAi.add(g);
    }
    return { all: [...all].sort(), workersAi: [...workersAi].sort() };
  },
};

// Rows of a source's per-script metrics: { metric: { script: amount } }. A row with no script name
// (the API's null) is kept under NO_SCRIPT so the per-script amounts still add up to the total.
export const NO_SCRIPT = "(no script name)";
export function scriptsOf(source, rows) {
  const out = {};
  for (const [metric, pick] of Object.entries(source.perScript ?? {})) {
    const by = {};
    for (const r of rows) {
      const name = r.dimensions?.scriptName || NO_SCRIPT;
      by[name] = (by[name] ?? 0) + (Number(pick(r)) || 0);
    }
    out[metric] = by;
  }
  return out;
}

export function buildQuery(source) {
  const extra = source.filter ? `, ${source.filter}` : "";
  return `query Usage($account: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    rows: ${source.dataset}(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end${extra} }) { ${source.fields} }
  } }
}`;
}

// A failure that asking again may fix. Everything else thrown here is a real error.
export class TransientError extends Error {}

// Waits after the 1st, 2nd and 3rd failure: up to four requests for one dataset, then it is unknown.
export const RETRY_DELAYS_MS = [2000, 5000, 10000];
const TRY_AGAIN = /try again/i;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function queryOnce(env, source, window, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
      body: JSON.stringify({
        query: buildQuery(source),
        variables: { account: env.CF_ACCOUNT_ID, start: window.start.toISOString(), end: window.end.toISOString() },
      }),
    });
  } catch (e) {
    throw new TransientError(`${source.dataset}: ${String(e.message).slice(0, 200)}`);
  }
  if (!res.ok) {
    const Kind = res.status >= 500 || res.status === 429 ? TransientError : Error;
    throw new Kind(`${source.dataset}: HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body.errors?.length) {
    const message = String(body.errors[0].message).slice(0, 200);
    throw new (TRY_AGAIN.test(message) ? TransientError : Error)(`${source.dataset}: ${message}`);
  }
  const rows = body.data?.viewer?.accounts?.[0]?.rows;
  if (!Array.isArray(rows)) throw new Error(`${source.dataset}: no data in the response`);
  if (rows.length >= 10000) throw new Error(`${source.dataset}: 10,000 rows, the total would be cut short`);
  return rows;
}

// Rows of one dataset over one window. Throws with a message that never contains the token: a
// TransientError once the retries are used up, a plain Error at once for anything retrying can't fix.
export async function queryRows(env, source, window, fetchImpl, { delays = RETRY_DELAYS_MS, sleep = wait } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await queryOnce(env, source, window, fetchImpl);
    } catch (e) {
      if (!(e instanceof TransientError) || attempt >= delays.length) throw e;
      await sleep(delays[attempt]);
    }
  }
}

// { values: { metric: number }, errors: { metric: message }, unknown: { metric: message },
//   gateways: { all, workersAi } | null, scripts: { metric: { script: number } } }. `scripts` has
//   the metrics of a source with `perScript` that was read this run. `unknown` is a dataset still failing with a "try again"
// after the retries; `errors` is one that can't be fixed by waiting.
export async function readUsage(env, now, day, fetchImpl = fetch, retry = {}) {
  const values = {};
  const errors = {};
  const unknown = {};
  const scripts = {};
  // Each window up to now; the API has no data from the future.
  const until = (kind) => ({ start: windowFor(kind, now, day).start, end: now });
  await Promise.all(SOURCES.map(async (s) => {
    try {
      const rows = await queryRows(env, s, until(s.window), fetchImpl, retry);
      Object.assign(values, s.read(rows));
      Object.assign(scripts, scriptsOf(s, rows));
    } catch (e) {
      for (const m of s.metrics) (e instanceof TransientError ? unknown : errors)[m] = e.message;
    }
  }));
  let gateways;
  try {
    gateways = GATEWAYS.read(await queryRows(env, GATEWAYS, until(GATEWAYS.window), fetchImpl, retry));
  } catch (e) {
    gateways = { error: e.message, ...(e instanceof TransientError && { transient: true }) };
  }
  return { values, errors, unknown, gateways, scripts };
}
