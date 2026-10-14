// The line (setkernel-live#36): which column each engineer's card sits in, derived from event
// sequences and states as docs/design/v2/README.md's table says, and the header counts.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { ENGINEERS, applyBatch, cleanBatch, emptyState } from "../src/logic.js";
import { STARTED_FOR_S, column, replayAgents, reviewers, settleLines, stepLines, steps } from "../public/lib/line.js";

const T0 = 490_000 * 3600;
const gh = (agent, action, ts, repo) => ({ t: "msg", kind: "github", agent, action, ts, ...(repo ? { repo } : {}) });
const claude = (agent, ts) => ({ t: "msg", kind: "claude", agent, ts });
const lanes = (events) => stepLines({}, events, ENGINEERS).lines;
const WORKING = { state: "WORKING", work: "issue" };

test("Started: a pick-up, until the first Claude request after it or about two minutes", () => {
  let l = lanes([gh("Vega", "picked_up", T0, "setkernel-live")]);
  assert.equal(column(l.Vega, WORKING, T0 + 30), "started");
  assert.equal(column(l.Vega, WORKING, T0 + STARTED_FOR_S), "building", "two minutes with no request: under way anyway");
  l = lanes([claude("Vega", T0 - 5), gh("Vega", "picked_up", T0), claude("Vega", T0 + 20)]);
  assert.equal(l.Vega.built, true, "a request before the pick-up doesn't count; the one after does");
  assert.equal(column(l.Vega, WORKING, T0 + 21), "building");
  assert.deepEqual(l.Vega.steps, { started: T0, building: T0 + 20 });
});

test("Building, then In review on its own pull request, staying there while idle or reviewing", () => {
  const l = lanes([gh("Lyra", "picked_up", T0), claude("Lyra", T0 + 10), gh("Lyra", "opened_pr", T0 + 900, "example-site")]);
  for (const info of [{ state: "IDLE" }, { state: "REVIEW", work: "review" }, { state: "DISCUSS", work: "discussion" }, undefined]) {
    assert.equal(column(l.Lyra, info, T0 + 1000), "review", JSON.stringify(info));
  }
  assert.deepEqual(l.Lyra.steps, { started: T0, building: T0 + 10, review: T0 + 900 });
  assert.equal(l.Lyra.repo, "example-site");
});

test("Fixing: working on review feedback, then back to In review after the push", () => {
  let l = lanes([gh("Orion", "picked_up", T0, "hq"), gh("Orion", "opened_pr", T0 + 100, "hq"), gh("Rigel", "requested_changes", T0 + 200, "hq")]);
  assert.equal(l.Orion.asked, T0 + 200, "a review in the same public repo names Orion's pull request");
  assert.equal(column(l.Orion, { state: "WORKING", work: "changes" }, T0 + 300), "fixing");
  l = settleLines(l, { Orion: { state: "WORKING", work: "changes" } }, ENGINEERS, T0 + 300).lines;
  assert.equal(l.Orion.steps.fixing, T0 + 200, "Fixing began when changes were asked for");
  l = stepLines(l, [gh("Orion", "pushed", T0 + 400, "hq")], ENGINEERS).lines;
  assert.equal(column(l.Orion, { state: "IDLE" }, T0 + 401), "review");
  assert.equal(l.Orion.asked, undefined);
  assert.equal(l.Orion.steps.review, T0 + 100, "In review keeps its first time");
});

test("Merged: until the next pick-up, which starts a fresh job", () => {
  let l = lanes([gh("Rigel", "picked_up", T0), gh("Rigel", "opened_pr", T0 + 100), gh("Rigel", "merged", T0 + 500)]);
  assert.equal(column(l.Rigel, { state: "REVIEW", work: "review" }, T0 + 9000), "merged");
  assert.deepEqual(steps(l.Rigel, "merged").map((s) => s.status), ["done", "skip", "done", "skip", "done"], "Building and Fixing passed with no time of their own");
  l = stepLines(l, [gh("Rigel", "picked_up", T0 + 600)], ENGINEERS).lines;
  assert.equal(column(l.Rigel, WORKING, T0 + 610), "started");
  assert.deepEqual(l.Rigel.steps, { started: T0 + 600 });
  assert.deepEqual(steps(l.Rigel, "started").map((s) => s.status), ["now", "todo", "todo", "todo", "todo"]);
});

