// Pure logic for live.setkernel.com: validating what sk-obs01 pushes, and the public state built
// from it. No Workers APIs here, so it runs under `node --test`.
//
// sk-obs01 already filters (setkernel/hq observability/wall/public.py). This checks again, with
// the same allowlist, so a bug or a compromised publisher still can't put anything else on the page.
//
// The state built from clean batches lives in public/lib/state.js, because ?demo mode on the page
// runs the same code; it is re-exported here.
import { AGENTS } from "../public/lib/state.js";

export { AGENTS };
export { applyBatch, emptyReplay, emptyState, hourly, recordReplay, replaySince, view } from "../public/lib/state.js";
export const STATES = ["WORKING", "REVIEW", "DISCUSS", "IDLE", "PAUSED"];
export const WORK = ["issue", "review", "changes", "discussion", "decision"];
export const ACTIONS = ["picked_up", "opened_pr", "approved", "requested_changes", "pushed", "posted_round", "decision_pr"];
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_EVENTS = 500;

function cleanAgentInfo(v) {
  if (!v || typeof v !== "object" || !STATES.includes(v.state)) return null;
  const out = { state: v.state };
  if (WORK.includes(v.work)) out.work = v.work;
  if (typeof v.repo === "string" && REPO.test(v.repo)) out.repo = v.repo;
  return out;
}

// One pushed event -> a clean copy, or null. Unknown fields are dropped, unknown values rejected.
export function cleanEvent(e) {
  if (!e || typeof e !== "object" || !AGENTS.includes(e.agent)) return null;
  const ts = Number.isFinite(e.ts) ? Math.trunc(e.ts) : null;
  if (e.t === "agent") {
    const info = cleanAgentInfo(e);
    return info ? { t: "agent", agent: e.agent, ...info, ...(ts ? { ts } : {}) } : null;
  }
  if (e.t !== "msg") return null;
  // "helper": the agent used a subagent or a skill. Which one is never accepted or shown.
  if (e.kind === "claude" || e.kind === "chat" || e.kind === "helper") return { t: "msg", kind: e.kind, agent: e.agent, ...(ts ? { ts } : {}) };
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
