// The showcase's publisher (setkernel-live#52): a public pull request's evidence, and the team's
// numbers, reduced to what the page may show. Pure, so it runs under `node --test`, in the v4
// prototype's demo mode, and later in the Worker.
//
// It is an allowlist. Every field it returns is built by a rule below from GitHub's REST shapes, and
// nothing else passes: no title, no body text, no code, no branch, no commit message, no login, and
// no repo that isn't one of setkernel's public ones. Text is read only to count things (criteria
// ticked, screenshots, blockers found); the words themselves are never kept. People appear by their
// star name; anyone else is "a person". A security fix waits 24 hours after it ships.
import { AGENTS } from "../public/lib/state.js";
import { guard } from "./logic.js";

export const OWNER = "setkernel";
export const SECURITY_HOLD_MS = 24 * 3600 * 1000;
// A repo name; "." and ".." are refused, since fetch would resolve them into another API path.
const REPO = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const CHECK = /^[A-Za-z0-9 ._()/:-]{1,40}$/;
const STAR = new Map(AGENTS.map((a) => [`${a.toLowerCase()}-setkernel`, a]));

// A GitHub user -> how the page names them: a star name, "automation" for a bot, else "a person".
export function who(user) {
  if (!user || typeof user !== "object") return "a person";
  if (user.type === "Bot") return "automation";
  return STAR.get(String(user.login).toLowerCase()) || "a person";
}

// Is this repo one of setkernel's public repos? Both flags must say so: a missing field is private.
export function isPublicRepo(repo) {
  return !!repo && repo.private === false && (repo.visibility ?? "public") === "public"
    && repo.owner?.login === OWNER && typeof repo.name === "string" && REPO.test(repo.name);
}

