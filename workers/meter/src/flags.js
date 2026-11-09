// The guard's contract with every Worker that reads it. sk-meter writes these KV keys in the GUARD
// namespace; every other component binds the same namespace read-only in spirit and imports this
// module. A key is present while its threshold is passed and deleted when usage falls back (the
// window resets). Each value is JSON: { since, metrics: [ids], until: ISO time or null }.
//
//   guard:alert    50% of any allowance: Buzz alert to Raghav (sk-meter sends it)
//   guard:degrade  80%: run with DEGRADED below
//   guard:refuse   95%: refuse non-essential requests until the window resets
//
// The static status page is served as static assets, which run before any Worker code, so it
// keeps serving whatever these flags say.

export const KEYS = { alert: "guard:alert", degrade: "guard:degrade", refuse: "guard:refuse" };
export const REPORT_KEY = "meter:report";
export const DRILL_KEY = "meter:drill";

// What a component does while guard:degrade is on.
export const DEGRADED = Object.freeze({
  heartbeatSeconds: 60,
  retentionDays: 7,
  bundlesPaused: true,
  newLeases: false,
  workersAi: false,
});

// Read the three flags. KV caches each for a minute at the edge, so a busy Worker costs a few
// reads a minute, not one per request. If KV can't be read the guard can't be confirmed, so the
// answer is degrade (stop starting new spend) but not refuse (keep serving).
export async function readGuard(kv, { cacheTtl = 60 } = {}) {
  try {
    const [alert, degrade, refuse] = await Promise.all(
      [KEYS.alert, KEYS.degrade, KEYS.refuse].map((k) => kv.get(k, { type: "json", cacheTtl })),
    );
    // degrade is implied by refuse, alert by both: a reader never sees refuse without degrade.
    return { alert: Boolean(alert || degrade || refuse), degrade: Boolean(degrade || refuse), refuse: Boolean(refuse), detail: { alert, degrade, refuse } };
  } catch (e) {
    return { alert: true, degrade: true, refuse: false, error: String(e?.message ?? e) };
  }
}

// For a Worker's fetch handler: a 503 to send instead of doing the work, or null to carry on.
// Essential requests (the status page, health checks, the guard's own readers) always carry on.
export function refusal(guard, { essential = false } = {}) {
  if (!guard.refuse || essential) return null;
  const until = guard.detail?.refuse?.until;
  const headers = { "content-type": "text/plain; charset=utf-8" };
  if (until) headers["retry-after"] = String(Math.max(60, Math.ceil((Date.parse(until) - Date.now()) / 1000)));
  return new Response("Paused: setkernel is holding Cloudflare usage inside its plan until the usage window resets.\n", { status: 503, headers });
}
