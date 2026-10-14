// Smoke check after a deploy (setkernel-live#30). For a few minutes after a deploy the Durable
// Object can still run the old code, so this first polls /api/state until its `version` is the
// deployed commit (or 10 minutes pass), then checks each public route once.
//
//   node scripts/smoke.mjs --expect <commit>      (or EXPECTED_VERSION=<commit>)
//   [--base https://live.setkernel.com]
//
// Exit 0: all checks passed. 1: a check failed or the version never arrived. 2: bad usage.
// The output is status codes, key names and the version only, never a response body, so it can
// go into a public issue as it is.

export const BASE = "https://live.setkernel.com";
export const WAIT_MS = 10 * 60_000;
export const POLL_MS = 10_000;
export const REQUEST_MS = 15_000;
// What /api/state must carry: view() in public/lib/state.js plus the Hub's version.
export const STATE_KEYS = ["agents", "counts", "byAgent", "seen", "feed", "ci", "hours", "lastIngest", "now", "version"];

// One GET, never following redirects (Access answers some routes itself). Returns the status and,
// if asked, the parsed JSON body; a network error or timeout is status 0 with the error's name.
async function get(fetchFn, url, { json = false } = {}) {
  try {
    const res = await fetchFn(url, { redirect: "manual", headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(REQUEST_MS) });
    if (!json) {
      await res.body?.cancel();
      return { status: res.status };
    }
    try {
      return { status: res.status, body: await res.json() };
    } catch {
      return { status: res.status, error: "not JSON" };
    }
  } catch (err) {
    return { status: 0, error: err?.name || "fetch failed" };
  }
}

// Polls /api/state until `version` is `expected`. Returns { ok, version, polls, waitedMs }, where
// version is the last one seen (null if none was readable).
export async function waitForVersion(expected, { base = BASE, fetch: fetchFn = fetch, sleep, now = Date.now, waitMs = WAIT_MS, pollMs = POLL_MS, log = () => {} }) {
  const start = now();
  let version = null;
  for (let polls = 1; ; polls++) {
    const res = await get(fetchFn, `${base}/api/state`, { json: true });
    if (res.status === 200 && typeof res.body?.version === "string") version = res.body.version;
    if (version === expected) return { ok: true, version, polls, waitedMs: now() - start };
    const waitedMs = now() - start;
    if (waitedMs + pollMs > waitMs) return { ok: false, version, polls, waitedMs };
    log(`waiting: /api/state answered ${res.status}${res.error ? ` (${res.error})` : ""}, version ${version ?? "unknown"}, after ${Math.round(waitedMs / 1000)} s`);
    await sleep(pollMs);
  }
}

// Each route once. Returns [{ name, ok, detail }].
export async function checkRoutes(expected, { base = BASE, fetch: fetchFn = fetch }) {
  const status = (name, path, want) => async () => {
    const res = await get(fetchFn, `${base}${path}`);
    return { name, ok: res.status === want, detail: `${res.status}${res.error ? ` (${res.error})` : ""}, want ${want}` };
  };
  const state = async () => {
    const name = "GET /api/state";
    const res = await get(fetchFn, `${base}/api/state`, { json: true });
    if (res.status !== 200 || !res.body || typeof res.body !== "object") {
      return { name, ok: false, detail: `${res.status}${res.error ? ` (${res.error})` : ""}, want 200 and a JSON object` };
    }
    const missing = STATE_KEYS.filter((k) => !(k in res.body));
    if (missing.length) return { name, ok: false, detail: `200, missing keys: ${missing.join(", ")}` };
    if (res.body.version !== expected) return { name, ok: false, detail: `200, version ${String(res.body.version)}, want ${expected}` };
    return { name, ok: true, detail: `200, all ${STATE_KEYS.length} keys, version ${expected}` };
  };
  const replay = async () => {
    const name = "GET /api/replay?h=1";
    const res = await get(fetchFn, `${base}/api/replay?h=1`, { json: true });
    const ok = res.status === 200 && typeof res.body?.now === "number";
    return { name, ok, detail: `${res.status}${res.error ? ` (${res.error})` : ""}${ok ? "" : ", want 200 and JSON with now"}` };
  };
  return Promise.all([
    status("GET /", "/", 200)(),
    state(),
    replay(),
    status("GET /github/webhook", "/github/webhook", 405)(), // public, POST only
    status("GET /github/queue", "/github/queue", 401)(), // Access answers before the Worker
  ]);
}

// The whole smoke check. Returns { ok, lines }; the lines are the report.
export async function smoke(expected, opts) {
  const lines = [];
  const log = (line) => {
    lines.push(line);
    opts.log?.(line);
  };
  log(`smoke ${opts.base ?? BASE}, expecting version ${expected}`);
  const wait = await waitForVersion(expected, { ...opts, log });
  if (!wait.ok) {
    log(`FAIL the Durable Object still serves version ${wait.version ?? "unknown"} after ${Math.round(wait.waitedMs / 1000)} s (${wait.polls} polls)`);
    return { ok: false, lines };
  }
  log(`ok   version ${expected} after ${Math.round(wait.waitedMs / 1000)} s (${wait.polls} polls)`);
  const results = await checkRoutes(expected, opts);
  for (const r of results) log(`${r.ok ? "ok  " : "FAIL"} ${r.name}: ${r.detail}`);
  return { ok: results.every((r) => r.ok), lines };
}

// Commit ids only: the value goes into the output and maybe a public issue.
export function parseArgs(argv, env) {
  let expected = env.EXPECTED_VERSION;
  let base = BASE;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--expect") expected = argv[++i];
    else if (argv[i] === "--base") base = argv[++i];
    else return { error: `unknown argument ${argv[i]}` };
  }
  if (!expected || !/^[0-9a-f]{7,40}$/.test(expected)) return { error: "--expect <commit sha> (or EXPECTED_VERSION) is required" };
  if (!/^https?:\/\/[^/]+$/.test(base ?? "")) return { error: "--base must be an origin like https://live.setkernel.com" };
  return { expected, base };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2), process.env);
  if (args.error) {
    console.error(`smoke: ${args.error}`);
    process.exit(2);
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const { ok } = await smoke(args.expected, { base: args.base, sleep, log: (line) => console.log(line) });
  console.log(ok ? "smoke passed" : "smoke FAILED");
  process.exit(ok ? 0 : 1);
}