test("a push or merge for an earlier pull request leaves the new job where it is", () => {
  const before = lanes([gh("Orion", "picked_up", T0, "hq"), claude("Orion", T0 + 5), gh("Orion", "opened_pr", T0 + 600, "hq"),
    gh("Orion", "picked_up", T0 + 700, "setkernel-live"), claude("Orion", T0 + 710)]);
  assert.equal(column(before.Orion, WORKING, T0 + 800), "building");
  for (const action of ["merged", "pushed"]) {
    const l = stepLines(before, [gh("Orion", action, T0 + 900, "hq")], ENGINEERS).lines;
    assert.equal(column(l.Orion, WORKING, T0 + 910), "building", action);
    assert.deepEqual(l.Orion, before.Orion, `${action}: the new job's lane is untouched`);
  }
  // in review in one repo, a merge in another is a different pull request too
  const open = lanes([gh("Lyra", "opened_pr", T0, "hq")]);
  assert.equal(stepLines(open, [gh("Lyra", "merged", T0 + 9, "example-site")], ENGINEERS).lines.Lyra.job, "review");
  assert.equal(stepLines(open, [gh("Lyra", "merged", T0 + 9)], ENGINEERS).lines.Lyra.job, "merged", "a merge with no repo can't be told apart");
});

test("a new pull request after a finished job starts its steps afresh", () => {
  const l = lanes([gh("Vega", "picked_up", T0), claude("Vega", T0 + 5), gh("Vega", "opened_pr", T0 + 60), gh("Vega", "merged", T0 + 120), gh("Vega", "opened_pr", T0 + 500)]);
  assert.deepEqual(l.Vega.steps, { review: T0 + 500 });
  assert.deepEqual(steps(l.Vega, "review").map((s) => s.status), ["skip", "skip", "now", "todo", "todo"]);
});

test("Building counts every job that got under way: a request, a pull request straight away, or the wait", () => {
  const b = (events, agents = {}) => cleanBatch({ events, agents });
  let s = applyBatch(emptyState("d"), b([gh("Vega", "picked_up", T0), gh("Vega", "opened_pr", T0 + 30), gh("Lyra", "picked_up", T0 + 40)]), (T0 + 50) * 1000, "d");
  assert.equal(s.counts.building, 1, "Vega went straight to a pull request");
  assert.equal(column(s.line.Lyra, WORKING, T0 + 50), "started");
  s = applyBatch(s, b([]), (T0 + 40 + STARTED_FOR_S) * 1000, "d");
  assert.equal(s.counts.building, 2, "Lyra, after the wait");
  assert.equal(s.line.Lyra.steps.building, T0 + 40 + STARTED_FOR_S);
  s = applyBatch(s, b([claude("Lyra", T0 + 200)]), (T0 + 201) * 1000, "d");
  assert.equal(s.counts.building, 2, "counted once");
});

test("no job seen yet: the card waits in Started, or Building when the state says it works on an issue", () => {
  assert.equal(column(undefined, { state: "IDLE" }, T0), "started");
  assert.equal(column(undefined, WORKING, T0), "building");
  assert.equal(column(undefined, { state: "WORKING", work: "changes" }, T0), "fixing");
});

