// The showcase's publisher (src/evidence.js): only a public setkernel repo, star names only, no
// text, a security fix held for 24 hours, and the team's numbers. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { criteria, fetchEvidence, images, isPublicRepo, isSecurity, linkedIssues, parsePull, publishEvidence, teamNumbers, who } from "../src/evidence.js";
import { hasNever } from "../src/logic.js";
import { readFileSync } from "node:fs";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const API = "https://api.github.com/repos/setkernel/setkernel-live";
const repo = (over = {}) => ({ name: "setkernel-live", full_name: "setkernel/setkernel-live", private: false, visibility: "public", owner: { login: "setkernel" }, url: API, ...over });
const SECRET = "Secret plan for Acme Corp in setkernel/hq";
function raw(over = {}) {
  return {
    repo: repo(),
    pull: {
      number: 49, title: SECRET, body: `${SECRET}\n\nCloses #48\n\n![shot](a.png)\n<img src="b.png">`,
      user: { login: "lyra-setkernel", type: "User" }, merged_by: { login: "someone-human", type: "User" },
      created_at: "2026-10-15T07:26:00Z", merged_at: "2026-10-15T14:11:12Z", commits: 6, changed_files: 45, additions: 1934, deletions: 2757,
      labels: [{ name: "owner-review" }], head: { ref: "agent/48-secret-branch", sha: "abc" }, base: { repo: { full_name: "setkernel/setkernel-live" } }, merge_commit_sha: "def",
    },
    issues: [{ number: 48, repository_url: API, user: { login: "realperson", type: "User" }, created_at: "2026-10-15T06:00:00Z", body: `${SECRET}\n- [x] one\n- [ ] two\n* [X] three`, labels: [] }],
    reviews: [
      { user: { login: "rigel-setkernel", type: "User" }, state: "CHANGES_REQUESTED", submitted_at: "2026-10-15T08:00:00Z", body: SECRET },
      { user: { login: "rigel-setkernel", type: "User" }, state: "APPROVED", submitted_at: "2026-10-15T08:19:30Z", body: SECRET },
      { user: { login: "x", type: "User" }, state: "DISMISSED", submitted_at: "2026-10-15T08:20:00Z" },
    ],
    comments: [
      { user: { login: "lyra-setkernel" }, created_at: "2026-10-15T07:30:50Z", body: "Reviewer: found 1 blocker(s); 0 still open. Fixes pushed in 1 commit(s).\n- secret detail" },
      { user: { login: "lyra-setkernel" }, created_at: "2026-10-15T08:05:52Z", body: "Reviewer: no blockers." },
      { user: { login: "outsider" }, created_at: "2026-10-15T08:06:00Z", body: "Reviewer: found 9 blocker(s)" },
    ],
    commits: [{ commit: { message: SECRET, committer: { date: "2026-10-15T07:30:38Z" } } }, { commit: { message: SECRET, committer: { date: "2026-10-15T07:24:15Z" } } }],
    files: [{ filename: "test/evidence.test.mjs", patch: SECRET }, { filename: "src/evidence.js" }, { filename: "test/worker/hub.test.js" }],
    checks: [
      { name: "validate", status: "completed", conclusion: "success", started_at: "2026-10-15T07:31:00Z", completed_at: "2026-10-15T07:31:40Z", html_url: "https://x" },
      { name: "skipped one", status: "completed", conclusion: "skipped", started_at: "2026-10-15T07:31:00Z", completed_at: "2026-10-15T07:31:00Z" },
    ],
    production: [{ name: "deploy", status: "completed", conclusion: "success", started_at: "2026-10-15T14:11:18Z", completed_at: "2026-10-15T14:17:02Z" }],
    ...over,
  };
}

