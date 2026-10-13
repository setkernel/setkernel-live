// live.setkernel.com (setkernel/hq#105). The page and its files are static assets; this Worker
// adds three routes:
//   GET  /ws         a WebSocket that gets the current picture, then every batch as it arrives
//   GET  /api/state  the current picture as JSON
//   POST /ingest     batches from sk-obs01 (Access service token at the edge, checked again here)
// One Durable Object ("live") holds the picture and fans batches out to every open WebSocket.
import { DurableObject } from "cloudflare:workers";
import { applyBatch, cleanBatch, emptyState } from "./logic.js";
import { jwksFetcher, verifyAccessJwt } from "./access.js";

const getKeys = jwksFetcher();
const MAX_BODY = 256 * 1024;
const today = () => new Date().toISOString().slice(0, 10);

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const hub = () => env.HUB.get(env.HUB.idFromName("live"));
    if (pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      return hub().fetch(request); // the upgrade request itself, so the object can answer 101
    }
    if (pathname === "/api/state") return hub().fetch("https://hub/state");
    if (pathname === "/ingest") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      if (!env.INGEST_AUD) return new Response("Ingest is not configured", { status: 503 });
      const ok = await verifyAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"), { aud: env.INGEST_AUD, getKeys });
      if (!ok) return new Response("Forbidden", { status: 403 });
      const body = await request.text();
      if (body.length > MAX_BODY) return new Response("Too large", { status: 413 });
      return hub().fetch("https://hub/ingest", { method: "POST", body });
    }
    return env.ASSETS.fetch(request);
  },
};

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = emptyState(today());
    this.lastSaved = 0;
    this.lastBroadcast = 0;
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get("state")) ?? this.state;
    });
  }

  view() {
    const { agents, counts, feed, ci, lastIngest } = this.state;
    return { agents, counts, feed, ci: ci ?? [], lastIngest, now: Date.now() };
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
      return Response.json(this.view(), { headers: { "Cache-Control": "no-store" } });
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
      if (now - this.lastSaved > 60_000) {
        // at most once a minute: a restart loses under a minute of counts, and storage writes stay low
        this.lastSaved = now;
        await this.ctx.storage.put("state", this.state);
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
