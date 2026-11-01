// The Usage Durable Object and its two routes in workerd (setkernel-live#66): /ingest/usage on the
// ingest's Access app, /usage/data on its own (503 while USAGE_AUD is empty), sums per Halifax
// day, and nothing of it on the public routes.
// Run: npm run test:worker
import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker.js";
import { CERTS, ISSUER } from "../../src/access.js";
import { COUNTS, hourOf as hour } from "../../src/usage.js";

const BASE = "https://live.setkernel.com";
const USAGE_AUD = "c".repeat(64); // stands in for the /usage Access app's tag; wrangler.jsonc ships ""
const store = () => env.USAGE.get(env.USAGE.idFromName("usage"));
const hub = () => env.HUB.get(env.HUB.idFromName("live"));

// Access tokens signed with a throwaway key; the Worker's fetch of Access's certs gets its public half.
let privateKey;
const b64url = (s) => btoa(typeof s === "string" ? s : String.fromCharCode(...s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sign(aud, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: ISSUER, aud: [aud], exp: now + 600, iat: now, ...extra }))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(head));
  return `${head}.${b64url(new Uint8Array(sig))}`;
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  privateKey = pair.privateKey;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => ((input instanceof Request ? input.url : String(input)) === CERTS ? Promise.resolve(Response.json({ keys: [jwk] })) : realFetch(input, init)));
});

afterEach(async () => {
  await runInDurableObject(store(), (_, ctx) => ctx.storage.deleteAll());
  await evictDurableObject(store());
});

// Every body is read: an unread one keeps the request open and evictDurableObject waits on it.
async function answer(res) {
  const text = await res.text();
  const json = res.headers.get("Content-Type")?.startsWith("application/json") ? JSON.parse(text) : undefined;
  return { status: res.status, json, text, cache: res.headers.get("Cache-Control") };
}
async function push(body, { token } = {}) {
  const headers = {};
  if (token !== null) headers["Cf-Access-Jwt-Assertion"] = token ?? (await sign(env.INGEST_AUD));
  return answer(await exports.default.fetch(`${BASE}/ingest/usage`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));
}
// GET /usage/data as if the /usage Access app existed (USAGE_AUD set), unless `aud` says otherwise.
async function read(month, { token, aud = USAGE_AUD } = {}) {
  const headers = {};
  if (token !== null) headers["Cf-Access-Jwt-Assertion"] = token ?? (await sign(USAGE_AUD));
  return answer(await worker.fetch(new Request(`${BASE}/usage/data?month=${month}`, { headers }), { ...env, USAGE_AUD: aud }));
}

const bucket = (hour, seat, n, extra = {}) => ({ hour, seat, model: "claude-opus-5-5", surface: "vm", ...Object.fromEntries(COUNTS.map((k, i) => [k, n * (i + 1)])), ...extra });
const counts = (n) => Object.fromEntries(COUNTS.map((k, i) => [k, n * (i + 1)]));

