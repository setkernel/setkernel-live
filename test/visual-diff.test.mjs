// The visual-diff check (setkernel-live#74): which paths count as UI, its plan step, its summary,
// and the workflow's shape: a required check that a fork's pull request can run. The drawing itself
// needs Playwright, which isn't a dependency; the workflow runs it. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SHOTS, isUiPath, summary, uiChanged } from "../scripts/visual-diff.mjs";

const script = fileURLToPath(new URL("../scripts/visual-diff.mjs", import.meta.url));
const plan = (paths) => spawnSync(process.execPath, [script, "plan"], { input: paths.join("\n"), encoding: "utf8" });
const workflow = readFileSync(new URL("../.github/workflows/visual-diff.yml", import.meta.url), "utf8");
const code = workflow.replace(/#.*$/gm, "");

test("the page's files are UI paths; the usage page, the Worker and docs are not", () => {
  for (const p of ["public/index.html", "public/app.js", "public/lib/day.js", "public/fonts/x.woff2", "public/_headers",
    "scripts/visual-diff.mjs", ".github/workflows/visual-diff.yml"]) assert.ok(isUiPath(p), p);
  for (const p of ["public/usage/index.html", "public/usage/table.js", "src/worker.js", "scripts/smoke.mjs", "README.md",
    "docs/design/v3/day/index.html", "test/page.test.mjs", "wrangler.jsonc", ".github/workflows/ci.yml", "xpublic/app.js"])
    assert.ok(!isUiPath(p), p);
  assert.equal(uiChanged([]), false);
  assert.equal(uiChanged(["README.md", "public/style.css"]), true);
});

test("plan says ui=false, and exits 0, when no UI path changed", () => {
  for (const paths of [[], ["src/worker.js", "public/usage/app.js", "AGENTS.md"]]) {
    const r = plan(paths);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "ui=false\n");
  }
  const r = plan(["src/worker.js", "  public/app.js  ", ""]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "ui=true\n");
});

test("bad usage exits 2", () => {
  assert.equal(spawnSync(process.execPath, [script], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [script, "render", "a"], { encoding: "utf8" }).status, 2);
});

test("it draws ?demo at 1440 x 900 and 375 x 812", () => {
  assert.deepEqual(SHOTS.map(([, w, h, q]) => `${w}x${h}${q}`), ["1440x900?demo", "375x812?demo"]);
  assert.equal(new Set(SHOTS.map(([n]) => n)).size, SHOTS.length);
});

test("the summary has a row per shot and says what changed or failed", () => {
  const ok = { errors: [] };
  const shot = (name, changed, head = ok, base = ok) => ({ name, width: 375, height: 812, query: "?demo", changed, base, head });
  const same = summary([shot("a", false), shot("b", false)]);
  assert.match(same, /No shot changed \(2 drawn\)/);
  assert.match(same, /\| a \| 375 x 812 \| `\?demo` \| same \|/);
  const some = summary([shot("a", true), shot("b", false, ok, { errors: ["boom"] })]);
  assert.match(some, /1 of 2 shots changed/);
  assert.match(some, /\| a \|.*\| changed \|/);
  assert.match(some, /\| b \|.*\| base failed: boom \|/);
  const bad = summary([shot("a", false, { errors: ["network: https://x.example/"] })]);
  assert.match(bad, /The head failed to draw cleanly in 1 of 1 shots/);
  assert.match(bad, /head failed: network: https:\/\/x\.example\//);
});

test("the workflow runs on every pull request, with no paths filter and no job condition", () => {
  assert.match(code, /^on:\n {2}pull_request:\n/m);
  assert.doesNotMatch(code, /pull_request_target|workflow_run|paths(-ignore)?:/);
  assert.match(code, /^ {2}visual-diff:\n {4}runs-on: ubuntu-latest\n/m);
  assert.doesNotMatch(code, /^ {4}if:/m, "a job-level if would skip the required check");
  // Every step past the plan that draws or installs waits for ui=true.
  const steps = code.split(/^ {6}- /m).slice(1);
  const drawing = steps.filter((s) => /playwright|render|worktree|upload-artifact/.test(s));
  assert.equal(drawing.length, 4);
  for (const s of drawing) assert.match(s, /steps\.plan\.outputs\.ui == 'true'/, s);
});

test("the workflow needs no secrets and no write access", () => {
  assert.doesNotMatch(code, /secrets\.|github\.token|GITHUB_TOKEN|id-token/);
  assert.equal(code.match(/permissions:/g).length, 1, "one permissions block, at the top");
  assert.doesNotMatch(code, /: *write\b/);
  assert.match(code, /^permissions:\n {2}contents: read\n\n/m);
  assert.match(code, /persist-credentials: false/);
});

test("the workflow pins its actions and Playwright", () => {
  const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.equal(uses.length, 3);
  for (const u of uses) assert.match(u, /^actions\/[\w-]+@[0-9a-f]{40}$/, u);
  assert.match(code, /playwright@\d+\.\d+\.\d+ *\n/);
  assert.match(code, /--ignore-scripts/);
});
