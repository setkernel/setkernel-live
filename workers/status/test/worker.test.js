// End to end in one process: the control Worker's views go in through the Feed entrypoint, land in the real
// Board class on a real SQLite, and come out of /status as HTML and JSON behind the Access check.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { Board, Feed, createHandler, guarded } from "../src/index.js";
import { fakeAccess, fakeNamespace, memoryKV } from "./fakes.js";

const AUD = "aud-sk-status";
const T0 = Date.parse("2026-10-16T12:00:00Z");
const WALL = "wall-client-id.access";
const PUBLISHER = "publisher-client-id.access";

async function setup({ guard = {}, env: extra = {} } = {}) {
  const access = await fakeAccess();
  const kv = memoryKV(Object.fromEntries(Object.entries(guard).map(([k, v]) => [`guard:${k}`, JSON.stringify(v)])));
  const env = { GUARD: kv, STATUS_ACCESS_AUD: AUD, STATUS_CLIENTS: JSON.stringify({ [WALL]: "internal", [PUBLISHER]: "public" }), ...extra };
  const clock = { t: T0 };
  // the board prunes and filters by its own clock, so it runs on the test's, not the real date
  env.BOARD = fakeNamespace(Board, env, (b) => { b.now = () => new Date(clock.t); });
  const handle = createHandler({ getKeys: access.getKeys, now: () => new Date(clock.t) });
  const base = { iss: "https://setkernel.cloudflareaccess.com", aud: [AUD], exp: T0 / 1000 + 3600 };
  const tokens = {
    raghav: await access.sign({ ...base, email: "raghav@example.com", sub: "u1" }),
    wall: await access.sign({ ...base, common_name: WALL, sub: "" }),
    publisher: await access.sign({ ...base, common_name: PUBLISHER, sub: "" }),
    stranger: await access.sign({ ...base, common_name: "someone-else.access", sub: "" }),
    otherApp: await access.sign({ ...base, aud: ["another-app"], email: "raghav@example.com" }),
    expired: await access.sign({ ...base, exp: T0 / 1000 - 1, email: "raghav@example.com" }),
  };
  const get = (path, token, headers = {}) => handle(new Request(`https://ctl.setkernel.net${path}`, { headers: { ...(token ? { "cf-access-jwt-assertion": token } : {}), ...headers } }), env);
  return { env, kv, clock, tokens, get, feed: new Feed({}, env) };
}

// What the control Worker's WorkItem.get() answers
const item = (ref, state, rev, extra = {}, dispatch = null) => ({ item: { ref, kind: "issue", state, rev, seat: null, pr: null, created_at: "2026-10-16T08:00:00Z", updated_at: "2026-10-16T11:00:00Z", ...extra }, dispatch });
const fired = { at: "2026-10-16T10:59:00Z", seat: "vega-setkernel", rev: 2, outcome: "fired", status: 200, session_id: "session_01ab", session_url: "https://claude.ai/code/session_01ab", error: null };

async function fill(feed) {
  const r = await feed.publish({
    items: [
      item("acme-client/secret-app#3", "queued", 1),
      item("setkernel/sk-demo#14", "queued", 1),
      item("setkernel/sk-demo#12", "running", 3, { seat: "vega-setkernel" }, fired),
      item("setkernel/hq#7", "merged", 6, { pr: 8, seat: "lyra-setkernel" }),
    ],
  });
  assert.equal(r.applied, 4);
}

