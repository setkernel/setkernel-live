// scripts/smoke.mjs against a fake fetch and a fake clock (setkernel-live#30).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { POLL_MS, STATE_KEYS, WAIT_MS, checkRoutes, parseArgs, smoke, waitForVersion } from "../scripts/smoke.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OLD = "fedcba9876543210fedcba9876543210fedcba98";
const BASE = "https://live.example";

// A healthy site; `version()` decides what /api/state says, `override` replaces any route's answer.
function site({ version = () => SHA, override = {} } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const path = url.slice(BASE.length);
    calls.push({ path, init });
    if (path in override) return override[path]();
    if (path === "/api/state") {
      const state = Object.fromEntries(STATE_KEYS.map((k) => [k, null]));
      return Response.json({ ...state, version: version() });
    }
    if (path === "/api/replay?h=1") return Response.json({ work: [], pulses: [], now: 1 });
    if (path === "/") return new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } });
    if (path === "/github/webhook") return new Response("Method not allowed", { status: 405 });
    if (path === "/github/queue") return new Response("Access", { status: 401 });
    return new Response("Not found", { status: 404 });
  };
  return { fetch, calls };
}

// A clock that moves only when the script sleeps.
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test("passes at once when the deployed version is already serving", async () => {
  const { fetch, calls } = site();
  const { ok, lines } = await smoke(SHA, { base: BASE, fetch, ...clock() });
  assert.equal(ok, true, lines.join("\n"));
  assert.deepEqual(new Set(calls.map((c) => c.path)), new Set(["/api/state", "/", "/api/replay?h=1", "/github/webhook", "/github/queue"]));
  assert.ok(calls.every((c) => c.init.redirect === "manual"), "never follows redirects");
  assert.equal(lines.filter((l) => l.startsWith("FAIL")).length, 0);
});

test("waits while the Durable Object serves the old version, then checks", async () => {
  let polls = 0;
  const { fetch } = site({ version: () => (++polls < 4 ? OLD : SHA) });
  const c = clock();
  const { ok, lines } = await smoke(SHA, { base: BASE, fetch, ...c });
  assert.equal(ok, true, lines.join("\n"));
  assert.equal(c.now(), 3 * POLL_MS);
  assert.equal(lines.filter((l) => l.startsWith("waiting")).length, 3);
  assert.match(lines.find((l) => l.startsWith("waiting")), new RegExp(`version ${OLD}`));
});

test("waits through 404s and errors from old code, and through state with no version yet", async () => {
  const answers = [
    () => new Response("Not found", { status: 404 }),
    () => Promise.reject(Object.assign(new Error("boom"), { name: "TimeoutError" })),
    () => Response.json({ now: 1 }),
  ];
  let n = 0;
  const { fetch } = site({ override: { "/api/state": () => (n < answers.length ? answers[n++]() : Response.json({ ...Object.fromEntries(STATE_KEYS.map((k) => [k, 0])), version: SHA })) } });
  const { ok, lines } = await smoke(SHA, { base: BASE, fetch, ...clock() });
  assert.equal(ok, true, lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("answered 404")));
  assert.ok(lines.some((l) => l.includes("answered 0 (TimeoutError)")));
});

test("gives up after 10 minutes on the old version and checks nothing else", async () => {
  const { fetch, calls } = site({ version: () => OLD });
  const c = clock();
  const { ok, lines } = await smoke(SHA, { base: BASE, fetch, ...c });
  assert.equal(ok, false);
  assert.ok(c.now() <= WAIT_MS);
  assert.ok(c.now() > WAIT_MS - 2 * POLL_MS);
  assert.ok(calls.every((x) => x.path === "/api/state"));
  assert.match(lines.at(-1), new RegExp(`^FAIL the Durable Object still serves version ${OLD} after \\d+ s`));
});

test("waitForVersion reports how long it waited and what it last saw", async () => {
  const { fetch } = site({ version: () => OLD });
  const r = await waitForVersion(SHA, { base: BASE, fetch, ...clock(), waitMs: 30_000, pollMs: 10_000 });
  assert.deepEqual(r, { ok: false, version: OLD, polls: 4, waitedMs: 30_000 });
});