// Every issue a pull request links in this repo, in order, once each: "Closes #12", "Closes #12, #13",
// "Fixes #12 and #13", "Closes setkernel/x#12" or "Closes https://github.com/setkernel/x/issues/12",
// where x is this repo. An issue in any other repo is never followed (it may be private).
const REF = String.raw`(?:https:\/\/github\.com\/setkernel\/([A-Za-z0-9._-]+)\/(?:issues|pull)\/|setkernel\/([A-Za-z0-9._-]+)#|#)(\d+)\b`;
const LINKS = new RegExp(String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs)(?:\s*:)?\s+${REF}(?:\s*(?:,|\band\b)\s*${REF})*`, "gi");
export function linkedIssues(body, repo) {
  const out = new Set();
  for (const list of String(body || "").matchAll(LINKS)) {
    for (const m of list[0].matchAll(new RegExp(REF, "gi"))) {
      const name = m[1] ?? m[2];
      if (!name || name.toLowerCase() === String(repo).toLowerCase()) out.add(Number(m[3]));
    }
  }
  return [...out];
}

// Acceptance criteria in a body: task-list lines, and how many are ticked.
export function criteria(body) {
  const lines = String(body || "").match(/^\s*[-*] \[[ xX]\]/gm) || [];
  return { total: lines.length, ticked: lines.filter((l) => /\[[xX]\]/.test(l)).length };
}

// Screenshots in a body: Markdown images and <img> tags.
export function images(body) {
  return (String(body || "").match(/!\[[^\]]*\]\([^)]+\)|<img\b/gi) || []).length;
}

// Is any label a security one? The word may sit anywhere in it ("security", "sec: high", "area:security",
// "type/security", "vulnerability", "CVE-2026-1"), bounded by anything but a letter or digit. A label
// held by mistake only waits; one missed would show a fix before it ships everywhere.
export function isSecurity(labels) {
  const re = /(?:^|[^a-z0-9])(?:security|sec|vuln(?:erabilit(?:y|ies))?|cve|ghsa)(?:$|[^a-z0-9])/i;
  return (labels || []).some((l) => re.test(typeof l === "string" ? l : l?.name || ""));
}

const time = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const ms = (v) => Date.parse(v);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const checkName = (n) => (CHECK.test(String(n)) ? String(n) : "a check");
const VERDICT = { APPROVED: "approved", CHANGES_REQUESTED: "changes", COMMENTED: "commented" };

function checks(runs) {
  return (runs || []).filter((r) => r?.status === "completed" && r.conclusion !== "skipped" && r.conclusion !== "neutral").map((r) => ({
    name: checkName(r.name),
    ok: r.conclusion === "success",
    seconds: Math.max(0, Math.round((ms(r.completed_at) - ms(r.started_at)) / 1000)) || 0,
    at: time(r.completed_at),
  }));
}

// Our own reviewer's summary comment: "Reviewer: found 2 blocker(s); 0 still open." or "Reviewer: no
// blockers." Only a teammate's comment counts, and only the two numbers are kept.
function automated(comments) {
  const out = [];
  for (const c of comments || []) {
    if (!STAR.has(String(c?.user?.login).toLowerCase())) continue;
    const m = /^Reviewer: (?:no blockers|found (\d+) blocker\(s\)(?:; (\d+) still open)?)/.exec(String(c.body || ""));
    if (m) out.push({ at: time(c.created_at), blockers: Number(m[1] || 0), open: Number(m[2] || 0) });
  }
  return out;
}

// raw: what fetchEvidence gathers. now: ms. Returns { ok: true, evidence } or { ok: false, reason }.
export function publishEvidence(raw, now) {
  const { repo, pull } = raw || {};
  if (!isPublicRepo(repo)) return { ok: false, reason: "That isn't one of setkernel's public repos." };
  if (!pull || pull.base?.repo?.full_name !== repo.full_name || !Number.isInteger(pull.number)) return { ok: false, reason: "That pull request isn't in this repo." };
  // Every issue it links must be here: without one, its security label can't be checked.
  const linked = linkedIssues(pull.body, repo.name).map((n) => (raw.issues || []).find((i) => i?.number === n));
  if (linked.some((i) => !i)) return { ok: false, reason: "The linked issue couldn't be checked." };
  const own = linked.find((i) => !i.pull_request && i.repository_url === repo.url) || null;
  const merged = pull.merged_at ? ms(pull.merged_at) : null;
  if (isSecurity(pull.labels) || linked.some((i) => isSecurity(i.labels))) {
    if (!merged || now - merged < SECURITY_HOLD_MS) return { ok: false, reason: "A security fix is shown 24 hours after it ships." };
  }
  const commitTimes = (raw.commits || []).map((c) => ms(c?.commit?.committer?.date)).filter(Number.isFinite).sort((a, b) => a - b);
  const files = (raw.files || []).map((f) => String(f?.filename || ""));
  const prod = merged ? checks(raw.production) : [];
  const last = Math.max(...prod.map((c) => ms(c.at)).filter(Number.isFinite));
  const base = `https://github.com/${OWNER}/${repo.name}`;
  const evidence = {
    repo: repo.name,
    href: `${base}/pull/${pull.number}`,
    idea: own ? { at: time(own.created_at), by: who(own.user), href: `${base}/issues/${own.number}`, words: String(own.body || "").split(/\s+/).filter(Boolean).length } : null,
    charter: own ? criteria(own.body) : null,
    build: {
      by: who(pull.user), count: count(pull.commits), files: count(pull.changed_files),
      added: count(pull.additions), removed: count(pull.deletions),
      first: commitTimes.length ? new Date(commitTimes[0]).toISOString() : null,
      last: commitTimes.length ? new Date(commitTimes.at(-1)).toISOString() : null,
      opened: time(pull.created_at),
    },
    proof: { checks: checks(raw.checks), screenshots: images(pull.body), tests: files.filter((f) => /(^|\/)(test|tests|__tests__)\/|\.test\.[a-z]+$/.test(f)).length },
    review: {
      automated: automated(raw.comments),
      peers: (raw.reviews || []).filter((r) => VERDICT[r?.state]).map((r) => ({ by: who(r.user), verdict: VERDICT[r.state], at: time(r.submitted_at) })),
    },
    merge: merged ? { at: time(pull.merged_at), by: who(pull.merged_by), hours: Math.round((merged - ms(pull.created_at)) / 360_000) / 10 } : null,
    production: prod.length ? { checks: prod, minutes: Number.isFinite(last) ? Math.max(0, Math.round((last - merged) / 60_000)) : null } : null,
  };
  const out = guard(evidence);
  return out ? { ok: true, evidence: out } : { ok: false, reason: "Withheld." };
}

