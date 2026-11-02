// The visual-diff check's poster (setkernel-live#74, slice 2): it reads only the expected PNGs from
// the untrusted artifact, posts only on the open pull request whose head is the run's head, writes
// only refs/heads/visual-diff-shots, and keeps one marked comment; and its workflow's shape. GitHub
// is a fake here. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SHOTS } from "../scripts/visual-diff.mjs";
import {
  MAX_PNG, SHOTS_BRANCH, checkPng, commentBody, find, github, marker, post, readArtifact, runFromEvent,
} from "../scripts/visual-diff-post.mjs";

const REPO = "setkernel/setkernel-live";
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const [[WIDE, W, H], [NARROW, w, h]] = SHOTS;

const png = (width, height, fill = 0) => {
  const b = Buffer.alloc(64, fill);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
};

// An artifact as visual-diff.yml uploads it: { "base/<shot>.png": Buffer, ..., "visual-diff.json": "..." }.
async function artifact(files) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "vd-"));
  for (const [path, body] of Object.entries(files)) {
    if (body === undefined) continue;
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), body);
  }
  return dir;
}
const good = (number = 7) => ({
  [`base/${WIDE}.png`]: png(W, H), [`head/${WIDE}.png`]: png(W, H, 1),
  [`base/${NARROW}.png`]: png(w, h), [`head/${NARROW}.png`]: png(w, h),
  "visual-diff.json": JSON.stringify({ pr: { number, head: HEAD }, shots: [] }),
});

// A fake GitHub: pulls by number, the shots branch, comments; records every request.
function fakeGitHub({ pulls = {}, branch = null, comments = [], moves = 0, artifacts = [], rerun = false } = {}) {
  const calls = [];
  const state = { branch, comments: [...comments], n: 0, moves: 0 };
  const sha = () => (++state.n).toString(16).padStart(40, "0");
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    const reply = (status, data) => ({ status, data });
    let m;
    if (method === "GET" && (m = path.match(/^\/pulls\/(\d+)$/)))
      return pulls[m[1]] ? reply(200, pulls[m[1]]) : reply(404, { message: "Not Found" });
    if (method === "GET" && path.startsWith("/actions/runs/")) return reply(200, { artifacts });
    if (method === "GET" && path === `/git/ref/heads/${SHOTS_BRANCH}`)
      return state.branch ? reply(200, { object: { sha: state.branch } }) : reply(404, { message: "Not Found" });
    if (method === "GET" && (m = path.match(/^\/git\/commits\/(\w+)$/))) return reply(200, { tree: { sha: `tree-of-${m[1]}` } });
    if (method === "POST" && path === "/git/blobs") return reply(201, { sha: sha() });
    // rerun: the shots are already on the branch, so GitHub hands back the tip's own tree.
    if (method === "POST" && path === "/git/trees") return reply(201, { sha: rerun && body.base_tree ? body.base_tree : sha() });
    if (method === "POST" && path === "/git/commits") return reply(201, { sha: sha() });
    if (method === "POST" && path === "/git/refs") {
      if (state.branch) return reply(422, { message: "Reference already exists" });
      state.branch = body.sha;
      return reply(201, {});
    }
    if (method === "PATCH" && path === `/git/refs/heads/${SHOTS_BRANCH}`) {
      if (state.moves < moves) { state.moves++; state.branch = sha(); return reply(422, { message: "not a fast forward" }); }
      state.branch = body.sha;
      return reply(200, {});
    }
    if (method === "GET" && (m = path.match(/^\/issues\/(\d+)\/comments\?/))) return reply(200, state.comments);
    if (method === "POST" && (m = path.match(/^\/issues\/(\d+)\/comments$/))) {
      state.comments.push({ id: 99, user: { login: "github-actions[bot]" }, body: body.body });
      return reply(201, {});
    }
    if (method === "PATCH" && (m = path.match(/^\/issues\/comments\/(\d+)$/))) {
      const c = state.comments.find((c) => c.id === Number(m[1]));
      c.body = body.body;
      return reply(200, {});
    }
    return reply(500, { message: `unexpected ${method} ${path}` });
  };
  return { api, calls, state };
}
const openPull = (sha = HEAD, head = {}) =>
  ({ state: "open", head: { sha, ref: "change", repo: { full_name: "someone/fork" }, ...head }, base: { repo: { full_name: REPO } } });
