// "The line" (setkernel-live#36): the board under the sky that shows where each engineer's work
// is, Started -> Building -> In review -> Fixing -> Merged. No new data: each engineer's column comes
// from its own GitHub actions, its Claude requests and its current state, as the table in
// docs/design/v2/README.md says. Pure, so the Durable Object (through state.js), ?demo and the
// replay all run it, and it is tested.
//
// A lane is what the board remembers about one engineer's current (or last) job:
//   job    "started" (picked up an issue), "review" (opened a pull request, not merged yet),
//          "merged" (its pull request was merged), or absent (nothing seen yet)
//   at     when that job event happened (seconds)
//   built  a Claude request came after the pick-up, so the work is under way
//   repo   the job's repo, when it is public (events carry a name only for public repos)
//   asked  when a reviewer asked for changes on this pull request, if the page could tell
//   steps  when the job reached each column, for the star card's five steps

export const STAGES = ["started", "building", "review", "fixing", "merged"];
export const STAGE_NAME = { started: "Started", building: "Building", review: "In review", fixing: "Fixing", merged: "Merged" };
// A pick-up with no Claude request after it moves on to Building after this long anyway.
export const STARTED_FOR_S = 120;

const REVIEWS = new Set(["approved", "requested_changes"]);

// Who a review is about: the one engineer, other than the reviewer, whose pull request is open
// in the same public repo. Private repos have no name on the page, so they never say. Like
// reviewTarget in words.js, it names an author only when it can be sure.
export function laneAuthor(lines, reviewer, repo) {
  if (!repo) return null;
  const hits = Object.entries(lines ?? {}).filter(([name, l]) => name !== reviewer && l?.job === "review" && l.repo === repo);
  return hits.length === 1 ? hits[0][0] : null;
}

// Apply clean events (any order; they are sorted by time) to the lanes of `engineers`. Returns
// { lines, built } where built names the engineer of each job that moved from Started to Building
// (for today's count).
export function stepLines(lines, events, engineers) {
  const out = structuredClone(lines ?? {});
  const built = [];
  const msgs = (events ?? []).filter((e) => e?.t === "msg" && Number.isFinite(e.ts)).sort((a, b) => a.ts - b.ts);
  for (const e of msgs) {
    if (e.kind === "github" && REVIEWS.has(e.action)) {
      // anyone's review, the director's included, can send an engineer's pull request back
      const author = laneAuthor(pick(out, engineers), e.agent, e.repo);
      if (author && e.action === "requested_changes") out[author].asked = e.ts;
      if (author && e.action === "approved") delete out[author].asked;
      continue;
    }
    if (!engineers.includes(e.agent)) continue;
    const lane = out[e.agent] ?? {};
    if (e.kind === "claude") {
      if (lane.job === "started" && !lane.built && e.ts >= lane.at) {
        lane.built = true;
        lane.steps = { ...lane.steps, building: e.ts };
        out[e.agent] = lane;
        built.push(e.agent);
      }
      continue;
    }
    if (e.kind !== "github") continue;
    const repo = e.repo ? { repo: e.repo } : {};
    if (e.action === "picked_up") out[e.agent] = { job: "started", at: e.ts, built: false, ...repo, steps: { started: e.ts } };
    else if (e.action === "opened_pr") {
      out[e.agent] = { job: "review", at: e.ts, built: true, ...repo, steps: { ...lane.steps, review: e.ts } };
    } else if (e.action === "pushed" && (lane.job === "review" || lane.job === "started")) {
      const { asked, ...rest } = lane; // the fixes are in: back to waiting for review
      out[e.agent] = { ...rest, job: "review", steps: { ...lane.steps, review: lane.steps?.review ?? e.ts } };
    } else if (e.action === "merged") {
      const { asked, ...rest } = lane;
      out[e.agent] = { ...rest, job: "merged", at: e.ts, ...repo, steps: { ...lane.steps, merged: e.ts } };
    }
  }
  return { lines: out, built };
}

const pick = (lines, names) => Object.fromEntries(names.filter((n) => lines[n]).map((n) => [n, lines[n]]));

// Which column an engineer's card sits in, from its lane and its current state ({ state, work }).
// Addressing review feedback is Fixing whatever the lane says. A card never leaves the board:
// with no job seen yet it waits in Started.
export function column(lane, info, nowS) {
  if (info?.state === "WORKING" && info.work === "changes") return "fixing";
  if (lane?.job === "review") return "review";
  if (lane?.job === "merged") return "merged";
  if (lane?.job === "started") return !lane.built && nowS - lane.at < STARTED_FOR_S ? "started" : "building";
  if (info?.state === "WORKING" && info.work === "issue") return "building";
  return "started";
}

// After a batch: note when a job reached a column the events alone don't mark (Building after
// the wait, Fixing from the state), so the star card has a time for every step it passed.
export function settleLines(lines, agents, engineers, nowS) {
  const out = structuredClone(lines ?? {});
  for (const name of engineers) {
    const lane = out[name];
    if (!lane?.job) continue;
    const col = column(lane, agents?.[name], nowS);
    if (col === "building" && !lane.steps?.building) lane.steps = { ...lane.steps, building: Math.min(nowS, lane.at + STARTED_FOR_S) };
    if (col === "fixing" && !lane.steps?.fixing) lane.steps = { ...lane.steps, fixing: lane.asked ?? nowS };
  }
  return out;
}

// Who is reviewing whose pull request, for the reviewer chip: { author: reviewer }. Only an
// engineer in REVIEW whose state names a public repo where exactly one teammate's pull request is
// open; otherwise the reviewer is just "reviewing a pull request".
export function reviewers(agents, lines, engineers) {
  const out = {};
  for (const name of engineers) {
    const info = agents?.[name];
    if (info?.state !== "REVIEW") continue;
    const author = laneAuthor(pick(lines ?? {}, engineers), name, info.repo);
    if (author && !out[author]) out[author] = name;
  }
  return out;
}

// The five steps of the job for the star card: [{ stage, status, ts }], where status is "done",
// "now", "todo" (not reached yet) or "skip" (passed without stopping, so no time).
export function steps(lane, col) {
  const cur = STAGES.indexOf(col);
  const at = lane?.job ? lane.steps ?? {} : {};
  return STAGES.map((stage, i) => {
    const ts = Number.isFinite(at[stage]) ? at[stage] : null;
    let status;
    if (col === "merged" || i < cur) status = ts ? "done" : "skip";
    else if (i === cur) status = "now";
    else status = "todo";
    return { stage, status, ts: status === "todo" ? null : ts };
  });
}

// Replay has no agent states, only events. This guesses them the way the board needs: an engineer
// whose Claude, chat or helper pulses came in the last few minutes is working, on review feedback
// when its pull request was sent back, otherwise on its issue. `last` is { name: ts of its latest
// pulse }.
export const REPLAY_ACTIVE_S = 180;
export function replayAgents(last, lines, engineers, nowS) {
  const out = {};
  for (const name of engineers) {
    const active = nowS - (last?.[name] ?? -Infinity) <= REPLAY_ACTIVE_S;
    const lane = lines?.[name];
    if (!active) out[name] = { state: "IDLE" };
    else out[name] = { state: "WORKING", work: lane?.job === "review" && lane.asked ? "changes" : "issue", ...(lane?.repo ? { repo: lane.repo } : {}) };
  }
  return out;
}
