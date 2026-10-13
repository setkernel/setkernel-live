// The real Worker and Hub Durable Object in workerd (setkernel-live#10): ingest auth, fan-out to
// sockets, state after eviction, the size cap, and what the page needs to spot a quiet office.
// Run: npm run test:worker
import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker.js";
import { CERTS, ISSUER } from "../../src/access.js";

const BASE = "https://live.setkernel.com";
const OFFLINE_AFTER_MS = 120_000; // public/app.js: the page says "Office offline" after this
const hub = () => env.HUB.get(env.HUB.idFromName("live"));

// Access tokens signed with a throwaway key; the Worker's fetch of Access's certs gets its public half.
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
    return url === CERTS ? Promise.resolve(Response.json({ keys: [jwk] })) : realFetch(input, init);
  });
});

const sockets = [];
afterEach(async () => {
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
});

describe("size cap", () => {
  it("answers 413 above 256 KiB and leaves the state alone", async () => {
    const big = JSON.stringify({ ...batch([claude()]), pad: "x".repeat(256 * 1024) });
    expect(await ingest(big)).toBe(413);
    const s = await state();
    expect(s.counts.claude).toBe(0);
    expect(s.lastIngest).toBe(0);
  });

  it("accepts a body just under the cap", async () => {
    const body = JSON.stringify(batch([claude()]));
    const padded = body.slice(0, -1) + `,"pad":"${"x".repeat(256 * 1024 - body.length - 9)}"}`;
    expect(padded.length).toBe(256 * 1024);
    expect(await ingest(padded)).toBe(200);
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