const run = (over = {}) => ({ id: 42, headSha: HEAD, headRepo: "someone/fork", headBranch: "change",
  url: "https://github.com/setkernel/setkernel-live/actions/runs/42", conclusion: "success", pulls: [], ...over });
const writes = (calls) => calls.filter((c) => c.method !== "GET");

test("a PNG must have the shot's exact size and stay under the cap", () => {
  assert.equal(checkPng(png(W, H), W, H), null);
  assert.equal(checkPng(png(w, h), W, H), `${w} x ${h}, not ${W} x ${H}`);
  assert.equal(checkPng(Buffer.from("<svg onload=alert(1)>".padEnd(64)), W, H), "not a PNG");
  assert.equal(checkPng(Buffer.alloc(10), W, H), "not a PNG");
  assert.equal(checkPng(Buffer.concat([png(W, H), Buffer.alloc(MAX_PNG)]), W, H), `over ${MAX_PNG} bytes`);
});

test("the artifact is read as the expected PNGs and nothing else", async (t) => {
  const dirs = [];
  t.after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));
  const make = async (files) => { const d = await artifact(files); dirs.push(d); return d; };

  const { number, shots } = await readArtifact(await make(good()));
  assert.equal(number, 7);
  assert.deepEqual(shots.map((s) => [s.name, s.changed]), [[WIDE, true], [NARROW, false]]);

  // A shot that didn't draw has no PNG; a JSON that isn't one only loses the candidate number.
  const { [`head/${NARROW}.png`]: _, ...missing } = good();
  const partial = await readArtifact(await make({ ...missing, "visual-diff.json": "{not json" }));
  assert.equal(partial.number, null);
  assert.equal(partial.shots[1].head, null);
  assert.equal(partial.shots[1].changed, false);
  for (const n of [0, -1, 1.5, "7", 2 ** 60]) {
    const r = await readArtifact(await make({ ...good(), "visual-diff.json": JSON.stringify({ pr: { number: n } }) }));
    assert.equal(r.number, null, String(n));
  }

  for (const [files, why] of [
    [{ ...good(), "base/run.sh": "echo" }, /unexpected file.*base\/run\.sh/],
    [{ ...good(), "head/x/y.png": png(W, H) }, /unexpected file.*head\/x/],
    [{ ...missing, "visual-diff.json": undefined, "visual-diff.json/a": "" }, /not a plain file: visual-diff\.json/],
    [{ ...good(), [`head/${WIDE}.png`]: png(w, h) }, /head\/demo-1440x900\.png: 375 x 812, not 1440 x 900/],
    [{ ...good(), [`base/${NARROW}.png`]: "not a png" }, /not a PNG/],
    [{ ...good(), "visual-diff.json": "x".repeat(70_000) }, /over/],
  ]) await assert.rejects(readArtifact(await make(files)), why);

  const linked = await make(good());
  await rm(join(linked, `head/${WIDE}.png`));
  await symlink("/etc/passwd", join(linked, `head/${WIDE}.png`));
  await assert.rejects(readArtifact(linked), /not a plain file/);
});

