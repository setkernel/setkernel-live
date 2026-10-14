// What the Worker accepts from sk-obs01, and the public state it builds. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { NEVER, applyBatch, cleanBatch, cleanEvent, emptyState, guard, hasNever } from "../src/logic.js";

test("only allowlisted events and fields survive", () => {
  assert.deepEqual(cleanEvent({ t: "msg", kind: "claude", agent: "Vega", ts: 5, host: "vega-dev", text: "x" }), { t: "msg", kind: "claude", agent: "Vega", ts: 5 });
  assert.deepEqual(cleanEvent({ t: "msg", kind: "github", agent: "Rigel", action: "opened_pr", repo: "lafka-plugin", ref: "lafka-plugin#9" }),
    { t: "msg", kind: "github", agent: "Rigel", action: "opened_pr", repo: "lafka-plugin" });
  assert.deepEqual(cleanEvent({ t: "agent", agent: "Lyra", state: "REVIEW", work: "review", task: "REVIEW keelpost#31" }), { t: "agent", agent: "Lyra", state: "REVIEW", work: "review" });
  for (const bad of [
    { t: "msg", kind: "claude", agent: "raghav-dev" },
    { t: "msg", kind: "telemetry", agent: "Vega" },
    { t: "msg", kind: "github", agent: "Vega", action: "asked_review" },
    { t: "agent", agent: "Vega", state: "HACKED" },
    { t: "metrics", agent: "Vega" },
    null, "x", 42,
  ]) assert.equal(cleanEvent(bad), null, JSON.stringify(bad));
});

test("repo names must look like repo names", () => {
  const e = (repo) => cleanEvent({ t: "msg", kind: "github", agent: "Vega", action: "pushed", repo });
  assert.equal(e("lafka-plugin").repo, "lafka-plugin");
  for (const bad of ["<script>", "a/b", "x".repeat(101), "", 7]) assert.equal(e(bad).repo, undefined, String(bad));
});

test("Polaris and its three Claudes: their GitHub actions only, never a state; merged is an action", () => {
  for (const agent of ["Polaris", "Kochab", "Pherkad", "Yildun"]) {
    for (const action of ["opened_pr", "merged", "approved", "requested_changes"]) {
      assert.deepEqual(cleanEvent({ t: "msg", kind: "github", agent, action, repo: "hq", ts: 9, title: "secret", number: 12, branch: "claude/x", login: "realRaghavGupta" }),
        { t: "msg", kind: "github", agent, action, repo: "hq", ts: 9 });
    }
    // no state, and no Claude requests, chat posts or helpers: only GitHub sees them
    assert.equal(cleanEvent({ t: "agent", agent, state: "WORKING", work: "issue", repo: "hq" }), null, `${agent} state`);
    for (const kind of ["claude", "chat", "helper"]) assert.equal(cleanEvent({ t: "msg", kind, agent, ts: 1 }), null, `${agent} ${kind}`);
  }
  assert.deepEqual(cleanEvent({ t: "msg", kind: "github", agent: "Vega", action: "merged" }), { t: "msg", kind: "github", agent: "Vega", action: "merged" });
  // the names the page never shows, as an agent
  for (const name of ["Claude", "claude", "Raghav", "raghav-dev", "realRaghavGupta", "polaris"]) assert.equal(cleanEvent({ t: "msg", kind: "github", agent: name, action: "opened_pr" }), null, name);
  assert.deepEqual(cleanBatch({ events: [], agents: { Polaris: { state: "IDLE" }, Pherkad: { state: "WORKING" }, Claude: { state: "IDLE" }, Vega: { state: "IDLE" } } }).agents, { Vega: { state: "IDLE" } });
});

test("a batch keeps the four engineers' states only and caps the event count", () => {
  const b = cleanBatch({ events: Array.from({ length: 600 }, () => ({ t: "msg", kind: "claude", agent: "Orion" })), agents: { Vega: { state: "WORKING", work: "issue" }, Mallory: { state: "IDLE" } } });
  assert.equal(b.events.length, 500);
  assert.deepEqual(b.agents, { Vega: { state: "WORKING", work: "issue" } });
  assert.equal(cleanBatch({}), null);
  assert.equal(cleanBatch(null), null);
});

