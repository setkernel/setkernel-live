// When GitHub's API fails, test/private-repos.test.mjs fails only with LIVE_REPO_CHECK=1 (ci.yml);
// the deploy's re-gate (CI=true, no token, no flag) skips it, so a rate limit can't block a deploy.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const suite = fileURLToPath(new URL("./private-repos.test.mjs", import.meta.url));
// Every fetch answers 403, as GitHub does when the unauthenticated rate limit is spent.
const rateLimited = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => new Response("{}", { status: 403 });')}`;
function run(extra) {
  const env = { ...process.env, CI: "true", ...extra };
  for (const k of ["GITHUB_TOKEN", "SETKERNEL_REPO_TOKEN", "LIVE_REPO_CHECK", "NODE_TEST_CONTEXT"]) if (!(k in extra)) delete env[k];
  return spawnSync(process.execPath, ["--import", rateLimited, "--test", "--test-reporter=tap", suite], { env, encoding: "utf8" });
}

test("a failed GitHub request skips the live repo check outside ci.yml (the deploy's re-gate)", () => {
  const r = run({});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /# fail 0/);
  assert.match(r.stdout, /# SKIP no GitHub API here \(GitHub answered 403/);
});

test("a failed GitHub request fails the live repo check under ci.yml's LIVE_REPO_CHECK=1", () => {
  const r = run({ LIVE_REPO_CHECK: "1" });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /# fail 1/);
  assert.match(r.stdout, /GitHub answered 403 for the public repo list/);
});
