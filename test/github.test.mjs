// The GitHub Actions receiver: signature, size cap, dedupe, collapse, stored fields and the pull
// cursor. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { EVENTS, actorFor, cleanDelivery, cleanWebhook, emptyQueue, fetchHub, MAX_WEBHOOK_BODY, parseCursor, pushEvent, readCapped, readQueue, verifySignature } from "../src/github.js";

const SECRET = "test-secret-not-real";
async function sign(body, secret = SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${Buffer.from(mac).toString("hex")}`;
}

// A workflow_run payload with the fields that must never come through.
const runPayload = (over = {}) => ({
  action: "completed",
  workflow: { id: 7, name: "CI", path: ".github/workflows/ci.yml" },
  workflow_run: {
    id: 1001,
    name: "CI",
    display_title: "fix: secret commit message",
    head_branch: "agent/secret-branch",
    head_sha: "abc123",
    html_url: "https://github.com/setkernel/hidden/actions/runs/1001",
    conclusion: "success",
    run_attempt: 1,
    updated_at: "2026-10-13T12:00:00Z",
    actor: { login: "someone" },
    triggering_actor: { login: "someone" },
    head_commit: { message: "fix: secret commit message", author: { email: "a@example.com" } },
    ...over.run,
  },
  repository: { id: 5, name: "setkernel-live", full_name: "setkernel/setkernel-live", private: false, html_url: "https://github.com/setkernel/setkernel-live", ...over.repo },
  sender: { login: "someone" },
  ...over.top,
});

const deployPayload = (state = "success") => ({
  action: "created",
  deployment_status: { id: 9, state, environment: "production-secret", target_url: "https://x", creator: { login: "someone" }, updated_at: "2026-10-13T12:05:00Z" },
  deployment: { id: 300, environment: "production-secret", ref: "main", sha: "abc", creator: { login: "someone" } },
  workflow: { name: "Deploy" },
  repository: { name: "setkernel-live", private: false },
  sender: { login: "someone" },
});

// A pull_request payload by `login` from branch `head`, with the fields that must never come through.
const prPayload = ({ action = "opened", login = "vega-setkernel", head = "agent/33-secret-branch", merged = false, repo = {} } = {}) => ({
  action,
  number: 4242,
  pull_request: {
    id: 777001,
    number: 4242,
    title: "feat: secret title",
    body: "secret body",
    html_url: "https://github.com/setkernel/hidden/pull/4242",
    user: { login, id: 1 },
    head: { ref: head, sha: "abc123", label: `setkernel:${head}` },
    base: { ref: "main" },
    merged,
    merged_by: merged ? { login: "realRaghavGupta" } : null,
    created_at: "2026-10-14T12:00:00Z",
    merged_at: merged ? "2026-10-14T13:00:00Z" : null,
  },
  repository: { name: "setkernel-live", full_name: "setkernel/setkernel-live", private: false, ...repo },
  sender: { login },
});
const reviewPayload = ({ state = "approved", login = "rigel-setkernel", head = "agent/33-secret-branch", action = "submitted" } = {}) => ({
  ...prPayload({ action, login: "vega-setkernel", head }),
  review: { id: 555, state, body: "secret review", user: { login }, html_url: "https://github.com/x", submitted_at: "2026-10-14T12:30:00Z" },
  sender: { login },
});
const NEVER_PR = ["secret", "4242", "777001", "vega-setkernel", "rigel-setkernel", "realRaghavGupta", "claude/", "agent/", "https://", "main", "abc"];

test("pull requests and reviews are listened for next to CI", () => {
  assert.deepEqual(EVENTS, ["workflow_run", "deployment_status", "pull_request", "pull_request_review"]);
});

test("actors: the four agents by login, Raghav's account only on a claude/ branch, nobody else", () => {
  assert.equal(actorFor("vega-setkernel", "agent/1-x"), "Vega");
  assert.equal(actorFor("Rigel-Setkernel", undefined), "Rigel", "logins are case-insensitive");
  assert.equal(actorFor("lyra-setkernel", "claude/x"), "Lyra");
  assert.equal(actorFor("orion-setkernel", "main"), "Orion");
  assert.equal(actorFor("realRaghavGupta", "claude/fix-the-thing"), "Claude");
  assert.equal(actorFor("realraghavgupta", "claude/x"), "Claude");
  for (const head of ["agent/33-x", "feature/claude/x", "Claude/x", "claude", "main", undefined, 7]) assert.equal(actorFor("realRaghavGupta", head), null, `Raghav on ${head}`);
  for (const login of ["someone", "dependabot[bot]", "vega", "vega-setkernel-evil", "", undefined, null, 5, "constructor", "__proto__", "toString"]) {
    assert.equal(actorFor(login, "claude/x"), null, String(login));
  }
});

test("pull requests: opened and merged keep only kind, action, repo, private, actor and time", () => {
  const opened = cleanWebhook("pull_request", prPayload());
  assert.deepEqual(opened, { key: "pr:777001:opened_pr", event: { kind: "pr", repo: "setkernel-live", private: false, action: "opened_pr", actor: "Vega", ts: Date.parse("2026-10-14T12:00:00Z") / 1000 } });
  const merged = cleanWebhook("pull_request", prPayload({ action: "closed", merged: true, login: "realRaghavGupta", head: "claude/secret-branch" }));
  assert.deepEqual(merged, { key: "pr:777001:merged", event: { kind: "pr", repo: "setkernel-live", private: false, action: "merged", actor: "Claude", ts: Date.parse("2026-10-14T13:00:00Z") / 1000 } });
  for (const c of [opened, merged]) {
    const text = JSON.stringify(c.event);
    for (const never of NEVER_PR) assert.ok(!text.includes(never), `${never} leaked: ${text}`);
  }
  // the author is the actor, not whoever merged it
  assert.equal(cleanWebhook("pull_request", prPayload({ action: "closed", merged: true, login: "orion-setkernel" })).event.actor, "Orion");
  assert.equal(cleanWebhook("pull_request", prPayload({ repo: { private: true } })).event.private, true);
  assert.equal(cleanWebhook("pull_request", prPayload({ repo: { private: undefined } })).event.private, true);
});

test("pull requests: closed unmerged, other actions, Raghav off claude/ and unknown logins are dropped", () => {
  assert.equal(cleanWebhook("pull_request", prPayload({ action: "closed", merged: false })), null);
  assert.equal(cleanWebhook("pull_request", prPayload({ action: "closed", merged: "true" })), null);
  for (const action of ["edited", "synchronize", "reopened", "labeled", "ready_for_review", "assigned"]) assert.equal(cleanWebhook("pull_request", prPayload({ action })), null, action);
  assert.equal(cleanWebhook("pull_request", prPayload({ login: "realRaghavGupta", head: "agent/33-x" })), null, "Raghav's own pull request");
  assert.equal(cleanWebhook("pull_request", prPayload({ action: "closed", merged: true, login: "realRaghavGupta", head: "fix/x" })), null);
  assert.equal(cleanWebhook("pull_request", prPayload({ login: "someone-else", head: "claude/x" })), null, "an unknown login");
  assert.equal(cleanWebhook("pull_request", { ...prPayload(), pull_request: { ...prPayload().pull_request, id: "1" } }), null);
  assert.equal(cleanWebhook("pull_request", { ...prPayload(), pull_request: undefined }), null);
  assert.equal(cleanWebhook("pull_request", prPayload({ repo: { name: "../x" } })), null);
});

test("reviews: approvals and change requests by a known reviewer, nothing else", () => {
  const ok = cleanWebhook("pull_request_review", reviewPayload());
  assert.deepEqual(ok, { key: "review:555", event: { kind: "pr", repo: "setkernel-live", private: false, action: "approved", actor: "Rigel", ts: Date.parse("2026-10-14T12:30:00Z") / 1000 } });
  for (const never of NEVER_PR) assert.ok(!JSON.stringify(ok.event).includes(never), never);
  assert.equal(cleanWebhook("pull_request_review", reviewPayload({ state: "changes_requested" })).event.action, "requested_changes");
  assert.equal(cleanWebhook("pull_request_review", reviewPayload({ state: "APPROVED" })).event.action, "approved");
  // the reviewer is the actor; Raghav's account counts only on a claude/ branch
  assert.equal(cleanWebhook("pull_request_review", reviewPayload({ login: "realRaghavGupta", head: "claude/x" })).event.actor, "Claude");
  assert.equal(cleanWebhook("pull_request_review", reviewPayload({ login: "realRaghavGupta" })), null, "Raghav reviewing off claude/");
  assert.equal(cleanWebhook("pull_request_review", reviewPayload({ login: "stranger" })), null);
  for (const state of ["commented", "dismissed", "pending", "", null]) assert.equal(cleanWebhook("pull_request_review", reviewPayload({ state })), null, String(state));
  for (const action of ["edited", "dismissed"]) assert.equal(cleanWebhook("pull_request_review", reviewPayload({ action })), null, action);
});

test("a pull request's open, merge and each review queue once each; a repeated open replaces itself", () => {
  let q = emptyQueue();
  q = pushEvent(q, "d-1", cleanWebhook("pull_request", prPayload())).queue;
  q = pushEvent(q, "d-2", cleanWebhook("pull_request_review", reviewPayload())).queue;
  q = pushEvent(q, "d-3", cleanWebhook("pull_request", prPayload({ action: "closed", merged: true }))).queue;
  q = pushEvent(q, "d-4", cleanWebhook("pull_request", prPayload())).queue; // the same open, delivered again under a new id
  assert.deepEqual(q.items.map((it) => it.event.action), ["approved", "merged", "opened_pr"]);
  const out = readQueue(q, 0);
  for (const e of out.events) assert.deepEqual(Object.keys(e).sort(), ["action", "actor", "cursor", "kind", "private", "repo", "ts"]);
  assert.ok(!JSON.stringify(out).includes("777001") && !JSON.stringify(out).includes("review:"), "keys stay inside the Hub");
});

test("a good signature passes; a bad, missing or wrong-secret one fails", async () => {
  const body = JSON.stringify(runPayload());
  const sig = await sign(body);
  assert.equal(await verifySignature(SECRET, body, sig), true);
  assert.equal(await verifySignature(SECRET, new TextEncoder().encode(body), sig), true); // bytes too
  assert.equal(await verifySignature(SECRET, body + " ", sig), false); // body changed
  assert.equal(await verifySignature(SECRET, body, await sign(body, "other-secret")), false);
  assert.equal(await verifySignature(SECRET, body, sig.replace("sha256=", "sha1=")), false);
  assert.equal(await verifySignature(SECRET, body, sig.slice(0, -2)), false);
  assert.equal(await verifySignature(SECRET, body, `sha256=${"0".repeat(64)}`), false);
  for (const junk of [null, undefined, "", "sha256=", "sha256=zz"]) assert.equal(await verifySignature(SECRET, body, junk), false);
  assert.equal(await verifySignature("", body, sig), false); // no secret configured
});

test("an oversize body is rejected, by header or by what is actually sent", async () => {
  const ok = await readCapped(new Request("https://x/github/webhook", { method: "POST", body: "a".repeat(100) }), 1000);
  assert.equal(ok.byteLength, 100);
  const big = "a".repeat(MAX_WEBHOOK_BODY + 1);
  assert.equal(await readCapped(new Request("https://x/github/webhook", { method: "POST", body: big })), null);
  // a lying Content-Length doesn't help: the stream is counted as it is read
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(400));
      c.close();
    },
  });
  const lying = new Request("https://x/github/webhook", { method: "POST", body: stream, duplex: "half", headers: { "Content-Length": "10" } });
  assert.equal(await readCapped(lying, 1000), null);
  assert.equal(await readCapped(new Request("https://x/github/webhook", { method: "POST", headers: { "Content-Length": "2000" }, body: "short" }), 1000), null);
});

test("only the stored fields come through, for runs and deployments", () => {
  const run = cleanWebhook("workflow_run", runPayload());
  assert.deepEqual(run, { key: "run:1001", event: { kind: "run", repo: "setkernel-live", private: false, workflow: "CI", conclusion: "success", ts: Date.parse("2026-10-13T12:00:00Z") / 1000 } });
  const dep = cleanWebhook("deployment_status", deployPayload());
  assert.deepEqual(dep, { key: "deploy:300", event: { kind: "deploy", repo: "setkernel-live", private: false, workflow: "Deploy", conclusion: "success", ts: Date.parse("2026-10-13T12:05:00Z") / 1000 } });
  for (const c of [run, dep]) {
    const text = JSON.stringify(c.event);
    for (const never of ["secret", "someone", "https://", "abc", "main", "production"]) assert.ok(!text.includes(never), `${never} leaked: ${text}`);
  }
});

test("private is kept, and anything but private:false counts as private", () => {
  assert.equal(cleanWebhook("workflow_run", runPayload({ repo: { private: true } })).event.private, true);
  assert.equal(cleanWebhook("workflow_run", runPayload({ repo: { private: undefined } })).event.private, true);
  assert.equal(cleanWebhook("workflow_run", runPayload({ repo: { private: "false" } })).event.private, true);
});

test("only completed workflow runs and finished deployments are accepted", () => {
  for (const action of ["requested", "in_progress"]) assert.equal(cleanWebhook("workflow_run", runPayload({ top: { action } })), null);
  assert.equal(cleanWebhook("workflow_run", runPayload({ run: { conclusion: null } })), null);
  assert.equal(cleanWebhook("workflow_run", runPayload({ run: { conclusion: "made-up" } })), null);
  assert.equal(cleanWebhook("workflow_run", runPayload({ run: { conclusion: "failure" } })).event.conclusion, "failure");
  for (const state of ["pending", "queued", "in_progress", "inactive"]) assert.equal(cleanWebhook("deployment_status", deployPayload(state)), null);
  assert.equal(cleanWebhook("deployment_status", deployPayload("error")).event.conclusion, "error");
  for (const other of ["push", "pull_request", "workflow_job", "check_run", "ping"]) assert.equal(cleanWebhook(other, runPayload()), null);
  assert.equal(cleanWebhook("workflow_run", runPayload({ repo: { name: "bad name/../x" } })), null);
  assert.equal(cleanWebhook("workflow_run", null), null);
});

test("a workflow name is cleaned and never taken from the run title", () => {
  const p = runPayload({ top: { workflow: undefined }, run: { name: "Build\nand\u0007test" } });
  assert.equal(cleanWebhook("workflow_run", p).event.workflow, "Build and test");
  assert.equal(cleanWebhook("workflow_run", runPayload({ top: { workflow: { name: "x".repeat(300) } } })).event.workflow.length, 100);
  const dep = deployPayload();
  delete dep.workflow;
  assert.equal(cleanWebhook("deployment_status", dep).event.workflow, "deployment");
});

test("a delivery id seen before changes nothing", () => {
  const ev = cleanWebhook("workflow_run", runPayload());
  const first = pushEvent(emptyQueue(), "d-1", ev);
  assert.equal(first.added, true);
  const again = pushEvent(first.queue, "d-1", ev);
  assert.equal(again.added, false);
  assert.equal(again.queue, first.queue);
  assert.equal(cleanDelivery("72d3162e-cc78-11e3-81ab-4c9367dc0958"), "72d3162e-cc78-11e3-81ab-4c9367dc0958");
  for (const bad of [null, "", "x".repeat(65), "a b", "a/b"]) assert.equal(cleanDelivery(bad), null);
  // the remembered ids are capped
  let q = emptyQueue();
  for (let i = 0; i < 5; i++) q = pushEvent(q, `d-${i}`, { key: `run:${i}`, event: { kind: "run" } }, { deliveryCap: 3 }).queue;
  assert.deepEqual(q.deliveries, ["d-2", "d-3", "d-4"]);
});

test("each run collapses to one queued event, the latest, with a new cursor", () => {
  let q = emptyQueue();
  q = pushEvent(q, "d-1", cleanWebhook("workflow_run", runPayload({ run: { conclusion: "failure" } }))).queue;
  q = pushEvent(q, "d-2", cleanWebhook("workflow_run", runPayload({ run: { id: 2002 } }))).queue;
  q = pushEvent(q, "d-3", cleanWebhook("workflow_run", runPayload({ run: { conclusion: "success", run_attempt: 2 } }))).queue; // re-run of 1001
  assert.equal(q.items.length, 2);
  assert.deepEqual(q.items.map((it) => [it.key, it.seq, it.event.conclusion]), [["run:2002", 2, "success"], ["run:1001", 3, "success"]]);
});

test("the pull cursor returns only newer events, in order, with nothing but the stored fields", () => {
  let q = emptyQueue();
  for (let i = 1; i <= 5; i++) q = pushEvent(q, `d-${i}`, cleanWebhook("workflow_run", runPayload({ run: { id: i } }))).queue;
  const all = readQueue(q, 0);
  assert.deepEqual(all.events.map((e) => e.cursor), [1, 2, 3, 4, 5]);
  assert.equal(all.cursor, 5);
  assert.equal(all.more, false);
  assert.equal(all.gap, false);
  for (const e of all.events) assert.deepEqual(Object.keys(e).sort(), ["conclusion", "cursor", "kind", "private", "repo", "ts", "workflow"]);
  assert.ok(!JSON.stringify(all).includes("run:")); // the collapse key stays inside the Hub
  const later = readQueue(q, 3);
  assert.deepEqual(later.events.map((e) => e.cursor), [4, 5]);
  const none = readQueue(q, 5);
  assert.deepEqual(none.events, []);
  assert.equal(none.cursor, 5);
  // paged
  const page = readQueue(q, 0, 2);
  assert.deepEqual(page.events.map((e) => e.cursor), [1, 2]);
  assert.equal(page.cursor, 2);
  assert.equal(page.more, true);
  // a cursor ahead of the queue (it was reset) starts over
  assert.deepEqual(readQueue(q, 99).events.map((e) => e.cursor), [1, 2, 3, 4, 5]);
  // the cursor parser
  assert.equal(parseCursor(null), 0);
  assert.equal(parseCursor("12"), 12);
  for (const bad of ["-1", "1.5", "abc", "1e3", "9".repeat(16)]) assert.equal(parseCursor(bad), null);
});

test("the queue is capped, and a cursor behind the cap reports a gap", () => {
  let q = emptyQueue();
  for (let i = 1; i <= 6; i++) q = pushEvent(q, `d-${i}`, { key: `run:${i}`, event: { kind: "run" } }, { cap: 4 }).queue;
  assert.deepEqual(q.items.map((it) => it.seq), [3, 4, 5, 6]);
  assert.equal(q.dropped, 2);
  assert.equal(readQueue(q, 1).gap, true);
  assert.equal(readQueue(q, 2).gap, false);
  assert.deepEqual(readQueue(q, 1).events.map((e) => e.cursor), [3, 4, 5, 6]);
});

// A Hub that answers 404 (older code after a deploy) a few times, then like the new code.
function skewedHub(stale, answer) {
  const calls = [];
  const hub = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ?? null });
    return calls.length <= stale ? new Response("Not found", { status: 404 }) : answer();
  };
  return { hub, calls };
}
const noSleep = { sleep: async () => {} };

test("a push that meets an old Hub is retried until the new one queues it", async () => {
  const { hub, calls } = skewedHub(2, () => new Response("Queued", { status: 202 }));
  const body = JSON.stringify({ delivery: "d-1", cleaned: { key: "run:1" } });
  const slept = [];
  const res = await fetchHub(() => hub("https://hub/github/push", { method: "POST", body }), { sleep: async (ms) => slept.push(ms) });
  assert.equal(res.status, 202);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.method === "POST" && c.body === body)); // the same body every time
  assert.deepEqual(slept, [500, 1000]);
});

test("a queue pull that meets an old Hub is retried until the new one answers", async () => {
  const { hub, calls } = skewedHub(1, () => Response.json({ events: [], cursor: 0, more: false, gap: false }));
  const res = await fetchHub(() => hub("https://hub/github/queue?since=0"), noSleep);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { events: [], cursor: 0, more: false, gap: false });
  assert.equal(calls.length, 2);
});

test("a Hub that stays old becomes 503 after about 7.5 s, never 404", async () => {
  const { hub, calls } = skewedHub(Infinity, () => new Response("unreachable"));
  const slept = [];
  const res = await fetchHub(() => hub("https://hub/github/push", { method: "POST", body: "{}" }), { sleep: async (ms) => slept.push(ms) });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("Retry-After"), "30");
  assert.equal(calls.length, 5);
  assert.equal(slept.reduce((a, b) => a + b, 0), 7500); // inside GitHub's 10 s delivery timeout
});

test("only 404 is retried: other Hub answers pass straight through", async () => {
  for (const status of [200, 202, 400, 500]) {
    const { hub, calls } = skewedHub(0, () => new Response("x", { status }));
    const res = await fetchHub(() => hub("https://hub/github/push", { method: "POST", body: "{}" }), noSleep);
    assert.equal(res.status, status);
    assert.equal(calls.length, 1);
  }
});
