// live.setkernel.com (setkernel/hq#105). The page and its files are static assets; this Worker
// adds these routes:
//   GET  /ws              a WebSocket that gets the current picture, then every batch as it arrives
//   GET  /api/state       the current picture as JSON, plus the deployed commit (VERSION) of the Hub's code
//   GET  /api/replay      the last hour (?h=1) or 24 hours (?h=24) of allowlisted events, for the replay
//   POST /ingest          batches from sk-obs01 (Access service token at the edge, checked again here)
//   POST /github/webhook  GitHub Actions, pull request, review, issue and comment events from the org webhook (public; HMAC-signed)
//   GET  /github/queue    those events, cut down, for sk-obs01 to pull (its own Access token, checked again)
// One Durable Object ("live") holds the picture, a capped 24-hour replay buffer and the GitHub queue,
// and fans batches out to every open WebSocket.
// A Cron Trigger asks it once a minute whether updates have stopped, and it tells Buzz #infra.
import { DurableObject } from "cloudflare:workers";
import { applyBatch, cleanBatch, emptyReplay, emptyState, homeDay, recordReplay, replaySince, view } from "./logic.js";
import { jwksFetcher, verifyAccessJwt } from "./access.js";
import { EVENTS, cleanDelivery, cleanWebhook, emptyQueue, fetchHub, parseCursor, pushEvent, readCapped, readQueue, verifySignature } from "./github.js";
import { delivered, emptyWatch, tick } from "./watch.js";
import { postMessage } from "./buzz.js";

const getKeys = jwksFetcher();
const MAX_BODY = 256 * 1024;
// Today's counts are the Halifax day's (hq#177): they reset at midnight in Halifax, not UTC.
const today = () => homeDay(Date.now());

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const hub = () => env.HUB.get(env.HUB.idFromName("live"));
    if (pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      return hub().fetch(request); // the upgrade request itself, so the object can answer 101
    }
    if (pathname === "/api/state") return hub().fetch("https://hub/state");
    if (pathname === "/api/replay") {
      const h = new URL(request.url).searchParams.get("h") === "24" ? 24 : 1;
      return hub().fetch(`https://hub/replay?h=${h}`);
    }
    if (pathname === "/ingest") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      if (!env.INGEST_AUD) return new Response("Ingest is not configured", { status: 503 });
      const ok = await verifyAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"), { aud: env.INGEST_AUD, getKeys });
      if (!ok) return new Response("Forbidden", { status: 403 });
      const body = await request.text();
      if (body.length > MAX_BODY) return new Response("Too large", { status: 413 });
      return hub().fetch("https://hub/ingest", { method: "POST", body });
    }
    if (pathname === "/github/webhook") return githubWebhook(request, env, hub);
    if (pathname === "/github/queue") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      if (!env.QUEUE_AUD) return new Response("Queue is not configured", { status: 503 });
      const ok = await verifyAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"), { aud: env.QUEUE_AUD, getKeys });
      if (!ok) return new Response("Forbidden", { status: 403 });
      const since = parseCursor(new URL(request.url).searchParams.get("since"));
      if (since === null) return new Response("Bad cursor", { status: 400 });
      return fetchHub(() => hub().fetch(`https://hub/github/queue?since=${since}`));
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(env.HUB.get(env.HUB.idFromName("live")).watch());
  },
};

