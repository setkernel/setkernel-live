// The public state and the 24-hour replay buffer (public/lib/state.js, shared by the Durable
// Object and ?demo mode). Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { HOME_ZONE, applyBatch, cleanBatch, emptyReplay, emptyState, homeDay, homeMidnight, hourly, recordReplay, replaySince, view } from "../src/logic.js";

const T0 = 490_000 * 3600; // seconds, on an hour boundary
const batch = (...events) => cleanBatch({ events, agents: {} });
const msg = (agent, kind, ts, extra = {}) => ({ t: "msg", kind, agent, ts, ...extra });

test("per-agent counts: only the known agents, reset when the day changes", () => {
  const b = batch(
    msg("Vega", "github", T0, { action: "picked_up" }),
    msg("Vega", "github", T0 + 1, { action: "opened_pr", repo: "lafka-plugin" }),
    msg("Vega", "claude", T0 + 2),
    msg("Rigel", "github", T0 + 3, { action: "approved" }),
    msg("Rigel", "github", T0 + 4, { action: "requested_changes" }),
    msg("Rigel", "helper", T0 + 5),
    msg("Mallory", "claude", T0 + 6),
  );
  let s = applyBatch(emptyState("2026-10-13"), b, T0 * 1000 + 70_000, "2026-10-13");
  assert.deepEqual(Object.keys(s.byAgent).sort(), ["Rigel", "Vega"]);
  assert.deepEqual(s.byAgent.Vega, { claude: 1, chat: 0, helpers: 0, prs: 1, reviews: 0, started: 1, building: 1, changes: 0, merged: 0, requests: 0, merges: 0, ringed: 0 });
  assert.deepEqual(s.byAgent.Rigel, { claude: 0, chat: 0, helpers: 1, prs: 0, reviews: 2, started: 0, building: 0, changes: 1, merged: 0, requests: 0, merges: 0, ringed: 0 });
  assert.deepEqual(s.counts, { claude: 1, chat: 0, helpers: 1, prs: 1, reviews: 2, started: 1, building: 1, changes: 1, merged: 0, requests: 0, merges: 0, ringed: 0, ci: 0, ciPass: 0 });
  assert.deepEqual(s.seen, { Vega: T0 + 2, Rigel: T0 + 5 });

  s = applyBatch(s, batch(), T0 * 1000 + 86_400_000, "2026-10-14");
  assert.deepEqual(s.byAgent, {});
  assert.deepEqual(s.seen, { Vega: T0 + 2, Rigel: T0 + 5 }, "when each agent was last seen carries over midnight");
});

test("seen keeps the latest time; no ts, or a clock ahead of ours, counts as now", () => {
  let s = applyBatch(emptyState("d"), batch(msg("Lyra", "chat", T0 + 50), msg("Lyra", "chat", T0 + 10)), T0 * 1000 + 99_000, "d");
  assert.equal(s.seen.Lyra, T0 + 50);
  assert.equal(applyBatch(emptyState("d"), batch(msg("Vega", "chat", T0 + 9999)), T0 * 1000, "d").seen.Vega, T0);
  s = applyBatch(s, cleanBatch({ events: [{ t: "msg", kind: "claude", agent: "Lyra" }], agents: {} }), (T0 + 200) * 1000, "d");
  assert.equal(s.seen.Lyra, T0 + 200);
});

test("a state saved before this change loads without NaN", () => {
  const old = { day: "d", agents: {}, counts: { claude: 3, chat: 0, prs: 0, reviews: 0, started: 0 }, feed: [], lastIngest: 0 };
  const s = applyBatch(old, batch(msg("Orion", "helper", T0), msg("Orion", "claude", T0)), T0 * 1000, "d");
  assert.deepEqual(s.counts, { claude: 4, chat: 0, helpers: 1, prs: 0, reviews: 0, started: 0, building: 0, changes: 0, merged: 0, requests: 0, merges: 0, ringed: 0, ci: 0, ciPass: 0 });
  assert.equal(s.byAgent.Orion.helpers, 1);
  const v = view(old, undefined, T0 * 1000);
  assert.deepEqual([v.byAgent, v.seen, v.line, v.ci, v.hours.length], [{}, {}, {}, [], 24]);
  assert.equal(s.line.Orion, undefined, "a Claude request with no job seen starts no lane");
});