test("it posts only on the open pull request whose head is the run's head", async (t) => {
  const dir = await artifact(good(7));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Gone, moved on, closed, into another repo, or the same commit from another fork or branch.
  for (const pulls of [{}, { 7: openPull(OTHER) }, { 7: { ...openPull(), state: "closed" } },
    { 7: { ...openPull(), base: { repo: { full_name: "someone/fork" } } } },
    { 7: openPull(HEAD, { repo: { full_name: "victim/fork" } }) }, { 7: openPull(HEAD, { ref: "other" }) },
    { 7: openPull(HEAD, { repo: null }) }]) {
    const gh = fakeGitHub({ pulls });
    assert.match(await post(gh.api, REPO, run(), dir), /nothing was posted/);
    assert.deepEqual(writes(gh.calls), [], "no write when the pull request doesn't match");
  }
  // The event's pull request is tried first, and a false claim in the artifact is skipped.
  const gh = fakeGitHub({ pulls: { 7: openPull(OTHER), 8: openPull() } });
  assert.match(await post(gh.api, REPO, run({ pulls: [8] }), dir), /posted the comment on #8/);
  assert.ok(writes(gh.calls).every((c) => !c.path.includes("/issues/7/")));
  // A fork's run has no pull request in the event: the artifact's candidate, once checked, is used.
  const fork = fakeGitHub({ pulls: { 5: { ...openPull(), state: "closed" }, 7: openPull() } });
  assert.match(await post(fork.api, REPO, run({ pulls: [5] }), dir), /posted the comment on #7/);
  assert.equal(await post(fakeGitHub().api, REPO, null, dir), "Not a pull request's run, so nothing was posted.");
});

test("the only ref it writes is refs/heads/visual-diff-shots, whatever the artifact says", async (t) => {
  const evil = await artifact({ ...good(7), "visual-diff.json": JSON.stringify({ pr: { number: 7, head: "main", ref: "refs/heads/main" } }) });
  t.after(() => rm(evil, { recursive: true, force: true }));
  // First run: the branch is made as an orphan. Later: a fast-forward, retried when another poster moved it.
  for (const opts of [{}, { branch: "c".repeat(40) }, { branch: "c".repeat(40), moves: 2 }]) {
    const gh = fakeGitHub({ pulls: { 7: openPull() }, ...opts });
    await post(gh.api, REPO, run(), evil);
    const refWrites = writes(gh.calls).filter((c) => c.path.startsWith("/git/refs"));
    assert.ok(refWrites.length >= 1);
    for (const c of refWrites)
      assert.ok(c.path === `/git/refs/heads/${SHOTS_BRANCH}` ? c.body.force === false
        : c.path === "/git/refs" && c.body.ref === "refs/heads/visual-diff-shots", JSON.stringify(c));
    if (!opts.branch) assert.deepEqual(gh.calls.find((c) => c.path === "/git/commits" && c.method === "POST").body.parents, []);
    const trees = gh.calls.filter((c) => c.path === "/git/trees").flatMap((c) => c.body.tree.map((e) => e.path));
    assert.ok(trees.length && trees.every((p) => p.startsWith(`pr-7/${HEAD}/`)), trees.join());
  }
  // Every write the script can make goes to the shots branch's objects or the pull request's comment.
  const src = readFileSync(new URL("../scripts/visual-diff-post.mjs", import.meta.url), "utf8");
  assert.deepEqual([...src.matchAll(/api\("(POST|PATCH|PUT|DELETE)", ([^,)]+)/g)].map((m) => `${m[1]} ${m[2]}`).sort(), [
    "PATCH `/git/refs/heads/${SHOTS_BRANCH}`", "PATCH `/issues/comments/${id}`", "POST \"/git/blobs\"", "POST \"/git/commits\"",
    "POST \"/git/refs\"", "POST \"/git/trees\"", "POST `/issues/${number}/comments`",
  ]);
  assert.match(src, /^export const SHOTS_BRANCH = "visual-diff-shots";$/m);
  assert.match(src, /^const SHOTS_REF = `refs\/heads\/\$\{SHOTS_BRANCH\}`;$/m);
});

test("a re-run with the same shots makes no commit and links the tip that holds them", async (t) => {
  const dir = await artifact(good(7));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tip = "c".repeat(40);
  const gh = fakeGitHub({ pulls: { 7: openPull() }, branch: tip, rerun: true });
  assert.match(await post(gh.api, REPO, run(), dir), new RegExp(`on ${SHOTS_BRANCH} at \`${tip}\`; posted the comment on #7`));
  assert.deepEqual(gh.calls.filter((c) => c.path === "/git/commits" || c.path.startsWith("/git/refs")).filter((c) => c.method !== "GET"), []);
  assert.equal(gh.state.branch, tip);
  assert.ok(gh.state.comments[0].body.includes(`https://raw.githubusercontent.com/${REPO}/${tip}/pr-7/${HEAD}/`));
});

test("one marked comment: a later head rewrites the poster's own, not anyone else's", async (t) => {
  const dir = await artifact(good(7));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pasted = { id: 1, user: { login: "someone" }, body: marker(OTHER) };
  const old = { id: 2, user: { login: "github-actions[bot]" }, body: `${marker(OTHER)}\nold shots` };
  const gh = fakeGitHub({ pulls: { 7: openPull() }, comments: [pasted, old] });
  assert.match(await post(gh.api, REPO, run(), dir), /updated the comment on #7/);
  assert.equal(gh.state.comments[0].body, marker(OTHER));
  assert.ok(gh.state.comments[1].body.startsWith(`${marker(HEAD)}\n`));
  assert.equal(gh.state.comments.length, 2);

  const fresh = fakeGitHub({ pulls: { 7: openPull() }, comments: [pasted] });
  assert.match(await post(fresh.api, REPO, run(), dir), /posted the comment on #7/);
  assert.equal(fresh.state.comments.filter((c) => c.body.includes("<!-- sk-visual head=")).length, 2);
});

test("the comment shows base and head at each size, by the commit that holds them", () => {
  const shot = (name, width, height, base, head, changed) => ({ name, width, height, base, head, changed });
  const commit = "d".repeat(40);
  const body = commentBody({ repo: REPO, headSha: HEAD, commit, number: 7, runUrl: "https://example.test/run", conclusion: "failure",
    shots: [shot(WIDE, W, H, png(W, H), png(W, H, 1), true), shot(NARROW, w, h, png(w, h), null, false)] });
  assert.ok(body.startsWith(`<!-- sk-visual head=${HEAD} -->\n`));
  const raw = `https://raw.githubusercontent.com/${REPO}/${commit}/pr-7/${HEAD}`;
  assert.ok(body.includes(`| ![base, 1440 x 900](${raw}/base/${WIDE}.png) | ![head, 1440 x 900](${raw}/head/${WIDE}.png) |`));
  assert.match(body, /#### 1440 x 900: changed/);
  assert.match(body, /#### 375 x 812: the head didn't draw/);
  assert.ok(body.includes(`| ![base, 375 x 812](${raw}/base/${NARROW}.png) | not drawn |`));
  assert.match(body, /1 of 2 shots changed\. The check failed/);
  assert.match(body, /\[Visual diff run\]\(https:\/\/example\.test\/run\)/);
  // An unknown conclusion adds nothing.
  assert.doesNotMatch(commentBody({ repo: REPO, headSha: HEAD, commit, number: 7, runUrl: "u", conclusion: "<b>x</b>", shots: [] }), /<b>/);
});

test("the run comes from GitHub's event, and only a pull request's run counts", async () => {
  const event = { workflow_run: { id: 42, event: "pull_request", head_sha: HEAD, html_url: "u", conclusion: "success",
    pull_requests: [{ number: 8 }] } };
  assert.deepEqual(runFromEvent({ workflow_run: { ...event.workflow_run, head_branch: "change", head_repository: { full_name: "someone/fork" } } }),
    { id: 42, headSha: HEAD, headRepo: "someone/fork", headBranch: "change", url: "u", conclusion: "success", pulls: [8] });
  assert.equal(runFromEvent({ workflow_run: { ...event.workflow_run, event: "push" } }), null);
  assert.equal(runFromEvent({ workflow_run: { ...event.workflow_run, head_sha: "main" } }), null);
  assert.equal(runFromEvent({}), null);
  assert.equal(await find(fakeGitHub({ artifacts: [{ name: "visual-diff", expired: false }] }).api, run()), true);
  assert.equal(await find(fakeGitHub({ artifacts: [] }).api, run()), false);
  assert.equal(await find(fakeGitHub({ artifacts: [{ name: "visual-diff", expired: true }] }).api, run()), false);
  assert.equal(await find(fakeGitHub().api, null), false);
});

test("the API client sends the token and the JSON body", async () => {
  const seen = [];
  const fetch = async (url, init) => { seen.push({ url, init }); return { status: 201, json: async () => ({ sha: "x" }) }; };
  const r = await github({ repo: REPO, token: "t0k", fetch })("POST", "/git/blobs", { content: "" });
  assert.deepEqual(r, { status: 201, data: { sha: "x" } });
  assert.equal(seen[0].url, `https://api.github.com/repos/${REPO}/git/blobs`);
  assert.equal(seen[0].init.headers.Authorization, "Bearer t0k");
  assert.equal(seen[0].init.body, '{"content":""}');
});

test("bad usage exits 2", () => {
  const script = fileURLToPath(new URL("../scripts/visual-diff-post.mjs", import.meta.url));
  for (const args of [[], ["find", "x"], ["post"], ["push", "main"]])
    assert.equal(spawnSync(process.execPath, [script, ...args], { encoding: "utf8" }).status, 2, args.join(" "));
});

// The workflow: after "Visual diff", from main, with the only write access in this repo's PR workflows.
const workflow = readFileSync(new URL("../.github/workflows/visual-diff-comment.yml", import.meta.url), "utf8");
const code = workflow.replace(/#.*$/gm, "");
const drawn = readFileSync(new URL("../.github/workflows/visual-diff.yml", import.meta.url), "utf8");

test("the poster runs after the Visual diff workflow completes, never on a pull request itself", () => {
  const name = drawn.match(/^name: (.+)$/m)[1];
  assert.match(code, new RegExp(`^on:\\n {2}workflow_run:\\n {4}workflows: \\[${name}\\]\\n {4}types: \\[completed\\]\\n\\n`, "m"));
  assert.doesNotMatch(code, /pull_request_target|^ {2}pull_request:|^ {2}push:/m);
  assert.match(code, /^ {4}if: github\.event\.workflow_run\.event == 'pull_request'\n {4}runs-on: ubuntu-latest\n/m);
  assert.equal([...code.matchAll(/runs-on:/g)].length, 1);
});

test("the poster checks out main only and runs nothing from the pull request", () => {
  const checkouts = code.split(/^ {6}- /m).filter((s) => /actions\/checkout@/.test(s));
  assert.equal(checkouts.length, 1);
  assert.match(checkouts[0], /\n {10}ref: main\n/);
  assert.match(checkouts[0], /persist-credentials: false/);
  assert.doesNotMatch(code, /git (push|fetch|checkout)|\bgh |ref: (?!main\n)/);
  // The pull request's head names only the concurrency group.
  for (const line of code.split("\n").filter((l) => /workflow_run\.head/.test(l))) assert.match(line, /^ {2}group: /, line);
  // Event fields reach a shell only through the script, which reads GitHub's event file.
  for (const block of code.matchAll(/^ {8}run: (.+)$/gm)) assert.doesNotMatch(block[1], /\$\{\{/, block[1]);
  assert.match(code, /run: node scripts\/visual-diff-post\.mjs find >> "\$GITHUB_OUTPUT"/);
  assert.match(code, /run: node scripts\/visual-diff-post\.mjs post "\$RUNNER_TEMP\/visual-diff" >> "\$GITHUB_STEP_SUMMARY"/);
});

test("only the poster job can write, and only what it needs", () => {
  assert.match(code, /^permissions: \{\}\n/m);
  assert.equal(code.match(/permissions:/g).length, 2);
  assert.match(code, /^ {4}permissions:\n {6}actions: read *\n {6}contents: write *\n {6}pull-requests: write *\n {4}steps:/m);
  assert.doesNotMatch(code, /secrets\.|id-token/);
  const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.equal(uses.length, 3);
  for (const u of uses) assert.match(u, /^actions\/[\w-]+@[0-9a-f]{40}$/, u);
});
