// What the Worker accepts from sk-obs01, and the public state it builds. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { applyBatch, cleanBatch, cleanEvent, emptyState, rollHours } from "../src/logic.js";

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
  assert.deepEqual(s.counts, { claude: 1, chat: 1, prs: 1, reviews: 1, started: 1 });
  assert.deepEqual(s.feed[0], { agent: "Rigel", action: "approved", ts: 103 });
  assert.equal(s.feed.length, 3);
  assert.equal(s.lastIngest, 1_000_000);
  s = applyBatch(s, cleanBatch({ events: [], agents: {} }), 2_000_000, "2026-10-14");
  assert.deepEqual(s.counts, { claude: 0, chat: 0, prs: 0, reviews: 0, started: 0 });
  assert.equal(s.feed.length, 3); // the feed carries over midnight
  const many = cleanBatch({ events: Array.from({ length: 50 }, (_, i) => ({ t: "msg", kind: "github", agent: "Lyra", action: "pushed", ts: i })), agents: {} });
  assert.equal(applyBatch(s, many, 3, "2026-10-14").feed.length, 30);
});

test("hourly buckets: one per UTC hour, rolled on the hour, gaps filled with zeros, never more than 24", () => {
  const H = 3_600_000, T0 = 490_000 * H; // an hour boundary
  const msgs = (ts, ...kinds) => cleanBatch({ events: kinds.map((kind) => ({ t: "msg", kind, agent: "Vega", ts, ...(kind === "github" ? { action: "pushed" } : {}) })), agents: {} });
  let s = applyBatch(emptyState("d"), msgs(T0 / 1000 + 10, "claude", "claude", "github", "chat"), T0 + 70_000, "d");
  assert.equal(s.hours.length, 24);
  assert.deepEqual(s.hours.at(-1), { h: T0 / H, claude: 2, github: 1, chat: 1 });
  assert.deepEqual(s.hours[0], { h: T0 / H - 23, claude: 0, github: 0, chat: 0 });

  // an event from 10:59 that arrives at 11:00 counts in 10:00; the new hour starts empty
  s = applyBatch(s, msgs(T0 / 1000 + 3599, "claude"), T0 + H + 30_000, "d");
  assert.equal(s.hours.length, 24);
  assert.deepEqual(s.hours.at(-2), { h: T0 / H, claude: 3, github: 1, chat: 1 });
  assert.deepEqual(s.hours.at(-1), { h: T0 / H + 1, claude: 0, github: 0, chat: 0 });

  // five quiet hours, then one event: the gap comes back as zeros and the old hour moves left
  s = applyBatch(s, msgs(T0 / 1000 + 6 * 3600 + 5, "chat"), T0 + 6 * H + 60_000, "d");
  assert.deepEqual(s.hours.map((b) => b.h), Array.from({ length: 24 }, (_, i) => T0 / H + 6 - 23 + i));
  assert.deepEqual(s.hours.at(-7), { h: T0 / H, claude: 3, github: 1, chat: 1 });
  for (const b of s.hours.slice(-6, -1)) assert.deepEqual([b.claude, b.github, b.chat], [0, 0, 0]);
  assert.equal(s.hours.at(-1).chat, 1);

  // 24 hours on, the first hour has fallen off; events older than the window are dropped,
  // events stamped ahead of our clock count in the current hour, events without ts count now
  s = applyBatch(s, msgs(T0 / 1000, "claude"), T0 + 24 * H + 1, "d");
  assert.equal(s.hours.length, 24);
  assert.equal(s.hours.find((b) => b.h === T0 / H), undefined);
  assert.equal(s.hours.reduce((n, b) => n + b.claude, 0), 0);
  s = applyBatch(s, msgs(T0 / 1000 + 30 * 3600, "github"), T0 + 24 * H + 2, "d");
  assert.equal(s.hours.at(-1).github, 1);
  s = applyBatch(s, cleanBatch({ events: [{ t: "msg", kind: "claude", agent: "Lyra" }], agents: {} }), T0 + 24 * H + 3, "d");
  assert.equal(s.hours.at(-1).claude, 1);

  // a long outage empties every bucket but still returns 24
  const later = rollHours(s.hours, T0 + 100 * H);
  assert.equal(later.length, 24);
  assert.ok(later.every((b) => b.claude + b.github + b.chat === 0));
  assert.equal(later.at(-1).h, T0 / H + 100);
});

test("hourly buckets survive midnight and states saved before they existed", () => {
  const H = 3_600_000, T0 = 490_000 * H;
  const one = cleanBatch({ events: [{ t: "msg", kind: "claude", agent: "Orion", ts: T0 / 1000 }], agents: {} });
  let s = applyBatch(emptyState("2026-10-13"), one, T0 + 1000, "2026-10-13");
  s = applyBatch(s, cleanBatch({ events: [], agents: {} }), T0 + H, "2026-10-14");
  assert.equal(s.counts.claude, 0);
  assert.equal(s.hours.at(-2).claude, 1); // the chart carries over midnight like the feed
  const old = { ...emptyState("2026-10-14") };
  delete old.hours;
  s = applyBatch(old, one, T0 + 1000, "2026-10-14");
  assert.equal(s.hours.length, 24);
  assert.equal(s.hours.at(-1).claude, 1);
  assert.equal(rollHours(undefined, T0).length, 24);
});
