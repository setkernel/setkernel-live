// The Usage Durable Object and its two routes in workerd (setkernel-live#66): /ingest/usage on the
// ingest's Access app, /usage/data on its own (503 if USAGE_AUD is empty), sums per Halifax
// day, and nothing of it on the public routes.
// /ingest/limits (#88) on the ingest's app too, its readings as /usage/data's limits on the current month only.
// Run: npm run test:worker
import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker.js";
import { CERTS, ISSUER } from "../../src/access.js";
import { COUNTS, hourOf as hour } from "../../src/usage.js";
import { homeDay } from "../../public/lib/state.js";

const BASE = "https://live.setkernel.com";
const OTHER_AUD = "c".repeat(64); // another Access app's tag
const USAGE_AUD = "5fb92f4788226bc0b1bc4d1e71e171d68e15528c876740365cb79effc8462cb7"; // the "live usage" Access app's tag, as wrangler.jsonc ships it
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
async function pushLimits(body, { token } = {}) {
  const headers = {};
  if (token !== null) headers["Cf-Access-Jwt-Assertion"] = token ?? (await sign(env.INGEST_AUD));
  return answer(await exports.default.fetch(`${BASE}/ingest/limits`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));
}
// GET /usage/data with the shipped USAGE_AUD, unless `aud` says otherwise.
async function read(month, { token, aud = USAGE_AUD } = {}) {
  const headers = {};
  if (token !== null) headers["Cf-Access-Jwt-Assertion"] = token ?? (await sign(USAGE_AUD));
  return answer(await worker.fetch(new Request(`${BASE}/usage/data?month=${month}`, { headers }), { ...env, USAGE_AUD: aud }));
}
// What the store holds, per hour, seat and model.
const stored = () => runInDurableObject(store(), (_, ctx) => ctx.storage.sql.exec("SELECT hour, seat, model, input, requests FROM buckets ORDER BY hour, seat, model").toArray());

const storedLimits = () => runInDurableObject(store(), (_, ctx) => ctx.storage.sql.exec("SELECT seat, part, at FROM seat_limits ORDER BY seat, part").toArray());

const bucket = (hour, seat, n, extra = {}) => ({ hour, seat, model: "claude-opus-5-5", surface: "vm", ...Object.fromEntries(COUNTS.map((k, i) => [k, n * (i + 1)])), ...extra });
const counts = (n) => Object.fromEntries(COUNTS.map((k, i) => [k, n * (i + 1)]));

