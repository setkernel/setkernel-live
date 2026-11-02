// /usage in workerd (setkernel-live#71): the Worker serves the files under it only with a token for
// the "live usage" Access app (that it runs before the assets is wrangler.jsonc's run_worker_first,
// pinned in test/usage-page.test.mjs); /usage/data names its newest hour; the
// live page still says nothing of usage. Run: npm run test:worker
import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker.js";
import { CERTS, ISSUER } from "../../src/access.js";

const BASE = "https://live.setkernel.com";
const store = () => env.USAGE.get(env.USAGE.idFromName("usage"));
let privateKey;
const b64url = (s) => btoa(typeof s === "string" ? s : String.fromCharCode(...s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sign(aud) {
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: ISSUER, aud: [aud], exp: now + 600, iat: now }))}`;
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
async function get(path, token, init = {}) {
  const headers = token ? { "Cf-Access-Jwt-Assertion": token } : {};
  const res = await exports.default.fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...init.headers } });
  return { status: res.status, text: await res.text(), newest: res.headers.get("Usage-Newest-Hour") };
}

describe("usage page", () => {
  it("serves /usage and its files only with a live usage token", async () => {
    for (const path of ["/usage/", "/usage", "/usage/index.html", "/usage/page.js", "/usage/usage.css", "/usage/table.js", "/usage/nothing-here"]) {
      for (const token of [undefined, "not.a.jwt", await sign(env.INGEST_AUD)]) expect((await get(path, token)).status, path).toBe(403);
    }
    const file = await get("/usage/table.js", await sign(env.USAGE_AUD));
    expect(file.status).toBe(200);
    expect(file.text).toContain("export function buildMonth");
  });

  it("serves the page at /usage/ and /usage, and its script and styles, to a valid token", async () => {
    const token = await sign(env.USAGE_AUD);
    for (const path of ["/usage/", "/usage", "/usage/index.html"]) {
      const res = await exports.default.fetch(`${BASE}${path}`, { headers: { "Cf-Access-Jwt-Assertion": token } });
      const text = await res.text();
      expect(res.status, path).toBe(200);
      expect(text, path).toContain('<script type="module" src="/usage/page.js"></script>');
      expect(res.headers.get("Content-Security-Policy"), path).toContain("script-src 'self'; style-src 'self'");
    }
    expect((await get("/usage/page.js", token)).text).toContain('from "./table.js"');
    expect((await get("/usage/usage.css", token)).text).toContain("td.t8");
  });

  it("answers /usage/ files 503 if USAGE_AUD is ever empty", async () => {
    const res = await worker.fetch(new Request(`${BASE}/usage/table.js`, { headers: { "Cf-Access-Jwt-Assertion": await sign(env.USAGE_AUD) } }), { ...env, USAGE_AUD: "" });
    await res.text();
    expect(res.status).toBe(503);
  });

  it("names the newest hour stored, of any month, in Usage-Newest-Hour", async () => {
    const token = await sign(env.USAGE_AUD);
    expect((await get("/usage/data?month=2026-10", token)).newest).toBeNull();
    const bucket = (hour) => ({ hour, seat: "vega", model: "claude-opus-5-5", surface: "vm", input: 1, output: 1, cache_read: 1, cache_write: 1, usd_micros: 1, requests: 1 });
    const pushed = await get("/ingest/usage", await sign(env.INGEST_AUD), { method: "POST", body: JSON.stringify({ buckets: [bucket("2026-10-14T15"), bucket("2026-11-01T04")] }) });
    expect(pushed.status).toBe(200);
    const oct = await get("/usage/data?month=2026-10", token);
    expect(oct.newest).toBe("2026-11-01T04");
    expect(Object.keys(JSON.parse(oct.text))).toEqual(["month", "days", "totals"]);
  });

  it("leaves the live page and its script without a word of /usage", async () => {
    for (const path of ["/", "/app.js"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(/\/usage|Usage-Newest|tokens per seat/i);
    }
  });
});
