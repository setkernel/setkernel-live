// The GitHub Actions receiver: signature, size cap, dedupe, collapse, stored fields and the pull
// cursor. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { EVENTS, actorFor, cleanDelivery, cleanWebhook, emptyQueue, fetchHub, MAX_WEBHOOK_BODY, parseCursor, pushEvent, readCapped, readQueue, verifySignature } from "../src/github.js";

const SECRET = "test-secret-not-real";
// Most deliveries give one event: this returns it, or null, and fails if there were more.
function one(...args) {
  const out = cleanWebhook(...args);
  assert.ok(Array.isArray(out) && out.length <= 1, `one event at most: ${JSON.stringify(out)}`);
  return out[0] ?? null;
}
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
const prPayload = ({ action = "opened", login = "vega-setkernel", head = "agent/33-secret-branch", body = "secret body", merged = false, mergedBy = "a-maintainer", repo = {} } = {}) => ({
  action,
  number: 4242,
  pull_request: {
    id: 777001,
    number: 4242,
    title: "feat: secret title",
    body,
    html_url: "https://github.com/setkernel/hidden/pull/4242",
    user: { login, id: 1 },
    head: { ref: head, sha: "abc123", label: `setkernel:${head}` },
    base: { ref: "main" },
    merged,
    merged_by: merged ? { login: mergedBy } : null,
    created_at: "2026-10-14T12:00:00Z",
    merged_at: merged ? "2026-10-14T13:00:00Z" : null,
  },
  repository: { name: "setkernel-live", full_name: "setkernel/setkernel-live", private: false, ...repo },
  sender: { login },
});
const reviewPayload = ({ state = "approved", login = "rigel-setkernel", head = "agent/33-secret-branch", body = "secret review", action = "submitted" } = {}) => ({
  ...prPayload({ action, login: "vega-setkernel", head }),
  review: { id: 555, state, body, user: { login }, html_url: "https://github.com/x", submitted_at: "2026-10-14T12:30:00Z" },
  sender: { login },
});
const NEVER_PR = ["secret", "4242", "777001", "vega-setkernel", "rigel-setkernel", "realRaghavGupta", "Raghav", "raghav", "claude/", "lead/", "agent/", "Claude", "—", "https://", "main", "abc"];
const sig = (who) => `Looks good.\n\nSome notes, quoting "— Claude Lead" mid-text.\n\n— ${who}\n`;

test("pull requests, reviews, issues and comments are listened for next to CI", () => {
  assert.deepEqual(EVENTS, ["workflow_run", "deployment_status", "pull_request", "pull_request_review", "issues", "issue_comment"]);
});

test("actors: the four agents by login, whatever the branch or body", () => {
  assert.equal(actorFor("vega-setkernel", "agent/1-x"), "Vega");
  assert.equal(actorFor("Rigel-Setkernel", undefined), "Rigel", "logins are case-insensitive");
  assert.equal(actorFor("lyra-setkernel", "claude/x", sig("Claude Lead")), "Lyra");
  assert.equal(actorFor("orion-setkernel", "main"), "Orion");
});

