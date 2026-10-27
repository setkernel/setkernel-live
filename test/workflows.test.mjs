// This repo is public: a fork's pull request runs the workflow's code, so any workflow that a
// pull_request or pull_request_target event starts must run on a GitHub-hosted runner, never the
// self-hosted setkernel-linux one (setkernel-live#59). Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("../.github/workflows/", import.meta.url);
const workflows = readdirSync(dir)
  .filter((n) => /\.ya?ml$/.test(n))
  .map((n) => ({ n, text: readFileSync(new URL(n, dir), "utf8") }));
const noComments = (t) => t.replace(/#.*$/gm, "");
const runners = (t) => [...noComments(t).matchAll(/^\s*runs-on:\s*(.+?)\s*$/gm)].map((m) => m[1]);
const fromPullRequest = (t) => /^\s*pull_request(_target)?\s*:/m.test(noComments(t));

test("workflows are found", () => {
  assert.ok(workflows.some((w) => w.n === "ci.yml"));
});

test("a workflow started by a pull request runs only on GitHub-hosted runners", () => {
  const hit = workflows.filter((w) => fromPullRequest(w.text));
  assert.ok(hit.length > 0, "ci.yml should run on pull_request");
  for (const { n, text } of hit) {
    const found = runners(text);
    assert.ok(found.length > 0, `${n} has no runs-on`);
    for (const r of found) assert.match(r, /^ubuntu-(latest|\d\d\.\d\d)$/, `${n} runs on ${r}`);
  }
});
