// The public picture of the office, built from batches that are already clean (src/logic.js
// checks them against the allowlist first). Pure: no Workers or DOM APIs. The Durable Object runs
// it on every batch, and the page runs the same code in ?demo mode, so the demo can't drift from
// what the live page really shows. Run its tests with: npm test
//
// Two parts, stored under two keys:
//   state   today's counts (overall and per agent), the recent-work feed, the recent CI
//           results, the agents' current state, when each agent last did anything, and each
//           engineer's lane on the line (public/lib/line.js).
//   replay  the last 24 hours, capped, for "replay the last hour / 24 h" and the hourly chart:
//           one row of counts per minute, and each GitHub action (capped).

import { settleLines, stepLines } from "./line.js";

// The four AI engineers, then Polaris (the director) and the three Claudes grouped around it:
// Kochab, Pherkad and Yildun, after Ursa Minor (setkernel-live#33). The pole stars are seen only
// through their pull requests and reviews. They come after the engineers: a replay row's columns
// follow this order, so rows saved with four agents still read the same.
export const ENGINEERS = ["Vega", "Rigel", "Lyra", "Orion"];
export const POLE = ["Polaris", "Kochab", "Pherkad", "Yildun"];
export const AGENTS = [...ENGINEERS, ...POLE];
export const PULSE_KINDS = ["claude", "chat", "helper"]; // too frequent to keep one by one
// Columns per engineer in a minute row: the pulse kinds, then GitHub actions (counted there too, so
// the hourly chart stays exact even when the list of actions is capped). The pole stars have only
// GitHub actions, and they share one column after the engineers': only the hourly chart reads a
// GitHub column (the replay show takes each action, with its star, from `work`), and one column
// keeps a full day under the size limit (test/state.test.mjs).
export const ROW_KINDS = [...PULSE_KINDS, "github"];
export const COLUMNS = [...ENGINEERS.flatMap((agent) => ROW_KINDS.map((kind) => [agent, kind])), ["pole", "github"]];
const COLUMN = new Map([
  ...COLUMNS.map(([agent, kind], i) => [`${agent} ${kind}`, i]),
  ...POLE.map((agent) => [`${agent} github`, COLUMNS.length - 1]),
]);
// Where an agent's count of a kind sits in a minute row (after the minute itself), or -1.
export const columnOf = (agent, kind) => COLUMN.get(`${agent} ${kind}`) ?? -1;
const FEED = 30;
const CI_RECENT = 20;
const DAY_S = 86_400;
const REPLAY_MINUTES = 24 * 60; // one row per minute at most, so this is also the row cap
const REPLAY_WORK = 300; // GitHub actions kept for the replay; a busy day is under 200

// The line's header counts too: building (jobs that got under way), changes (changes requested)
// and merged (pull requests merged).
const zeroCounts = () => ({ claude: 0, chat: 0, helpers: 0, prs: 0, reviews: 0, started: 0, building: 0, changes: 0, merged: 0 });
// CI runs have no agent, so they are only counted overall: runs, and how many passed.
const zeroTotals = () => ({ ...zeroCounts(), ci: 0, ciPass: 0 });

export function emptyState(day) {
  return { day, agents: {}, counts: zeroTotals(), byAgent: {}, seen: {}, line: {}, feed: [], ci: [], lastIngest: 0 };
}

export function emptyReplay() {
  return { pulses: [], work: [] };
}