test("actors: the director's account by branch, then signature, else Polaris", () => {
  // the branch prefix names the Claude
  assert.equal(actorFor("realRaghavGupta", "claude/fix-the-thing"), "Pherkad");
  assert.equal(actorFor("realraghavgupta", "raghav-dev/x"), "Yildun");
  assert.equal(actorFor("REALRAGHAVGUPTA", "lead/x"), "Kochab");
  assert.equal(actorFor("realRaghavGupta", "claude/x", sig("Claude Lead")), "Pherkad", "the branch wins over the body");
  // no branch marker: the body's closing signature line
  assert.equal(actorFor("realRaghavGupta", "fix/x", sig("Claude Cloud")), "Pherkad");
  assert.equal(actorFor("realRaghavGupta", undefined, sig("raghav-dev")), "Yildun");
  assert.equal(actorFor("realRaghavGupta", undefined, "Requested changes.\r\n\r\n— Claude Lead\r\n\r\n"), "Kochab", "CRLF and trailing blank lines");
  assert.equal(actorFor("realRaghavGupta", undefined, "— Claude Lead"), "Kochab", "a body that is only the signature");
  // footer lines after the signature are skipped (setkernel/agent-plugins#17), each on its own and all together
  const GENERATED = "🤖 Generated with [Claude Code](https://claude.com/claude-code)";
  const COAUTHOR = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";
  const AUTOMATED = "_Automated: @vega-setkernel's agent on `vega-dev`._";
  for (const footer of [GENERATED, COAUTHOR, AUTOMATED, `${GENERATED}\n\n${COAUTHOR}\n\n${AUTOMATED}`]) {
    assert.equal(actorFor("realRaghavGupta", undefined, `x\n\n— Claude Lead\n\n${footer}`), "Kochab", footer);
    assert.equal(actorFor("realRaghavGupta", undefined, `x\r\n\r\n— Claude Cloud\r\n\r\n${footer.replaceAll("\n", "\r\n")}\r\n`), "Pherkad", `CRLF: ${footer}`);
    assert.equal(actorFor("realRaghavGupta", undefined, `x\n\n${footer}`), "Polaris", `a footer with no signature: ${footer}`);
    assert.equal(actorFor("realRaghavGupta", undefined, footer), "Polaris", `only a footer: ${footer}`);
  }
  // no marker: Polaris, the director
  for (const head of ["agent/33-x", "feature/claude/x", "Claude/x", "claude", "LEAD/x", "main", undefined, 7]) assert.equal(actorFor("realRaghavGupta", head), "Polaris", `branch ${head}`);
  for (const body of [undefined, null, "", "Merging.", "— Claude Lead\n\nthen more text", "— Claude Leader", "-- Claude Lead", "— claude lead", "Signed — Claude Lead", 5, {},
    // only the listed footers are skipped: anything else after the signature, or a near-miss footer, hides it
    "— Claude Lead\n\nCloses setkernel/setkernel-live#33", "— Claude Lead\n\nGenerated with Claude Code", "— Claude Lead\n\n🤖 Generated with [Claude Code](https://x) and more",
    "— Claude Lead\n\nCo-Authored-By:", "— Claude Lead\n\n_Automated: no closing underscore", "— Claude Lead\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nP.S."]) {
    assert.equal(actorFor("realRaghavGupta", "fix/x", body), "Polaris", `body ${JSON.stringify(body)}`);
  }
});

test("actors: an unknown login is dropped, even with a marker", () => {
  for (const login of ["someone", "dependabot[bot]", "vega", "vega-setkernel-evil", "realRaghavGupta-evil", "Polaris", "Claude", "Raghav", "", undefined, null, 5, "constructor", "__proto__", "toString"]) {
    assert.equal(actorFor(login, "claude/x", sig("Claude Lead")), null, String(login));
  }
});

test("pull requests: opened and merged keep only kind, action, repo, private, actor and time", () => {
  const opened = one("pull_request", prPayload());
  assert.deepEqual(opened, { key: "pr:777001:opened_pr", event: { kind: "pr", repo: "setkernel-live", private: false, action: "opened_pr", actor: "Vega", ts: Date.parse("2026-10-14T12:00:00Z") / 1000 } });
  const merged = one("pull_request", prPayload({ action: "closed", merged: true, login: "realRaghavGupta", head: "claude/secret-branch" }));
  assert.deepEqual(merged, { key: "pr:777001:merged", event: { kind: "pr", repo: "setkernel-live", private: false, action: "merged", actor: "Pherkad", ts: Date.parse("2026-10-14T13:00:00Z") / 1000 } });
  const signed = one("pull_request", prPayload({ login: "realRaghavGupta", head: "fix/secret", body: `secret body\n\n— raghav-dev` }));
  assert.equal(signed.event.actor, "Yildun");
  for (const c of [opened, merged, signed]) {
    const text = JSON.stringify(c.event);
    for (const never of NEVER_PR) assert.ok(!text.includes(never), `${never} leaked: ${text}`);
  }
  // the author is the actor, not whoever merged it
  assert.equal(one("pull_request", prPayload({ action: "closed", merged: true, login: "orion-setkernel" })).event.actor, "Orion");
  assert.equal(one("pull_request", prPayload({ action: "closed", merged: true, login: "realRaghavGupta", head: "lead/x" })).event.actor, "Kochab");
  // the director's own pull request, no marker
  assert.equal(one("pull_request", prPayload({ login: "realRaghavGupta", head: "agent/33-x" })).event.actor, "Polaris");
  assert.equal(one("pull_request", prPayload({ repo: { private: true } })).event.private, true);
  assert.equal(one("pull_request", prPayload({ repo: { private: undefined } })).event.private, true);
});

