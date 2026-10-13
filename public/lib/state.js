// The public picture of the office, built from batches that are already clean (src/logic.js
// checks them against the allowlist first). Pure: no Workers or DOM APIs. The Durable Object runs
// it on every batch, and the page runs the same code in ?demo mode, so the demo can't drift from
// what the live page really shows. Run its tests with: npm test
//
// Two parts, stored under two keys:
//   state   today's counts (overall and per agent), the recent-work feed, the agents' current
//           state, and when each agent last did anything.
//   replay  the last 24 hours, capped, for "replay the last hour / 24 h" and the hourly chart:
//           one row of counts per minute, and each GitHub action (capped).

export const AGENTS = ["Vega", "Rigel", "Lyra", "Orion"];
export const PULSE_KINDS = ["claude", "chat", "helper"]; // too frequent to keep one by one
// Columns per agent in a minute row: the pulse kinds, then GitHub actions (counted there too, so
// the hourly chart stays exact even when the list of actions is capped).
export const ROW_KINDS = [...PULSE_KINDS, "github"];
const FEED = 30;
const DAY_S = 86_400;
const REPLAY_MINUTES = 24 * 60; // one row per minute at most, so this is also the row cap
const REPLAY_WORK = 300; // GitHub actions kept for the replay; a busy day is under 200

const zeroCounts = () => ({ claude: 0, chat: 0, helpers: 0, prs: 0, reviews: 0, started: 0 });

export function emptyState(day) {
  return { day, agents: {}, counts: zeroCounts(), byAgent: {}, seen: {}, feed: [], lastIngest: 0 };
}

export function emptyReplay() {
  return { pulses: [], work: [] };
}

// Apply a clean batch to the state (returns a new state). Counts reset each UTC day; the feed and
// when each agent was last seen carry over midnight. A state saved before byAgent, seen or
// counts.helpers existed is filled in rather than showing NaN.
export function applyBatch(state, batch, now, day) {
  const s = state && state.day === day
    ? structuredClone(state)
    : { ...emptyState(day), feed: state?.feed ?? [], seen: state?.seen ?? {} };
  s.counts = { ...zeroCounts(), ...s.counts };
  s.byAgent ??= {};
  s.seen ??= {};
  s.agents = batch.agents;
  const nowS = Math.trunc(now / 1000);
  for (const e of batch.events) {
    if (e.t !== "msg") continue;
    const mine = (s.byAgent[e.agent] = { ...zeroCounts(), ...s.byAgent[e.agent] });
    const ts = e.ts ?? nowS;
    if (!(s.seen[e.agent] >= ts)) s.seen[e.agent] = ts;
    for (const c of [s.counts, mine]) {
      if (e.kind === "claude") c.claude++;
      else if (e.kind === "chat") c.chat++;
      else if (e.kind === "helper") c.helpers++;
      else if (e.kind === "github") {
        if (e.action === "opened_pr") c.prs++;
        if (e.action === "approved" || e.action === "requested_changes") c.reviews++;
        if (e.action === "picked_up") c.started++;
      }
    }
    if (e.kind === "github") s.feed.unshift(workItem(e, ts));
  }
  s.feed = s.feed.slice(0, FEED);
  s.lastIngest = now;
  return s;
}

const workItem = (e, ts) => ({ agent: e.agent, action: e.action, ...(e.repo ? { repo: e.repo } : {}), ts });

// Add a clean batch's events to the replay buffer (returns a new buffer). Only fields that passed
// the allowlist go in, and nothing older than 24 hours stays. A row in `pulses` is
// [minute since the epoch, then for each agent in AGENTS order its ROW_KINDS counts], so a full
// day is at most 1440 short rows. `work` holds the latest GitHub actions in the feed's shape.
export function recordReplay(replay, batch, now) {
  const nowS = Math.trunc(now / 1000);
  const oldest = nowS - DAY_S;
  const rows = new Map((replay?.pulses ?? []).map((r) => [r[0], r.slice()]));
  const work = (replay?.work ?? []).slice();
  for (const e of batch.events) {
    if (e.t !== "msg") continue;
    const ts = Math.min(e.ts ?? nowS, nowS); // a clock ahead of ours counts as now
    if (ts < oldest) continue;
    const a = AGENTS.indexOf(e.agent);
    if (a < 0) continue;
    if (e.kind === "github") work.push(workItem(e, ts));
    const k = ROW_KINDS.indexOf(e.kind);
    if (k < 0) continue;
    const minute = Math.floor(ts / 60);
    let row = rows.get(minute);
    if (!row) rows.set(minute, (row = [minute, ...Array(AGENTS.length * ROW_KINDS.length).fill(0)]));
    row[1 + a * ROW_KINDS.length + k]++;
  }
  const pulses = [...rows.values()]
    .filter((r) => r[0] * 60 >= oldest - 59)
    .sort((x, y) => x[0] - y[0])
    .slice(-REPLAY_MINUTES);
  return {
    pulses,
    work: work.filter((w) => w.ts >= oldest).sort((x, y) => x.ts - y.ts).slice(-REPLAY_WORK),
  };
}

// The replay buffer from `since` (seconds) on: what /api/replay serves.
export function replaySince(replay, since) {
  return {
    pulses: (replay?.pulses ?? []).filter((r) => r[0] * 60 + 59 >= since),
    work: (replay?.work ?? []).filter((w) => w.ts >= since),
  };
}

// The last 24 hours per UTC hour, oldest first: exactly 24 buckets { h, claude, chat, helper,
// github }, where h is hours since the epoch and the last bucket is the hour `now` (ms) is in.
export function hourly(replay, now) {
  const end = Math.floor(now / 3_600_000);
  const out = Array.from({ length: 24 }, (_, i) => ({ h: end - 23 + i, claude: 0, chat: 0, helper: 0, github: 0 }));
  const at = (ts) => out[Math.floor(ts / 3600) - (end - 23)];
  for (const r of replay?.pulses ?? []) {
    const b = at(r[0] * 60);
    if (!b) continue;
    for (let a = 0; a < AGENTS.length; a++) {
      ROW_KINDS.forEach((k, i) => { b[k] += r[1 + a * ROW_KINDS.length + i] || 0; });
    }
  }
  return out;
}

// What the page gets: on connect, with every batch, and from /api/state.
export function view(state, replay, now) {
  const { agents, counts, byAgent, seen, feed, lastIngest } = state;
  return { agents, counts, byAgent: byAgent ?? {}, seen: seen ?? {}, feed, hours: hourly(replay, now), lastIngest, now };
}
