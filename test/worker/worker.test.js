// The real Worker and Hub Durable Object in workerd (setkernel-live#10): ingest auth, fan-out to
// sockets, state after eviction, the size cap, what the page needs to spot a quiet office, the
// replay route, and the GitHub webhook and pull queue.
// Run: npm run test:worker
import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker.js";
import { CERTS, ISSUER } from "../../src/access.js";
import { OFFLINE_AFTER_MS } from "../../public/lib/words.js"; // the page says "Office offline" after this
import { STATE_KEYS } from "../../scripts/smoke.mjs"; // what the post-deploy smoke check expects

const BASE = "https://live.setkernel.com";
const hub = () => env.HUB.get(env.HUB.idFromName("live"));

// Access tokens signed with a throwaway key; the Worker's fetch of Access's certs gets its public half.
const buzzPosts = []; // what the Worker posted to the Buzz relay
let privateKey;
let jwk;
const b64url = (s) => btoa(typeof s === "string" ? s : String.fromCharCode(...s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sign(claims) {
  const head = `${b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(head));
  return `${head}.${b64url(new Uint8Array(sig))}`;
}
const claims = (extra = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return { iss: ISSUER, aud: [env.INGEST_AUD], exp: now + 600, iat: now, ...extra };
};

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  privateKey = pair.privateKey;
  jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === CERTS) return Promise.resolve(Response.json({ keys: [jwk] }));
    if (url === `${env.BUZZ_RELAY_URL}/events`) {
      buzzPosts.push(JSON.parse(init.body));
      return Promise.resolve(Response.json({ accepted: true }));
    }
    return realFetch(input, init);
  });
});

const sockets = [];
afterEach(async () => {
  buzzPosts.length = 0;
  for (const ws of sockets.splice(0)) {
    try {
      ws.close(1000, "done");
    } catch {
      // already closed
    }
  }
  // Wipe the one "live" object and drop its memory between tests (reset() and
  // abortAllDurableObjects() do too, but log a stack trace each time).
  await runInDurableObject(hub(), (_, ctx) => ctx.storage.deleteAll());
  await evictDurableObject(hub(), { webSockets: "close" });
});

// POSTs a batch as sk-obs01 would (a valid token unless one is given) and returns the status.
// Bodies are always read: an unread one keeps the request open and evictDurableObject waits on it.
async function ingest(body, { token } = {}) {
  const headers = {};
  if (token !== null) headers["Cf-Access-Jwt-Assertion"] = token ?? (await sign(claims()));
  const res = await exports.default.fetch(`${BASE}/ingest`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  await res.text();
  return res.status;
}
const state = async () => (await exports.default.fetch(`${BASE}/api/state`)).json();
const batch = (events = [], agents = { Vega: { state: "WORKING", work: "issue", repo: "setkernel-live" } }) => ({ events, agents });
const claude = (agent = "Vega") => ({ t: "msg", kind: "claude", agent, ts: Math.floor(Date.now() / 1000) });

// A viewer: opens /ws like the page does and queues what arrives.
async function viewer() {
  const res = await exports.default.fetch(`${BASE}/ws`, { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  const inbox = [];
  let wake = () => {};
  ws.addEventListener("message", (m) => {
    inbox.push(JSON.parse(m.data));
    wake();
  });
  ws.accept();
  sockets.push(ws);
  return {
    async next() {
      while (!inbox.length) await new Promise((r) => (wake = r));
      return inbox.shift();
    },
  };
}

describe("ingest auth", () => {
  it("rejects a missing, malformed, wrong-audience, wrong-issuer or expired token, and changes nothing", async () => {
    const tokens = [
      null,
      "",
      "not.a.jwt",
      await sign(claims({ aud: ["b".repeat(64)] })),
      await sign(claims({ iss: "https://evil.cloudflareaccess.com" })),
      await sign(claims({ exp: Math.floor(Date.now() / 1000) - 5 })),
    ];
    for (const token of tokens) {
      expect(await ingest(batch([claude()]), { token }), `token ${String(token).slice(0, 20)}`).toBe(403);
    }
    const s = await state();
    expect(s.counts.claude).toBe(0);
    expect(s.lastIngest).toBe(0);
  });

  it("rejects a token signed by another key", async () => {
    const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const head = (await sign(claims())).split(".").slice(0, 2).join(".");
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", other.privateKey, new TextEncoder().encode(head));
    expect(await ingest(batch([claude()]), { token: `${head}.${b64url(new Uint8Array(sig))}` })).toBe(403);
  });

  it("answers 405 to anything but POST, and 503 when INGEST_AUD is empty", async () => {
    const get = await exports.default.fetch(`${BASE}/ingest`);
    await get.text();
    expect(get.status).toBe(405);
    const req = new Request(`${BASE}/ingest`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": await sign(claims()) }, body: "{}" });
    const res = await worker.fetch(req, { ...env, INGEST_AUD: "" });
    await res.text();
    expect(res.status).toBe(503);
  });

  it("accepts a valid token and applies the batch", async () => {
    expect(await ingest(batch([claude(), claude("Rigel")]))).toBe(200);
    const s = await state();
    expect(s.counts.claude).toBe(2);
    expect(s.agents).toEqual({ Vega: { state: "WORKING", work: "issue", repo: "setkernel-live" } });
    expect(s.lastIngest).toBeGreaterThan(0);
  });

  it("carries a VM that stopped reporting to /api/state: SILENT and its last run, checked on the Worker's clock (setkernel-live#54)", async () => {
    const lastRun = Math.floor(Date.now() / 60_000) * 60 - 20 * 60; // 20 minutes ago, on a whole minute
    expect(await ingest(batch([], {
      Orion: { state: "SILENT", lastRun, host: "orion-dev" },
      Vega: { state: "SILENT", lastRun: lastRun + 3600 }, // in the future: the time goes, the state stays
      Lyra: { state: "IDLE", lastRun },
    }))).toBe(200);
    expect((await state()).agents).toEqual({ Orion: { state: "SILENT", lastRun }, Vega: { state: "SILENT" }, Lyra: { state: "IDLE" } });
  });
});

describe("size cap", () => {
  // A valid batch padded to exactly `size` characters.
  const padded = (size) => {
    const body = JSON.stringify(batch([claude()]));
    const out = body.slice(0, -1) + `,"pad":"${"x".repeat(size - body.length - 9)}"}`;
    expect(out.length).toBe(size);
    return out;
  };

  it("answers 413 one character over 256 KiB and leaves the state alone", async () => {
    expect(await ingest(padded(256 * 1024 + 1))).toBe(413);
    const s = await state();
    expect(s.counts.claude).toBe(0);
    expect(s.lastIngest).toBe(0);
  });

  it("accepts a body at the cap", async () => {
    expect(await ingest(padded(256 * 1024))).toBe(200);
  });
});

describe("fan-out", () => {
  it("greets each viewer with the picture, then sends every batch to all of them", async () => {
    await ingest(batch([claude()]));
    const a = await viewer();
    const b = await viewer();
    for (const v of [a, b]) {
      const hello = await v.next();
      expect(hello.t).toBe("hello");
      expect(hello.counts.claude).toBe(1);
      expect(typeof hello.now).toBe("number");
    }
    expect(await ingest(batch([claude("Lyra"), { t: "msg", kind: "github", agent: "Orion", action: "opened_pr", repo: "setkernel-live" }]))).toBe(200);
    for (const v of [a, b]) {
      const msg = await v.next();
      expect(msg.t).toBe("batch");
      expect(msg.events.map((e) => e.agent)).toEqual(["Lyra", "Orion"]);
      expect(msg.counts).toMatchObject({ claude: 2, prs: 1 });
      expect(msg.feed[0]).toMatchObject({ agent: "Orion", action: "opened_pr", repo: "setkernel-live" });
    }
  });

  it("sends only allowlisted fields to viewers", async () => {
    const v = await viewer();
    await v.next(); // hello
    await ingest(batch([{ ...claude(), title: "secret PR title", host: "box.example.test" }, { t: "msg", kind: "github", agent: "Mallory", action: "opened_pr" }]));
    const msg = await v.next();
    expect(msg.events).toEqual([{ t: "msg", kind: "claude", agent: "Vega", ts: expect.any(Number) }]);
    expect(JSON.stringify(msg)).not.toMatch(/secret|box.example.test|Mallory/);
  });

  it("keeps each engineer's lane on the line, with nothing beyond actions, times and public repos", async () => {
    const ts = Math.floor(Date.now() / 1000) - 30;
    await ingest(batch([
      { t: "msg", kind: "github", agent: "Vega", action: "picked_up", repo: "setkernel-live", ts, title: "secret issue title", number: 77, branch: "agent/77-secret" },
      { ...claude(), ts: ts + 5 },
    ]));
    const s = await state();
    expect(s.line.Vega).toEqual({ job: "started", at: ts, built: true, repo: "setkernel-live", steps: { started: ts, building: ts + 5 } });
    expect(s.counts).toMatchObject({ started: 1, building: 1 });
    expect(JSON.stringify(s.line)).not.toMatch(/secret|title|number|branch/); // the number by key: its digits could be in a time
  });
});

describe("requests and Polaris's merges", () => {
  it("shows a request apart from work and rings the merge Polaris made, with nothing but star names", async () => {
    const ts = Math.floor(Date.now() / 1000) - 30;
    const v = await viewer();
    await v.next(); // hello
    await ingest(batch([
      { t: "msg", kind: "request", agent: "Polaris", action: "opened_issue", ts, title: "secret issue title", body: "secret body", number: 4243 },
      { t: "msg", kind: "request", agent: "Kochab", action: "commented", repo: "setkernel-live", ts: ts + 1 },
      { t: "msg", kind: "github", agent: "Vega", action: "merged", repo: "setkernel-live", ts: ts + 2 },
      { t: "msg", kind: "github", agent: "Polaris", action: "merged_by", repo: "setkernel-live", ts: ts + 2 },
      { t: "msg", kind: "claude", agent: "Yildun", ts: ts + 3 },
      { t: "msg", kind: "chat", agent: "Yildun", ts: ts + 3 }, // only its Claude requests
      { t: "msg", kind: "github", agent: "Vega", action: "merged_by", ts: ts + 4 }, // only the director merges
    ]));
    const msg = await v.next();
    expect(msg.events.map((e) => [e.agent, e.kind, e.action])).toEqual([
      ["Polaris", "request", "opened_issue"], ["Kochab", "request", "commented"], ["Vega", "github", "merged"], ["Polaris", "github", "merged_by"], ["Yildun", "claude", undefined],
    ]);
    expect(msg.byAgent.Polaris).toMatchObject({ requests: 1, merges: 1, prs: 0, reviews: 0, claude: 0 });
    expect(msg.byAgent.Vega).toMatchObject({ merged: 1, ringed: 1 });
    expect(msg.counts).toMatchObject({ requests: 2, merged: 1, merges: 1, ringed: 1, claude: 1 });
    expect(msg.feed.slice(0, 4).map((f) => [f.agent, f.action])).toEqual([["Polaris", "merged_by"], ["Vega", "merged"], ["Kochab", "commented"], ["Polaris", "opened_issue"]]);
    expect(JSON.stringify(msg)).not.toMatch(/secret|4243/);
    const replay = await (await exports.default.fetch(`${BASE}/api/replay`)).json();
    expect(replay.work.map((w) => w.action)).toEqual(["opened_issue", "commented", "merged", "merged_by"]);
  });
});

describe("eviction", () => {
  it("restores the saved picture and still reaches hibernated sockets", async () => {
    await ingest(batch([claude(), claude("Lyra")]));
    const v = await viewer();
    await v.next(); // hello
    const before = await state();
    await evictDurableObject(hub());
    const after = await state();
    expect(after.counts).toEqual(before.counts);
    expect(after.agents).toEqual(before.agents);
    expect(after.lastIngest).toBe(before.lastIngest);
    await ingest(batch([claude("Orion")]));
    const msg = await v.next();
    expect(msg.t).toBe("batch");
    expect(msg.counts.claude).toBe(3);
  });

  it("keeps every batch that carries events, even within the minute of the last save", async () => {
    await ingest(batch([claude()]));
    await ingest(batch([claude("Lyra")]));
    await evictDurableObject(hub());
    const after = await state();
    expect(after.counts.claude).toBe(2);
    const res = await exports.default.fetch(`${BASE}/api/replay?h=24`);
    const replay = await res.json();
    // pulses are one row per minute: both batches land in it, as [minute, ...counts]
    const total = replay.pulses.reduce((n, r) => n + r.slice(1).reduce((a, b) => a + b, 0), 0);
    expect(total).toBe(2);
  });
});

describe("a quiet office", () => {
  it("reports an old lastIngest so the page shows offline, and a heartbeat clears it", async () => {
    // A picture saved ten minutes ago, as if sk-obs01 stopped pushing then.
    await runInDurableObject(hub(), async (instance, ctx) => {
      await ctx.storage.put("state", { ...instance.state, lastIngest: Date.now() - 10 * 60_000 });
    });
    await evictDurableObject(hub());
    const stale = await state();
    expect(stale.now - stale.lastIngest).toBeGreaterThan(OFFLINE_AFTER_MS);

    const v = await viewer();
    const hello = await v.next();
    expect(hello.now - hello.lastIngest).toBeGreaterThan(OFFLINE_AFTER_MS);

    // sk-obs01 is back: an empty batch is a heartbeat, broadcast so open pages clear the banner.
    expect(await ingest(batch([]))).toBe(200);
    const beat = await v.next();
    expect(beat).toMatchObject({ t: "batch", events: [] });
    expect(beat.now - beat.lastIngest).toBeLessThan(OFFLINE_AFTER_MS);
    const fresh = await state();
    expect(fresh.now - fresh.lastIngest).toBeLessThan(OFFLINE_AFTER_MS);
  });

  it("sends an empty heartbeat at most every 30 s, but always records it", async () => {
    const v = await viewer();
    await v.next(); // hello
    await ingest(batch([]));
    expect(await v.next()).toMatchObject({ t: "batch", events: [] }); // first heartbeat goes out

    await ingest(batch([], { Rigel: { state: "IDLE" } })); // within 30 s: not broadcast
    expect((await state()).agents).toEqual({ Rigel: { state: "IDLE" } });

    await runInDurableObject(hub(), (instance) => {
      instance.lastBroadcast = Date.now() - 31_000;
    });
    await ingest(batch([], { Lyra: { state: "REVIEW" } }));
    // The next message is the late heartbeat, so the one in between was held back.
    expect(await v.next()).toMatchObject({ t: "batch", events: [], agents: { Lyra: { state: "REVIEW" } } });
  });
});

describe("version", () => {
  it("answers /api/state with every key the smoke check wants, and the Hub's version", async () => {
    const res = await exports.default.fetch(`${BASE}/api/state`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const s = await res.json();
    expect(Object.keys(s).sort()).toEqual([...STATE_KEYS].sort());
    expect(s.version).toBe(env.VERSION); // "dev" from wrangler.jsonc; the deploy sets the commit
    expect(s.version).toBe("dev");
  });
});

describe("replay", () => {
  const replay = async (query = "") => {
    const res = await exports.default.fetch(`${BASE}/api/replay${query}`);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=30");
    return res.json();
  };

  it("serves the last hour by default and 24 hours with ?h=24, allowlisted only", async () => {
    const now = Math.floor(Date.now() / 1000);
    const pr = (ts) => ({ t: "msg", kind: "github", agent: "Orion", action: "opened_pr", repo: "setkernel-live", ts, title: "secret PR title" });
    await ingest(batch([claude(), pr(now), pr(now - 2 * 3600), { ...claude("Mallory") }]));

    for (const query of ["", "?h=1", "?h=7"]) {
      const hour = await replay(query);
      expect(typeof hour.now).toBe("number");
      expect(hour.work).toEqual([{ agent: "Orion", action: "opened_pr", repo: "setkernel-live", ts: now }]);
      expect(hour.pulses).toHaveLength(1);
    }
    const day = await replay("?h=24");
    expect(day.work.map((w) => w.ts)).toEqual([now - 2 * 3600, now]);
    expect(day.pulses).toHaveLength(2);
    expect(JSON.stringify(day)).not.toMatch(/secret|Mallory/);
  });

  it("keeps the replay buffer across an eviction", async () => {
    await ingest(batch([claude(), { t: "msg", kind: "github", agent: "Lyra", action: "approved", repo: "setkernel-live" }]));
    const before = await replay("?h=24");
    await evictDurableObject(hub());
    const after = await replay("?h=24");
    expect(after.pulses).toEqual(before.pulses);
    expect(after.work).toEqual(before.work);
    expect(after.work).toHaveLength(1);
  });
});

describe("GitHub webhook and queue", () => {
  const SECRET = "throwaway-webhook-secret"; // a test value; the real one is a Worker secret
  const withSecret = { ...env, GITHUB_WEBHOOK_SECRET: SECRET };
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  async function signBody(body, secret = SECRET) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return `sha256=${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))}`;
  }
  // Delivers a webhook as GitHub would (signed with SECRET unless a signature is given).
  async function deliver(event, payload, { signature, delivery = crypto.randomUUID(), envOverride = withSecret } = {}) {
    const body = JSON.stringify(payload);
    const headers = { "X-GitHub-Event": event, "X-GitHub-Delivery": delivery, "Content-Type": "application/json" };
    const sig = signature === undefined ? await signBody(body) : signature;
    if (sig !== null) headers["X-Hub-Signature-256"] = sig;
    const res = await worker.fetch(new Request(`${BASE}/github/webhook`, { method: "POST", headers, body }), envOverride);
    return { status: res.status, text: await res.text() };
  }
  // Pulls the queue as sk-obs01 would (a valid "live queue" token unless one is given).
  async function pull(query = "", { token, envOverride = env } = {}) {
    const headers = {};
    if (token !== null) headers["Cf-Access-Jwt-Assertion"] = token ?? (await sign(claims({ aud: [env.QUEUE_AUD] })));
    const res = await worker.fetch(new Request(`${BASE}/github/queue${query}`, { headers }), envOverride);
    return { status: res.status, body: await res.text() };
  }
  const run = (id, extra = {}) => ({
    action: "completed",
    repository: { name: "setkernel-live", private: false },
    workflow: { name: "deploy" },
    workflow_run: { id, conclusion: "success", updated_at: new Date().toISOString(), display_title: "secret commit message", head_branch: "secret-branch" },
    sender: { login: "someone" },
    ...extra,
  });

  it("answers 401 to a missing, malformed or wrong signature, and queues nothing", async () => {
    const wrong = await signBody(JSON.stringify(run(1)), "another-secret");
    for (const signature of [null, "", "sha256=nothex", "sha1=" + "0".repeat(40), wrong]) {
      expect(await deliver("workflow_run", run(1), { signature }), `signature ${signature}`).toEqual({ status: 401, text: "Bad signature" });
    }
    expect(JSON.parse((await pull()).body).events).toEqual([]);
  });

  it("answers a signed ping with pong", async () => {
    expect(await deliver("ping", { zen: "Keep it logically awesome.", hook_id: 1 })).toEqual({ status: 200, text: "pong" });
  });

  it("answers 405 to anything but POST, and 503 without the webhook secret", async () => {
    const get = await worker.fetch(new Request(`${BASE}/github/webhook`), withSecret);
    await get.text();
    expect(get.status).toBe(405);
    expect((await deliver("ping", {}, { envOverride: { ...env, GITHUB_WEBHOOK_SECRET: "" } })).status).toBe(503);
  });

  it("queues a signed run once, cut down, for sk-obs01 to pull", async () => {
    expect(await deliver("workflow_run", run(42), { delivery: "d-1" })).toEqual({ status: 202, text: "Queued" });
    expect(await deliver("workflow_run", run(42), { delivery: "d-1" })).toEqual({ status: 200, text: "Duplicate" });
    expect(await deliver("issues", { action: "opened" })).toEqual({ status: 202, text: "Ignored" }); // no issue in it: nothing to keep
    expect(await deliver("star", { action: "created", repository: { name: "setkernel-live" } })).toEqual({ status: 202, text: "Ignored" }); // not an event it keeps
    const { status, body } = await pull();
    expect(status).toBe(200);
    const q = JSON.parse(body);
    expect(q.events).toEqual([{ cursor: 1, kind: "run", repo: "setkernel-live", private: false, workflow: "deploy", conclusion: "success", ts: expect.any(Number) }]);
    expect(q).toMatchObject({ cursor: 1, more: false, gap: false });
    expect(body).not.toMatch(/secret|someone/);
    expect(JSON.parse((await pull("?since=1")).body).events).toEqual([]);
  });

  it("queues pull requests and reviews under star names, never a login, title, branch or body", async () => {
    const pr = (action, login, head, extra = {}) => ({
      action,
      repository: { name: "setkernel-live", private: false },
      pull_request: { id: 9001, number: 77, title: "secret title", body: "secret body", user: { login }, head: { ref: head }, merged: action === "closed", created_at: new Date().toISOString(), merged_at: new Date().toISOString() },
      sender: { login },
      ...extra,
    });
    expect(await deliver("pull_request", pr("opened", "realRaghavGupta", "claude/secret-branch"))).toEqual({ status: 202, text: "Queued" });
    expect(await deliver("pull_request", pr("closed", "realRaghavGupta", "claude/secret-branch"))).toEqual({ status: 202, text: "Queued" });
    const review = (id, login, body) => ({ review: { id, state: "approved", body, user: { login }, submitted_at: new Date().toISOString() } });
    expect(await deliver("pull_request_review", pr("submitted", "realRaghavGupta", "claude/secret-branch", review(31, "lyra-setkernel", "secret")))).toEqual({ status: 202, text: "Queued" });
    expect(await deliver("pull_request_review", pr("submitted", "vega-setkernel", "agent/secret-branch", review(32, "realRaghavGupta", "secret\n\n— Claude Lead")))).toEqual({ status: 202, text: "Queued" });
    expect(await deliver("pull_request_review", pr("submitted", "vega-setkernel", "agent/secret-branch", review(33, "realRaghavGupta", "secret")))).toEqual({ status: 202, text: "Queued" });
    // a stranger, even with a marker: signed, but nothing to keep
    expect(await deliver("pull_request", pr("opened", "someone", "claude/secret-branch"))).toEqual({ status: 202, text: "Ignored" });
    const { body } = await pull();
    const q = JSON.parse(body);
    expect(q.events.map(({ action, actor }) => [action, actor])).toEqual([["opened_pr", "Pherkad"], ["merged", "Pherkad"], ["approved", "Lyra"], ["approved", "Kochab"], ["approved", "Polaris"]]);
    expect(q.events[0]).toEqual({ cursor: 1, kind: "pr", repo: "setkernel-live", private: false, action: "opened_pr", actor: "Pherkad", ts: expect.any(Number) });
    expect(body).not.toMatch(/secret|someone|raghav|lyra-setkernel|claude\/|Claude|—/i);
    // the id and number as whole values: as substrings they can turn up inside a timestamp
    expect(q.events.flatMap(Object.values).filter((v) => [9001, 77, "9001", "77"].includes(v))).toEqual([]);
  });

  it("queues issues opened and comments as requests, and Polaris's merges, never a title, body, number or login", async () => {
    const now = new Date().toISOString();
    const issue = (action, login, body, extra = {}) => ({
      action,
      repository: { name: "hq", private: true },
      issue: { id: 8801, number: 4243, title: "secret issue title", body, user: { login }, labels: [{ name: "secret-label" }], created_at: now },
      sender: { login },
      ...extra,
    });
    const comment = (id, login, body) => issue("created", "vega-setkernel", "secret issue body", { comment: { id, body, user: { login }, created_at: now } });
    expect(await deliver("issues", issue("opened", "realRaghavGupta", "secret body"))).toEqual({ status: 202, text: "Queued" });
    expect(await deliver("issues", issue("edited", "realRaghavGupta", "secret body"))).toEqual({ status: 202, text: "Ignored" });
    expect(await deliver("issue_comment", comment(9901, "realRaghavGupta", "secret comment\n\n— Claude Lead"))).toEqual({ status: 202, text: "Queued" });
    expect(await deliver("issue_comment", comment(9902, "lyra-setkernel", "secret comment"))).toEqual({ status: 202, text: "Queued" });
    expect(await deliver("issue_comment", comment(9903, "someone", "secret comment"))).toEqual({ status: 202, text: "Ignored" });
    // a pull request merged from the director's account: the author's merge, then Polaris's, both from one delivery
    const merged = {
      action: "closed",
      repository: { name: "setkernel-live", private: false },
      pull_request: { id: 9002, number: 78, title: "secret title", body: "secret body", user: { login: "orion-setkernel" }, head: { ref: "agent/secret" }, merged: true, merged_by: { login: "realRaghavGupta" }, merged_at: now },
      sender: { login: "realRaghavGupta" },
    };
    expect(await deliver("pull_request", merged, { delivery: "m-1" })).toEqual({ status: 202, text: "Queued" });
    expect(await deliver("pull_request", merged, { delivery: "m-1" })).toEqual({ status: 200, text: "Duplicate" });
    const { body } = await pull();
    const q = JSON.parse(body);
    expect(q.events.map(({ kind, action, actor }) => [kind, action, actor])).toEqual([
      ["request", "opened_issue", "Polaris"], ["request", "commented", "Kochab"], ["request", "commented", "Lyra"], ["pr", "merged", "Orion"], ["pr", "merged_by", "Polaris"],
    ]);
    expect(q.events[0]).toEqual({ cursor: 1, kind: "request", repo: "hq", private: true, action: "opened_issue", actor: "Polaris", ts: expect.any(Number) });
    expect(body).not.toMatch(/secret|someone|raghav|lyra-setkernel|vega-setkernel|orion-setkernel|label|Claude|—/i);
    expect(q.events.flatMap(Object.values).filter((v) => [8801, 9901, 9902, 9002, 4243, 78, "8801", "4243", "78"].includes(v))).toEqual([]);
  });

  it("pushes a delivery's events on a route an older Hub doesn't know, and still takes one from an older Worker", async () => {
    // what the Worker sends now: a list, on push-all, which a Hub on older code answers 404 to (so
    // fetchHub waits for the new one) instead of queueing an empty item
    const calls = [];
    const fakeHub = { idFromName: () => "id", get: () => ({ fetch: async (url, init) => { calls.push([new URL(url).pathname, JSON.parse(init.body)]); return new Response("Queued", { status: 202 }); } }) };
    expect(await deliver("workflow_run", run(51), { delivery: "new-1", envOverride: { ...withSecret, HUB: fakeHub } })).toEqual({ status: 202, text: "Queued" });
    expect(calls).toEqual([["/github/push-all", { delivery: "new-1", events: [{ key: "run:51", event: expect.objectContaining({ kind: "run", workflow: "deploy" }) }] }]]);
    // a Worker still on older code sends one event on push: the new Hub queues it
    const res = await hub().fetch("https://hub/github/push", { method: "POST", body: JSON.stringify({ delivery: "old-1", cleaned: { key: "run:52", event: { kind: "run", repo: "setkernel-live", private: false, workflow: "CI", conclusion: "success", ts: 1 } } }) });
    expect([res.status, await res.text()]).toEqual([202, "Queued"]);
    const q = JSON.parse((await pull()).body);
    expect(q.events.map((e) => [e.cursor, e.kind, e.workflow])).toEqual([[1, "run", "CI"]]);
  });

  it("guards the queue: 503 while QUEUE_AUD is empty, 405, 403 and a bad cursor", async () => {
    expect((await pull("", { envOverride: { ...env, QUEUE_AUD: "" } })).status).toBe(503);
    const post = await worker.fetch(new Request(`${BASE}/github/queue`, { method: "POST" }), env);
    await post.text();
    expect(post.status).toBe(405);
    expect((await pull("", { token: null })).status).toBe(403);
    // an ingest token must not open the queue: each Access app has its own audience
    expect((await pull("", { token: await sign(claims()) })).status).toBe(403);
    expect((await pull("?since=-1")).status).toBe(400);
  });
});

describe("updates-stopped alert (cron)", () => {
  // the Worker hands the Hub's promise to waitUntil; await it here
  const runCron = async () => {
    let pending;
    await worker.scheduled({}, env, { waitUntil: (p) => (pending = p) });
    await pending;
  };
  // Calling the Hub directly: an RPC stub kept from the Worker's cron keeps its request open, and an
  // eviction then hangs, so tests that evict dispose the stub themselves.
  const tickHub = async () => {
    const stub = hub();
    await stub.watch();
    stub[Symbol.dispose]?.();
  };
  // pushes a batch, then makes it look `ms` old, in memory and in storage
  async function ingestAged(ms) {
    expect(await ingest(batch([claude()]))).toBe(200);
    await runInDurableObject(hub(), async (instance, ctx) => {
      instance.state.lastIngest = Date.now() - ms;
      await ctx.storage.put("state", instance.state);
    });
  }

  it("posts one signed alert, survives an eviction without repeating, then one recovery", async () => {
    await ingestAged(6 * 60_000);
    await tickHub();
    expect(buzzPosts).toHaveLength(1);
    const alert = buzzPosts[0];
    expect(alert.kind).toBe(9);
    expect(alert.tags).toEqual([["h", env.BUZZ_CHANNEL]]);
    expect(alert.sig).toMatch(/^[0-9a-f]{128}$/);

    await tickHub(); // already told
    expect(buzzPosts).toHaveLength(1);

    await evictDurableObject(hub()); // a restarted Hub neither repeats nor forgets
    await tickHub();
    expect(buzzPosts).toHaveLength(1);

    expect(await ingest(batch([claude()]))).toBe(200); // updates are back
    await tickHub();
    expect(buzzPosts).toHaveLength(2);
    expect(buzzPosts[1].content).not.toBe(alert.content);
    await tickHub();
    expect(buzzPosts).toHaveLength(2);
  });

  it("is started by the Worker's cron trigger", async () => {
    await ingestAged(6 * 60_000);
    await runCron();
    expect(buzzPosts).toHaveLength(1);
  });

  it("says nothing while updates are fresh, or before any has arrived", async () => {
    await runCron();
    expect(await ingest(batch([claude()]))).toBe(200);
    await runCron();
    expect(buzzPosts).toHaveLength(0);
  });

  it("retries a failed post on the next tick", async () => {
    await ingestAged(6 * 60_000);
    const spy = globalThis.fetch;
    const impl = spy.getMockImplementation();
    spy.mockImplementationOnce(() => Promise.resolve(new Response("nope", { status: 500 })));
    await runCron();
    expect(buzzPosts).toHaveLength(0);
    spy.mockImplementation(impl);
    await runCron();
    expect(buzzPosts).toHaveLength(1);
  });
});