test("pull requests: closed unmerged, other actions and unknown logins are dropped", () => {
  assert.equal(one("pull_request", prPayload({ action: "closed", merged: false })), null);
  assert.equal(one("pull_request", prPayload({ action: "closed", merged: "true" })), null);
  for (const action of ["edited", "synchronize", "reopened", "labeled", "ready_for_review", "assigned"]) assert.equal(one("pull_request", prPayload({ action })), null, action);
  assert.equal(one("pull_request", prPayload({ login: "someone-else", head: "claude/x", body: "— Claude Lead" })), null, "an unknown login");
  assert.equal(one("pull_request", { ...prPayload(), pull_request: { ...prPayload().pull_request, id: "1" } }), null);
  assert.equal(one("pull_request", { ...prPayload(), pull_request: undefined }), null);
  assert.equal(one("pull_request", prPayload({ repo: { name: "../x" } })), null);
});

test("reviews: approvals and change requests by a known reviewer, nothing else", () => {
  const ok = one("pull_request_review", reviewPayload());
  assert.deepEqual(ok, { key: "review:555", event: { kind: "pr", repo: "setkernel-live", private: false, action: "approved", actor: "Rigel", ts: Date.parse("2026-10-14T12:30:00Z") / 1000 } });
  for (const never of NEVER_PR) assert.ok(!JSON.stringify(ok.event).includes(never), never);
  assert.equal(one("pull_request_review", reviewPayload({ state: "changes_requested" })).event.action, "requested_changes");
  assert.equal(one("pull_request_review", reviewPayload({ state: "APPROVED" })).event.action, "approved");
  assert.equal(one("pull_request_review", reviewPayload({ login: "stranger", body: "— Claude Lead" })), null);
  for (const state of ["commented", "dismissed", "pending", "", null]) assert.equal(one("pull_request_review", reviewPayload({ state })), null, String(state));
  for (const action of ["edited", "dismissed"]) assert.equal(one("pull_request_review", reviewPayload({ action })), null, action);
});