test("counts and feed, reset each day", () => {
  const batch = cleanBatch({ events: [
    { t: "msg", kind: "github", agent: "Vega", action: "picked_up", ts: 100 },
    { t: "msg", kind: "claude", agent: "Vega", ts: 101 },
    { t: "msg", kind: "github", agent: "Vega", action: "opened_pr", repo: "lafka-plugin", ts: 102 },
    { t: "msg", kind: "github", agent: "Rigel", action: "approved", ts: 103 },
    { t: "msg", kind: "chat", agent: "Rigel", ts: 104 },
  ], agents: {} });
  let s = applyBatch(emptyState("2026-10-13"), batch, 1_000_000, "2026-10-13");
  assert.deepEqual(s.counts, { claude: 1, chat: 1, helpers: 0, prs: 1, reviews: 1, started: 1, ci: 0, ciPass: 0 });
  assert.deepEqual(s.feed[0], { agent: "Rigel", action: "approved", ts: 103 });
  assert.equal(s.feed.length, 3);
  assert.equal(s.lastIngest, 1_000_000);
  s = applyBatch(s, cleanBatch({ events: [], agents: {} }), 2_000_000, "2026-10-14");
  assert.deepEqual(s.counts, { claude: 0, chat: 0, helpers: 0, prs: 0, reviews: 0, started: 0, ci: 0, ciPass: 0 });
  assert.equal(s.feed.length, 3); // the feed carries over midnight
  const many = cleanBatch({ events: Array.from({ length: 50 }, (_, i) => ({ t: "msg", kind: "github", agent: "Lyra", action: "pushed", ts: i })), agents: {} });
  assert.equal(applyBatch(s, many, 3, "2026-10-14").feed.length, 30);
});

test("CI results: the accepted shape, extra fields dropped, no repo unless sent", () => {
  assert.deepEqual(cleanEvent({ t: "msg", kind: "ci", result: "pass", repo: "setkernel-live", ts: 7 }), { t: "msg", kind: "ci", result: "pass", repo: "setkernel-live", ts: 7 });
  assert.deepEqual(cleanEvent({ t: "msg", kind: "ci", result: "fail" }), { t: "msg", kind: "ci", result: "fail" });
  // never branch, commit message, run URL, actor or anything else, and no agent either
  assert.deepEqual(cleanEvent({ t: "msg", kind: "ci", result: "fail", agent: "Vega", branch: "main", message: "fix: x", url: "https://github.com/x", actor: "someone", workflow: "deploy", environment: "prod" }),
    { t: "msg", kind: "ci", result: "fail" });
  assert.equal(cleanEvent({ t: "msg", kind: "ci", result: "pass", repo: "a/b" }).repo, undefined);
  for (const bad of [
    { t: "msg", kind: "ci" },
    { t: "msg", kind: "ci", result: "cancelled" },
    { t: "msg", kind: "ci", result: "PASS" },
    { t: "agent", kind: "ci", result: "pass" },
    { t: "msg", kind: "claude" }, // other kinds still need an agent
  ]) assert.equal(cleanEvent(bad), null, JSON.stringify(bad));
});

test("CI counts, pass count and recent results", () => {
  const ci = (result, repo, ts) => ({ t: "msg", kind: "ci", result, ...(repo ? { repo } : {}), ts });
  const batch = cleanBatch({ events: [ci("pass", "setkernel-live", 1), ci("fail", undefined, 2), ci("pass", undefined, 3)], agents: {} });
  let s = applyBatch(emptyState("2026-10-13"), batch, 1_000_000, "2026-10-13");
  assert.equal(s.counts.ci, 3);
  assert.equal(s.counts.ciPass, 2);
  assert.deepEqual(s.ci, [{ result: "pass", ts: 3 }, { result: "fail", ts: 2 }, { result: "pass", repo: "setkernel-live", ts: 1 }]);
  assert.equal(s.feed.length, 0); // CI runs aren't agent work
  assert.deepEqual([s.byAgent, s.seen], [{}, {}]); // and have no agent to count or see
  s = applyBatch(s, cleanBatch({ events: Array.from({ length: 20 }, (_, i) => ci("pass", undefined, 10 + i)), agents: {} }), 2_000_000, "2026-10-13");
  assert.equal(s.ci.length, 12);
  assert.equal(s.counts.ci, 23);
  s = applyBatch(s, cleanBatch({ events: [], agents: {} }), 3_000_000, "2026-10-14");
  assert.equal(s.counts.ci, 0);
  assert.equal(s.counts.ciPass, 0);
  assert.equal(s.ci.length, 12); // recent results carry over midnight, like the feed
});

test("a state saved before CI existed still counts CI", () => {
  const old = { day: "2026-10-13", agents: {}, counts: { claude: 4, chat: 0, prs: 0, reviews: 0, started: 0 }, feed: [], lastIngest: 1 };
  const s = applyBatch(old, cleanBatch({ events: [{ t: "msg", kind: "ci", result: "pass", ts: 1 }], agents: {} }), 2, "2026-10-13");
  assert.deepEqual(s.counts, { claude: 4, chat: 0, helpers: 0, prs: 0, reviews: 0, started: 0, ci: 1, ciPass: 1 });
  assert.deepEqual(s.ci, [{ result: "pass", ts: 1 }]);
});

