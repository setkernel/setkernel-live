// The public state and the 24-hour replay buffer (public/lib/state.js, shared by the Durable
// Object and ?demo mode). Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { applyBatch, cleanBatch, emptyReplay, emptyState, hourly, recordReplay, replaySince, view } from "../src/logic.js";

const T0 = 490_000 * 3600; // seconds, on an hour boundary
const batch = (...events) => cleanBatch({ events, agents: {} });
const msg = (agent, kind, ts, extra = {}) => ({ t: "msg", kind, agent, ts, ...extra });

test("per-agent counts: only the four agents, reset each UTC day", () => {
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
  assert.deepEqual(s.byAgent.Vega, { claude: 1, chat: 0, helpers: 0, prs: 1, reviews: 0, started: 1 });
  assert.deepEqual(s.byAgent.Rigel, { claude: 0, chat: 0, helpers: 1, prs: 0, reviews: 2, started: 0 });
  assert.deepEqual(s.counts, { claude: 1, chat: 0, helpers: 1, prs: 1, reviews: 2, started: 1 });
  assert.deepEqual(s.seen, { Vega: T0 + 2, Rigel: T0 + 5 });

  s = applyBatch(s, batch(), T0 * 1000 + 86_400_000, "2026-10-14");
  assert.deepEqual(s.byAgent, {});
  assert.deepEqual(s.seen, { Vega: T0 + 2, Rigel: T0 + 5 }, "when each agent was last seen carries over midnight");
});

test("seen keeps the latest time, and an event without ts counts as now", () => {
  let s = applyBatch(emptyState("d"), batch(msg("Lyra", "chat", T0 + 50), msg("Lyra", "chat", T0 + 10)), T0 * 1000 + 99_000, "d");
  assert.equal(s.seen.Lyra, T0 + 50);
  s = applyBatch(s, cleanBatch({ events: [{ t: "msg", kind: "claude", agent: "Lyra" }], agents: {} }), (T0 + 200) * 1000, "d");
  assert.equal(s.seen.Lyra, T0 + 200);
});

test("a state saved before this change loads without NaN", () => {
  const old = { day: "d", agents: {}, counts: { claude: 3, chat: 0, prs: 0, reviews: 0, started: 0 }, feed: [], lastIngest: 0 };
  const s = applyBatch(old, batch(msg("Orion", "helper", T0), msg("Orion", "claude", T0)), T0 * 1000, "d");
  assert.deepEqual(s.counts, { claude: 4, chat: 0, helpers: 1, prs: 0, reviews: 0, started: 0 });
  assert.equal(s.byAgent.Orion.helpers, 1);
  const v = view(old, undefined, T0 * 1000);
  assert.deepEqual([v.byAgent, v.seen, v.hours.length], [{}, {}, 24]);
});

test("replay: frequent kinds as one row per minute, GitHub actions one by one", () => {
  const b = batch(
    msg("Vega", "claude", T0 + 1), msg("Vega", "claude", T0 + 59), msg("Vega", "chat", T0 + 30),
    msg("Orion", "helper", T0 + 61),
    msg("Rigel", "github", T0 + 62, { action: "opened_pr", repo: "setkernel-live" }),
  );
  const r = recordReplay(emptyReplay(), b, (T0 + 120) * 1000);
  const m = T0 / 60;
  //                  Vega c ch h gh  Rigel       Lyra        Orion
  assert.deepEqual(r.pulses, [[m, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [m + 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0]]);
  assert.deepEqual(r.work, [{ agent: "Rigel", action: "opened_pr", repo: "setkernel-live", ts: T0 + 62 }]);
  // a later batch adds to the same minute's row
  const r2 = recordReplay(r, batch(msg("Vega", "claude", T0 + 5)), (T0 + 130) * 1000);
  assert.equal(r2.pulses[0][1], 3);
  assert.equal(r.pulses[0][1], 2, "the old buffer is not changed");
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
      events.push(msg("Vega", "github", s, { action: "pushed", repo: "a-public-repo-with-a-long-name" }));
    }
    r = recordReplay(r, { events: events.map((e) => ({ ...e })), agents: {} }, (t + 600) * 1000);
  }
  assert.equal(r.pulses.length, 1440);
  assert.equal(r.work.length, 300);
  const bytes = Buffer.byteLength(JSON.stringify(r));
  assert.ok(bytes < 100 * 1024, `${bytes} bytes; a Durable Object storage value may be up to 128 KiB`);
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

test("hourly: 24 buckets per UTC hour from the replay buffer, gaps as zeros", () => {
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