describe("usage", () => {
  it("sums 48 hourly buckets into their two Halifax days, on the push and on the read", async () => {
    const start = Date.UTC(2026, 9, 14, 3); // midnight ADT on 14 October
    const buckets = [];
    for (let i = 0; i < 48; i++) {
      buckets.push(bucket(hour(start + i * 3_600_000), "vega", i + 1));
      if (i % 2) buckets.push(bucket(hour(start + i * 3_600_000), "rigel", 1, { surface: "desktop" }));
    }
    const pushed = await push({ buckets });
    expect(pushed.status).toBe(200);
    expect(pushed.cache).toBe("no-store");
    const day1 = { vega: counts((24 * 25) / 2), rigel: counts(12) }; // vega 1..24, rigel 12 hours
    const day2 = { vega: counts((48 * 49) / 2 - (24 * 25) / 2), rigel: counts(12) };
    expect(pushed.json).toEqual({ stored: 72, days: { "2026-10-14": day1, "2026-10-15": day2 } });

    const got = await read("2026-10");
    expect(got.status).toBe(200);
    expect(got.cache).toBe("no-store");
    expect(got.json).toEqual({ month: "2026-10", days: { "2026-10-14": day1, "2026-10-15": day2 }, totals: { vega: counts((48 * 49) / 2), rigel: counts(24) } });
    expect((await read("2026-11")).json).toEqual({ month: "2026-11", days: {}, totals: {} });
  });

  it("replaces a bucket pushed again, adds another model's, and echoes only the hours pushed", async () => {
    await push({ buckets: [bucket("2026-10-14T15", "orion", 5), bucket("2026-10-14T16", "orion", 7)] });
    const again = await push({ buckets: [bucket("2026-10-14T15", "orion", 3), bucket("2026-10-14T15", "orion", 2, { model: "claude-sonnet-5-5" })] });
    expect(again.json).toEqual({ stored: 2, days: { "2026-10-14": { orion: counts(5) } } });
    expect((await read("2026-10")).json.totals).toEqual({ orion: counts(12) });
  });

  it("puts 03:00 UTC on the day the clocks go forward on the previous Halifax day", async () => {
    const pushed = await push({ buckets: [bucket("2026-03-08T03", "lyra", 1), bucket("2026-03-08T04", "lyra", 2), bucket("2026-03-01T03", "lyra", 4)] });
    expect(Object.keys(pushed.json.days)).toEqual(["2026-02-28", "2026-03-07", "2026-03-08"]);
    const march = await read("2026-03");
    expect(march.json.days).toEqual({ "2026-03-07": { lyra: counts(1) }, "2026-03-08": { lyra: counts(2) } });
    expect((await read("2026-02")).json.days).toEqual({ "2026-02-28": { lyra: counts(4) } });
  });

  it("deletes hours older than 400 days", async () => {
    const old = hour(Date.now() - 401 * 86_400_000);
    await push({ buckets: [bucket(old, "polaris", 1), bucket(hour(Date.now()), "polaris", 1)] });
    const rows = await runInDurableObject(store(), (_, ctx) => ctx.storage.sql.exec("SELECT hour FROM buckets").toArray());
    expect(rows.map((r) => r.hour)).toEqual([hour(Date.now())]);
  });

  it("refuses a bad push with 400 and stores none of it", async () => {
    const good = bucket("2026-10-14T15", "vega", 1);
    for (const body of ["{", { buckets: [good, { ...good, seat: "raghav" }] }, { buckets: [{ ...good, surface: "phone" }] }, { buckets: [{ ...good, input: -1 }] }, { buckets: [{ ...good, hour: "2026-10-14 15" }] }, { rows: [good] }]) {
      expect((await push(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await push("x".repeat(256 * 1024 + 1))).status).toBe(413);
    expect((await read("2026-10")).json.days).toEqual({});
  });

  it("checks the token on both routes: 403 for none, a forged one or the other app's, and stores nothing", async () => {
    const body = { buckets: [bucket("2026-10-14T15", "vega", 1)] };
    for (const token of [null, "", "not.a.jwt", await sign(USAGE_AUD), await sign(env.INGEST_AUD, { iss: "https://evil.cloudflareaccess.com" }), await sign(env.INGEST_AUD, { exp: 1 })]) {
      expect((await push(body, { token })).status).toBe(403);
    }
    for (const token of [null, "", "not.a.jwt", await sign(env.INGEST_AUD), await sign(USAGE_AUD, { exp: 1 })]) {
      expect((await read("2026-10", { token })).status).toBe(403);
    }
    expect((await read("2026-10")).json.days).toEqual({});
  });

  it("fails closed: /usage/data answers 503 while USAGE_AUD is empty, as wrangler.jsonc ships it", async () => {
    expect(env.USAGE_AUD).toBe("");
    const res = await answer(await exports.default.fetch(`${BASE}/usage/data?month=2026-10`, { headers: { "Cf-Access-Jwt-Assertion": await sign(USAGE_AUD) } }));
    expect(res.status).toBe(503);
    expect((await read("2026-10", { aud: "" })).status).toBe(503);
    const req = new Request(`${BASE}/ingest/usage`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": await sign(env.INGEST_AUD) }, body: "{}" });
    expect((await answer(await worker.fetch(req, { ...env, INGEST_AUD: "" }))).status).toBe(503);
    expect((await answer(await exports.default.fetch(`${BASE}/ingest/usage`))).status).toBe(405);
    expect((await answer(await exports.default.fetch(`${BASE}/usage/data`, { method: "POST" }))).status).toBe(405);
    for (const month of ["", "2026-13", "2026-10-01", "x"]) expect((await read(month)).status, month).toBe(400);
  });

  it("shows none of it on /api/state, /api/replay or the /ws first frame", async () => {
    await push({ buckets: [bucket("2026-10-14T15", "rigel", 7_654_321, { model: "claude-haiku-5-5", surface: "codex" })] });
    const ws = (await exports.default.fetch(`${BASE}/ws`, { headers: { Upgrade: "websocket" } })).webSocket;
    const first = new Promise((resolve) => ws.addEventListener("message", (m) => resolve(m.data)));
    ws.accept();
    const seen = [(await answer(await exports.default.fetch(`${BASE}/api/state`))).text, (await answer(await exports.default.fetch(`${BASE}/api/replay?h=24`))).text, await first];
    ws.close(1000, "done");
    await evictDurableObject(hub(), { webSockets: "close" });
    // "requests" is left out: the page's own counts have one (issues opened and comments)
    const words = ["input", "output", "cache_read", "cache_write", "usd_micros", "rigel", "claude-haiku-5-5", "codex", "surface", "usage"];
    for (const text of seen) {
      for (const n of Object.values(counts(7_654_321))) expect(text).not.toContain(String(n));
      for (const word of words) expect(text).not.toContain(word);
    }
  });
});
