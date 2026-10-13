// What the Worker accepts from sk-obs01, and the public state it builds. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { applyBatch, cleanBatch, cleanEvent, emptyState } from "../src/logic.js";

test("only allowlisted events and fields survive", () => {
  assert.deepEqual(cleanEvent({ t: "msg", kind: "claude", agent: "Vega", ts: 5, host: "vega-dev", text: "x" }), { t: "msg", kind: "claude", agent: "Vega", ts: 5 });
  assert.deepEqual(cleanEvent({ t: "msg", kind: "github", agent: "Rigel", action: "opened_pr", repo: "lafka-plugin", ref: "lafka-plugin#9" }),
    { t: "msg", kind: "github", agent: "Rigel", action: "opened_pr", repo: "lafka-plugin" });
  assert.deepEqual(cleanEvent({ t: "agent", agent: "Lyra", state: "REVIEW", work: "review", task: "REVIEW keelpost#31" }), { t: "agent", agent: "Lyra", state: "REVIEW", work: "review" });
  for (const bad of [
    { t: "msg", kind: "claude", agent: "raghav-dev" },
    { t: "msg", kind: "telemetry", agent: "Vega" },
    { t: "msg", kind: "github", agent: "Vega", action: "asked_review" },
    { t: "agent", agent: "Vega", state: "HACKED" },
    { t: "metrics", agent: "Vega" },
    null, "x", 42,
  ]) assert.equal(cleanEvent(bad), null, JSON.stringify(bad));
});

test("repo names must look like repo names", () => {
  const e = (repo) => cleanEvent({ t: "msg", kind: "github", agent: "Vega", action: "pushed", repo });
  assert.equal(e("lafka-plugin").repo, "lafka-plugin");
  for (const bad of ["<script>", "a/b", "x".repeat(101), "", 7]) assert.equal(e(bad).repo, undefined, String(bad));
});

test("a batch keeps the four agents only and caps the event count", () => {
  const b = cleanBatch({ events: Array.from({ length: 600 }, () => ({ t: "msg", kind: "claude", agent: "Orion" })), agents: { Vega: { state: "WORKING", work: "issue" }, Mallory: { state: "IDLE" } } });
  assert.equal(b.events.length, 500);
  assert.deepEqual(b.agents, { Vega: { state: "WORKING", work: "issue" } });
  assert.equal(cleanBatch({}), null);
  assert.equal(cleanBatch(null), null);
});

test("counts and feed, reset each day", () => {
  const batch = cleanBatch({ events: [
    { t: "msg", kind: "github", agent: "Vega", action: "picked_up", ts: 100 },
    { t: "msg", kind: "claude", agent: "Vega", ts: 101 },
    { t: "msg", kind: "github", agent: "Vega", action: "opened_pr", repo: "lafka-plugin", ts: 102 },
    { t: "msg", kind: "github", agent: "Rigel", action: "approved", ts: 103 },
    { t: "msg", kind: "chat", agent: "Rigel", ts: 104 },
  ], agents: {} });
  let s = applyBatch(emptyState("2026-10-13"), batch, 1_000_000, "2026-10-13");
  assert.deepEqual(s.counts, { claude: 1, chat: 1, helpers: 0, prs: 1, reviews: 1, started: 1 });
  assert.deepEqual(s.feed[0], { agent: "Rigel", action: "approved", ts: 103 });
  assert.equal(s.feed.length, 3);
  assert.equal(s.lastIngest, 1_000_000);
  s = applyBatch(s, cleanBatch({ events: [], agents: {} }), 2_000_000, "2026-10-14");
  assert.deepEqual(s.counts, { claude: 0, chat: 0, helpers: 0, prs: 0, reviews: 0, started: 0 });
  assert.equal(s.feed.length, 3); // the feed carries over midnight
  const many = cleanBatch({ events: Array.from({ length: 50 }, (_, i) => ({ t: "msg", kind: "github", agent: "Lyra", action: "pushed", ts: i })), agents: {} });
  assert.equal(applyBatch(s, many, 3, "2026-10-14").feed.length, 30);
});

test("helper events: agent only, nothing else", () => {
  assert.deepEqual(cleanEvent({ t: "msg", kind: "helper", agent: "Orion", ts: 7 }), { t: "msg", kind: "helper", agent: "Orion", ts: 7 });
  assert.deepEqual(cleanEvent({ t: "msg", kind: "helper", agent: "Lyra", name: "setkernel:reviewer", type: "subagent", skill: "verify", repo: "hq", action: "opened_pr" }),
    { t: "msg", kind: "helper", agent: "Lyra" });
  for (const bad of [
    { t: "msg", kind: "helper", agent: "Mallory" },
    { t: "msg", kind: "helper", agent: "orion" },
    { t: "msg", kind: "helper" },
    { t: "agent", kind: "helper", agent: "Vega" },
  ]) assert.equal(cleanEvent(bad), null, JSON.stringify(bad));
});