test("each route check fails on its own wrong answer", async () => {
  const cases = [
    ["/", () => new Response("down", { status: 502 }), "GET /", "502, want 200"],
    ["/api/replay?h=1", () => new Response("Not found", { status: 404 }), "GET /api/replay?h=1", "404"],
    ["/api/replay?h=1", () => new Response("<html>", { status: 200 }), "GET /api/replay?h=1", "200 (not JSON)"],
    ["/github/webhook", () => new Response("ok", { status: 200 }), "GET /github/webhook", "200, want 405"],
    ["/github/queue", () => new Response("Forbidden", { status: 403 }), "GET /github/queue", "403, want 401"],
    ["/github/queue", () => new Response(null, { status: 302, headers: { Location: "https://login.example" } }), "GET /github/queue", "302, want 401"],
    ["/api/state", () => Response.json({ agents: {}, version: SHA }), "GET /api/state", "missing keys: counts, byAgent"],
    ["/api/state", () => Response.json([1]), "GET /api/state", "missing keys"],
    ["/api/state", () => new Response("Not found", { status: 404 }), "GET /api/state", "404 (not JSON)"],
  ];
  for (const [path, answer, name, detail] of cases) {
    const { fetch } = site({ override: { [path]: answer } });
    const results = await checkRoutes(SHA, { base: BASE, fetch });
    const failed = results.filter((r) => !r.ok);
    assert.deepEqual(failed.map((r) => r.name), [name], `${path}: ${JSON.stringify(results)}`);
    assert.ok(failed[0].detail.includes(detail), `${path}: ${failed[0].detail}`);
  }
});

test("the state check fails if the version changes back after the wait", async () => {
  let polls = 0;
  const { fetch } = site({ version: () => (++polls === 1 ? SHA : OLD) });
  const { ok, lines } = await smoke(SHA, { base: BASE, fetch, ...clock() });
  assert.equal(ok, false);
  assert.ok(lines.includes(`FAIL GET /api/state: 200, version ${OLD}, want ${SHA}`), lines.join("\n"));
});

test("the report never carries a response body", async () => {
  const { fetch } = site({ override: { "/": () => new Response("secret page body", { status: 500 }) } });
  const { ok, lines } = await smoke(SHA, { base: BASE, fetch, ...clock() });
  assert.equal(ok, false);
  assert.doesNotMatch(lines.join("\n"), /secret/);
});

test("parseArgs wants a commit id and an origin", () => {
  assert.deepEqual(parseArgs(["--expect", SHA], {}), { expected: SHA, base: "https://live.setkernel.com" });
  assert.deepEqual(parseArgs([], { EXPECTED_VERSION: "abc1234" }), { expected: "abc1234", base: "https://live.setkernel.com" });
  assert.deepEqual(parseArgs(["--expect", SHA, "--base", BASE], {}), { expected: SHA, base: BASE });
  for (const argv of [[], ["--expect"], ["--expect", "main"], ["--expect", "$(id)"], ["--expect", SHA, "--base", "https://x/y"], ["--expect", SHA, "--nope"]]) {
    assert.ok(parseArgs(argv, {}).error, JSON.stringify(argv));
  }
  assert.match(parseArgs([], {}).error, /is required/);
  assert.match(parseArgs(["--expect", "ABCDEF1"], {}).error, /must be a lowercase hex commit id/);
});

// The script must run its check when started directly (by relative or absolute path), so a bad
// argument exits 2 instead of the script quietly doing nothing and exiting 0.
test("running the script directly parses its arguments", () => {
  const script = fileURLToPath(new URL("../scripts/smoke.mjs", import.meta.url));
  for (const path of [script, "scripts/smoke.mjs"]) {
    const run = spawnSync(process.execPath, [path, "--expect", "ABCDEF1"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", env: {} });
    assert.equal(run.status, 2, path);
    assert.match(run.stderr, /must be a lowercase hex commit id/);
  }
});
