// The public picture of the office, built from batches that are already clean (src/logic.js
// checks them against the allowlist first). Pure: no Workers or DOM APIs. The Durable Object runs
// it on every batch, and the page runs the same code in ?demo mode, so the demo can't drift from
// what the live page really shows. Run its tests with: npm test
//
// Two parts, stored under two keys:
//   state   today's counts (today is the Halifax day, see homeDay) (overall and per agent), the recent-work feed, the recent CI
//           results, the agents' current state, when each agent last did anything, and each
//           engineer's lane on the line (public/lib/line.js).
//   replay  the last 24 hours, capped, for "replay the last hour / 24 h" and the hourly chart:
//           one row of counts per minute, and each GitHub action (capped).

import { settleLines, stepLines } from "./line.js";

// The four AI engineers, then Polaris (the director) and the three Claudes grouped around it:
// Kochab, Pherkad and Yildun, after Ursa Minor (setkernel-live#33). The pole stars are seen only
// through GitHub: their requests, pull requests, reviews and merges (and Yildun's Claude requests,
// which only the live counts show: the replay keeps no column for them). They come after the
// engineers: a replay row's columns
// follow this order, so rows saved with four agents still read the same.
export const ENGINEERS = ["Vega", "Rigel", "Lyra", "Orion"];
export const POLE = ["Polaris", "Kochab", "Pherkad", "Yildun"];
export const AGENTS = [...ENGINEERS, ...POLE];
export const PULSE_KINDS = ["claude", "chat", "helper"]; // too frequent to keep one by one
// A request (setkernel-live#35): an issue opened or a comment made, sent to the team. Kept one by one
// with the GitHub actions, but never counted as work.
export const REQUEST_ACTIONS = ["opened_issue", "commented"];
export const isRequest = (e) => REQUEST_ACTIONS.includes(e?.action);
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
export const CI_RECENT = 20;
const DAY_S = 86_400;
const REPLAY_MINUTES = 24 * 60; // one row per minute at most, so this is also the row cap
export const REPLAY_WORK = 300; // GitHub actions kept for the replay; a busy day is under 200

