// The alert webhook: the headers the /meter receiver behind Cloudflare Access needs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { notify, payload } from "../src/notify.js";

const URL = "https://alerts.example.test/meter";
const ALERT = { text: "x", mention: false };

function capture(status = 200) {
  const seen = [];
  const impl = async (url, init) => {
    seen.push({ url, init });
    return new Response(null, { status, headers: status >= 300 && status < 400 ? { location: "https://login.example.test/" } : {} });
  };
  impl.seen = seen;
  return impl;
}

test("sends the Access service token and the bearer, and doesn't follow redirects", async () => {
  const f = capture();
  const env = { ALERT_WEBHOOK_URL: URL, ALERT_WEBHOOK_TOKEN: "t", ALERT_ACCESS_CLIENT_ID: "id", ALERT_ACCESS_CLIENT_SECRET: "s" };
  assert.equal(await notify(env, ALERT, f), true);
  const { headers, redirect } = f.seen[0].init;
  assert.equal(headers["cf-access-client-id"], "id");
  assert.equal(headers["cf-access-client-secret"], "s");
  assert.equal(headers.authorization, "Bearer t");
  assert.equal(redirect, "manual");
});

test("no Access headers unless both halves of the service token are set", async () => {
  const f = capture();
  await notify({ ALERT_WEBHOOK_URL: URL, ALERT_ACCESS_CLIENT_ID: "id" }, ALERT, f);
  assert.equal(f.seen[0].init.headers["cf-access-client-id"], undefined);
  assert.equal(f.seen[0].init.headers["cf-access-client-secret"], undefined);
});

test("an Access redirect to its login page is a failure, so the alert is retried", async () => {
  await assert.rejects(notify({ ALERT_WEBHOOK_URL: URL }, ALERT, capture(302)), /HTTP 302/);
});

test("the receiver's contract: POST { source, text, mention, title, message } as JSON, and its 204 counts as delivered", async () => {
  const f = capture(204);
  const env = { ALERT_WEBHOOK_URL: "https://alerts.setkernel.net/meter", ALERT_WEBHOOK_TOKEN: "t" };
  assert.equal(await notify(env, { text: "line 1\nline 2", mention: true }, f), true);
  const { url, init } = f.seen[0];
  assert.equal(url, "https://alerts.setkernel.net/meter");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(init.body), { source: "sk-meter", text: "line 1\nline 2", mention: true, title: "sk-meter: line 1", message: "line 1\nline 2" });
});

test("the ops Worker's /alert reads title as the subject and message as the body", () => {
  assert.deepEqual(payload({ text: "\n  DEGRADE: queues_ops 85%\nmore", mention: true }), {
    source: "sk-meter", text: "\n  DEGRADE: queues_ops 85%\nmore", mention: true, title: "sk-meter: DEGRADE: queues_ops 85%", message: "\n  DEGRADE: queues_ops 85%\nmore",
  });
  assert.equal(payload({ text: "x".repeat(500) }).title.length, 200);
  assert.equal(payload({ text: "" }).title, "sk-meter: alert");
});

test("an http:// URL is refused before anything is sent, so no secret leaves in the clear", async () => {
  const f = capture();
  const env = { ALERT_WEBHOOK_URL: "http://alerts.setkernel.net/meter", ALERT_WEBHOOK_TOKEN: "t", ALERT_ACCESS_CLIENT_ID: "id", ALERT_ACCESS_CLIENT_SECRET: "s" };
  await assert.rejects(notify(env, ALERT, f), /must be https/);
  assert.equal(f.seen.length, 0);
});

test("a receiver error is a failure, so the alert is retried", async () => {
  await assert.rejects(notify({ ALERT_WEBHOOK_URL: URL }, ALERT, capture(401)), /HTTP 401/);
});

test("the source is sk-meter unless the alert names its own (another sender)", async () => {
  const f = capture();
  await notify({ ALERT_WEBHOOK_URL: URL }, ALERT, f);
  await notify({ ALERT_WEBHOOK_URL: URL }, { ...ALERT, source: "other-sender" }, f);
  assert.deepEqual(f.seen.map((s) => JSON.parse(s.init.body).source), ["sk-meter", "other-sender"]);
});
