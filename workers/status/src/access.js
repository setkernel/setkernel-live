// Who may read /status. Access admits only its policy's people and service tokens at the edge
// (setkernel-cloudflare, access stack); index.js checks the token again with verifyAccessJwt
// below, so a mistake in the Access config still can't open the page. This file verifies the
// token and maps the verified claims to a viewer and a scope. jwksFetcher and verifyAccessJwt
// began as a copy of the control Worker's access.js (setkernel-live's before it); status keeps its own.

export const ISSUER = "https://setkernel.cloudflareaccess.com";
export const CERTS = `${ISSUER}/cdn-cgi/access/certs`;

function b64urlBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

// Access's signing keys, cached for an hour (they rotate rarely). An unknown kid refetches, but
// not more than once every minRefetchMs, so junk tokens can't turn every request into a fetch.
export function jwksFetcher(url = CERTS, ttlMs = 3600_000, fetchFn = (u) => fetch(u), minRefetchMs = 60_000) {
  let keys = null;
  let at = 0;
  return async (kid) => {
    const age = Date.now() - at;
    const unknown = kid && keys && !keys.some((k) => k.kid === kid);
    if (!keys || age >= ttlMs || (unknown && age >= minRefetchMs)) {
      const r = await fetchFn(url);
      if (!r.ok) throw new Error(`certs: HTTP ${r.status}`);
      keys = (await r.json()).keys ?? [];
      at = Date.now();
    }
    return keys;
  };
}

// The claims of an unexpired RS256 token from setkernel's Access, for this app (aud), signed by
// one of Access's current keys; null for anything else.
export async function verifyAccessJwt(token, { aud, getKeys, issuer = ISSUER, now = Date.now() }) {
  try {
    const parts = (token || "").split(".");
    if (parts.length !== 3 || !aud) return null;
    const header = b64urlJson(parts[0]);
    const claims = b64urlJson(parts[1]);
    if (header.alg !== "RS256" || claims.iss !== issuer) return null;
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(aud)) return null;
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now) return null;
    if (Number.isFinite(claims.nbf) && claims.nbf * 1000 > now + 60_000) return null;
    const jwk = (await getKeys(header.kid)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    return ok ? claims : null;
  } catch {
    return null;
  }
}


export const SCOPES = ["internal", "public"];

// STATUS_CLIENTS: { "<service token client id>": "internal" | "public" }. The wall's token gets
// internal; the showcase publisher's gets public, so it can only ever read the sanitized view.
// Answers a Map; an unset or malformed variable is an empty one (no service token is let in).
export function clientScopes(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    const entries = Object.entries(parsed);
    if (entries.some(([id, scope]) => !id || !SCOPES.includes(scope))) return new Map();
    return new Map(entries);
  } catch {
    return new Map();
  }
}

// Verified claims -> who is asking: { who: "person", email } for someone who signed in through
// Access, { who: "service", scope } for a listed service token, or null. A service token's
// claims carry common_name (its client id) and no email.
export function viewer(claims, scopes) {
  if (!claims) return null;
  if (typeof claims.common_name === "string" && claims.common_name) {
    const scope = scopes.get(claims.common_name);
    return scope ? { who: "service", scope } : null;
  }
  return typeof claims.email === "string" && claims.email ? { who: "person", email: claims.email } : null;
}
