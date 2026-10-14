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
//   merge  a merge ({ at, repo }) that came in before its own pull request was opened (batches
//          can arrive out of order), kept until that pull request turns up

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

// Job events in the order a job goes through them; one no later than the lane's own is old news.
const JOB_RANK = { picked_up: 0, opened_pr: 1, merged: 2, started: 0, review: 1 };
const sameRepo = (a, b) => !a || !b || a === b;

// Apply clean events to the lanes of `engineers`. Any order: a batch is sorted by time, and an
// event older than what a lane already shows (a late batch, or a duplicate) leaves it alone, so
// the lanes come out as if every event had arrived in time order. Returns { lines, built } where
// built names the engineer of each job that moved from Started to Building (for today's count).
export function stepLines(lines, events, engineers) {
  const out = structuredClone(lines ?? {});
  const built = [];
  const msgs = (events ?? []).filter((e) => e?.t === "msg" && Number.isFinite(e.ts)).sort((a, b) => a.ts - b.ts);
  for (const e of msgs) {
    if (e.kind === "github" && REVIEWS.has(e.action)) {
      // anyone's review, the director's included, can send an engineer's pull request back
      const author = laneAuthor(pick(out, engineers), e.agent, e.repo);
      const lane = out[author];
      // a review from before the pull request, or before the latest one, is old news
      if (!author || e.ts < lane.at || lane.asked > e.ts) continue;
      if (e.action === "requested_changes") lane.asked = e.ts;
      else delete lane.asked;
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
    if (lane.job && e.ts < lane.at) continue;
    if (lane.job && e.ts === lane.at && JOB_RANK[e.action] <= JOB_RANK[lane.job]) continue;
    const repo = e.repo ? { repo: e.repo } : {};
    // a push or merge is about the open pull request only: one for an earlier pull request, while
    // the engineer is on a new job, or in another repo, leaves the lane alone (it still counts)
    const ours = lane.job === "review" && sameRepo(e.repo, lane.repo);
    if (e.action === "picked_up") out[e.agent] = { job: "started", at: e.ts, built: false, ...repo, steps: { started: e.ts } };
    else if (e.action === "opened_pr") {
      if (lane.job === "started" && !lane.built) built.push(e.agent); // straight to a pull request: under way all the same
      const steps = lane.job === "started" ? { ...lane.steps, review: e.ts } : { review: e.ts };
      const m = lane.merge;
      if (m && e.ts <= m.at && sameRepo(m.repo, e.repo)) {
        // its merge came first, in an earlier batch: on to Merged
        out[e.agent] = { job: "merged", at: m.at, built: true, ...repo, steps: { ...steps, merged: m.at } };
      } else out[e.agent] = { job: "review", at: e.ts, built: true, ...repo, steps };
    } else if (e.action === "pushed" && ours && !(lane.asked > e.ts)) {
      const { asked, ...rest } = lane; // the fixes are in: back to waiting for review
      out[e.agent] = { ...rest, steps: { ...lane.steps, review: lane.steps?.review ?? e.ts } };
    } else if (e.action === "merged" && ours) {
      const { asked, ...rest } = lane;
      out[e.agent] = { ...rest, job: "merged", at: e.ts, ...repo, steps: { ...lane.steps, merged: e.ts } };
    } else if (e.action === "merged" && (!lane.job || lane.job === "started") && sameRepo(e.repo, lane.repo) && !(lane.merge?.at > e.ts)) {
      // no pull request open yet: this job's may still be on its way, so keep the merge for it
      out[e.agent] = { ...lane, merge: { at: e.ts, ...repo } };
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
// the wait, Fixing from the state), so the star card has a time for every step it passed. Returns
// { lines, built } with built naming each job that went on to Building by the wait.
export function settleLines(lines, agents, engineers, nowS) {
  const out = structuredClone(lines ?? {});
  const built = [];
  for (const name of engineers) {
    const lane = out[name];
    if (!lane?.job) continue;
    const col = column(lane, agents?.[name], nowS);
    if (col === "building" && !lane.built) {
      lane.built = true;
      built.push(name);
    }
    if (col === "building" && !lane.steps?.building) lane.steps = { ...lane.steps, building: Math.min(nowS, lane.at + STARTED_FOR_S) };
    if (col === "fixing" && !lane.steps?.fixing) lane.steps = { ...lane.steps, fixing: lane.asked ?? nowS };
  }
  return { lines: out, built };
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