// Apply a clean batch to the state (returns a new state). Counts reset each UTC day; the feed, the
// recent CI results, when each agent was last seen and the lanes carry over midnight. A state saved
// before byAgent, seen, line, ci or a count existed is filled in rather than showing NaN.
export function applyBatch(state, batch, now, day) {
  const s = state && state.day === day
    ? structuredClone(state)
    : { ...emptyState(day), feed: state?.feed ?? [], ci: state?.ci ?? [], seen: state?.seen ?? {}, line: state?.line ?? {} };
  s.counts = { ...zeroTotals(), ...s.counts };
  s.ci ??= [];
  s.byAgent ??= {};
  s.seen ??= {};
  s.agents = batch.agents;
  const nowS = Math.trunc(now / 1000);
  for (const e of batch.events) {
    if (e.t !== "msg") continue;
    if (e.kind === "ci") {
      s.counts.ci++;
      if (e.result === "pass") s.counts.ciPass++;
      s.ci.unshift({ result: e.result, ...(e.repo ? { repo: e.repo } : {}), ts: e.ts ?? nowS });
      continue;
    }
    const mine = (s.byAgent[e.agent] = { ...zeroCounts(), ...s.byAgent[e.agent] });
    const ts = Math.min(e.ts ?? nowS, nowS); // a clock ahead of ours counts as now
    if (!(s.seen[e.agent] >= ts)) s.seen[e.agent] = ts;
    for (const c of [s.counts, mine]) {
      if (e.kind === "claude") c.claude++;
      else if (e.kind === "chat") c.chat++;
      else if (e.kind === "helper") c.helpers++;
      else if (e.kind === "github") {
        if (e.action === "opened_pr") c.prs++;
        if (e.action === "approved" || e.action === "requested_changes") c.reviews++;
        if (e.action === "picked_up") c.started++;
        if (e.action === "requested_changes") c.changes++;
        if (e.action === "merged") c.merged++;
      }
    }
    if (e.kind === "github") s.feed.unshift(workItem(e, ts));
  }
  // the lanes, with each event at the time it counted at
  const timed = batch.events.filter((e) => e.t === "msg" && e.kind !== "ci").map((e) => ({ ...e, ts: Math.min(e.ts ?? nowS, nowS) }));
  const { lines, built } = stepLines(s.line, timed, ENGINEERS);
  for (const name of built) {
    s.counts.building++;
    s.byAgent[name] = { ...zeroCounts(), ...s.byAgent[name] };
    s.byAgent[name].building++;
  }
  s.line = settleLines(lines, s.agents, ENGINEERS, nowS);
  s.feed = s.feed.slice(0, FEED);
  s.ci = s.ci.slice(0, CI_RECENT);
  s.lastIngest = now;
  return s;
}

const workItem = (e, ts) => ({ agent: e.agent, action: e.action, ...(e.repo ? { repo: e.repo } : {}), ts });

// Add a clean batch's events to the replay buffer (returns a new buffer). Only fields that passed
// the allowlist go in, and nothing older than 24 hours stays. A row in `pulses` is
// [minute since the epoch, then the counts in COLUMNS order], so a full
// day is at most 1440 short rows. Trailing zeros are left off (a missing count is 0), so the pole
// stars' column at the end, with nothing that minute, costs nothing. `work` holds the latest GitHub actions
// in the feed's shape.
export function recordReplay(replay, batch, now) {
  const nowS = Math.trunc(now / 1000);
  const oldest = nowS - DAY_S;
  const width = 1 + COLUMNS.length;
  // a row saved before an agent was added is shorter: pad it, so that agent's counts start at 0
  const rows = new Map((replay?.pulses ?? []).map((r) => [r[0], r.length < width ? [...r, ...Array(width - r.length).fill(0)] : r.slice()]));
  const work = (replay?.work ?? []).slice();
  for (const e of batch.events) {
    if (e.t !== "msg") continue;
    const ts = Math.min(e.ts ?? nowS, nowS); // a clock ahead of ours counts as now
    if (ts < oldest) continue;
    if (!AGENTS.includes(e.agent)) continue;
    if (e.kind === "github") work.push(workItem(e, ts));
    const c = columnOf(e.agent, e.kind);
    if (c < 0) continue;
    const minute = Math.floor(ts / 60);
    let row = rows.get(minute);
    if (!row) rows.set(minute, (row = [minute, ...Array(width - 1).fill(0)]));
    row[1 + c]++;
  }
  const pulses = [...rows.values()]
    .filter((r) => r[0] * 60 >= oldest - 59)
    .sort((x, y) => x[0] - y[0])
    .slice(-REPLAY_MINUTES)
    .map(trimZeros);
  return {
    pulses,
    work: work.filter((w) => w.ts >= oldest).sort((x, y) => x.ts - y.ts).slice(-REPLAY_WORK),
  };
}

function trimZeros(row) {
  let n = row.length;
  while (n > 1 && row[n - 1] === 0) n--;
  return n === row.length ? row : row.slice(0, n);
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
    COLUMNS.forEach(([, kind], i) => { b[kind] += r[1 + i] || 0; });
  }
  return out;
}

// What the page gets: on connect, with every batch, and from /api/state.
export function view(state, replay, now) {
  const { agents, counts, byAgent, seen, line, feed, ci, lastIngest } = state;
  return { agents, counts, byAgent: byAgent ?? {}, seen: seen ?? {}, line: line ?? {}, feed, ci: ci ?? [], hours: hourly(replay, now), lastIngest, now };
}