test("a public pull request's evidence: numbers, times and star names, nothing else", () => {
  const r = publishEvidence(raw(), NOW);
  assert.equal(r.ok, true);
  const e = r.evidence;
  assert.equal(e.repo, "setkernel-live");
  assert.equal(e.href, "https://github.com/setkernel/setkernel-live/pull/49");
  assert.deepEqual(e.idea, { at: "2026-10-15T06:00:00.000Z", by: "a person", href: "https://github.com/setkernel/setkernel-live/issues/48", words: 17 });
  assert.deepEqual(e.charter, { total: 3, ticked: 2 });
  assert.deepEqual(e.build, { by: "Lyra", count: 6, files: 45, added: 1934, removed: 2757, first: "2026-10-15T07:24:15.000Z", last: "2026-10-15T07:30:38.000Z", opened: "2026-10-15T07:26:00.000Z" });
  assert.deepEqual(e.proof, { checks: [{ name: "validate", ok: true, seconds: 40, at: "2026-10-15T07:31:40.000Z" }], screenshots: 2, tests: 2 });
  assert.deepEqual(e.review.automated, [{ at: "2026-10-15T07:30:50.000Z", blockers: 1, open: 0 }, { at: "2026-10-15T08:05:52.000Z", blockers: 0, open: 0 }]);
  assert.deepEqual(e.review.peers.map((p) => [p.by, p.verdict]), [["Rigel", "changes"], ["Rigel", "approved"]]);
  assert.deepEqual(e.merge, { at: "2026-10-15T14:11:12.000Z", by: "a person", hours: 6.8 });
  assert.deepEqual(e.production, { checks: [{ name: "deploy", ok: true, seconds: 344, at: "2026-10-15T14:17:02.000Z" }], minutes: 6 });
  const text = JSON.stringify(e);
  for (const leak of ["Secret", "Acme", "hq", "agent/48", "someone-human", "realperson", "lyra-setkernel", "rigel-setkernel", "abc", "def", "patch", "html_url", "a.png", "#48"]) {
    assert.ok(!text.includes(leak), `evidence carries ${leak}`);
  }
  assert.equal(hasNever(e), false);
});

test("a private repo, another owner or a mismatched pull request is refused", () => {
  for (const over of [{ private: true }, { private: undefined }, { visibility: "internal" }, { owner: { login: "someone" } }]) {
    const r = publishEvidence(raw({ repo: repo(over) }), NOW);
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.evidence, undefined);
  }
  const p = raw();
  p.pull.base.repo.full_name = "setkernel/hq";
  assert.equal(publishEvidence(p, NOW).ok, false);
  assert.equal(publishEvidence(null, NOW).ok, false);
});

test("an issue from another repo is never shown, even if one is passed in", () => {
  const e = publishEvidence(raw({ issues: [{ ...raw().issues[0], repository_url: "https://api.github.com/repos/setkernel/hq" }] }), NOW).evidence;
  assert.equal(e.idea, null);
  assert.equal(e.charter, null);
});

test("a security fix waits 24 hours after it merges, labelled on the pull request or its issue", () => {
  const sec = raw();
  sec.pull.labels = [{ name: "security" }];
  const merged = Date.parse(sec.pull.merged_at);
  assert.equal(publishEvidence(sec, merged + 23 * 3600_000).ok, false);
  assert.match(publishEvidence(sec, merged + 23 * 3600_000).reason, /24 hours/);
  assert.equal(publishEvidence(sec, merged + 24 * 3600_000).ok, true);
  const open = raw();
  open.pull.labels = ["security"];
  open.pull.merged_at = null;
  assert.equal(publishEvidence(open, NOW + 30 * 86_400_000).ok, false, "an unmerged security fix never shows");
  const viaIssue = raw();
  viaIssue.issues[0].labels = [{ name: "sec: high" }];
  assert.equal(publishEvidence(viaIssue, merged + 3600_000).ok, false);
});

test("a security label is held wherever the word sits in it: prefixed, scoped, or a vulnerability or CVE", () => {
  for (const name of ["security", "Security", "sec-fix", "sec: high", "area:security", "area: security", "type/security",
    "security-fix", "area_security", "kind/vulnerability", "vulnerabilities", "vuln", "cve", "CVE-2026-1234", "ghsa"]) {
    assert.equal(isSecurity([{ name }]), true, name);
    assert.equal(isSecurity([name]), true, name);
    const r = raw();
    r.issues[0].labels = [{ name }];
    assert.equal(publishEvidence(r, Date.parse(r.pull.merged_at) + 3600_000).ok, false, `${name} on the issue`);
  }
  for (const name of ["insecure-defaults", "secret-santa", "second", "documentation", "owner-review", ""]) assert.equal(isSecurity([{ name }]), false, name);
  assert.equal(isSecurity(null), false);
});