describe("usage", () => {
  it("echoes 48 hourly buckets summed into their two Halifax days", async () => {
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
    expect(await stored()).toHaveLength(72);

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
    expect(await stored()).toEqual([
      { hour: "2026-10-14T15", seat: "orion", model: "claude-opus-5-5", input: 3, requests: 18 },
      { hour: "2026-10-14T15", seat: "orion", model: "claude-sonnet-5-5", input: 2, requests: 12 },
      { hour: "2026-10-14T16", seat: "orion", model: "claude-opus-5-5", input: 7, requests: 42 },
    ]);
  });

  it("puts 03:00 UTC on the day the clocks go forward on the previous Halifax day", async () => {
    const pushed = await push({ buckets: [bucket("2026-03-08T03", "lyra", 1), bucket("2026-03-08T04", "lyra", 2), bucket("2026-03-01T03", "lyra", 4)] });
    expect(pushed.json.days).toEqual({ "2026-02-28": { lyra: counts(4) }, "2026-03-07": { lyra: counts(1) }, "2026-03-08": { lyra: counts(2) } });
    // the read keeps each Halifax day in its own month, though 2026-03-01T03 is already March in UTC
    expect((await read("2026-03")).json.days).toEqual({ "2026-03-07": { lyra: counts(1) }, "2026-03-08": { lyra: counts(2) } });
    expect((await read("2026-02")).json.days).toEqual({ "2026-02-28": { lyra: counts(4) } });
  });

  it("deletes hours older than 400 days", async () => {
    const old = hour(Date.now() - 401 * 86_400_000);
    await push({ buckets: [bucket(old, "polaris", 1), bucket(hour(Date.now()), "polaris", 1)] });
    expect((await stored()).map((r) => r.hour)).toEqual([hour(Date.now())]);
    await push({ buckets: [bucket(hour(Date.now() - 399 * 86_400_000), "polaris", 1)] });
    expect(await stored()).toHaveLength(2);
  });

  it("refuses a bad push with 400 and stores none of it", async () => {
    const good = bucket("2026-10-14T15", "vega", 1);
    for (const body of ["{", { buckets: [good, { ...good, seat: "raghav" }] }, { buckets: [{ ...good, surface: "phone" }] }, { buckets: [{ ...good, input: -1 }] }, { buckets: [{ ...good, hour: "2026-10-14 15" }] }, { rows: [good] }]) {
      expect((await push(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await push("x".repeat(256 * 1024 + 1))).status).toBe(413);
    expect(await stored()).toEqual([]);
  });

  it("answers 403 for no token, a forged one or another app's, and stores nothing", async () => {
    const body = { buckets: [bucket("2026-10-14T15", "vega", 1)] };
    for (const token of [null, "", "not.a.jwt", await sign(OTHER_AUD), await sign(env.INGEST_AUD, { iss: "https://evil.cloudflareaccess.com" }), await sign(env.INGEST_AUD, { exp: 1 })]) {
      expect((await push(body, { token })).status).toBe(403);
    }
    expect(await stored()).toEqual([]);
  });

  it("answers /usage/data 403 for no token, a forged one, the ingest app's or an expired one", async () => {
    await push({ buckets: [bucket("2026-10-14T15", "vega", 1)] });
    for (const token of [null, "", "not.a.jwt", await sign(env.INGEST_AUD), await sign(OTHER_AUD), await sign(USAGE_AUD, { iss: "https://evil.cloudflareaccess.com" }), await sign(USAGE_AUD, { exp: 1 })]) {
      const res = await read("2026-10", { token });
      expect(res.status).toBe(403);
      expect(res.text).not.toContain("vega");
    }
  });

  it("ships USAGE_AUD as the live usage Access app's tag, and fails closed with 503 if it is ever empty", async () => {
    expect(env.USAGE_AUD).toBe(USAGE_AUD);
    const token = await sign(USAGE_AUD);
    expect((await answer(await exports.default.fetch(`${BASE}/usage/data?month=2026-10`, { headers: { "Cf-Access-Jwt-Assertion": token } }))).status).toBe(200);
    expect((await answer(await exports.default.fetch(`${BASE}/usage/data?month=2026-10`))).status).toBe(403);
    expect((await read("2026-10", { aud: "" })).status).toBe(503);
    expect((await read("2026-10", { aud: "", token: null })).status).toBe(503);
  });

  it("answers /usage/data 405 for anything but GET and 400 for a bad month, after the token check", async () => {
    const headers = { "Cf-Access-Jwt-Assertion": await sign(USAGE_AUD) };
    for (const method of ["POST", "PUT", "DELETE"]) expect((await answer(await worker.fetch(new Request(`${BASE}/usage/data?month=2026-10`, { method, headers }), { ...env, USAGE_AUD }))).status, method).toBe(405);
    for (const month of ["", "2026-13", "2026-00", "2026-10-01", "x"]) expect((await read(month)).status, month).toBe(400);
    expect((await read("2026-13", { token: null })).status).toBe(403);
    expect((await answer(await worker.fetch(new Request(`${BASE}/usage/data`, { headers }), { ...env, USAGE_AUD }))).status).toBe(400);
  });

  it("answers 405 for anything but POST and 503 while INGEST_AUD is empty", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) expect((await answer(await exports.default.fetch(`${BASE}/ingest/usage`, { method }))).status, method).toBe(405);
    const req = new Request(`${BASE}/ingest/usage`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": await sign(env.INGEST_AUD) }, body: "{}" });
    expect((await answer(await worker.fetch(req, { ...env, INGEST_AUD: "" }))).status).toBe(503);
  });

  // limits: each seat's newest reading, as public/usage/limits.js reads them (setkernel-live#88)
  const T0 = Date.now();
  const iso = (ago) => new Date(T0 - ago).toISOString();
  const win = (utilization, ago, extra = {}) => ({ utilization, resets_at: iso(ago - 3 * 3_600_000), observed_at: iso(ago), ...extra });
  const rejected = (ago) => ({ status: "rejected", rate_limit_type: "five_hour", resets_at: iso(ago - 3_600_000), received_at: iso(ago) });
  const thisMonth = () => homeDay(Date.now()).slice(0, 7);
  const lastMonth = () => new Date(Date.parse(`${thisMonth()}-01T12:00:00Z`) - 5 * 86_400_000).toISOString().slice(0, 7);

  it("stores each seat's newest limit readings and serves them as limits on the current Halifax month only", async () => {
    expect((await read(thisMonth())).json).not.toHaveProperty("limits"); // none yet: the page says it can't check them
    const first = { rigel: { five_hour: win(0.84, 60_000), seven_day: win(0.52, 60_000, { resets_at: null }), event: null }, lyra: { five_hour: win(0.31, 120_000), note: "dropped" } };
    const pushed = await pushLimits(first);
    expect(pushed.status).toBe(200);
    expect(pushed.cache).toBe("no-store");
    const want = { rigel: { five_hour: win(0.84, 60_000), seven_day: win(0.52, 60_000, { resets_at: null }), event: null }, lyra: { five_hour: win(0.31, 120_000), seven_day: null, event: null } };
    expect(pushed.json).toEqual({ limits: want });

    // an older reading changes nothing, a newer one replaces only its own part, and null erases nothing
    await pushLimits({ rigel: { five_hour: win(0.10, 3_600_000), seven_day: null, event: rejected(30_000) }, lyra: { seven_day: win(0.73, 90_000) } });
    const got = await read(thisMonth());
    expect(got.status).toBe(200);
    expect(got.json.limits).toEqual({ rigel: { ...want.rigel, event: rejected(30_000) }, lyra: { ...want.lyra, seven_day: win(0.73, 90_000) } });
    await pushLimits({ rigel: { five_hour: win(1, 10_000) } });
    expect((await read(thisMonth())).json.limits.rigel.five_hour).toEqual(win(1, 10_000));
    expect(await storedLimits()).toHaveLength(5);

    // read live, so a past month carries none
    const past = await read(lastMonth());
    expect(past.status).toBe(200);
    expect(past.json).toEqual({ month: lastMonth(), days: {}, totals: {} });
  });

  it("refuses a bad limits push with 400 and stores none of it", async () => {
    const good = { five_hour: win(0.5, 60_000) };
    for (const body of ["{", "[]", "null", { codex: good }, { vega: good, raghav: good }, { vega: { five_hour: win(-1, 60_000) } }, { vega: { five_hour: win(0.5, 60_000, { observed_at: "yesterday" }) } }, { vega: { event: { ...rejected(1000), rate_limit_type: "overage" } } }]) {
      expect((await pushLimits(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await pushLimits("x".repeat(256 * 1024 + 1))).status).toBe(413);
    expect(await storedLimits()).toEqual([]);
  });

  it("answers /ingest/limits 403 for no token, a forged one or another app's, 405 for anything but POST, 503 while INGEST_AUD is empty", async () => {
    const body = { vega: { five_hour: win(0.5, 60_000) } };
    for (const token of [null, "", "not.a.jwt", await sign(OTHER_AUD), await sign(USAGE_AUD), await sign(env.INGEST_AUD, { iss: "https://evil.cloudflareaccess.com" }), await sign(env.INGEST_AUD, { exp: 1 })]) {
      expect((await pushLimits(body, { token })).status).toBe(403);
    }
    for (const method of ["GET", "PUT", "DELETE"]) expect((await answer(await exports.default.fetch(`${BASE}/ingest/limits`, { method }))).status, method).toBe(405);
    const req = new Request(`${BASE}/ingest/limits`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": await sign(env.INGEST_AUD) }, body: JSON.stringify(body) });
    expect((await answer(await worker.fetch(req, { ...env, INGEST_AUD: "" }))).status).toBe(503);
    expect(await storedLimits()).toEqual([]);
  });

  it("shows no limits on /api/state, /api/replay or the /ws first frame", async () => {
    await pushLimits({ rigel: { five_hour: win(0.8765, 60_000), seven_day: win(0.4321, 60_000), event: rejected(30_000) } });
    const ws = (await exports.default.fetch(`${BASE}/ws`, { headers: { Upgrade: "websocket" } })).webSocket;
    const first = new Promise((resolve) => ws.addEventListener("message", (m) => resolve(m.data)));
    ws.accept();
    const seen = [(await answer(await exports.default.fetch(`${BASE}/api/state`))).text, (await answer(await exports.default.fetch(`${BASE}/api/replay?h=24`))).text, await first];
    ws.close(1000, "done");
    await evictDurableObject(hub(), { webSockets: "close" });
    for (const text of seen) {
      for (const word of ["limits", "five_hour", "seven_day", "utilization", "0.8765", "0.4321", "rejected", "rate_limit_type", "resets_at", "observed_at", "rigel"]) expect(text).not.toContain(word);
    }
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
    expect((await answer(await exports.default.fetch(`${BASE}/api/state?month=2026-10`))).text).not.toContain("days");
    const words = ["input", "output", "cache_read", "cache_write", "usd_micros", "rigel", "claude-haiku-5-5", "codex", "surface", "usage"];
    for (const text of seen) {
      for (const n of Object.values(counts(7_654_321))) expect(text).not.toContain(String(n));
      for (const word of words) expect(text).not.toContain(word);
    }
  });
});
