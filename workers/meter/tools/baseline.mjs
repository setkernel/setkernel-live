#!/usr/bin/env node
// The baseline: what the account already uses, measured the way the hourly run measures it, with
// nothing written anywhere. Also the schema check before a deploy: every dataset, field and filter
// key is looked up by introspection first, and anything the API doesn't have, or a query it
// rejects, is a "Can't read" line. Any "Can't read" line fails the run (exit 1). A dataset the API
// keeps answering "try again later" (after retries) is an "Unknown" line instead: that metric shows
// as "?" and the run still exits 0, because waiting fixes it and no name was wrong.
//
//   CF_ACCOUNT_ID=... CF_ANALYTICS_TOKEN=... BILLING_DAY=13 node tools/baseline.mjs [--scripts]
//
// It also prints Workers CPU-ms and Durable Object requests by script (hq#243): the top
// TOP_SCRIPTS of each, or every script with --scripts.
//
// The token needs Account Analytics: Read and nothing else. Pass it from Infisical in the
// environment; it is never printed. Run it by hand (README.md, "The baseline").

import { pathToFileURL } from "node:url";
import allowances from "../allowances.json" with { type: "json" };
import { readUsage } from "../src/usage.js";
import { evaluate, message } from "../src/meter.js";
import { billingDay } from "../src/windows.js";
import { checkSchema, introspector } from "./schema.mjs";

export const CANT_READ = "Can't read";
export const UNKNOWN = "Unknown";
export const TOP_SCRIPTS = 5;
// The metrics read per script that the baseline lists, in this order.
const BY_SCRIPT = ["workers_cpu_ms", "do_requests"];

export async function baseline(env, { now = new Date(), fetchImpl = fetch, log = console.log, retry, allScripts = false } = {}) {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) {
    log("baseline: set CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN (Account Analytics: Read)");
    return 2;
  }
  const day = billingDay(env.BILLING_DAY);
  const lines = [];
  let failed = false;

  let problems;
  try {
    problems = await checkSchema(introspector(env, fetchImpl));
  } catch (e) {
    problems = [{ where: "the schema", missing: "", has: [], error: e.message }];
  }
  for (const p of problems) {
    failed = true;
    lines.push(p.error
      ? `${CANT_READ} the schema: ${p.error}`
      : `${CANT_READ} ${p.where}.${p.missing}: not in the schema; there: ${p.has.join(" ") || "nothing"}`);
  }

  const usage = await readUsage(env, now, day, fetchImpl, retry);
  const report = evaluate({ allowances, usage, now, day });
  lines.push(message(report, { full: true }).text, "", `billing day ${day}`, "metric | used | allowance | share | projected at reset");
  for (const [id, m] of Object.entries(report.metrics)) {
    const p = m.projected == null ? "" : `${Math.round((m.projected / m.allowance) * 100)}%`;
    lines.push(`${id} | ${m.used ?? "?"} | ${m.allowance} | ${m.share == null ? "?" : (m.share * 100).toFixed(2) + "%"} | ${p}`);
  }
  for (const id of BY_SCRIPT) {
    const by = usage.scripts?.[id];
    if (!by) continue;
    const rows = Object.entries(by).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const shown = allScripts ? rows : rows.slice(0, TOP_SCRIPTS);
    lines.push("", `${id} by script (${shown.length} of ${rows.length}) | ${report.metrics[id].unit}`);
    for (const [name, v] of shown) lines.push(`${name} | ${Math.round(v * 1000) / 1000}`);
  }
  for (const id of report.errors) lines.push(`${CANT_READ} ${id}: ${report.metrics[id].error}`);
  for (const id of report.unknown) lines.push(`${UNKNOWN} ${id}: ${report.metrics[id].unknown}; the API said to try again later, so it is not a schema problem`);
  failed ||= report.errors.length > 0 || Boolean(report.gateways?.error && !report.gateways.transient);

  for (const l of lines) log(l);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { CF_ANALYTICS_TOKEN, CF_ACCOUNT_ID, BILLING_DAY } = process.env;
  process.exit(await baseline({ CF_ANALYTICS_TOKEN, CF_ACCOUNT_ID, BILLING_DAY }, { allScripts: process.argv.includes("--scripts") }));
}
