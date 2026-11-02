// The visual-diff check's poster (setkernel-live#74, slice 2). .github/workflows/visual-diff.yml runs
// on a pull request with a read-only token, a fork's included, so it can only keep its shots as the
// run's visual-diff artifact. .github/workflows/visual-diff-comment.yml runs this, from main, when
// that run completes: it commits the shots to the visual-diff-shots branch, under
// pr-<n>/<head sha>/, and posts them in one comment on the pull request, marked
// <!-- sk-visual head=<sha> -->. A later head rewrites the same comment.
//
//   node scripts/visual-diff-post.mjs find          prints artifact=true or artifact=false
//   node scripts/visual-diff-post.mjs post <dir>    publishes <dir>, the downloaded artifact; prints a summary
//
// Both read the workflow_run event from GITHUB_EVENT_PATH, and GITHUB_REPOSITORY and GITHUB_TOKEN.
//
// The artifact is untrusted: a pull request, a fork's too, can change the workflow that made it. So
// only the expected PNGs are read, each checked for its signature, size and dimensions; nothing in
// it is run, and no text from it reaches the comment. Its pull request number is only a candidate:
// the pull request is used only if it is open here and its head is the run's head (the event's
// head_sha). The only ref this ever writes is refs/heads/visual-diff-shots.

import { lstat, readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SHOTS } from "./visual-diff.mjs";

export const SHOTS_BRANCH = "visual-diff-shots";
const SHOTS_REF = `refs/heads/${SHOTS_BRANCH}`;
export const MAX_PNG = 5 * 1024 * 1024;
const MAX_JSON = 64 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BOT = "github-actions[bot]";

export const marker = (sha) => `<!-- sk-visual head=${sha} -->`;
const MARKED = /<!-- sk-visual head=[0-9a-f]{40} -->/;

// A PNG of exactly width x height: its signature, then IHDR, which holds the size.
export function checkPng(buf, width, height) {
  if (buf.length > MAX_PNG) return `over ${MAX_PNG} bytes`;
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE) || buf.toString("latin1", 12, 16) !== "IHDR")
    return "not a PNG";
  const [w, h] = [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  return w === width && h === height ? null : `${w} x ${h}, not ${width} x ${height}`;
}

// The downloaded artifact: base/<shot>.png, head/<shot>.png and visual-diff.json, nothing else, no
// links. A shot that failed to draw has no PNG. Throws on anything unexpected.
export async function readArtifact(dir) {
  const allowed = new Set(["visual-diff.json", "base", "head",
    ...SHOTS.flatMap(([name]) => [`base/${name}.png`, `head/${name}.png`])]);
  const walk = async (rel) => {
    for (const name of await readdir(join(dir, rel))) {
      const path = rel ? `${rel}/${name}` : name;
      if (!allowed.has(path)) throw new Error(`unexpected file in the artifact: ${JSON.stringify(path)}`);
      const st = await lstat(join(dir, path));
      const folder = path === "base" || path === "head";
      if (folder ? !st.isDirectory() : !st.isFile()) throw new Error(`not a plain ${folder ? "folder" : "file"}: ${path}`);
      if (folder) await walk(path);
    }
  };
  await walk("");
  const read = async (path, max) => {
    const st = await lstat(join(dir, path)).catch(() => null);
    if (!st) return null;
    if (st.size > max) throw new Error(`${path} is over ${max} bytes`);
    return readFile(join(dir, path));
  };
  const shots = [];
  for (const [name, width, height] of SHOTS) {
    const shot = { name, width, height };
    for (const side of ["base", "head"]) {
      const png = await read(`${side}/${name}.png`, MAX_PNG);
      const bad = png && checkPng(png, width, height);
      if (bad) throw new Error(`${side}/${name}.png: ${bad}`);
      shot[side] = png;
    }
    shot.changed = !!(shot.base && shot.head) && !shot.base.equals(shot.head);
    shots.push(shot);
  }
  const json = await read("visual-diff.json", MAX_JSON);
  let number = null;
  try {
    const n = JSON.parse(json)?.pr?.number;
    if (Number.isSafeInteger(n) && n > 0) number = n;
  } catch {}
  return { number, shots };
}

