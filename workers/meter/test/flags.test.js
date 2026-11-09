// What the Workers reading the guard see: readGuard and refusal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readGuard, refusal, KEYS, DEGRADED } from "../src/flags.js";
import { memoryKV } from "./fakes.js";

const flag = (until = null) => JSON.stringify({ since: "2026-10-15T10:07:00.000Z", metrics: ["ai_neurons"], until });

test("no flags: carry on", async () => {
  const g = await readGuard(memoryKV());
  assert.deepEqual([g.alert, g.degrade, g.refuse], [false, false, false]);
  assert.equal(refusal(g), null);
});

test("refuse implies degrade and alert, even if only the refuse key is there", async () => {
  const g = await readGuard(memoryKV({ [KEYS.refuse]: flag() }));
  assert.deepEqual([g.alert, g.degrade, g.refuse], [true, true, true]);
});

test("refuse: non-essential requests get a 503 with Retry-After; essential ones carry on", async () => {
  const until = new Date(Date.now() + 3600e3).toISOString();
  const g = await readGuard(memoryKV({ [KEYS.alert]: flag(until), [KEYS.degrade]: flag(until), [KEYS.refuse]: flag(until) }));
  const res = refusal(g);
  assert.equal(res.status, 503);
  const retry = Number(res.headers.get("retry-after"));
  assert.ok(retry > 3500 && retry <= 3600, String(retry));
  assert.equal(refusal(g, { essential: true }), null);
});

test("degrade alone refuses nothing", async () => {
  const g = await readGuard(memoryKV({ [KEYS.alert]: flag(), [KEYS.degrade]: flag() }));
  assert.equal(g.degrade, true);
  assert.equal(refusal(g), null);
});

test("KV unreadable: degrade (start nothing new) but keep serving", async () => {
  const broken = { get: async () => { throw new Error("KV down"); } };
  const g = await readGuard(broken);
  assert.deepEqual([g.alert, g.degrade, g.refuse], [true, true, false]);
  assert.match(g.error, /KV down/);
});

test("readGuard asks KV to cache each flag at the edge", async () => {
  const seen = [];
  await readGuard({ get: async (k, o) => { seen.push([k, o]); return null; } });
  assert.deepEqual(seen.map(([k]) => k), [KEYS.alert, KEYS.degrade, KEYS.refuse]);
  for (const [, o] of seen) assert.deepEqual(o, { type: "json", cacheTtl: 60 });
});

test("the degraded settings are the spec's", () => {
  assert.deepEqual(DEGRADED, { heartbeatSeconds: 60, retentionDays: 7, bundlesPaused: true, newLeases: false, workersAi: false });
  assert.ok(Object.isFrozen(DEGRADED));
});
