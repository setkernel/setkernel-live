#!/usr/bin/env node
// The offline drill (`node workers/meter/tools/drill.mjs`): the live drill in README.md, step for step, against an
// in-memory KV and a fake analytics API. Nothing leaves this machine. Exit 1 if any step doesn't
// see what the live drill must see.

import { run } from "../src/index.js";
import { KEYS, DRILL_KEY, readGuard } from "../src/flags.js";
import { memoryKV, fakeGraphQL, rowsFor } from "../test/fakes.js";

const at = (h) => new Date(Date.UTC(2026, 9, 15, h, 7));
const kv = memoryKV();
const webhook = [];
const env = { CF_ANALYTICS_TOKEN: "drill", CF_ACCOUNT_ID: "drill", BILLING_DAY: "13", ALERT_WEBHOOK_URL: "https://alerts.example.test/meter", GUARD: kv };
// 1,200 queue operations used this cycle: 0.12% of the 1,000,000 allowance
const fetchImpl = fakeGraphQL(rowsFor("queues_ops", 1200), { webhook });

let failed = 0;
const step = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

let r = await run(env, at(9), { fetchImpl });
step(!(await readGuard(kv)).degrade, `1. baseline run: queues_ops at ${r.metrics.queues_ops.used}, guard:degrade absent`);

const allowance = Math.round(r.metrics.queues_ops.used / 0.85);
kv.data.set(DRILL_KEY, JSON.stringify({ metric: "queues_ops", allowance, expiresAt: at(12).toISOString() }));
step(true, `2. put ${DRILL_KEY}: queues_ops allowance ${allowance} (used ÷ 0.85) until ${at(12).toISOString()}`);

r = await run(env, at(10), { fetchImpl });
const g = await readGuard(kv);
step(g.degrade && !g.refuse && kv.data.has(KEYS.degrade), `3. next run: guard:degrade present (${Math.round(r.metrics.queues_ops.share * 100)}%), guard:refuse absent`);
step(webhook.at(-1)?.body.text.startsWith("[DRILL]") && webhook.at(-1)?.body.mention === true, "4. the alert says [DRILL] and mentions Raghav");

kv.data.delete(DRILL_KEY);
r = await run(env, at(11), { fetchImpl });
step(!kv.data.has(KEYS.degrade) && !kv.data.has(KEYS.alert) && r.drill === null, `5. delete ${DRILL_KEY}, next run: every flag cleared`);

console.log(failed ? `drill: ${failed} step(s) failed` : "drill: passed");
process.exit(failed ? 1 : 0);