test("requests are counted apart from work, go in the feed and the replay, and move no lane", () => {
  const b = batch(
    msg("Vega", "github", T0, { action: "picked_up", repo: "hq" }),
    msg("Polaris", "request", T0 + 10, { action: "opened_issue" }),
    msg("Kochab", "request", T0 + 20, { action: "commented", repo: "hq" }),
    msg("Vega", "request", T0 + 30, { action: "commented" }),
  );
  const s = applyBatch(emptyState("d"), b, (T0 + 60) * 1000, "d");
  assert.equal(s.counts.requests, 3);
  assert.deepEqual([s.byAgent.Polaris.requests, s.byAgent.Kochab.requests, s.byAgent.Vega.requests], [1, 1, 1]);
  // not work: no pull requests, reviews, starts, merges or Claude requests
  for (const k of ["claude", "prs", "reviews", "merged", "merges"]) assert.equal(s.byAgent.Polaris[k], 0, k);
  assert.equal(s.byAgent.Vega.started, 1);
  assert.equal(s.counts.started, 1);
  assert.deepEqual(s.feed.slice(0, 3), [
    { agent: "Vega", action: "commented", ts: T0 + 30 }, { agent: "Kochab", action: "commented", repo: "hq", ts: T0 + 20 }, { agent: "Polaris", action: "opened_issue", ts: T0 + 10 },
  ]);
  assert.deepEqual(s.line.Vega, { job: "started", at: T0, built: false, repo: "hq", steps: { started: T0 } }, "a request moves no card");
  const r = recordReplay(emptyReplay(), b, (T0 + 60) * 1000);
  assert.deepEqual(r.work.map((w) => w.action), ["picked_up", "opened_issue", "commented", "commented"]);
  assert.deepEqual(r.pulses, [[T0 / 60, 0, 0, 0, 1]], "only Vega's pick-up: requests are not pulses, and the hourly chart's GitHub row leaves them out");
});

