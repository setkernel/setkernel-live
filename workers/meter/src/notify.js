// Alert delivery. sk-meter POSTs one JSON body to ALERT_WEBHOOK_URL (a Worker secret) with
// ALERT_WEBHOOK_TOKEN as a bearer token. The body carries two shapes at once, so either receiver reads it:
//   { source, text, mention }   the old buzz-alerts bridge's /meter route on sk-obs01 (removed in hq#1261)
//   { title, message }          the ops Worker's POST /alert (setkernel/hq workers/ops), which emails
//                               `title` as the subject and `message` as the body (plan v6 E3b: alerts are email)
// ALERT_ACCESS_CLIENT_ID and ALERT_ACCESS_CLIENT_SECRET, when both are set, are sent as a Cloudflare
// Access service token (the old route was behind Access; the ops Worker's is not). A caller may name its
// own `source`. Without a webhook the alert is logged and the KV flags still act; the guard never
// depends on the alert arriving.

// The subject line is the source and the alert's first line, the body its whole text.
export function payload(alert) {
  const source = alert.source ?? "sk-meter";
  const first = String(alert.text ?? "").split("\n").find((l) => l.trim()) ?? "alert";
  return { source, text: alert.text, mention: alert.mention, title: `${source}: ${first.trim()}`.slice(0, 200), message: alert.text };
}

export async function notify(env, alert, fetchImpl = fetch) {
  const url = env.ALERT_WEBHOOK_URL;
  if (!url) {
    console.warn(`sk-meter: no ALERT_WEBHOOK_URL, alert not delivered: ${alert.text}`);
    return false;
  }
  // Never send the bearer token over plain HTTP.
  if (!url.startsWith("https://")) throw new Error("ALERT_WEBHOOK_URL must be https");
  const headers = { "content-type": "application/json" };
  if (env.ALERT_WEBHOOK_TOKEN) headers.authorization = `Bearer ${env.ALERT_WEBHOOK_TOKEN}`;
  if (env.ALERT_ACCESS_CLIENT_ID && env.ALERT_ACCESS_CLIENT_SECRET) {
    headers["cf-access-client-id"] = env.ALERT_ACCESS_CLIENT_ID;
    headers["cf-access-client-secret"] = env.ALERT_ACCESS_CLIENT_SECRET;
  }
  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    // Access answers a refused token with a redirect to its login page; following it could end in
    // a 200 and count the alert as delivered. A redirect is a failure, retried next hour.
    redirect: "manual",
    body: JSON.stringify(payload(alert)),
  });
  if (!res.ok) throw new Error(`alert webhook answered HTTP ${res.status}`);
  return true;
}