test("a linked issue that can't be read holds the pull request back instead of skipping the security check", async () => {
  const r = raw();
  r.issues[0].labels = [{ name: "area:security" }];
  const get = async (p) => {
    if (p === "repos/setkernel/setkernel-live") return repo();
    if (p.endsWith("/pulls/49")) return r.pull;
    if (p.endsWith("/issues/48")) throw new Error("HTTP 403: API rate limit exceeded");
    if (p.includes("check-runs")) return { check_runs: [] };
    return [];
  };
  await assert.rejects(fetchEvidence(get, "setkernel-live", 49), /rate limit/);
  // and publishEvidence refuses on its own when the linked issue is missing or isn't the one linked
  const at = Date.parse(r.pull.merged_at) + 30 * 86_400_000;
  for (const issues of [null, undefined, [], [{ ...r.issues[0], number: 47, labels: [] }]]) {
    const got = publishEvidence(raw({ issues }), at);
    assert.equal(got.ok, false, JSON.stringify(issues));
    assert.match(got.reason, /linked issue/);
  }
  // a linked pull request ("Refs #47" where #47 is a PR) still has its labels checked, but isn't shown as the idea
  const pr = raw({ issues: [{ ...r.issues[0], pull_request: {}, labels: [{ name: "security" }] }] });
  assert.equal(publishEvidence(pr, Date.parse(pr.pull.merged_at) + 3600_000).ok, false);
  pr.issues[0].labels = [];
  assert.equal(publishEvidence(pr, at).evidence.idea, null);
  // no link: no issue needed
  const none = raw({ issues: [] });
  none.pull.body = "No link here";
  assert.equal(publishEvidence(none, at).ok, true);
});

test("every issue a pull request links is read and checked, in each form GitHub links it", async () => {
  for (const body of ["Closes #12\nCloses #13", "Closes #12, closes #13", "Closes #12, #13", "Fixes #12 and #13", "Closes: #12\nFixes https://github.com/setkernel/setkernel-live/issues/13",
    "Resolves #12\nCloses SetKernel/Setkernel-Live#13", "Closes https://github.com/setkernel/hq/issues/9, #12\nrefs https://github.com/setkernel/setkernel-live/pull/13"]) {
    assert.deepEqual(linkedIssues(body, "setkernel-live"), [12, 13], body);
    const r = raw();
    r.pull.body = body;
    const issue = (number, labels) => ({ ...r.issues[0], number, labels });
    const asked = [];
    const get = async (p) => {
      asked.push(p);
      if (p === "repos/setkernel/setkernel-live") return repo();
      if (p.endsWith("/pulls/49")) return r.pull;
      if (p.endsWith("/issues/12")) return issue(12, []);
      if (p.endsWith("/issues/13")) return issue(13, [{ name: "security" }]);
      if (p.includes("check-runs")) return { check_runs: [] };
      return [];
    };
    const got = await fetchEvidence(get, "setkernel-live", 49);
    assert.deepEqual(got.issues.map((i) => i.number), [12, 13], body);
    assert.ok(!asked.some((p) => p.includes("hq")), body);
    const merged = Date.parse(r.pull.merged_at);
    assert.equal(publishEvidence(got, merged + 3600_000).ok, false, `${body}: only #13 is labelled security`);
    const later = publishEvidence(got, merged + 24 * 3600_000);
    assert.equal(later.ok, true, body);
    assert.equal(later.evidence.idea.href, "https://github.com/setkernel/setkernel-live/issues/12", "the first linked issue is the idea");
    // and one linked issue missing is refused, whichever it is
    for (const keep of [12, 13]) assert.match(publishEvidence({ ...got, issues: got.issues.filter((i) => i.number === keep) }, merged + 30 * 86_400_000).reason, /linked issue/, `${body} without the other`);
  }
  assert.deepEqual(linkedIssues("Closes #12\nCloses #12\nsee #14\nCloses other/x#15", "setkernel-live"), [12], "once each; a mention or another owner isn't a link");
});

test("names: star names for the team, 'a person' for anyone else, 'automation' for bots", () => {
  assert.equal(who({ login: "Orion-setkernel", type: "User" }), "Orion");
  assert.equal(who({ login: "polaris-setkernel", type: "User" }), "Polaris");
  assert.equal(who({ login: "realSomeone", type: "User" }), "a person");
  assert.equal(who({ login: "orion-setkernel-evil", type: "User" }), "a person");
  assert.equal(who({ login: "github-actions[bot]", type: "Bot" }), "automation");
  assert.equal(who(null), "a person");
});

