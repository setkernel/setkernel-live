// The Access token check on /ingest, against tokens signed with a throwaway key. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { ISSUER, jwksFetcher, verifyAccessJwt } from "../src/access.js";

const AUD = "a".repeat(64);
const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const getKeys = async () => [jwk];
const b64url = (b) => Buffer.from(b).toString("base64url");
async function sign(claims, header = { alg: "RS256", kid: "k1", typ: "JWT" }) {
  const head = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(head));
  return `${head}.${b64url(new Uint8Array(sig))}`;
}
const now = Date.now();
const good = { iss: ISSUER, aud: [AUD], exp: Math.floor(now / 1000) + 600, iat: Math.floor(now / 1000), common_name: "x.access" };

test("a valid token for this app passes", async () => {
  assert.equal(await verifyAccessJwt(await sign(good), { aud: AUD, getKeys }), true);
});

test("wrong audience, issuer, expiry, algorithm, key or signature fail", async () => {
  const v = async (token, aud = AUD) => verifyAccessJwt(token, { aud, getKeys });
  assert.equal(await v(await sign({ ...good, aud: ["b".repeat(64)] })), false);
  assert.equal(await v(await sign({ ...good, iss: "https://evil.cloudflareaccess.com" })), false);
  assert.equal(await v(await sign({ ...good, exp: Math.floor(now / 1000) - 5 })), false);
  assert.equal(await v(await sign(good, { alg: "none", kid: "k1" })), false);
  assert.equal(await v(await sign(good, { alg: "RS256", kid: "other" })), false);
  const t = await sign(good);
  assert.equal(await v(t.slice(0, -4) + "AAAA"), false);
  assert.equal(await v(t, ""), false); // ingest not configured
  for (const junk of ["", "a.b", "a.b.c", null, undefined]) assert.equal(await v(junk), false);
});

test("keys are cached and refetched for an unknown kid", async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; return { ok: true, json: async () => ({ keys: [jwk] }) }; };
  const keys = jwksFetcher("https://example.test/certs", 3600_000, fetchFn);
  await keys("k1"); await keys("k1");
  assert.equal(calls, 1);
  await keys("rotated");
  assert.equal(calls, 2);
});
