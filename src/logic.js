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
export const CI_RESULTS = ["pass", "fail"];
// Fields that never reach the page, under the names GitHub's CI, deployment and push payloads use
// (hq#113): deployment environments, branches, commit messages, run URLs, actors. The same list as
// NEVER in setkernel/hq observability/wall/public.py. A clean event or agent state carrying one, at
// any depth, is dropped whole, so a future CI event can't leak them through a field added in a hurry.
export const NEVER = new Set([
  "environment", "environment_name", "environment_url", "deployment", "deployment_environment", // environments
  "ref", "branch", "branches", "head_branch", "head_ref", "base_ref", "ref_name", // branches
  "commit", "commits", "head_commit", "commit_message", "message", "display_title", // commit messages
  "run_url", "html_url", "url", "logs_url", "log_url", "jobs_url", "details_url", "target_url", "check_suite_url", // run URLs
  "actor", "triggering_actor", "sender", "pusher", "author", "committer", "login", "user", "creator", // actor logins
]);
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_EVENTS = 500;

// Does v carry a NEVER field anywhere inside it?
export function hasNever(v) {
  if (Array.isArray(v)) return v.some(hasNever);
  if (v && typeof v === "object") return Object.entries(v).some(([k, x]) => NEVER.has(k) || hasNever(x));
  return false;
}

// The last check on anything that becomes public: null if it carries a NEVER field.
export function guard(out) {
  return out && !hasNever(out) ? out : null;
}

function cleanAgentInfo(v) {
  return guard(agentInfo(v));
}

function agentInfo(v) {
  if (!v || typeof v !== "object" || !STATES.includes(v.state)) return null;
  const out = { state: v.state };
  if (WORK.includes(v.work)) out.work = v.work;
  if (typeof v.repo === "string" && REPO.test(v.repo)) out.repo = v.repo;
  return out;
}

// One pushed event -> a clean copy, or null. Unknown fields are dropped, unknown values rejected.
export function cleanEvent(e) {
  return guard(eventFields(e));
}

function eventFields(e) {
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