test("the text helpers count, and follow only an issue in the same repo", () => {
  assert.deepEqual(linkedIssues("Closes setkernel/hq#213\nRefs setkernel/setkernel-live#52", "setkernel-live"), [52]);
  assert.deepEqual(linkedIssues("Closes setkernel/hq#213", "setkernel-live"), []);
  assert.deepEqual(linkedIssues("fixes #7", "x"), [7]);
  assert.deepEqual(criteria("- [ ] a\n- [x] b\ntext [x]"), { total: 2, ticked: 1 });
  assert.equal(images("![a](b) <IMG src=c> [not](d)"), 2);
  assert.equal(isPublicRepo(repo()), true);
  assert.equal(isPublicRepo({ ...repo(), name: "../hq" }), false);
  for (const name of [".", ".."]) assert.equal(isPublicRepo({ ...repo(), name }), false, name);
  assert.deepEqual(parsePull("https://github.com/setkernel/setkernel-live/pull/49"), { repo: "setkernel-live", number: 49 });
  assert.deepEqual(parsePull("setkernel-live#49"), { repo: "setkernel-live", number: 49 });
  assert.equal(parsePull("https://github.com/other/x/pull/1"), null);
});

test("fetchEvidence asks nothing more about a private repo, and never follows another repo's issue", async () => {
  const asked = [];
  const priv = await fetchEvidence(async (p) => { asked.push(p); return repo({ private: true }); }, "secret", 1);
  assert.deepEqual(asked, ["repos/setkernel/secret"]);
  assert.equal(publishEvidence(priv, NOW).ok, false);
  const r = raw();
  r.pull.body = "Closes setkernel/hq#213";
  const seen = [];
  const get = async (p) => {
    seen.push(p);
    if (p === "repos/setkernel/setkernel-live") return repo();
    if (p.endsWith("/pulls/49")) return r.pull;
    if (p.includes("check-runs")) return { check_runs: [] };
    return [];
  };
  const got = await fetchEvidence(get, "setkernel-live", 49);
  assert.ok(!seen.some((p) => p.includes("hq")), "no request about a private repo");
  assert.deepEqual(got.issues, []);
  await assert.rejects(fetchEvidence(get, "../x", 1));
  for (const name of [".", ".."]) await assert.rejects(fetchEvidence(get, name, 1), name);
});

test("team numbers: throughput, lead time, pass rate, revert rate and time to recover", () => {
  const d = (h) => new Date(NOW - h * 3_600_000).toISOString();
  const pulls = [
    { created_at: d(30), merged_at: d(20), title: "feat: a" },
    { created_at: d(10), merged_at: d(8), title: "Revert \"feat: a\"" },
    { created_at: d(5), merged_at: d(1), title: "fix: b" },
    { created_at: d(5), merged_at: null, title: "closed unmerged" },
    { created_at: d(2000), merged_at: d(1900), title: "too old" },
  ];
  const run = (name, conclusion, h, repo = "a") => ({ name, conclusion, created_at: d(h), updated_at: d(h - 0.5), repository: { name: repo } });
  const runs = [run("CI", "success", 50), run("CI", "failure", 40), run("CI", "failure", 39), run("CI", "success", 38), run("CI", "cancelled", 37), run("Deploy", "success", 30, "b"), run("CI", "failure", 3, "b"), run("CI", "success", 2, "b")];
  const n = teamNumbers({ pulls, runs }, NOW, 7);
  assert.deepEqual(n, { days: 7, merged: 3, perWeek: 3, leadHours: 4, runs: 7, passRate: 57, reverts: 1, revertRate: 33.3, recoveries: 2, recoverMinutes: 120 });
  const empty = teamNumbers({ pulls: [], runs: [] }, NOW);
  assert.equal(empty.passRate, null);
  assert.equal(empty.recoverMinutes, null);
});

test("the v4 prototype's inlined publisher is src/evidence.js as it is now (rerun build.mjs after changing it)", () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const html = read("docs/design/v4/showcase/index.html");
  const lib = /\/\* lib \*\/([\s\S]*?)\/\* end lib \*\//.exec(html)?.[1];
  assert.ok(lib, "index.html has a lib block");
  // the same stripping build.mjs does: imports and exports go, the rest is verbatim
  const strip = (src) => src.replace(/^import .*$/gm, "").replace(/^export \{[^}]*\}.*$/gm, "").replace(/^export /gm, "");
  assert.ok(lib.includes(strip(read("src/evidence.js"))), "index.html is stale: run node docs/design/v4/showcase/build.mjs");
  const logic = read("src/logic.js");
  assert.ok(lib.includes(strip(logic.slice(logic.indexOf("export const NEVER"), logic.indexOf("function cleanAgentInfo")))), "index.html's guard is stale");
});