test("Polaris's merges: counted for the director, and the author's merge of the same pull request is ringed", () => {
  const b = batch(
    // one delivery: Vega's merge, then Polaris's, same time and repo
    msg("Vega", "github", T0, { action: "merged", repo: "hq" }), msg("Polaris", "github", T0, { action: "merged_by", repo: "hq" }),
    // merged by someone else: not ringed
    msg("Rigel", "github", T0 + 5, { action: "merged" }),
    // Polaris merging a pull request by someone the page doesn't show: no pair, nothing ringed
    msg("Polaris", "github", T0 + 9, { action: "merged_by" }),
    // two in a private repo at the same second: each pairs once
    msg("Lyra", "github", T0 + 20, { action: "merged" }), msg("Polaris", "github", T0 + 20, { action: "merged_by" }),
    msg("Orion", "github", T0 + 20, { action: "merged" }), msg("Polaris", "github", T0 + 20, { action: "merged_by" }),
  );
  let s = applyBatch(emptyState("d"), b, (T0 + 60) * 1000, "d");
  assert.equal(s.byAgent.Polaris.merges, 4);
  assert.equal(s.counts.merges, 4);
  assert.equal(s.counts.merged, 4, "Merged counts the authors' merges, not Polaris's as well");
  assert.equal(s.byAgent.Polaris.merged, 0);
  assert.deepEqual(["Vega", "Rigel", "Lyra", "Orion"].map((n) => s.byAgent[n].ringed), [1, 0, 1, 1]);
  assert.equal(s.counts.ringed, 3);
  assert.equal(s.feed.find((f) => f.agent === "Vega").ring, true);
  assert.equal(s.feed.find((f) => f.agent === "Rigel").ring, undefined);
  // the pair split across two batches still rings, whichever came first
  s = applyBatch(s, batch(msg("Vega", "github", T0 + 40, { action: "merged", repo: "hq" })), (T0 + 61) * 1000, "d");
  s = applyBatch(s, batch(msg("Polaris", "github", T0 + 40, { action: "merged_by", repo: "hq" })), (T0 + 62) * 1000, "d");
  s = applyBatch(s, batch(msg("Polaris", "github", T0 + 45, { action: "merged_by" })), (T0 + 63) * 1000, "d");
  s = applyBatch(s, batch(msg("Lyra", "github", T0 + 45, { action: "merged" })), (T0 + 64) * 1000, "d");
  assert.deepEqual([s.byAgent.Vega.ringed, s.byAgent.Lyra.ringed, s.counts.ringed], [2, 2, 5]);
  // a merged_by in another repo, or at another second, is not the same pull request
  s = applyBatch(emptyState("d"), batch(msg("Vega", "github", T0, { action: "merged", repo: "hq" }), msg("Polaris", "github", T0, { action: "merged_by", repo: "lafka" }), msg("Polaris", "github", T0 + 1, { action: "merged_by", repo: "hq" })), (T0 + 60) * 1000, "d");
  assert.equal(s.counts.ringed, 0);
  // and it moves no lane: Polaris isn't on the line
  assert.equal(s.line.Polaris, undefined);
});

test("replay: frequent kinds as one row per minute, GitHub actions one by one", () => {
  const b = batch(
    msg("Vega", "claude", T0 + 1), msg("Vega", "claude", T0 + 59), msg("Vega", "chat", T0 + 30),
    msg("Orion", "helper", T0 + 61),
    msg("Rigel", "github", T0 + 62, { action: "opened_pr", repo: "setkernel-live" }),
  );
  const r = recordReplay(emptyReplay(), b, (T0 + 120) * 1000);
  const m = T0 / 60;
  // trailing zeros are left off:  Vega c ch h gh  Rigel       Lyra        Orion       (the pole stars)
  assert.deepEqual(r.pulses, [[m, 2, 1], [m + 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]]);
  assert.deepEqual(r.work, [{ agent: "Rigel", action: "opened_pr", repo: "setkernel-live", ts: T0 + 62 }]);
  // a later batch adds to the same minute's row
  const r2 = recordReplay(r, batch(msg("Vega", "claude", T0 + 5)), (T0 + 130) * 1000);
  assert.equal(r2.pulses[0][1], 3);
  assert.equal(r.pulses[0][1], 2, "the old buffer is not changed");
});

test("replay: the pole stars' GitHub actions share the last column; rows saved with four agents still add up", () => {
  const m = T0 / 60;
  const r = recordReplay(emptyReplay(), batch(msg("Yildun", "github", T0 + 1, { action: "merged", repo: "hq" })), (T0 + 60) * 1000);
  // the pole stars have one column between them, their GitHub actions, after the 4 x 4 engineers'
  assert.deepEqual(r.pulses, [[m, ...Array(16).fill(0), 1]]);
  assert.deepEqual(r.work, [{ agent: "Yildun", action: "merged", repo: "hq", ts: T0 + 1 }], "which star it was stays in `work`");
  const p = recordReplay(r, batch(...["Polaris", "Kochab", "Pherkad"].map((a) => msg(a, "github", T0 + 2, { action: "approved" }))), (T0 + 60) * 1000);
  assert.deepEqual(p.pulses, [[m, ...Array(16).fill(0), 4]]);
  assert.deepEqual(p.work.map((w) => w.agent), ["Yildun", "Polaris", "Kochab", "Pherkad"]);
  assert.equal(hourly(p, (T0 + 60) * 1000).at(-1).github, 4);
  // a row stored with four agents: 1 + 4 x 4 columns, all of them written out
  const old = { pulses: [[m, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]], work: [] };
  const r2 = recordReplay(old, batch(msg("Kochab", "github", T0 + 2, { action: "opened_pr" }), msg("Vega", "claude", T0 + 3)), (T0 + 60) * 1000);
  assert.deepEqual(r2.pulses, [[m, 3, 1, ...Array(14).fill(0), 1]]);
  assert.ok(r2.pulses[0].every(Number.isInteger), "no NaN from the missing columns");
  assert.deepEqual(hourly(old, (T0 + 60) * 1000).at(-1), { h: T0 / 3600, claude: 2, chat: 1, helper: 0, github: 0 });
  assert.equal(hourly(r2, (T0 + 60) * 1000).at(-1).github, 1);
});