test("GET /status renders the board for Raghav's phone, from the Durable Object's state", async () => {
  const { feed, get, tokens } = await setup();
  await fill(feed);
  const res = await get("/status", tokens.raghav, { accept: "text/html,application/xhtml+xml" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
  const html = await res.text();
  assert.doesNotMatch(html, /Running|Queue|Seats|sk-demo#12|acme-client|session_01ab/, "no running, queue or seats parts");
  assert.match(html, /Last 24 h: 1 merged, 0 failed/);
  assert.match(html, /<a href="https:\/\/github.com\/setkernel\/hq\/pull\/8">setkernel\/hq#7<\/a>/);
  assert.match(html, /Guard: ok/);
  assert.match(html, /url\(\/status\/fonts\/manrope-latin-400-normal.woff2\)/);
  assert.doesNotMatch(html, /<script|googleapis|gstatic/);
});

test("GET /status/internal.json is the internal view for the wall's service token", async () => {
  const { feed, get, tokens } = await setup();
  await fill(feed);
  const res = await get("/status/internal.json", tokens.wall);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, max-age=120");
  const v = await res.json();
  assert.deepEqual(Object.keys(v), ["generated_at", "snapshot_at", "guard", "last_24h"], "no queue, running or seats");
  assert.deepEqual(v.last_24h.events.map((e) => [e.ref, e.state, e.pr_url]), [["setkernel/hq#7", "merged", "https://github.com/setkernel/hq/pull/8"]]);
  // a browser asking /status with a service token still gets JSON
  assert.match((await get("/status", tokens.wall, { accept: "text/html" })).headers.get("content-type"), /json/);
});

test("the publisher's token reads the sanitized view and nothing else", async () => {
  const { feed, get, tokens } = await setup();
  await fill(feed);
  const res = await get("/status/public.json", tokens.publisher);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.deepEqual(JSON.parse(body), { generated_at: new Date(T0).toISOString(), last_24h: { merged: 1, failed: 0 } });
  for (const leak of ["acme", "secret-app", "sk-demo", "http", "-setkernel", "session"]) assert.ok(!body.includes(leak), leak);
  assert.equal((await get("/status/internal.json", tokens.publisher)).status, 403);
  assert.equal((await get("/status", tokens.publisher)).status, 403);
  assert.equal((await get("/status/public.json", tokens.raghav)).status, 200);
});

test("no valid Access token for this app, no status", async () => {
  const { get, tokens, env } = await setup();
  for (const [why, token] of [["none", null], ["garbage", "a.b.c"], ["another app", tokens.otherApp], ["expired", tokens.expired], ["unlisted service token", tokens.stranger]]) {
    assert.equal((await get("/status/internal.json", token)).status, 401, why);
  }
  assert.equal(env.BOARD.gets, 0, "the board is never read before auth");
});

test("fails closed: with no audience configured, even a good token gets a 401", async () => {
  const { get, tokens } = await setup({ env: { STATUS_ACCESS_AUD: undefined } });
  assert.equal((await get("/status/internal.json", tokens.raghav)).status, 401);
});

test("a malformed STATUS_CLIENTS lets no service token in, and people still get in", async () => {
  const { get, tokens } = await setup({ env: { STATUS_CLIENTS: JSON.stringify({ [WALL]: "admin" }) } });
  assert.equal((await get("/status/internal.json", tokens.wall)).status, 401);
  assert.equal((await get("/status/internal.json", tokens.raghav)).status, 200);
});

test("guard:refuse stops the public feed first; Raghav and the wall still see the guard", async () => {
  const until = new Date(T0 + 3 * 86400_000).toISOString();
  const { get, tokens } = await setup({ guard: { refuse: { since: "x", metrics: ["workers_cpu_ms"], until } } });
  const pub = await get("/status/public.json", tokens.publisher);
  assert.equal(pub.status, 503);
  assert.ok(Number(pub.headers.get("retry-after")) > 0);
  const internal = await get("/status/internal.json", tokens.wall);
  assert.equal(internal.status, 200);
  assert.equal(internal.headers.get("cache-control"), "private, max-age=600");
  assert.deepEqual((await internal.json()).guard, { level: "refuse", alert: true, degrade: true, refuse: true, metrics: ["workers_cpu_ms"], until });
  const html = await (await get("/status", tokens.raghav, { accept: "text/html" })).text();
  assert.match(html, /Guard: <span class="n">refuse<\/span> \(workers_cpu_ms, until/);
});

test("pollers reuse a snapshot for 120 s (600 s under degrade), people for 15 s", async () => {
  const { get, tokens, env, clock, kv } = await setup();
  await get("/status/internal.json", tokens.wall);
  await get("/status/internal.json", tokens.wall);
  assert.equal(env.BOARD.gets, 1);
  clock.t += 119_000;
  const reused = await get("/status/internal.json", tokens.wall);
  assert.equal(env.BOARD.gets, 1);
  assert.equal(reused.headers.get("vary"), "accept");
  const body = await reused.json();
  assert.equal(body.generated_at, new Date(clock.t).toISOString());
  assert.equal(body.snapshot_at, new Date(T0).toISOString(), "the data's age shows");
  await get("/status/internal.json", tokens.raghav); // older than a person's 15 s
  assert.equal(env.BOARD.gets, 2);
  await kv.put("guard:degrade", JSON.stringify({ since: "x", metrics: ["do_requests"], until: null }));
  clock.t += 121_000; // the guard is re-read after 60 s: degrade; the snapshot is 121 s old
  await get("/status/internal.json", tokens.wall);
  assert.equal(env.BOARD.gets, 2, "under degrade the wall waits 600 s, not 120");
  clock.t += 480_000;
  await get("/status/internal.json", tokens.wall);
  assert.equal(env.BOARD.gets, 3);
});

test("unknown paths are 404, writes are 405, and an error hides its detail", async () => {
  const { get, tokens, env } = await setup();
  assert.equal((await get("/status/../work-items", tokens.raghav)).status, 404);
  assert.equal((await get("/statusx", tokens.raghav)).status, 404);
  const post = await createHandler()(new Request("https://ctl.setkernel.net/status", { method: "POST" }), env);
  assert.equal(post.status, 405);
  const broken = { ...env, BOARD: { idFromName: () => ({}), get: () => ({ snapshot: async () => { throw new Error("secret detail"); } }) } };
  const logged = [];
  const quiet = console.error;
  console.error = (m) => logged.push(m);
  try {
    const access = await fakeAccess();
    const handle = guarded(createHandler({ getKeys: access.getKeys, now: () => new Date(T0) }));
    const token = await access.sign({ iss: "https://setkernel.cloudflareaccess.com", aud: AUD, exp: T0 / 1000 + 60, email: "raghav@example.com" });
    const res = await handle(new Request("https://ctl.setkernel.net/status/internal.json", { headers: { "cf-access-jwt-assertion": token } }), broken);
    assert.equal(res.status, 500);
    assert.doesNotMatch(await res.text(), /secret detail/);
    assert.match(logged.join("\n"), /secret detail/);
  } finally {
    console.error = quiet;
  }
});

test("the default export is a fetch handler that fails closed without an audience", async () => {
  const res = await worker.fetch(new Request("https://ctl.setkernel.net/status/internal.json", { headers: { "cf-access-jwt-assertion": "a.b.c" } }), { STATUS_ACCESS_AUD: "" });
  assert.equal(res.status, 401);
});

test("Feed.publish answers what the board did, so the control Worker can log a rejected view", async () => {
  const { feed } = await setup();
  const r = await feed.publish({ items: [item("setkernel/sk-demo#1", "queued", 1), item("bad", "queued", 1)] });
  assert.equal(r.ok, true);
  assert.equal(r.applied, 1);
  assert.equal(r.rejected[0].error, "ref must be owner/repo#N");
});