// Everything publishEvidence reads, from the REST API. get(path) -> parsed JSON (it throws on a
// failed request, and so does this: a linked issue that can't be read fails the call, since every
// linked issue's labels decide the security hold). The repo is checked first, so nothing else is asked about a
// private one.
export async function fetchEvidence(get, repoName, number) {
  if (!REPO.test(String(repoName)) || !Number.isInteger(number) || number < 1) throw new Error("Give a setkernel repo and a pull request number.");
  const path = `repos/${OWNER}/${repoName}`;
  const repo = await get(path);
  if (!isPublicRepo(repo)) return { repo };
  const pull = await get(`${path}/pulls/${number}`);
  const [issues, reviews, comments, commits, files, checksHead, production] = await Promise.all([
    Promise.all(linkedIssues(pull.body, repo.name).map((n) => get(`${path}/issues/${n}`))),
    get(`${path}/pulls/${number}/reviews?per_page=100`),
    get(`${path}/issues/${number}/comments?per_page=100`),
    get(`${path}/pulls/${number}/commits?per_page=100`),
    get(`${path}/pulls/${number}/files?per_page=100`),
    get(`${path}/commits/${pull.head.sha}/check-runs?per_page=100`).then((r) => r.check_runs),
    pull.merged_at && pull.merge_commit_sha ? get(`${path}/commits/${pull.merge_commit_sha}/check-runs?per_page=100`).then((r) => r.check_runs) : [],
  ]);
  return { repo, pull, issues, reviews, comments, commits, files, checks: checksHead, production };
}

// "https://github.com/setkernel/x/pull/12" or "x#12" -> { repo, number }, or null.
export function parsePull(text) {
  const m = /^\s*(?:https:\/\/github\.com\/setkernel\/|setkernel\/)?([A-Za-z0-9._-]{1,100})(?:\/pull\/|#)(\d+)\/?\s*$/.exec(String(text || ""));
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const round = (v, d = 0) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

// The numbers that sell, for the whole team (never per person), over the last `days` days.
// pulls: closed pull requests (REST shape) from public repos; runs: workflow runs on each repo's
// default branch, with repository.name. Titles are read only to count reverts.
export function teamNumbers({ pulls, runs }, now, days = 30) {
  const from = now - days * 86_400_000;
  const merged = (pulls || []).filter((p) => p?.merged_at && ms(p.merged_at) >= from && ms(p.merged_at) <= now);
  const done = (runs || []).filter((r) => (r?.conclusion === "success" || r?.conclusion === "failure") && ms(r.created_at) >= from && ms(r.created_at) <= now);
  const passed = done.filter((r) => r.conclusion === "success").length;
  // time to recover: from a workflow's first failure on the default branch to its next success
  const recover = [];
  const byFlow = Map.groupBy(done, (r) => `${r.repository?.name}\n${r.name}`);
  for (const list of byFlow.values()) {
    let failedAt = null;
    for (const r of list.sort((a, b) => ms(a.created_at) - ms(b.created_at))) {
      if (r.conclusion === "failure") failedAt ??= ms(r.created_at);
      else if (failedAt != null) { recover.push((ms(r.updated_at) - failedAt) / 60_000); failedAt = null; }
    }
  }
  return {
    days,
    merged: merged.length,
    perWeek: round(merged.length / (days / 7), 1),
    leadHours: round(median(merged.map((p) => (ms(p.merged_at) - ms(p.created_at)) / 3_600_000)), 1),
    runs: done.length,
    passRate: done.length ? round((100 * passed) / done.length) : null,
    reverts: merged.filter((p) => /^revert\b/i.test(String(p.title || ""))).length,
    revertRate: merged.length ? round((100 * merged.filter((p) => /^revert\b/i.test(String(p.title || ""))).length) / merged.length, 1) : null,
    recoveries: recover.length,
    recoverMinutes: round(median(recover)),
  };
}