test("replay holds only allowlisted fields: what cleanEvent let through", () => {
  const raw = { events: [{ t: "msg", kind: "github", agent: "Lyra", action: "approved", repo: "hq", ref: "hq#31", title: "secret", host: "lyra-dev", ts: T0 }], agents: {} };
  const r = recordReplay(emptyReplay(), cleanBatch(raw), T0 * 1000);
  assert.deepEqual(r.work, [{ agent: "Lyra", action: "approved", repo: "hq", ts: T0 }]);
  assert.doesNotMatch(JSON.stringify(r), /secret|lyra-dev|#31/);
});

test("replay drops anything older than 24 hours and counts a future clock as now", () => {
  const now = (T0 + 86_400) * 1000;
  let r = recordReplay(emptyReplay(), batch(msg("Vega", "claude", T0 - 10), msg("Vega", "github", T0 - 10, { action: "pushed" })), now);
  assert.deepEqual(r, emptyReplay());
  r = recordReplay(emptyReplay(), batch(msg("Vega", "claude", T0 + 100), msg("Rigel", "github", T0 + 999_999, { action: "pushed" })), (T0 + 200) * 1000);
  assert.equal(r.work[0].ts, T0 + 200);
  // a day later the old rows fall out as new batches arrive
  r = recordReplay(r, batch(msg("Lyra", "chat", T0 + 86_400 + 500)), (T0 + 86_400 + 500) * 1000);
  assert.deepEqual(r.pulses.map((p) => p[0]), [(T0 + 86_400 + 480) / 60]);
  assert.equal(r.pulses.length, 1);
  assert.deepEqual(r.work, []);
});

test("replay is capped: a full day of heavy traffic stays far below the storage value limit", () => {
  let r = emptyReplay();
  const end = T0 + 86_400;
  for (let t = T0 + 60; t < end; t += 600) { // every minute of a day, in ten-minute batches
    const events = [];
    for (let s = t; s < t + 600; s += 60) {
      for (const agent of ["Vega", "Rigel", "Lyra", "Orion"]) {
        for (let i = 0; i < 120; i++) events.push(msg(agent, "claude", s));
        events.push(msg(agent, "chat", s), msg(agent, "helper", s));
      }
      events.push(msg("Vega", "github", s, { action: "pushed", repo: "r".repeat(100) })); // the longest name the allowlist takes
      // the pole stars, which have only GitHub actions, each act every minute too
      for (const pole of ["Polaris", "Kochab", "Pherkad", "Yildun"]) events.push(msg(pole, "github", s, { action: "merged", repo: "r".repeat(100) }));
    }
    r = recordReplay(r, { events: events.map((e) => ({ ...e })), agents: {} }, (t + 600) * 1000);
  }
  assert.equal(r.pulses.length, 1440);
  assert.equal(r.work.length, 300);
  assert.ok(r.pulses.every((row) => row.length === 18), "every row full width: 1 + 4 engineers x 4 kinds + the pole stars' column");
  const bytes = Buffer.byteLength(JSON.stringify(r));
  // under 128 KiB (the key-value backend's value limit), so far below the 2 MB of a SQLite-backed object
  assert.ok(bytes < 128 * 1024, `${bytes} bytes`);
  assert.ok(r.pulses.every((row, i) => i === 0 || row[0] > r.pulses[i - 1][0]), "rows stay in time order");
});

test("replaySince serves the last hour or the whole buffer", () => {
  const r = recordReplay(emptyReplay(), batch(
    msg("Vega", "claude", T0), msg("Vega", "claude", T0 + 7200),
    msg("Rigel", "github", T0, { action: "pushed" }), msg("Rigel", "github", T0 + 7200, { action: "approved" }),
  ), (T0 + 7300) * 1000);
  const hour = replaySince(r, T0 + 7300 - 3600);
  assert.deepEqual(hour.pulses.map((p) => p[0]), [(T0 + 7200) / 60]);
  assert.deepEqual(hour.work.map((w) => w.action), ["approved"]);
  assert.equal(replaySince(r, T0 - 1).pulses.length, 2);
  assert.deepEqual(replaySince(undefined, 0), emptyReplay());
});

test("hourly: 24 buckets per hour from the replay buffer, gaps as zeros", () => {
  const r = recordReplay(emptyReplay(), batch(
    msg("Vega", "claude", T0 + 10), msg("Rigel", "claude", T0 + 3599), msg("Lyra", "helper", T0 + 3600),
    msg("Orion", "github", T0 + 5, { action: "opened_pr" }), msg("Vega", "chat", T0 - 3600),
  ), (T0 + 3700) * 1000);
  const h = hourly(r, (T0 + 3700) * 1000);
  assert.equal(h.length, 24);
  assert.deepEqual(h.at(-1), { h: T0 / 3600 + 1, claude: 0, chat: 0, helper: 1, github: 0 });
  assert.deepEqual(h.at(-2), { h: T0 / 3600, claude: 2, chat: 0, helper: 0, github: 1 });
  assert.deepEqual(h.at(-3), { h: T0 / 3600 - 1, claude: 0, chat: 1, helper: 0, github: 0 });
  // GitHub counts come from the rows, so they stay exact when the list of actions is capped
  const capped = { ...r, work: [] };
  assert.equal(hourly(capped, (T0 + 3700) * 1000).at(-2).github, 1);
  assert.ok(h.slice(0, -3).every((b) => b.claude + b.chat + b.helper + b.github === 0));
  // a long outage: still 24 buckets, all zero, ending at the current hour
  const later = hourly(r, (T0 + 100 * 3600) * 1000);
  assert.equal(later.at(-1).h, T0 / 3600 + 100);
  assert.ok(later.every((b) => b.claude + b.github === 0));
});

// ---- today is the Halifax day (hq#177, question 5)
const at = (iso) => Date.parse(iso) / 1000;
const iso = (s) => new Date(s * 1000).toISOString();

test("homeDay: the date in Halifax, in AST and ADT, whatever the UTC date", () => {
  assert.equal(HOME_ZONE, "America/Halifax");
  assert.equal(homeDay(at("2026-10-15T02:59:59Z") * 1000), "2026-10-14", "23:59 ADT is still the 14th, though UTC is on the 15th");
  assert.equal(homeDay(at("2026-10-15T03:00:00Z") * 1000), "2026-10-15", "00:00 ADT");
  assert.equal(homeDay(at("2026-01-15T03:59:59Z") * 1000), "2026-01-14", "23:59 AST");
  assert.equal(homeDay(at("2026-01-15T04:00:00Z") * 1000), "2026-01-15", "00:00 AST");
});

test("homeMidnight: where today began, on ordinary days and both days the clocks change", () => {
  // an ordinary day: midnight is now less the wall clock
  assert.equal(iso(homeMidnight(at("2026-10-14T19:40:00Z"))), "2026-10-14T03:00:00.000Z");
  // 8 March 2026: 02:00 AST becomes 03:00 ADT, a 23-hour day that began at 00:00 AST
  for (const t of ["2026-03-08T04:00:00Z", "2026-03-08T05:59:59Z", "2026-03-08T06:00:00Z", "2026-03-08T12:00:00Z", "2026-03-09T02:59:59Z"]) {
    assert.equal(iso(homeMidnight(at(t))), "2026-03-08T04:00:00.000Z", t);
  }
  assert.equal(iso(homeMidnight(at("2026-03-09T03:00:00Z"))), "2026-03-09T03:00:00.000Z", "the next day begins at 00:00 ADT");
  // 1 November 2026: 02:00 ADT becomes 01:00 AST, a 25-hour day that began at 00:00 ADT
  for (const t of ["2026-11-01T03:00:00Z", "2026-11-01T04:30:00Z", "2026-11-01T05:30:00Z", "2026-11-01T12:00:00Z", "2026-11-02T03:59:59Z"]) {
    assert.equal(iso(homeMidnight(at(t))), "2026-11-01T03:00:00.000Z", t);
  }
  assert.equal(iso(homeMidnight(at("2026-11-02T04:00:00Z"))), "2026-11-02T04:00:00.000Z", "the next day begins at 00:00 AST");
});

test("today's counts reset at Halifax midnight, not UTC midnight, across a change of the clocks", () => {
  const step = (s, ts) => applyBatch(s, batch(msg("Vega", "github", ts, { action: "opened_pr" })), ts * 1000, homeDay(ts * 1000));
  // UTC midnight passes at 21:00 ADT: the same Halifax day, so the count goes on
  let s = step(emptyState(homeDay(at("2026-10-14T20:00:00Z") * 1000)), at("2026-10-14T20:00:00Z"));
  s = step(s, at("2026-10-15T00:30:00Z"));
  assert.equal(s.counts.prs, 2, "21:30 ADT is still the 14th in Halifax");
  s = step(s, at("2026-10-15T03:00:00Z"));
  assert.equal(s.counts.prs, 1, "a fresh count from 00:00 ADT");
  assert.equal(s.day, "2026-10-15");
  // the night the clocks go back: 25 hours of one day, then a fresh count at 00:00 AST
  s = step(emptyState("x"), at("2026-11-01T03:00:00Z"));
  s = step(s, at("2026-11-02T03:30:00Z"));
  assert.equal(s.counts.prs, 2, "23:30 AST on the 1st: the same day as 00:00 ADT");
  s = step(s, at("2026-11-02T04:00:00Z"));
  assert.equal(s.counts.prs, 1);
  // the night the clocks go forward
  s = step(emptyState("x"), at("2026-03-08T04:00:00Z"));
  s = step(s, at("2026-03-09T02:59:00Z"));
  assert.equal(s.counts.prs, 2, "23:59 ADT on the 8th, 23 hours on");
  assert.equal(step(s, at("2026-03-09T03:00:00Z")).counts.prs, 1);
});

test("hourly: across a change of the clocks, still 24 buckets, each one an hour on the Halifax clock", () => {
  const now = at("2026-11-01T12:30:00Z") * 1000; // 08:30 AST, the morning the clocks went back
  const h = hourly(emptyReplay(), now);
  assert.equal(h.length, 24);
  assert.ok(h.every((b, i) => i === 0 || b.h === h[i - 1].h + 1), "no gap and no double hour");
  const minute = new Intl.DateTimeFormat("en-GB", { timeZone: HOME_ZONE, minute: "2-digit" });
  assert.ok(h.every((b) => Number(minute.format(new Date(b.h * 3_600_000))) === 0), "each starts on a Halifax hour");
  assert.equal(h.at(-1).h, Math.floor(now / 3_600_000));
});