// The REST API with the job's token. fetch is a parameter so the tests can stand in for GitHub.
export function github({ repo, token, fetch = globalThis.fetch, base = "https://api.github.com" }) {
  return async (method, path, body) => {
    const res = await fetch(`${base}/repos/${repo}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, data };
  };
}

const ok = (r, what) => {
  if (r.status >= 200 && r.status < 300) return r.data;
  throw new Error(`${what}: HTTP ${r.status}${r.data?.message ? ` (${r.data.message})` : ""}`);
};

// The open pull request here whose head is the run's: the same commit, from the same repo and
// branch, so another pull request on the same commit can't take its comment. Candidates come from
// the event and the artifact; each is checked against GitHub. null if none matches (closed, moved
// on, or a lie).
export async function findPull(api, repo, run) {
  for (const n of new Set([...run.pulls, ...run.claimed].filter((n) => Number.isSafeInteger(n) && n > 0))) {
    const r = await api("GET", `/pulls/${n}`);
    if (r.status === 404) continue;
    const pr = ok(r, `pull request ${n}`);
    if (pr.state === "open" && pr.base?.repo?.full_name === repo && pr.head?.sha === run.headSha &&
      pr.head?.repo?.full_name === run.headRepo && pr.head?.ref === run.headBranch) return n;
  }
  return null;
}

// Commits the shots under pr-<n>/<sha>/ on top of visual-diff-shots (an orphan branch, made on the
// first run) and returns the commit that holds them. Another pull request's poster may move the
// branch meanwhile, so a rejected update starts again from the new tip.
export async function publish(api, number, headSha, shots, tries = 5) {
  const files = shots.flatMap((s) => ["base", "head"].filter((side) => s[side])
    .map((side) => ({ path: `pr-${number}/${headSha}/${side}/${s.name}.png`, png: s[side] })));
  const tree = [];
  for (const f of files) {
    const blob = ok(await api("POST", "/git/blobs", { content: f.png.toString("base64"), encoding: "base64" }), "blob");
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  for (let i = 0; i < tries; i++) {
    const ref = await api("GET", `/git/ref/heads/${SHOTS_BRANCH}`);
    const parent = ref.status === 404 ? null : ok(ref, SHOTS_BRANCH).object.sha;
    const parentTree = parent && ok(await api("GET", `/git/commits/${parent}`), "commit").tree.sha;
    const made = ok(await api("POST", "/git/trees", { ...(parentTree ? { base_tree: parentTree } : {}), tree }), "tree");
    if (made.sha === parentTree) return parent; // a re-run: these shots are already there
    const commit = ok(await api("POST", "/git/commits", {
      message: `visual-diff: pr-${number} ${headSha}`, tree: made.sha, parents: parent ? [parent] : [],
    }), "commit").sha;
    const moved = parent
      ? await api("PATCH", `/git/refs/heads/${SHOTS_BRANCH}`, { sha: commit, force: false })
      : await api("POST", "/git/refs", { ref: SHOTS_REF, sha: commit });
    if (moved.status === 422 || moved.status === 409) continue; // not a fast-forward, or made meanwhile
    ok(moved, `update ${SHOTS_BRANCH}`);
    return commit;
  }
  throw new Error(`${SHOTS_BRANCH} kept moving; gave up after ${tries} tries`);
}

const CONCLUSION = {
  success: "The check passed.",
  failure: "The check failed: the head didn't draw cleanly. The run's summary says why.",
};

// The comment, from this file and the event only: no text from the artifact.
export function commentBody({ repo, headSha, commit, number, runUrl, conclusion, shots }) {
  const raw = (side, name) => `https://raw.githubusercontent.com/${repo}/${commit}/pr-${number}/${headSha}/${side}/${name}.png`;
  const cell = (s, side) => s[side] ? `![${side}, ${s.width} x ${s.height}](${raw(side, s.name)})` : "not drawn";
  const state = (s) => !s.head ? "the head didn't draw" : !s.base ? "the base didn't draw" : s.changed ? "changed" : "same";
  const changed = shots.filter((s) => s.changed).length;
  return [
    marker(headSha),
    "### Visual diff",
    "",
    `\`?demo\` drawn from this pull request's base and from its head, \`${headSha.slice(0, 7)}\`, in the ` +
      `[Visual diff run](${runUrl}). ${changed ? `${changed} of ${shots.length} shots changed.` : "No shot changed."}` +
      (CONCLUSION[conclusion] ? ` ${CONCLUSION[conclusion]}` : ""),
    ...shots.flatMap((s) => [
      "",
      `#### ${s.width} x ${s.height}: ${state(s)}`,
      "",
      "| Base | Head |",
      "| --- | --- |",
      `| ${cell(s, "base")} | ${cell(s, "head")} |`,
    ]),
    "",
  ].join("\n");
}

// The poster's own marked comment, whatever head it names. Only the bot's: anyone can paste a marker.
export async function findComment(api, number) {
  for (let page = 1; page <= 30; page++) {
    const list = ok(await api("GET", `/issues/${number}/comments?per_page=100&page=${page}`), "comments");
    const hit = list.find((c) => c.user?.login === BOT && MARKED.test(c.body ?? ""));
    if (hit) return hit.id;
    if (list.length < 100) return null;
  }
  return null;
}

export async function comment(api, number, body) {
  const id = await findComment(api, number);
  if (id) ok(await api("PATCH", `/issues/comments/${id}`, { body }), "update comment");
  else ok(await api("POST", `/issues/${number}/comments`, { body }), "post comment");
  return id ? "updated" : "posted";
}

// The completed run, from the event GitHub wrote (not from the artifact).
export function runFromEvent(event) {
  const run = event?.workflow_run;
  if (!run || run.event !== "pull_request" || !SHA.test(run.head_sha ?? "")) return null;
  return { id: run.id, headSha: run.head_sha, headRepo: run.head_repository?.full_name, headBranch: run.head_branch,
    url: run.html_url, conclusion: run.conclusion, pulls: (run.pull_requests ?? []).map((p) => p.number) };
}

// find: did that run keep a visual-diff artifact? (None when no UI path changed.)
export async function find(api, run) {
  if (!run) return false;
  const r = ok(await api("GET", `/actions/runs/${run.id}/artifacts?name=visual-diff`), "artifacts");
  return (r.artifacts ?? []).some((a) => a.name === "visual-diff" && !a.expired);
}

export async function post(api, repo, run, dir) {
  if (!run) return "Not a pull request's run, so nothing was posted.";
  const { number: claimed, shots } = await readArtifact(dir);
  const number = await findPull(api, repo, { ...run, claimed: [claimed] });
  if (!number) return `No open pull request has head \`${run.headSha}\` any more, so nothing was posted.`;
  if (!shots.some((s) => s.base || s.head)) return "The artifact holds no shots, so nothing was posted.";
  const commit = await publish(api, number, run.headSha, shots);
  const body = commentBody({ repo, headSha: run.headSha, commit, number, runUrl: run.url, conclusion: run.conclusion, shots });
  return `Shots for \`${run.headSha}\` are on ${SHOTS_BRANCH} at \`${commit}\`; ${await comment(api, number, body)} the comment on #${number}.`;
}

// Not import.meta.main: that needs Node 24.2 (scripts/smoke.mjs says the same).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  if ((cmd === "find" && !args.length) || (cmd === "post" && args.length === 1)) {
    const repo = process.env.GITHUB_REPOSITORY;
    const run = runFromEvent(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")));
    const api = github({ repo, token: process.env.GITHUB_TOKEN });
    if (cmd === "find") console.log(`artifact=${await find(api, run)}`);
    else console.log(`### Visual diff comment\n\n${await post(api, repo, run, args[0])}`);
  } else {
    console.error("usage: visual-diff-post.mjs find | visual-diff-post.mjs post <artifact dir>");
    process.exitCode = 2;
  }
}
