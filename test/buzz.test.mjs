// Posting to Buzz: Nostr signing (NIP-01), the NIP-98 header, and how relay answers are read.
// Uses throwaway keys and a fake fetch; nothing is sent. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/secp256k1";
import { nip98, postMessage, signEvent } from "../src/buzz.js";

const KEY = "0000000000000000000000000000000000000000000000000000000000000003"; // BIP-340 test vector 0
const PUB = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
const CHANNEL = "fc80475f-c5f0-42b7-870f-44785c189566";
const RELAY = "https://buzz.example.test";
const hexBytes = (h) => Uint8Array.from(Buffer.from(h, "hex"));

async function valid(e) {
  const id = createHash("sha256").update(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])).digest("hex");
  return e.id === id && (await schnorr.verifyAsync(hexBytes(e.sig), hexBytes(e.id), hexBytes(e.pubkey)));
}

test("events carry the right public key, id and a valid signature", async () => {
  const e = await signEvent(KEY, { kind: 9, content: "🔴 hi\n\"there\"", tags: [["h", CHANNEL]], created_at: 1_760_000_000 });
  assert.equal(e.pubkey, PUB);
  assert.equal(await valid(e), true);
  assert.equal(await valid({ ...e, content: "changed" }), false);
});

test("a bad key is refused without echoing it", async () => {
  const secret = "ab".repeat(32);
  for (const bad of ["", "nsec1xyz", secret.toUpperCase(), secret.slice(1), `${secret}\n`, undefined]) {
    await assert.rejects(signEvent(bad, { kind: 9, content: "", tags: [], created_at: 1 }), (err) => {
      assert.match(err.message, /64 lowercase hex/);
      assert.ok(!bad || !err.message.includes(bad.slice(0, 16)));
      return true;
    });
  }
});

test("NIP-98 header names the URL, method and body hash", async () => {
  const h = await nip98(KEY, `${RELAY}/events`, "POST", "{}", 1_760_000_000_000);
  assert.match(h, /^Nostr /);
  const e = JSON.parse(atob(h.slice(6)));
  assert.equal(e.kind, 27235);
  assert.equal(e.created_at, 1_760_000_000);
  const tag = (n) => e.tags.find((t) => t[0] === n)?.[1];
  assert.equal(tag("u"), `${RELAY}/events`);
  assert.equal(tag("method"), "POST");
  assert.equal(tag("payload"), createHash("sha256").update("{}").digest("hex"));
  assert.ok(tag("nonce"));
  assert.equal(await valid(e), true);
});

function fakeFetch(status, reply) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return new Response(reply, { status });
  };
  return { fn, calls };
}

test("a message goes to /events as a kind-9 event in the channel", async () => {
  const f = fakeFetch(200, JSON.stringify({ event_id: "x", accepted: true }));
  const id = await postMessage({ relay: `${RELAY}/`, channel: CHANNEL, key: KEY, text: "hello", fetchFn: f.fn });
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, `${RELAY}/events`);
  assert.equal(init.method, "POST");
  const e = JSON.parse(init.body);
  assert.equal(e.id, id);
  assert.equal(e.kind, 9);
  assert.equal(e.content, "hello");
  assert.deepEqual(e.tags, [["h", CHANNEL]]);
  assert.equal(await valid(e), true);
  const auth = JSON.parse(atob(init.headers.Authorization.slice(6)));
  assert.equal(auth.tags.find((t) => t[0] === "payload")[1], createHash("sha256").update(init.body).digest("hex"));
  assert.ok(!init.body.includes(KEY) && !init.headers.Authorization.includes(KEY));
});

test("refusals and errors throw, so the alert is retried", async () => {
  const post = (status, reply) => postMessage({ relay: RELAY, channel: CHANNEL, key: KEY, text: "x", fetchFn: fakeFetch(status, reply).fn });
  await assert.rejects(post(403, '{"error":"not a member"}'), /HTTP 403/);
  await assert.rejects(post(502, "bad gateway"), /HTTP 502/);
  await assert.rejects(post(200, '{"accepted":false,"message":"blocked"}'), /refused the message: blocked/);
  await assert.rejects(postMessage({ relay: RELAY, channel: CHANNEL, key: KEY, text: "x", fetchFn: async () => { throw new TypeError("fetch failed"); } }), /fetch failed/);
  await post(200, "ok");
});

test("only an https relay and a channel UUID are accepted", async () => {
  const f = fakeFetch(200, "{}");
  await assert.rejects(postMessage({ relay: "http://buzz.example.test", channel: CHANNEL, key: KEY, text: "x", fetchFn: f.fn }), /https/);
  await assert.rejects(postMessage({ relay: RELAY, channel: "#infra", key: KEY, text: "x", fetchFn: f.fn }), /UUID/);
  assert.equal(f.calls.length, 0);
});
