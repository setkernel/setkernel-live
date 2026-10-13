// The GitHub Actions receiver for live.setkernel.com (setkernel-live#16, decision setkernel/hq#113):
// checking a webhook delivery, cutting it down to a few fields, and the capped queue sk-obs01
// pulls. Pure, so it runs under `node --test`; src/worker.js wires it to the routes and the Hub.
//
// Stored per run, and nothing else: repo name, private flag, workflow name, conclusion and time
// (plus whether it was a workflow run or a deployment). Never commit messages, branch names,
// URLs, actors or deployment environment names. The raw payload is never stored.

export const MAX_WEBHOOK_BODY = 512 * 1024; // a workflow_run payload is tens of KB
export const QUEUE_CAP = 500; // events kept for sk-obs01; the oldest go first
export const DELIVERY_CAP = 2000; // X-GitHub-Delivery ids remembered for dedupe
export const PULL_LIMIT = 200; // events per pull
export const EVENTS = ["workflow_run", "deployment_status"];

const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const DELIVERY = /^[A-Za-z0-9-]{1,64}$/;
const RUN_CONCLUSIONS = ["success", "failure", "cancelled", "timed_out", "action_required", "neutral", "skipped", "stale", "startup_failure"];
const DEPLOY_STATES = ["success", "failure", "error"]; // terminal only; pending, queued, in_progress and inactive are dropped

const hexBytes = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));

// true only if `header` is "sha256=<hex>" and is the HMAC-SHA256 of the raw body under `secret`.
// crypto.subtle.verify compares in constant time.
export async function verifySignature(secret, body, header) {
  if (!secret || typeof header !== "string") return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const data = typeof body === "string" ? enc.encode(body) : body;
  return crypto.subtle.verify("HMAC", key, hexBytes(m[1]), data);
}

// The request body as bytes, or null once it passes `max` (stops reading there).
export async function readCapped(request, max = MAX_WEBHOOK_BODY) {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export const cleanDelivery = (v) => (typeof v === "string" && DELIVERY.test(v) ? v : null);

function cleanName(v, fallback) {
  if (typeof v !== "string") return fallback;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 100);
  return s || fallback;
}

function toSeconds(v, now) {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Math.trunc((Number.isFinite(ms) ? ms : now) / 1000);
}

// A verified delivery -> { key, event } to queue, or null to ignore it. `key` collapses every
// delivery about the same run (re-runs, redelivered or repeated statuses) to one queued event;
// it stays inside the Hub and is never handed out.
export function cleanWebhook(eventName, payload, now = Date.now()) {
  if (!payload || typeof payload !== "object") return null;
  const repo = payload.repository;
  if (!repo || typeof repo.name !== "string" || !REPO.test(repo.name)) return null;
  const base = { repo: repo.name, private: repo.private !== false }; // fails closed: unknown counts as private
  if (eventName === "workflow_run") {
    const run = payload.workflow_run;
    if (payload.action !== "completed" || !run || !Number.isSafeInteger(run.id)) return null;
    if (!RUN_CONCLUSIONS.includes(run.conclusion)) return null;
    // the workflow's name, never run.display_title (that can be a commit message)
    const workflow = cleanName(payload.workflow?.name ?? run.name, "workflow");
    return { key: `run:${run.id}`, event: { kind: "run", ...base, workflow, conclusion: run.conclusion, ts: toSeconds(run.updated_at, now) } };
  }
  if (eventName === "deployment_status") {
    const status = payload.deployment_status;
    const deployment = payload.deployment;
    if (!status || !deployment || !Number.isSafeInteger(deployment.id)) return null;
    if (!DEPLOY_STATES.includes(status.state)) return null;
    // never the environment name; the workflow's name when a workflow made the deployment
    const workflow = cleanName(payload.workflow?.name, "deployment");
    return { key: `deploy:${deployment.id}`, event: { kind: "deploy", ...base, workflow, conclusion: status.state, ts: toSeconds(status.updated_at ?? status.created_at, now) } };
  }
  return null;
}

export function emptyQueue() {
  return { seq: 0, dropped: 0, items: [], deliveries: [] };
}

// Add a cleaned event for a delivery (returns { queue, added }). A delivery id seen before is a
// duplicate and changes nothing. An event for a run already queued replaces it and moves to the
// end with a new cursor, so a re-run reaches sk-obs01 again but the queue holds one per run.
export function pushEvent(queue, delivery, cleaned, { cap = QUEUE_CAP, deliveryCap = DELIVERY_CAP } = {}) {
  const q = queue ?? emptyQueue();
  if (q.deliveries.includes(delivery)) return { queue: q, added: false };
  const deliveries = [...q.deliveries, delivery].slice(-deliveryCap);
  const seq = q.seq + 1;
  let items = q.items.filter((it) => it.key !== cleaned.key);
  items.push({ seq, key: cleaned.key, event: cleaned.event });
  let dropped = q.dropped;
  if (items.length > cap) {
    dropped = items[items.length - cap - 1].seq;
    items = items.slice(-cap);
  }
  return { queue: { seq, dropped, items, deliveries }, added: true };
}

// What sk-obs01 gets for ?since=<cursor>: events after the cursor, oldest first, and the cursor
// to send next time. `gap` is true when events after its cursor were dropped by the cap. A cursor
// ahead of the queue (the queue was reset) starts again from the beginning.
export function readQueue(queue, since, limit = PULL_LIMIT) {
  const q = queue ?? emptyQueue();
  let from = Number.isSafeInteger(since) && since >= 0 ? since : 0;
  if (from > q.seq) from = 0;
  const items = q.items.filter((it) => it.seq > from).slice(0, limit);
  const cursor = items.length ? items[items.length - 1].seq : from;
  return {
    events: items.map((it) => ({ cursor: it.seq, ...it.event })),
    cursor,
    more: q.items.some((it) => it.seq > cursor),
    gap: from < q.dropped,
  };
}

// "?since=" -> an integer cursor, or null if it isn't one.
export function parseCursor(v) {
  if (v === null || v === "") return 0;
  return /^\d{1,15}$/.test(v) ? Number(v) : null;
}
