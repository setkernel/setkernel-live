// sk-meter: Cloudflare's budget alerts arrive a day late and stop nothing, and overage on Workers
// Paid bills automatically. Every hour this reads the account's usage, compares it with the
// plan's included allowances (allowances.json) and sets the guard flags (flags.js) that the
// Workers reading them obey.
//
// Its own cost: 720 cron runs a month, ~11 GraphQL subrequests each (up to ~44 when every dataset
// needs all its retries), two KV reads, one KV write for the report and a write only when a flag
// changes.

import allowances from "../allowances.json" with { type: "json" };
import { evaluate, message, signature, FLAGS } from "./meter.js";
import { KEYS, REPORT_KEY, DRILL_KEY } from "./flags.js";
import { notify } from "./notify.js";
import { readUsage } from "./usage.js";
import { billingDay } from "./windows.js";

export async function run(env, now, { fetchImpl = fetch, table = allowances, retry } = {}) {
  const kv = env.GUARD;
  const day = billingDay(env.BILLING_DAY);
  const [prev, drill] = await Promise.all([kv.get(REPORT_KEY, "json"), kv.get(DRILL_KEY, "json")]);
  const usage = await readUsage(env, now, day, fetchImpl, retry);
  const report = evaluate({ allowances: table, usage, now, day, prev, drill });

  // Flags first: they are what stops spend. Write only on change; on the first run (no previous
  // report) clear any flag left over from before.
  for (const name of FLAGS) {
    const was = prev ? prev.flags?.[name] ?? null : undefined;
    const is = report.flags[name];
    if (is && JSON.stringify(is) !== JSON.stringify(was)) await kv.put(KEYS[name], JSON.stringify(is));
    else if (!is && was !== null) await kv.delete(KEYS[name]);
  }

  // Alert when the state changes, and retry each hour until one is delivered. The first run has
  // nothing to compare with, so it always reports: that is the baseline.
  const sig = signature(report);
  report.notified = prev?.notified ?? null;
  if (sig !== report.notified) {
    try {
      if (await notify(env, message(report, { full: !prev }), fetchImpl)) report.notified = sig;
    } catch (e) {
      report.notifyError = e.message;
      console.error(`sk-meter: alert failed: ${e.message}`);
    }
  }

  await kv.put(REPORT_KEY, JSON.stringify(report));
  const on = FLAGS.filter((f) => report.flags[f]);
  console.log(`sk-meter: flags ${on.join(",") || "none"}; errors ${report.errors.join(",") || "none"}; unknown ${report.unknown.join(",") || "none"}`);
  return report;
}

export default {
  // Awaited, so a run that throws shows as a failed cron event (sk-watch watches for those).
  async scheduled(controller, env) {
    await run(env, new Date(controller.scheduledTime));
  },
};