test("private repos never tie a review to an author; two open pull requests in one repo don't either", () => {
  let l = lanes([gh("Vega", "opened_pr", T0), gh("Rigel", "requested_changes", T0 + 10)]);
  assert.equal(l.Vega.asked, undefined);
  l = lanes([gh("Vega", "opened_pr", T0, "hq"), gh("Lyra", "opened_pr", T0 + 1, "hq"), gh("Rigel", "requested_changes", T0 + 10, "hq")]);
  assert.equal(l.Vega.asked ?? l.Lyra.asked, undefined);
  assert.equal(lanes([gh("Vega", "opened_pr", T0, "hq"), gh("Vega", "requested_changes", T0 + 1, "hq")]).Vega.asked, undefined, "not your own");
  assert.equal(lanes([gh("Vega", "opened_pr", T0, "hq"), gh("Polaris", "requested_changes", T0 + 1, "hq")]).Vega.asked, T0 + 1, "the director's review counts");
  assert.equal(lanes([gh("Kochab", "picked_up", T0)]).Kochab, undefined, "the pole stars have no lane");
});

test("reviewer chip: joined to the author only when the review names one", () => {
  const l = lanes([gh("Lyra", "opened_pr", T0, "setkernel-live"), gh("Vega", "opened_pr", T0, "hq")]);
  assert.deepEqual(reviewers({ Rigel: { state: "REVIEW", work: "review", repo: "setkernel-live" } }, l, ENGINEERS), { Lyra: "Rigel" });
  assert.deepEqual(reviewers({ Rigel: { state: "REVIEW", work: "review" } }, l, ENGINEERS), {}, "private: just reviewing a pull request");
  assert.deepEqual(reviewers({ Lyra: { state: "REVIEW", repo: "setkernel-live" } }, l, ENGINEERS), {}, "not your own");
});

test("the Durable Object's state keeps the lanes and the line's header counts", () => {
  const b = (events, agents = {}) => cleanBatch({ events, agents });
  let s = applyBatch(emptyState("d"), b([gh("Vega", "picked_up", T0, "hq"), claude("Vega", T0 + 5), gh("Lyra", "opened_pr", T0 + 6, "hq"),
    gh("Vega", "requested_changes", T0 + 7, "hq"), gh("Lyra", "merged", T0 + 8, "hq"), gh("Kochab", "merged", T0 + 9)], { Vega: WORKING }), (T0 + 10) * 1000, "d");
  assert.deepEqual([s.counts.started, s.counts.building, s.counts.prs, s.counts.changes, s.counts.merged], [1, 1, 1, 1, 2]);
  assert.equal(s.byAgent.Vega.building, 1);
  assert.equal(s.byAgent.Kochab.merged, 1, "the director's sessions' merges count too");
  assert.equal(column(s.line.Vega, s.agents.Vega, T0 + 10), "building");
  assert.equal(column(s.line.Lyra, undefined, T0 + 10), "merged");
  assert.deepEqual(Object.keys(s.line).sort(), ["Lyra", "Vega"]);
  // a second Claude request doesn't count the job again, and the lanes carry over midnight
  s = applyBatch(s, b([claude("Vega", T0 + 20)]), (T0 + 21) * 1000, "d");
  assert.equal(s.counts.building, 1);
  s = applyBatch(s, b([]), (T0 + 86_400) * 1000, "e");
  assert.equal(s.counts.building, 0);
  assert.equal(s.line.Vega.job, "started");
  assert.doesNotMatch(JSON.stringify(s.line), /title|number|branch|login/, "nothing beyond actions, times and public repo names");
});

test("replay guesses states from pulses: working on feedback once a pull request was sent back", () => {
  const l = lanes([gh("Orion", "opened_pr", T0, "hq"), gh("Rigel", "requested_changes", T0 + 10, "hq")]);
  const a = replayAgents({ Orion: T0 + 50, Vega: T0 - 1000 }, l, ENGINEERS, T0 + 60);
  assert.deepEqual(a.Orion, { state: "WORKING", work: "changes", repo: "hq" });
  assert.deepEqual(a.Vega, { state: "IDLE" });
  assert.equal(column(l.Orion, a.Orion, T0 + 60), "fixing");
});