test("helper events: agent only, nothing else", () => {
  assert.deepEqual(cleanEvent({ t: "msg", kind: "helper", agent: "Orion", ts: 7 }), { t: "msg", kind: "helper", agent: "Orion", ts: 7 });
  assert.deepEqual(cleanEvent({ t: "msg", kind: "helper", agent: "Lyra", name: "setkernel:reviewer", type: "subagent", skill: "verify", repo: "hq", action: "opened_pr" }),
    { t: "msg", kind: "helper", agent: "Lyra" });
  for (const bad of [
    { t: "msg", kind: "helper", agent: "Mallory" },
    { t: "msg", kind: "helper", agent: "orion" },
    { t: "msg", kind: "helper" },
    { t: "agent", kind: "helper", agent: "Vega" },
  ]) assert.equal(cleanEvent(bad), null, JSON.stringify(bad));
});

// CI and deploy detail that must never be public (hq#113), as GitHub names it, with values to look for.
// The same fixture as test_public.py in setkernel/hq.
const CI = {
  environment: "production", ref: "refs/heads/agent/126-leaky-branch", branch: "agent/126-leaky-branch", head_branch: "agent/126-leaky-branch",
  commit_message: "fix: rotate the Stripe key", message: "fix: rotate the Stripe key",
  head_commit: { message: "fix: rotate the Stripe key", author: { name: "Rigel" } },
  run_url: "https://github.com/setkernel/lafka-plugin/actions/runs/123", html_url: "https://github.com/setkernel/lafka-plugin/actions/runs/123",
  actor: "rigel-setkernel", pusher: { name: "rigel-setkernel" }, triggering_actor: { login: "rigel-setkernel" },
};
const CI_VALUES = ["production", "leaky-branch", "Stripe", "actions/runs", "rigel-setkernel", "https://"];
const assertNoCi = (v) => {
  assert.equal(hasNever(v), false, JSON.stringify(v));
  for (const bad of CI_VALUES) assert.ok(!JSON.stringify(v).includes(bad), `${bad} in ${JSON.stringify(v)}`);
};

test("the never list covers each kind and the allowlist uses none of it", () => {
  // environment, branch, commit message, run URL, actor: remove one and this fails
  for (const f of ["environment", "deployment", "ref", "branch", "head_branch", "head_ref", "ref_name", "commit_message", "message",
    "head_commit", "run_url", "html_url", "url", "log_url", "details_url", "actor", "pusher", "triggering_actor", "sender", "login"]) {
    assert.ok(NEVER.has(f), f);
  }
  const allowed = ["t", "kind", "agent", "action", "repo", "ts", "state", "work", "events", "agents", "day", "counts", "feed", "lastIngest", "result", "ci", "ciPass"];
  assert.deepEqual(allowed.filter((k) => NEVER.has(k)), []);
});

test("CI detail on any event never survives cleaning", () => {
  const events = [
    { t: "msg", kind: "github", agent: "Vega", action: "pushed", repo: "lafka-plugin", ts: 1, ...CI },
    { t: "msg", kind: "claude", agent: "Vega", ts: 2, ...CI },
    { t: "msg", kind: "chat", agent: "Vega", ts: 3, ...CI },
    { t: "agent", agent: "Vega", state: "WORKING", work: "issue", repo: "lafka-plugin", ...CI },
    { t: "msg", kind: "ci", agent: "Vega", action: "pushed", repo: "lafka-plugin", status: "failure", ...CI },
    { t: "ci", agent: "Vega", repo: "lafka-plugin", conclusion: "success", ...CI },
    { t: "deploy", agent: "Vega", repo: "lafka-plugin", ...CI },
  ];
  const clean = events.map(cleanEvent).filter(Boolean);
  assert.equal(clean.length, 4); // the allowed parts still go
  for (const e of clean) assertNoCi(e);
  const b = cleanBatch({ events, agents: { Vega: { state: "WORKING", work: "issue", repo: "lafka-plugin", ...CI } }, ...CI });
  assert.deepEqual(b.agents, { Vega: { state: "WORKING", work: "issue", repo: "lafka-plugin" } });
  assertNoCi(b);
  assertNoCi(applyBatch(emptyState("2026-10-13"), b, 1_000_000, "2026-10-13"));
});

test("anything that would carry a never field is dropped whole", () => {
  // if a later change copies a CI field into the clean output, guard() turns it into null
  const base = { t: "msg", kind: "github", agent: "Vega", action: "pushed" };
  for (const field of NEVER) {
    for (const extra of [{ [field]: "x" }, { detail: { [field]: "x" } }, { detail: [{ [field]: "x" }] }]) {
      assert.equal(guard({ ...base, ...extra }), null, JSON.stringify(extra));
    }
  }
  const ok = { ...base, detail: { ok: ["x"] } };
  assert.equal(guard(ok), ok); // the check itself lets clean output through
  assert.equal(guard(null), null);
});
