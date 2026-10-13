// Checks the Cloudflare Access token on /ingest and /github/queue. Access already admits only the
// live-ingest (or live-queue) service token at the edge (setkernel-cloudflare, access stack); this
// is the second check, so a mistake in Access config still can't let anyone push to the page or
// read the queue.

export const ISSUER = "https://setkernel.cloudflareaccess.com";
export const CERTS = `${ISSUER}/cdn-cgi/access/certs`;

function b64urlBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

// Access's signing keys, cached for an hour (they rotate rarely; an unknown kid refetches once).
export function jwksFetcher(url = CERTS, ttlMs = 3600_000, fetchFn = (u) => fetch(u)) {
  let keys = null;
  let at = 0;
  return async (kid) => {
    const fresh = Date.now() - at < ttlMs;
    if (!keys || !fresh || (kid && !keys.some((k) => k.kid === kid))) {
      const r = await fetchFn(url);
      if (!r.ok) throw new Error(`certs: HTTP ${r.status}`);
      keys = (await r.json()).keys ?? [];
      at = Date.now();
    }
    return keys;
  };
}

// true only for an unexpired RS256 token from setkernel's Access, for this app (aud), signed by
// one of Access's current keys.
export async function verifyAccessJwt(token, { aud, getKeys, issuer = ISSUER, now = Date.now() }) {
  try {
    const parts = (token || "").split(".");
    if (parts.length !== 3 || !aud) return false;
    const header = b64urlJson(parts[0]);
    const claims = b64urlJson(parts[1]);
    if (header.alg !== "RS256" || claims.iss !== issuer) return false;
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(aud)) return false;
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now) return false;
    if (Number.isFinite(claims.nbf) && claims.nbf * 1000 > now + 60_000) return false;
    const jwk = (await getKeys(header.kid)).find((k) => k.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return false;
  }
}