// "Today" is the day in Halifax, where setkernel is (hq#177, question 5): the counts reset at
// midnight there, in AST or ADT, whatever zone the visitor or the Worker is in.
export const HOME_ZONE = "America/Halifax";
const homeParts = new Intl.DateTimeFormat("en-CA", { timeZone: HOME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
// The Halifax wall clock at `s` (seconds), as if it were UTC: seconds since the epoch.
function homeClock(s) {
  const p = Object.fromEntries(homeParts.formatToParts(new Date(s * 1000)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, wall: Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000 };
}

// The Halifax date at `ms` -> "2026-10-14": the day key applyBatch is given.
export const homeDay = (ms) => homeClock(Math.floor(ms / 1000)).day;

// When the Halifax day holding `s` began, in seconds. On the days the clocks change, midnight is
// not "now less the wall-clock time", so this steps until the wall clock reads 00:00 on that date.
export function homeMidnight(s) {
  const { day } = homeClock(s);
  const target = Date.parse(`${day}T00:00:00Z`) / 1000;
  let m = s - (homeClock(s).wall - target);
  for (let i = 0; i < 3; i++) {
    const off = homeClock(m).wall - target;
    if (!off) break;
    m -= off;
  }
  return m;
}

// The line's header counts too: building (jobs that got under way), changes (changes requested)
// and merged (pull requests merged). Then the director's: requests (issues opened and comments, by
// anyone), merges (pull requests Polaris merged) and ringed (an author's merged pull requests that
// Polaris merged, paired by time and repo).
const zeroCounts = () => ({ claude: 0, chat: 0, helpers: 0, prs: 0, reviews: 0, started: 0, building: 0, changes: 0, merged: 0, requests: 0, merges: 0, ringed: 0 });
// CI runs have no agent, so they are only counted overall: runs, and how many passed.
const zeroTotals = () => ({ ...zeroCounts(), ci: 0, ciPass: 0 });

export function emptyState(day) {
  return { day, agents: {}, counts: zeroTotals(), byAgent: {}, seen: {}, line: {}, feed: [], ci: [], lastIngest: 0 };
}

export function emptyReplay() {
  return { pulses: [], work: [] };
}

// Apply a clean batch to the state (returns a new state). Counts reset when `day` changes (the
// Worker passes homeDay, so at Halifax midnight); the feed, the
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
      else if (e.kind === "request") c.requests++;
      else if (e.kind === "github") {
        if (e.action === "opened_pr") c.prs++;
        if (e.action === "approved" || e.action === "requested_changes") c.reviews++;
        if (e.action === "picked_up") c.started++;
        if (e.action === "requested_changes") c.changes++;
        if (e.action === "merged") c.merged++;
        if (e.action === "merged_by") c.merges++;
      }
    }
    if (e.kind !== "github" && e.kind !== "request") continue;
    const item = workItem(e, ts);
    const pair = ringPair(s.feed, item);
    if (pair) {
      // the author's merge and Polaris's are the same pull request: ring the author's token
      const merged = item.action === "merged" ? item : pair;
      pair.paired = item.paired = true;
      merged.ring = true;
      s.counts.ringed++;
      s.byAgent[merged.agent] = { ...zeroCounts(), ...s.byAgent[merged.agent] };
      s.byAgent[merged.agent].ringed++;
    }
    s.feed.unshift(item);
  }
  // the lanes, with each event at the time it counted at
  const timed = batch.events.filter((e) => e.t === "msg" && e.kind !== "ci").map((e) => ({ ...e, ts: Math.min(e.ts ?? nowS, nowS) }));
  // building counts each job that got under way today: a Claude request after the pick-up, a pull
  // request straight away, or the two-minute wait. It is jobs started, not issues worked on: a job
  // picked up yesterday and still being built adds nothing today.
  const stepped = stepLines(s.line, timed, ENGINEERS);
  const settled = settleLines(stepped.lines, s.agents, ENGINEERS, nowS);
  for (const name of [...stepped.built, ...settled.built]) {
    s.counts.building++;
    s.byAgent[name] = { ...zeroCounts(), ...s.byAgent[name] };
    s.byAgent[name].building++;
  }
  s.line = settled.lines;
  s.feed = s.feed.slice(0, FEED);
  s.ci = s.ci.slice(0, CI_RECENT);
  s.lastIngest = now;
  return s;
}

const workItem = (e, ts) => ({ agent: e.agent, action: e.action, ...(e.repo ? { repo: e.repo } : {}), ts });

// A merge and Polaris's merge of the same pull request come from one webhook delivery with the
// same time and repo, one after the other. The page has no pull request numbers, so that is how
// they are paired: the newest unpaired one of the other kind in the feed. A pull request by
// someone the page doesn't show, merged by Polaris, has no pair and rings nothing.
function ringPair(feed, item) {
  const other = item.action === "merged" ? "merged_by" : item.action === "merged_by" ? "merged" : null;
  if (!other) return null;
  return feed.find((f) => f.action === other && !f.paired && f.ts === item.ts && f.repo === item.repo) ?? null;
}

// Add a clean batch's events to the replay buffer (returns a new buffer). Only fields that passed
// the allowlist go in, and nothing older than 24 hours stays. A row in `pulses` is
// [minute since the epoch, then the counts in COLUMNS order], so a full
// day is at most 1440 short rows. Trailing zeros are left off (a missing count is 0), so the pole
// stars' column at the end, with nothing that minute, costs nothing. `work` holds the latest GitHub actions
// and requests in the feed's shape.
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
    if (e.kind === "github" || e.kind === "request") work.push(workItem(e, ts));
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

// The last 24 hours per hour, oldest first: exactly 24 buckets { h, claude, chat, helper, github },
// where h is hours since the epoch and the last bucket is the hour `now` (ms) is in. Halifax is a
// whole number of hours from UTC in AST and ADT, so every bucket is also an hour on the Halifax
// clock, and the 24 hours run across a change of the clocks without a gap or a double hour.
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
