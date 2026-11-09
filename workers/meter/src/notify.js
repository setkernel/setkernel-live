// Alert delivery. A Worker can't run the buzz CLI or hold a Buzz identity the way hq's
// observability bridge does, so it POSTs { source, text, mention } to ALERT_WEBHOOK_URL (a Worker
// secret) with ALERT_WEBHOOK_TOKEN as a bearer token, and the receiver sends it to Buzz. The
// receiver is the buzz-alerts bridge's /meter route on sk-obs01 (hq#222, observability/README.md),
// behind Cloudflare Access: ALERT_ACCESS_CLIENT_ID and ALERT_ACCESS_CLIENT_SECRET are the
// sk-meter-alerts service token. A caller may name its own `source`. Without a webhook the alert is logged and the KV flags still act;
// the guard never depends on the alert arriving.

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
    body: JSON.stringify({ source: alert.source ?? "sk-meter", text: alert.text, mention: alert.mention }),
  });
  if (!res.ok) throw new Error(`alert webhook answered HTTP ${res.status}`);
  return true;
}
