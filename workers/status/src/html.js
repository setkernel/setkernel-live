// The phone view of the internal read model: one small page, no script, nothing loaded from
// anywhere but this hostname. Manrope (Google Fonts, OFL) is self-hosted as a static asset at
// /status/fonts/ (public/status/fonts, with its licence); sans-serif is only the last fallback.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

// "4 min", "3 h", "2 d" since (or until) iso, from now
export function ago(iso, now) {
  const s = Math.abs(now.getTime() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return "?";
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

const link = (href, text) => (href ? `<a href="${esc(href)}">${esc(text)}</a>` : esc(text));

const STYLE = `
@font-face{font-family:Manrope;src:url(/status/fonts/manrope-latin-400-normal.woff2) format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:Manrope;src:url(/status/fonts/manrope-latin-600-normal.woff2) format("woff2");font-weight:600;font-display:swap}
:root{color-scheme:light dark;--fg:#1b1f24;--muted:#5b6470;--bg:#fbfbfa;--line:#d9dde3;--warn:#8a4b00;--bad:#a1101a;--ok:#1d6b3a}
@media (prefers-color-scheme:dark){:root{--fg:#e8eaed;--muted:#a3abb5;--bg:#14171a;--line:#2e343b;--warn:#f0b35a;--bad:#ff8a8f;--ok:#7fd49a}}
*{box-sizing:border-box}body{margin:0 auto;max-width:40rem;padding:1rem;font:400 1rem/1.45 Manrope,sans-serif;color:var(--fg);background:var(--bg)}
h1{font-size:1.25rem;margin:0 0 .25rem}h2{font-size:1rem;font-weight:600;margin:1.5rem 0 .5rem;border-bottom:1px solid var(--line);padding-bottom:.25rem}
a{color:inherit}ul{list-style:none;margin:0;padding:0}li{padding:.35rem 0;border-bottom:1px solid var(--line)}
.m{color:var(--muted);font-size:.875rem}.g{padding:.5rem .75rem;border:1px solid currentColor;border-radius:.25rem;margin:.75rem 0}
.alert{color:var(--warn)}.degrade,.refuse,.bad{color:var(--bad)}.ok{color:var(--ok)}.n{font-weight:600}`;

function guardBlock(g, now) {
  if (g.level === "ok") return `<p class="g ok">Guard: ok</p>`;
  const what = g.unreadable ? "flags unreadable, treated as degrade" : g.metrics.join(", ") || "no metric named";
  const until = g.until ? `, until ${esc(g.until.slice(0, 16).replace("T", " "))} UTC (${ago(g.until, now)})` : "";
  return `<p class="g ${esc(g.level)}">Guard: <span class="n">${esc(g.level)}</span> (${esc(what)}${until})</p>`;
}

// internal: model.js internalView()
export function renderHtml(v) {
  const now = new Date(v.generated_at);
  const events = v.last_24h.events.length
    ? v.last_24h.events.map((e) => `<li><span class="${e.state === "failed" ? "bad" : "ok"}">${esc(e.state)}</span> ${link(e.pr_url ?? e.url, e.ref)} <span class="m">${ago(e.at, now)} ago${e.seat ? ` · ${esc(e.seat)}` : ""}</span></li>`).join("")
    : `<li class="m">None.</li>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex"><title>setkernel status</title><style>${STYLE}</style></head><body>`
    + `<h1>setkernel status</h1><p class="m">${esc(v.generated_at.slice(0, 19).replace("T", " "))} UTC · <a href="/status/internal.json">JSON</a></p>`
    + guardBlock(v.guard, now)
    + `<h2>Last 24 h: ${v.last_24h.merged} merged, ${v.last_24h.failed} failed</h2><ul>${events}</ul>`
    + `</body></html>`;
}