test("reviews by the director's account: the review's signature, never the pull request's branch", () => {
  const by = (o) => one("pull_request_review", reviewPayload({ login: "realRaghavGupta", ...o })).event.actor;
  assert.equal(by({ body: sig("Claude Lead"), state: "changes_requested" }), "Kochab");
  assert.equal(by({ body: sig("Claude Cloud") }), "Pherkad");
  assert.equal(by({ body: sig("raghav-dev") }), "Yildun");
  // the head branch is the author's: a review on a claude/ pull request is not Pherkad's
  assert.equal(by({ head: "claude/x", body: "LGTM" }), "Polaris");
  assert.equal(by({ head: "lead/x", body: null }), "Polaris");
  const e = one("pull_request_review", reviewPayload({ login: "realRaghavGupta", body: `secret review\n\n— Claude Lead` })).event;
  for (const never of NEVER_PR) assert.ok(!JSON.stringify(e).includes(never), never);
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

// An issues or issue_comment payload, with the fields that must never come through.
const issuePayload = ({ action = "opened", login = "realRaghavGupta", body = "secret issue body", repo = {} } = {}) => ({
  action,
  issue: {
    id: 880001, number: 4243, title: "secret issue title", body, html_url: "https://github.com/setkernel/hidden/issues/4243",
    user: { login, id: 1 }, labels: [{ name: "secret-label" }], assignees: [{ login: "orion-setkernel" }], created_at: "2026-10-14T14:00:00Z",
  },
  repository: { name: "hq", full_name: "setkernel/hq", private: true, ...repo },
  sender: { login },
});
const commentPayload = ({ action = "created", login = "realRaghavGupta", body = "secret comment", issueBy = "vega-setkernel" } = {}) => ({
  ...issuePayload({ action, login: issueBy, body: "secret issue body" }),
  comment: { id: 990001, body, user: { login, id: 1 }, html_url: "https://github.com/setkernel/hidden/issues/4243#issuecomment-990001", created_at: "2026-10-14T14:05:00Z" },
  sender: { login },
});
const NEVER_REQUEST = [...NEVER_PR, "4243", "880001", "990001", "orion-setkernel", "label", "issuecomment"];

test("requests: an issue opened and a comment made keep only kind, action, repo, private, actor and time", () => {
  const opened = one("issues", issuePayload());
  assert.deepEqual(opened, { key: "issue:880001", event: { kind: "request", repo: "hq", private: true, action: "opened_issue", actor: "Polaris", ts: Date.parse("2026-10-14T14:00:00Z") / 1000 } });
  const comment = one("issue_comment", commentPayload());
  assert.deepEqual(comment, { key: "comment:990001", event: { kind: "request", repo: "hq", private: true, action: "commented", actor: "Polaris", ts: Date.parse("2026-10-14T14:05:00Z") / 1000 } });
  // the agents by login; the director's Claudes by the signature line, as for pull requests
  assert.equal(one("issue_comment", commentPayload({ login: "lyra-setkernel" })).event.actor, "Lyra");
  assert.equal(one("issues", issuePayload({ login: "orion-setkernel" })).event.actor, "Orion");
  assert.equal(one("issue_comment", commentPayload({ body: sig("Claude Lead") })).event.actor, "Kochab");
  assert.equal(one("issue_comment", commentPayload({ body: sig("Claude Cloud") })).event.actor, "Pherkad");
  assert.equal(one("issues", issuePayload({ body: `secret\n\n— raghav-dev\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)` })).event.actor, "Yildun");
  // the comment's own author and body count, never the issue's
  assert.equal(one("issue_comment", commentPayload({ login: "realRaghavGupta", issueBy: "vega-setkernel", body: "please look" })).event.actor, "Polaris");
  assert.equal(one("issues", issuePayload({ repo: { name: "setkernel-live", private: false } })).event.private, false);
});

test("requests never carry an issue's title, body, number, labels or a login", () => {
  const all = [
    one("issues", issuePayload()), one("issues", issuePayload({ body: sig("Claude Lead") })),
    one("issue_comment", commentPayload()), one("issue_comment", commentPayload({ login: "rigel-setkernel" })), one("issue_comment", commentPayload({ body: sig("raghav-dev") })),
  ];
  for (const c of all) {
    assert.deepEqual(Object.keys(c.event).sort(), ["action", "actor", "kind", "private", "repo", "ts"]);
    const text = JSON.stringify(c.event);
    for (const never of NEVER_REQUEST) assert.ok(!text.includes(never), `${never} leaked: ${text}`);
  }
  // and the queue hands out nothing more
  let q = emptyQueue();
  all.forEach((c, i) => { q = pushEvent(q, `d-${i}`, [c]).queue; });
  const pulled = JSON.stringify(readQueue(q, 0));
  for (const never of [...NEVER_REQUEST, "issue:", "comment:"]) assert.ok(!pulled.includes(never), `${never} leaked from the queue`);
});

test("requests: other actions, unknown logins and malformed payloads are dropped", () => {
  for (const action of ["edited", "closed", "reopened", "labeled", "assigned", "deleted", "transferred"]) assert.equal(one("issues", issuePayload({ action })), null, action);
  for (const action of ["edited", "deleted"]) assert.equal(one("issue_comment", commentPayload({ action })), null, action);
  assert.equal(one("issues", issuePayload({ login: "someone-else", body: "— Claude Lead" })), null, "a stranger, even with a marker");
  assert.equal(one("issue_comment", commentPayload({ login: "dependabot[bot]" })), null);
  assert.equal(one("issues", { ...issuePayload(), issue: { ...issuePayload().issue, id: "1" } }), null);
  assert.equal(one("issue_comment", { ...commentPayload(), comment: undefined }), null);
  assert.equal(one("issue_comment", { ...commentPayload(), comment: { ...commentPayload().comment, id: 1.5 } }), null);
  assert.equal(one("issues", { ...issuePayload(), issue: null }), null);
  assert.equal(one("issues", issuePayload({ repo: { name: "../x" } })), null);
});

test("merges from the director's account: the author's merge, then Polaris's; one event when it is its own", () => {
  const at = Date.parse("2026-10-14T13:00:00Z") / 1000;
  const base = { kind: "pr", repo: "setkernel-live", private: false, ts: at };
  assert.deepEqual(cleanWebhook("pull_request", prPayload({ action: "closed", merged: true, mergedBy: "realRaghavGupta" })), [
    { key: "pr:777001:merged", event: { ...base, action: "merged", actor: "Vega" } },
    { key: "pr:777001:merged_by", event: { ...base, action: "merged_by", actor: "Polaris" } },
  ]);
  // a Claude's pull request, merged from the same account (a merge carries no marker: Polaris)
  assert.deepEqual(cleanWebhook("pull_request", prPayload({ action: "closed", merged: true, login: "realRaghavGupta", head: "lead/x", mergedBy: "RealRaghavGupta" })).map((c) => [c.event.action, c.event.actor]),
    [["merged", "Kochab"], ["merged_by", "Polaris"]]);
  // the director's own pull request: Polaris merged it, once, not "had a pull request merged" too
  assert.deepEqual(cleanWebhook("pull_request", prPayload({ action: "closed", merged: true, login: "realRaghavGupta", head: "fix/x", mergedBy: "realRaghavGupta" })),
    [{ key: "pr:777001:merged_by", event: { ...base, action: "merged_by", actor: "Polaris" } }]);
  // someone the page doesn't show: Polaris's merge only
  assert.deepEqual(cleanWebhook("pull_request", prPayload({ action: "closed", merged: true, login: "dependabot[bot]", mergedBy: "realRaghavGupta" })).map((c) => c.event.action), ["merged_by"]);
  // merged by anyone else: the author's only, as before
  assert.deepEqual(cleanWebhook("pull_request", prPayload({ action: "closed", merged: true, mergedBy: "rigel-setkernel" })).map((c) => c.event.action), ["merged"]);
  assert.deepEqual(cleanWebhook("pull_request", { ...prPayload({ action: "closed", merged: true }), pull_request: { ...prPayload({ action: "closed", merged: true }).pull_request, merged_by: null } }).map((c) => c.event.action), ["merged"]);
  // closed without merging is nothing, whoever closed it
  assert.deepEqual(cleanWebhook("pull_request", prPayload({ action: "closed", merged: false, mergedBy: "realRaghavGupta" })), []);
  for (const c of cleanWebhook("pull_request", prPayload({ action: "closed", merged: true, mergedBy: "realRaghavGupta" }))) {
    for (const never of NEVER_PR) assert.ok(!JSON.stringify(c.event).includes(never), never);
  }
});

test("one delivery's two merge events queue together, in order, and a redelivery adds neither", () => {
  const both = cleanWebhook("pull_request", prPayload({ action: "closed", merged: true, mergedBy: "realRaghavGupta" }));
  let r = pushEvent(emptyQueue(), "d-1", both);
  assert.equal(r.added, true);
  assert.deepEqual(r.queue.items.map((it) => [it.seq, it.event.action]), [[1, "merged"], [2, "merged_by"]]);
  r = pushEvent(r.queue, "d-1", both);
  assert.equal(r.added, false);
  r = pushEvent(r.queue, "d-2", both); // the same merge, redelivered under a new id: replaced, not doubled
  assert.deepEqual(r.queue.items.map((it) => [it.seq, it.event.action]), [[3, "merged"], [4, "merged_by"]]);
  assert.deepEqual(readQueue(r.queue, 0).events.map((e) => e.cursor), [3, 4]);
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
  const run = one("workflow_run", runPayload());
  assert.deepEqual(run, { key: "run:1001", event: { kind: "run", repo: "setkernel-live", private: false, workflow: "CI", conclusion: "success", ts: Date.parse("2026-10-13T12:00:00Z") / 1000 } });
  const dep = one("deployment_status", deployPayload());
  assert.deepEqual(dep, { key: "deploy:300", event: { kind: "deploy", repo: "setkernel-live", private: false, workflow: "Deploy", conclusion: "success", ts: Date.parse("2026-10-13T12:05:00Z") / 1000 } });
  for (const c of [run, dep]) {
    const text = JSON.stringify(c.event);
    for (const never of ["secret", "someone", "https://", "abc", "main", "production"]) assert.ok(!text.includes(never), `${never} leaked: ${text}`);
  }
});

test("private is kept, and anything but private:false counts as private", () => {
  assert.equal(one("workflow_run", runPayload({ repo: { private: true } })).event.private, true);
  assert.equal(one("workflow_run", runPayload({ repo: { private: undefined } })).event.private, true);
  assert.equal(one("workflow_run", runPayload({ repo: { private: "false" } })).event.private, true);
});

test("only completed workflow runs and finished deployments are accepted", () => {
  for (const action of ["requested", "in_progress"]) assert.equal(one("workflow_run", runPayload({ top: { action } })), null);
  assert.equal(one("workflow_run", runPayload({ run: { conclusion: null } })), null);
  assert.equal(one("workflow_run", runPayload({ run: { conclusion: "made-up" } })), null);
  assert.equal(one("workflow_run", runPayload({ run: { conclusion: "failure" } })).event.conclusion, "failure");
  for (const state of ["pending", "queued", "in_progress", "inactive"]) assert.equal(one("deployment_status", deployPayload(state)), null);
  assert.equal(one("deployment_status", deployPayload("error")).event.conclusion, "error");
  for (const other of ["push", "pull_request", "workflow_job", "check_run", "ping"]) assert.equal(one(other, runPayload()), null);
  assert.equal(one("workflow_run", runPayload({ repo: { name: "bad name/../x" } })), null);
  assert.equal(one("workflow_run", null), null);
});

test("a workflow name is cleaned and never taken from the run title", () => {
  const p = runPayload({ top: { workflow: undefined }, run: { name: "Build\nand\u0007test" } });
  assert.equal(one("workflow_run", p).event.workflow, "Build and test");
  assert.equal(one("workflow_run", runPayload({ top: { workflow: { name: "x".repeat(300) } } })).event.workflow.length, 100);
  const dep = deployPayload();
  delete dep.workflow;
  assert.equal(one("deployment_status", dep).event.workflow, "deployment");
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
  for (let i = 0; i < 5; i++) q = pushEvent(q, `d-${i}`, [{ key: `run:${i}`, event: { kind: "run" } }], { deliveryCap: 3 }).queue;
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
  for (let i = 1; i <= 6; i++) q = pushEvent(q, `d-${i}`, [{ key: `run:${i}`, event: { kind: "run" } }], { cap: 4 }).queue;
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
