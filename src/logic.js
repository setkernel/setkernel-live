// Pure logic for live.setkernel.com: validating what sk-obs01 pushes, and the public state built
// from it. No Workers APIs here, so it runs under `node --test`.
//
// sk-obs01 already filters (setkernel/hq observability/wall/public.py). This checks again, with
// the same allowlist, so a bug or a compromised publisher still can't put anything else on the page.

export const AGENTS = ["Vega", "Rigel", "Lyra", "Orion"];
export const STATES = ["WORKING", "REVIEW", "DISCUSS", "IDLE", "PAUSED"];
export const WORK = ["issue", "review", "changes", "discussion", "decision"];
export const ACTIONS = ["picked_up", "opened_pr", "approved", "requested_changes", "pushed", "posted_round", "decision_pr"];
export const CI_RESULTS = ["pass", "fail"];
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_EVENTS = 500;
const FEED = 30;
const CI_RECENT = 12;

function cleanAgentInfo(v) {
  if (!v || typeof v !== "object" || !STATES.includes(v.state)) return null;
  const out = { state: v.state };
  if (WORK.includes(v.work)) out.work = v.work;
  if (typeof v.repo === "string" && REPO.test(v.repo)) out.repo = v.repo;
  return out;
}

// One pushed event -> a clean copy, or null. Unknown fields are dropped, unknown values rejected.
export function cleanEvent(e) {
  if (!e || typeof e !== "object") return null;
  const ts = Number.isFinite(e.ts) ? Math.trunc(e.ts) : null;
  // A CI run has no agent. Only the result, and the repo name when sk-obs01 sends one: it sends a
  // name for public repos only, so a run without one shows as "a private project".
  if (e.t === "msg" && e.kind === "ci") {
    if (!CI_RESULTS.includes(e.result)) return null;
    const out = { t: "msg", kind: "ci", result: e.result, ...(ts ? { ts } : {}) };
    if (typeof e.repo === "string" && REPO.test(e.repo)) out.repo = e.repo;
    return out;
  }
  if (!AGENTS.includes(e.agent)) return null;
  if (e.t === "agent") {
    const info = cleanAgentInfo(e);
    return info ? { t: "agent", agent: e.agent, ...info, ...(ts ? { ts } : {}) } : null;
  }
  if (e.t !== "msg") return null;
  if (e.kind === "claude" || e.kind === "chat") return { t: "msg", kind: e.kind, agent: e.agent, ...(ts ? { ts } : {}) };
  if (e.kind === "github" && ACTIONS.includes(e.action)) {
    const out = { t: "msg", kind: "github", agent: e.agent, action: e.action, ...(ts ? { ts } : {}) };
    if (typeof e.repo === "string" && REPO.test(e.repo)) out.repo = e.repo;
    return out;
  }
  return null;
}

// A pushed batch -> { events, agents } with only clean content, or null if it isn't a batch.
export function cleanBatch(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.events)) return null;
  const events = body.events.slice(0, MAX_EVENTS).map(cleanEvent).filter(Boolean);
  const agents = {};
  for (const name of AGENTS) {
    const info = cleanAgentInfo(body.agents?.[name]);
    if (info) agents[name] = info;
  }
  return { events, agents };
}

export function emptyState(day) {
  return { day, agents: {}, counts: { claude: 0, chat: 0, prs: 0, reviews: 0, started: 0, ci: 0, ciPass: 0 }, feed: [], ci: [], lastIngest: 0 };
}

// Apply a clean batch to the state (returns a new state). Counts reset each UTC day; the feed and
// the recent CI results carry over.
export function applyBatch(state, batch, now, day) {
  const s = state && state.day === day ? structuredClone(state) : { ...emptyState(day), feed: state?.feed ?? [], ci: state?.ci ?? [] };
  s.counts = { ...emptyState(day).counts, ...s.counts }; // a state saved before a count existed
  s.ci ??= [];
  s.agents = batch.agents;
  for (const e of batch.events) {
    if (e.t !== "msg") continue;
    if (e.kind === "claude") s.counts.claude++;
    else if (e.kind === "chat") s.counts.chat++;
    else if (e.kind === "github") {
      if (e.action === "opened_pr") s.counts.prs++;
      if (e.action === "approved" || e.action === "requested_changes") s.counts.reviews++;
      if (e.action === "picked_up") s.counts.started++;
      s.feed.unshift({ agent: e.agent, action: e.action, ...(e.repo ? { repo: e.repo } : {}), ts: e.ts ?? Math.trunc(now / 1000) });
    } else if (e.kind === "ci") {
      s.counts.ci++;
      if (e.result === "pass") s.counts.ciPass++;
      s.ci.unshift({ result: e.result, ...(e.repo ? { repo: e.repo } : {}), ts: e.ts ?? Math.trunc(now / 1000) });
    }
  }
  s.feed = s.feed.slice(0, FEED);
  s.ci = s.ci.slice(0, CI_RECENT);
  s.lastIngest = now;
  return s;
}
