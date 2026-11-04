// live.setkernel.com (setkernel/hq#105). The page and its files are static assets; this Worker
// adds these routes:
//   GET  /ws              a WebSocket that gets the current picture, then every batch as it arrives
//   GET  /api/state       the current picture as JSON, plus the deployed commit (VERSION) of the Hub's code
//   GET  /api/replay      the last hour (?h=1) or 24 hours (?h=24) of allowlisted events, for the replay
//   POST /ingest          batches from sk-obs01 (Access service token at the edge, checked again here)
//   POST /github/webhook  GitHub Actions, pull request, review, issue and comment events from the org webhook (public; HMAC-signed)
//   GET  /github/queue    those events, cut down, for sk-obs01 to pull (its own Access token, checked again)
//   POST /ingest/usage    hourly token usage per seat (the ingest's Access token, checked again; setkernel-live#66)
//   POST /ingest/limits   each seat's newest 5-hour and weekly limit readings (the same token as /ingest/usage; setkernel-live#88)
//   GET  /usage/data      that usage summed per Halifax day for ?month=YYYY-MM, and on the current month the limits (its own Access app)
//   GET  /usage/          the page that reads it (public/usage/), behind the same Access app and token check
// One Durable Object ("live") holds the picture, a capped 24-hour replay buffer and the GitHub queue,
// and fans batches out to every open WebSocket.
// A Cron Trigger asks it every 5 minutes whether updates have stopped, and it tells Buzz #infra.
// A second, private Durable Object ("usage") holds the usage and the limits, in SQLite; the Hub never sees them.
import { DurableObject } from "cloudflare:workers";
import { applyBatch, cleanBatch, emptyReplay, emptyState, homeDay, recordReplay, replaySince, view } from "./logic.js";
import { jwksFetcher, verifyAccessJwt } from "./access.js";
import { EVENTS, cleanDelivery, cleanWebhook, emptyQueue, fetchHub, parseCursor, pushEvent, readCapped, readQueue, verifySignature } from "./github.js";
import { delivered, emptyWatch, tick } from "./watch.js";
import { postMessage } from "./buzz.js";
import { COUNTS, cleanLimits, cleanUsage, keepFrom, monthRange, sumByDay } from "./usage.js";

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
    if (pathname === "/ingest/usage") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      if (!env.INGEST_AUD) return new Response("Ingest is not configured", { status: 503 });
      const ok = await verifyAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"), { aud: env.INGEST_AUD, getKeys });
      if (!ok) return new Response("Forbidden", { status: 403 });
      const body = await request.text();
      if (body.length > MAX_BODY) return new Response("Too large", { status: 413 });
      let buckets;
      try {
        buckets = cleanUsage(JSON.parse(body));
      } catch {
        return new Response("Bad JSON", { status: 400 });
      }
      if (!buckets) return new Response("Not usage", { status: 400 });
      return Response.json(await usage(env).push(buckets, Date.now()), { headers: { "Cache-Control": "no-store" } });
    }
    if (pathname === "/ingest/limits") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      if (!env.INGEST_AUD) return new Response("Ingest is not configured", { status: 503 });
      const ok = await verifyAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"), { aud: env.INGEST_AUD, getKeys });
      if (!ok) return new Response("Forbidden", { status: 403 });
      const body = await request.text();
      if (body.length > MAX_BODY) return new Response("Too large", { status: 413 });
      let limits;
      try {
        limits = cleanLimits(JSON.parse(body));
      } catch {
        return new Response("Bad JSON", { status: 400 });
      }
      if (!limits) return new Response("Not limits", { status: 400 });
      return Response.json(await usage(env).pushLimits(limits), { headers: { "Cache-Control": "no-store" } });
    }
    if (pathname === "/usage/data") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      if (!env.USAGE_AUD) return new Response("Usage is not configured", { status: 503 });
      const ok = await verifyAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"), { aud: env.USAGE_AUD, getKeys });
      if (!ok) return new Response("Forbidden", { status: 403 });
      const month = new URL(request.url).searchParams.get("month");
      if (!monthRange(month)) return new Response("Bad month, want YYYY-MM", { status: 400 });
      // the newest hour stored goes in a header, so the body keeps the shape #69 shipped
      const { newest, ...body } = await usage(env).month(month, Date.now());
      return Response.json(body, { headers: { "Cache-Control": "no-store", ...(newest && { "Usage-Newest-Hour": newest }) } });
    }
    if (pathname === "/usage" || pathname.startsWith("/usage/")) {
      if (!env.USAGE_AUD) return new Response("Usage is not configured", { status: 503 });
      const ok = await verifyAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"), { aud: env.USAGE_AUD, getKeys });
      if (!ok) return new Response("Forbidden", { status: 403 });
      return env.ASSETS.fetch(request);
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

const usage = (env) => env.USAGE.get(env.USAGE.idFromName("usage"));

// Hourly usage per seat, model and surface (setkernel-live#66), and each seat's newest limit readings
// (setkernel-live#88). Only the Worker calls it, over RPC, with what cleanUsage or cleanLimits has
// already checked. A bucket pushed again replaces the stored one, so a pusher can resend an hour's
// running totals; a limit reading replaces the stored one only if it is as new or newer.
export class Usage extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS buckets (hour TEXT NOT NULL, seat TEXT NOT NULL, model TEXT NOT NULL,
      surface TEXT NOT NULL, ${COUNTS.map((k) => `${k} INTEGER NOT NULL`).join(", ")}, PRIMARY KEY (hour, seat, model, surface))`);
    // One row per seat and part (five_hour, seven_day, event): `at` is its observed_at or received_at,
    // `value` the cleaned part as JSON. A seat has at most three rows, so nothing needs pruning.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS seat_limits (seat TEXT NOT NULL, part TEXT NOT NULL, at TEXT NOT NULL,
      value TEXT NOT NULL, PRIMARY KEY (seat, part))`);
  }

  // { seat: { five_hour, seven_day, event } } as stored, each part null until a reading of it arrives.
  #limits() {
    const out = {};
    for (const { seat, part, value } of this.sql.exec("SELECT seat, part, value FROM seat_limits ORDER BY seat, part")) {
      (out[seat] ??= { five_hour: null, seven_day: null, event: null })[part] = JSON.parse(value);
    }
    return out;
  }

  // Keeps each part pushed unless the stored one is newer (times are toISOString's, so they sort as
  // text), and answers with every seat's limits as now stored. A part pushed as null changes nothing.
  pushLimits(limits) {
    const upsert = `INSERT INTO seat_limits (seat, part, at, value) VALUES (?, ?, ?, ?)
      ON CONFLICT (seat, part) DO UPDATE SET at = excluded.at, value = excluded.value WHERE excluded.at >= seat_limits.at`;
    this.ctx.storage.transactionSync(() => {
      for (const [seat, parts] of Object.entries(limits)) {
        for (const [part, v] of Object.entries(parts)) if (v) this.sql.exec(upsert, seat, part, v.observed_at ?? v.received_at, JSON.stringify(v));
      }
    });
    return { limits: this.#limits() };
  }

  // Each hour summed per seat over its models and surfaces, oldest first.
  #rows(where, ...params) {
    const sums = COUNTS.map((k) => `SUM(${k}) AS ${k}`).join(", ");
    return this.sql.exec(`SELECT hour, seat, ${sums} FROM buckets WHERE ${where} GROUP BY hour, seat ORDER BY hour, seat`, ...params).toArray();
  }

  // Stores the buckets, deletes hours older than KEEP_DAYS, and answers with the stored totals of
  // the hours pushed, per Halifax day and seat, for the pusher to compare.
  push(buckets, now) {
    const cols = ["hour", "seat", "model", "surface", ...COUNTS];
    const insert = `INSERT OR REPLACE INTO buckets (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    this.ctx.storage.transactionSync(() => {
      for (const b of buckets) this.sql.exec(insert, ...cols.map((c) => b[c]));
      this.sql.exec("DELETE FROM buckets WHERE hour < ?", keepFrom(now));
    });
    const hours = JSON.stringify([...new Set(buckets.map((b) => b.hour))]);
    return { stored: buckets.length, days: sumByDay(this.#rows("hour IN (SELECT value FROM json_each(?))", hours)).days };
  }

  // The month's Halifax days, each seat's sums per day, each seat's totals for the month, and the
  // newest hour stored in any month (null if none). The current Halifax month at `now` also carries
  // the limits, once any reading is stored: they are read live, so a past month has none, and while
  // there are none the page says it can't check them.
  month(month, now) {
    const { from, to } = monthRange(month);
    const newest = this.sql.exec("SELECT MAX(hour) AS h FROM buckets").one().h;
    const limits = homeDay(now).startsWith(`${month}-`) ? this.#limits() : {};
    return { month, ...sumByDay(this.#rows("hour >= ? AND hour < ?", from, to), month), ...(Object.keys(limits).length && { limits }), newest };
  }
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

  // Called by the Cron Trigger every 5 minutes (setkernel-live#9). Posts at most one message per
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
        console.error(`watch: posting the ${send.type} to Buzz failed, retrying next tick: ${e.message}`);
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
      const now = Date.now();
      const batch = cleanBatch(body, Math.floor(now / 1000));
      if (!batch) return new Response("Not a batch", { status: 400 });
      this.state = applyBatch(this.state, batch, now, today());
      if (batch.events.length) this.replay = recordReplay(this.replay, batch, now);
      if (batch.events.length || now - this.lastSaved > 60_000) {
        // every batch that carries events, so a hibernation can't lose them (the Hub can be evicted
        // ~10 s after its last request); heartbeat batches save at most once a minute while the Hub
        // stays awake, but lastSaved starts at 0 on every wake, so the first batch after a wake always
        // saves. That is at most one write per batch: about every 15 s when busy, up to every 35 s
        // when quiet and hibernating. The replay buffer is capped (public/lib/state.js), so it stays
        // far below the value limit.
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
