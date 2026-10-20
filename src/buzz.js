// Posts a message to a Buzz channel as the Worker's own Buzz identity (setkernel-live#9), the way
// the buzz CLI does (`buzz messages send`): a Nostr kind-9 event tagged with the channel, POSTed to
// the relay's /events with a NIP-98 Authorization header. Signing is BIP-340 Schnorr from
// @noble/secp256k1 (pinned); hashing is WebCrypto, so this runs in Workers and under `node --test`.
//
// The private key comes from the BUZZ_PRIVATE_KEY secret. It is never logged or returned, and no
// error message here contains it.
import { schnorr } from "@noble/secp256k1";

const enc = new TextEncoder();
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

export const KEY = /^[0-9a-f]{64}$/;
const CHANNEL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function keyBytes(hex) {
  if (typeof hex !== "string" || !KEY.test(hex)) throw new Error("BUZZ_PRIVATE_KEY must be 64 lowercase hex characters");
  return Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
}

// NIP-01: id = sha256 of [0, pubkey, created_at, kind, tags, content]; sig = Schnorr over the id.
export async function signEvent(keyHex, { kind, content, tags, created_at }) {
  const sk = keyBytes(keyHex);
  const pubkey = toHex(schnorr.getPublicKey(sk));
  const id = await sha256(enc.encode(JSON.stringify([0, pubkey, created_at, kind, tags, content])));
  const sig = await schnorr.signAsync(id, sk);
  return { id: toHex(id), pubkey, created_at, kind, tags, content, sig: toHex(sig) };
}

// NIP-98: a kind-27235 event naming the URL, method and body hash, base64 in the header.
export async function nip98(keyHex, url, method, body, now = Date.now()) {
  const tags = [["u", url], ["method", method], ["nonce", crypto.randomUUID()]];
  if (body !== undefined) tags.push(["payload", toHex(await sha256(enc.encode(body)))]);
  const event = await signEvent(keyHex, { kind: 27235, content: "", tags, created_at: Math.floor(now / 1000) });
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

// Resolves when the relay accepted the message; throws otherwise (the caller retries next tick).
export async function postMessage({ relay, channel, key, text, now = Date.now(), fetchFn = fetch, timeoutMs = 10_000 }) {
  if (!CHANNEL.test(channel || "")) throw new Error("BUZZ_CHANNEL must be a channel UUID");
  const url = `${String(relay || "").replace(/\/+$/, "")}/events`;
  if (!url.startsWith("https://")) throw new Error("BUZZ_RELAY_URL must be https");
  const event = await signEvent(key, { kind: 9, content: text, tags: [["h", channel]], created_at: Math.floor(now / 1000) });
  const body = JSON.stringify(event);
  // not AbortSignal.timeout: its timer can't be cleared and keeps the Durable Object busy after the post
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("timed out")), timeoutMs);
  let r;
  let reply;
  try {
    r = await fetchFn(url, {
      method: "POST",
      headers: { Authorization: await nip98(key, url, "POST", body, now), "Content-Type": "application/json" },
      body,
      redirect: "manual", // a redirect (a login page, a proxy) is not the relay accepting the message
      signal: abort.signal,
    });
    reply = await r.text();
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) throw new Error(`relay answered HTTP ${r.status}: ${reply.slice(0, 200)}`);
  let parsed = null;
  try {
    parsed = JSON.parse(reply);
  } catch {
    // not JSON: handled below
  }
  // Only the relay's own {accepted: true} counts; anything else stays due and is retried.
  if (parsed?.accepted !== true) {
    const why = parsed && typeof parsed === "object" ? String(parsed.message ?? "") : `not a relay reply: ${reply}`;
    throw new Error(`relay refused the message: ${why.slice(0, 200)}`);
  }
  return event.id;
}
