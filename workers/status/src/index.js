// sk-status: the read model of the org (hq#208), for Raghav, the wall and Polaris.
//
//   GET /status                the internal view: HTML for a browser, JSON otherwise
//   GET /status/internal.json  the internal view as JSON (the wall, hq#127; Polaris)
//   GET /status/public.json    the sanitized view (the showcase's publisher, hq#213)
//   /status/fonts/*            static assets: served by Cloudflare before this code runs
//
// The routes are ctl.setkernel.net/status and /status/*, behind their own Access app (README.md,
// "Routes"), and every request's Access token is checked again here. A person sees everything;
// a service token sees what STATUS_CLIENTS gives it. The control Worker writes through the Feed entrypoint, over a service
// binding, so there is no write route at all.

import { WorkerEntrypoint } from "cloudflare:workers";
import { readGuard, refusal } from "../../meter/src/flags.js";
import { clientScopes, jwksFetcher, verifyAccessJwt, viewer } from "./access.js";
import { BOARD_NAME } from "./board.js";
import { renderHtml } from "./html.js";
import { internalView, publicView } from "./model.js";

export { Board } from "./board.js";

// How long one isolate reuses a board snapshot, in seconds. The Cache API isn't available
// behind Access, so this is per isolate. Pollers get the longer wait (twice their one-a-minute
// interval, so at most every other poll reads the object); under guard:degrade every wait goes up.
export const FRESH = { person: 15, service: 120 };
export const DEGRADED_FRESH = { person: 60, service: 600 };
export const GUARD_SECONDS = 60;

const fail = (status, error) => Response.json({ ok: false, error }, { status, headers: { "cache-control": "no-store" } });

const board = (env) => env.BOARD.get(env.BOARD.idFromName(BOARD_NAME));

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

// One handler with its own caches; tests make their own with a fake clock and fake keys.
export function createHandler({ getKeys = jwksFetcher(), now = () => new Date() } = {}) {
  let guardMemo = null;
  let snapMemo = null;

  async function guardOf(env) {
    const t = now().getTime();
    if (!guardMemo || t - guardMemo.at >= GUARD_SECONDS * 1000) guardMemo = { at: t, value: await readGuard(env.GUARD) };
    return guardMemo.value;
  }

  async function snapshotOf(env, maxAgeS) {
    const t = now().getTime();
    if (!snapMemo || t - snapMemo.at >= maxAgeS * 1000) {
      const snap = await board(env).snapshot();
      if (!snap?.ok) throw new Error("board snapshot failed");
      snapMemo = { at: t, value: snap };
    }
    return snapMemo.value;
  }

  return async function handle(request, env) {
    const { pathname } = new URL(request.url);
    const views = { "/status": "page", "/status/internal.json": "internal", "/status/public.json": "public" };
    const view = views[pathname];
    if (!view) return fail(404, "no such route");
    if (request.method !== "GET" && request.method !== "HEAD") return fail(405, "GET only");

    // fails closed: with no audience configured, nothing is served
    const claims = await verifyAccessJwt(request.headers.get("cf-access-jwt-assertion"), { aud: env.STATUS_ACCESS_AUD, getKeys, now: now().getTime() });
    const who = viewer(claims, clientScopes(env.STATUS_CLIENTS));
    if (!who) return fail(401, "unauthorized");
    if (who.who === "service" && who.scope === "public" && view !== "public") return fail(403, "this token reads /status/public.json only");

    const guard = await guardOf(env);
    // the public feed is the one that exists for polling from outside: it stops first
    if (view === "public") {
      const paused = refusal(guard);
      if (paused) return paused;
    }
    const wait = (guard.degrade ? DEGRADED_FRESH : FRESH)[who.who];
    const internal = internalView(await snapshotOf(env, wait), guard, now());
    // /status answers HTML or JSON by Accept, so a cache must key on it
    const headers = { "cache-control": `private, max-age=${wait}`, vary: "accept" };
    if (view === "public") return Response.json(publicView(internal), { headers });
    const wantsHtml = view === "page" && who.who === "person" && /text\/html/.test(request.headers.get("accept") ?? "");
    if (wantsHtml) return new Response(renderHtml(internal), { headers: { ...headers, ...HTML_HEADERS } });
    return Response.json(internal, { headers });
  };
}


// The control Worker's service binding: [[services]] binding = "STATUS", service = "sk-status", entrypoint = "Feed".
// publish({ items: [WorkItem.get() results] }) -> { ok, applied, stale, rejected }. Items feed only
// the "last 24 h" list now; a batch's `seats` is ignored.
export class Feed extends WorkerEntrypoint {
  async publish(batch) {
    return board(this.env).publish(batch);
  }
}

// A 500 that logs the error and tells the caller nothing more.
export const guarded = (handle) => async (request, env) => {
  try {
    return await handle(request, env);
  } catch (e) {
    console.error(`sk-status: ${request.method} ${new URL(request.url).pathname}: ${e?.stack ?? e}`);
    return fail(500, "internal error");
  }
};

export default { fetch: guarded(createHandler()) };