// GitHub calls this, so Access can't sit in front of it: the signature is the gate. Order matters:
// the size cap before reading, the signature before parsing, and dedupe only for signed deliveries.
// Nothing from the payload is logged or stored beyond what cleanWebhook keeps.
async function githubWebhook(request, env, hub) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!env.GITHUB_WEBHOOK_SECRET) return new Response("Webhook is not configured", { status: 503 });
  const body = await readCapped(request);
  if (!body) return new Response("Too large", { status: 413 });
  if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get("X-Hub-Signature-256")))) {
    return new Response("Bad signature", { status: 401 });
  }
  const event = request.headers.get("X-GitHub-Event");
  if (event === "ping") return new Response("pong");
  if (!EVENTS.includes(event)) return new Response("Ignored", { status: 202 });
  const delivery = cleanDelivery(request.headers.get("X-GitHub-Delivery"));
  if (!delivery) return new Response("No delivery id", { status: 400 });
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  const cleaned = cleanWebhook(event, payload);
  if (!cleaned.length) return new Response("Ignored", { status: 202 });
  // a list of events (setkernel-live#35) goes to its own route: a Hub still on older code answers
  // 404 there, so fetchHub waits for the new one rather than the old one queueing an empty item
  const push = JSON.stringify({ delivery, events: cleaned });
  return fetchHub(() => hub().fetch("https://hub/github/push-all", { method: "POST", body: push }));
}

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = emptyState(today());
    this.replay = emptyReplay();
    this.lastSaved = 0;
    this.lastBroadcast = 0;
    this.queue = emptyQueue();
    this.watchState = emptyWatch();
    this.watching = false;
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get(["state", "replay", "github-queue", "watch"]);
      this.state = saved.get("state") ?? this.state;
      this.replay = saved.get("replay") ?? this.replay;
      this.queue = saved.get("github-queue") ?? this.queue;
      this.watchState = saved.get("watch") ?? this.watchState;
    });
  }

  // Called by the Cron Trigger once a minute (setkernel-live#9). Posts at most one message per
  // tick; one that fails stays due and is tried again next tick.
  async watch() {
    const { BUZZ_RELAY_URL: relay, BUZZ_CHANNEL: channel, BUZZ_PRIVATE_KEY: key, ALERTS_MUTED } = this.env;
    if (!relay || !channel || !key) {
      console.log("watch: Buzz is not configured (BUZZ_RELAY_URL, BUZZ_CHANNEL, BUZZ_PRIVATE_KEY); not checking");
      return;
    }
    if (this.watching) return; // the previous tick is still posting
    this.watching = true;
    try {
      const now = Date.now();
      const muted = String(ALERTS_MUTED) === "true";
      const { watch, send } = tick(this.watchState, { lastIngest: this.state.lastIngest, now, muted });
      await this.saveWatch(watch);
      if (!send) return;
      try {
        await postMessage({ relay, channel, key, text: send.text, now });
        await this.saveWatch(delivered(this.watchState, send.type));
        console.log(`watch: posted the ${send.type} to Buzz`);
      } catch (e) {
        console.error(`watch: posting the ${send.type} to Buzz failed, retrying next minute: ${e.message}`);
      }
    } finally {
      this.watching = false;
    }
  }

  async saveWatch(watch) {
    if (JSON.stringify(watch) === JSON.stringify(this.watchState)) return;
    this.watchState = watch;
    await this.ctx.storage.put("watch", watch);
  }

  view() {
    return view(this.state, this.replay, Date.now());
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/ws") {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server); // hibernatable: the object can sleep between batches
      server.send(JSON.stringify({ t: "hello", ...this.view() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (pathname === "/state") {
      // version comes from the object's own env, so it names the code the object runs: right after
      // a deploy it can still be the old one for a few minutes (scripts/smoke.mjs waits for it).
      const body = { ...this.view(), version: this.env.VERSION || "dev" };
      return Response.json(body, { headers: { "Cache-Control": "no-store" } });
    }
    if (pathname === "/replay") {
      const hours = new URL(request.url).searchParams.get("h") === "24" ? 24 : 1;
      const now = Date.now();
      const body = { ...replaySince(this.replay, Math.trunc(now / 1000) - hours * 3600), now };
      return Response.json(body, { headers: { "Cache-Control": "public, max-age=30" } });
    }
    if (pathname === "/ingest" && request.method === "POST") {
      let body;
      try {
        body = JSON.parse(await request.text());
      } catch {
        return new Response("Bad JSON", { status: 400 });
      }
      const batch = cleanBatch(body);
      if (!batch) return new Response("Not a batch", { status: 400 });
      const now = Date.now();
      this.state = applyBatch(this.state, batch, now, today());
      if (batch.events.length) this.replay = recordReplay(this.replay, batch, now);
      if (now - this.lastSaved > 60_000) {
        // at most once a minute: a restart loses under a minute of counts, and storage writes stay low.
        // The replay buffer is capped (public/lib/state.js), so it stays far below the value limit.
        this.lastSaved = now;
        await this.ctx.storage.put({ state: this.state, replay: this.replay });
      }
      if (batch.events.length || now - this.lastBroadcast > 30_000) {
        // events right away; otherwise a heartbeat every 30 s so pages know the house is online
        this.lastBroadcast = now;
        const msg = JSON.stringify({ t: "batch", events: batch.events, ...this.view() });
        for (const ws of this.ctx.getWebSockets()) {
          try {
            ws.send(msg);
          } catch {
            // a closed socket; webSocketClose cleans it up
          }
        }
      }
      return new Response("ok");
    }
    if ((pathname === "/github/push-all" || pathname === "/github/push") && request.method === "POST") {
      // only the Worker calls this, with events it has already verified and cleaned: a list on
      // push-all, or one on push (from a Worker still on older code, for a few minutes after a deploy)
      const { delivery, events, cleaned } = await request.json();
      const { queue, added } = pushEvent(this.queue, delivery, pathname === "/github/push-all" ? events : [cleaned]);
      if (!added) return new Response("Duplicate");
      this.queue = queue;
      await this.ctx.storage.put("github-queue", queue); // every time, so dedupe survives a restart
      return new Response("Queued", { status: 202 });
    }
    if (pathname === "/github/queue") {
      const since = Number(new URL(request.url).searchParams.get("since"));
      return Response.json(readQueue(this.queue, since), { headers: { "Cache-Control": "no-store" } });
    }
    return new Response("Not found", { status: 404 });
  }

  webSocketMessage() {} // viewers never send anything that matters

  webSocketClose(ws, code) {
    try {
      ws.close(code, "closing");
    } catch {
      // already closed
    }
  }

  webSocketError(ws) {
    try {
      ws.close(1011, "error");
    } catch {
      // already closed
    }
  }
}
