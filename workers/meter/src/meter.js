// Turns usage into the guard's state: a share of the allowance per metric, the three flags, and
// the alert to send. Pure: no I/O, so every threshold is tested with synthetic usage.

import { windowFor, elapsed } from "./windows.js";

export const LEVELS = ["ok", "alert", "degrade", "refuse"];
export const FLAGS = ["alert", "degrade", "refuse"];

// Projection is noisy early in a window; it only speaks after this share has passed.
const PACE_AFTER = 0.1;

export function levelOf(share, thresholds) {
  if (share == null) return "unknown";
  if (share >= thresholds.refuse) return "refuse";
  if (share >= thresholds.degrade) return "degrade";
  if (share >= thresholds.alert) return "alert";
  return "ok";
}

// A drill lowers one metric's allowance until it expires, so real usage crosses a threshold with
// no extra spend. It can only make the guard stricter: a drill that would raise an allowance, or
// names an unknown metric, or has expired, is ignored.
export function activeDrill(drill, allowances, now) {
  if (!drill || typeof drill !== "object") return null;
  const pinned = allowances.metrics[drill.metric]?.allowance;
  const a = Number(drill.allowance);
  const until = Date.parse(drill.expiresAt);
  if (!pinned || !(a > 0) || a >= pinned || !(until > now.getTime())) return null;
  return { metric: drill.metric, allowance: a, expiresAt: new Date(until).toISOString() };
}

// The script using most of a metric that is projected to reach the alert level (50%) of its
// allowance, for any metric the run read per script. Ties go to the name that sorts first.
function topScripts(metrics, scripts, th) {
  const out = {};
  for (const [id, by] of Object.entries(scripts ?? {})) {
    const m = metrics[id];
    if (!m || m.projected == null || m.projected / m.allowance < th.alert) continue;
    const rows = Object.entries(by).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const sum = rows.reduce((t, [, v]) => t + v, 0);
    if (!rows.length || !(sum > 0)) continue;
    out[id] = { script: rows[0][0], used: rows[0][1], share: rows[0][1] / sum };
  }
  return out;
}

export function evaluate({ allowances, usage, now, day = 1, prev = null, drill = null }) {
  const th = allowances.thresholds;
  const d = activeDrill(drill, allowances, now);
  const metrics = {};
  for (const [id, spec] of Object.entries(allowances.metrics)) {
    const w = windowFor(spec.window, now, day);
    const windowStart = w.start.toISOString();
    const allowance = d?.metric === id ? d.allowance : spec.allowance;
    let used = usage.values[id] ?? null;
    let stale = false;
    const error = usage.errors[id];
    const unknown = usage.unknown?.[id];
    if (used == null) {
      // Unreadable: keep the last value from the same window, so a failing query can never
      // lower a flag. A gauge's window moves every hour, so match on the window kind instead.
      const last = prev?.metrics?.[id];
      const sameWindow = last && (spec.window === "gauge" || last.windowStart === windowStart);
      if (sameWindow && last.used != null) { used = last.used; stale = true; }
    }
    const share = used == null ? null : used / allowance;
    const f = spec.window === "gauge" ? null : elapsed(w, now);
    const projected = used == null || f == null || f < PACE_AFTER ? null : used / f;
    metrics[id] = {
      label: spec.label, unit: spec.unit, window: spec.window, used, allowance, share,
      level: levelOf(share, th),
      projected,
      windowStart,
      resetsAt: spec.window === "gauge" ? null : w.end.toISOString(),
      ...(stale && { stale }),
      ...(error && { error }),
      ...(unknown && { unknown }),
      ...(d?.metric === id && { drill: d.expiresAt }),
    };
  }

  const flags = {};
  for (const name of FLAGS) {
    const rank = LEVELS.indexOf(name);
    const hit = Object.entries(metrics).filter(([, m]) => LEVELS.indexOf(m.level) >= rank);
    if (!hit.length) { flags[name] = null; continue; }
    const resets = hit.map(([, m]) => m.resetsAt);
    flags[name] = {
      since: prev?.flags?.[name]?.since ?? now.toISOString(),
      metrics: hit.map(([id]) => id),
      // When the last metric holding the flag resets; null while storage holds it (deleting
      // objects is the only way down).
      until: resets.includes(null) ? null : resets.sort().at(-1),
    };
  }

  const errors = Object.keys(metrics).filter((id) => metrics[id].error).sort();
  // Still failing with a "try again" after the retries: not an error, but nothing is known this run.
  const unknown = Object.keys(metrics).filter((id) => metrics[id].unknown).sort();
  const overPace = Object.keys(metrics)
    .filter((id) => metrics[id].projected != null && metrics[id].projected >= metrics[id].allowance)
    .sort();
  return {
    at: now.toISOString(),
    metrics,
    flags,
    errors,
    unknown,
    overPace,
    drill: d,
    gateways: usage.gateways ?? null,
    topScripts: topScripts(metrics, usage.scripts, th),
  };
}

// What the alert is about. A new alert goes out when this changes, and keeps being retried each
// hour until one is delivered.
export function signature(report) {
  return JSON.stringify({
    flags: FLAGS.filter((f) => report.flags[f]).map((f) => [f, report.flags[f].metrics]),
    errors: report.errors,
    // A blip with a last known value changes nothing and sends nothing; a metric that has never
    // been read is unguarded, so that stays in the alert.
    unknown: (report.unknown ?? []).filter((id) => report.metrics[id].used == null),
    overPace: report.overPace,
    drill: report.drill?.metric ?? null,
    workersAi: report.gateways?.workersAi ?? [],
    // Not report.topScripts: the top script moves as usage does, and would re-send the alert.
  });
}

const n = (x) => Math.round(x).toLocaleString("en-US");
const pct = (x) => `${Math.round(x * 100)}%`;
const when = (iso) => iso.replace("T", " ").replace(/:00\.000Z$/, " UTC");

// A script name is the account owner's, but it goes into a chat message: keep it to name characters.
const scriptName = (name) => `\`${String(name).replace(/[^\w.\-/() ]/g, "?").slice(0, 64)}\``;

function line(m) {
  const per = m.window === "day" ? " a day" : m.window === "month" ? " this month" : "";
  const reset = m.resetsAt ? `, resets ${when(m.resetsAt)}` : ", stays until data is deleted";
  return `- ${m.label}: ${n(m.used)} of ${n(m.allowance)} ${m.unit.split(" (")[0]}${per} (${pct(m.share)})${reset}${m.stale ? " [last known]" : ""}`;
}

// The alert text. `full` lists every metric, for the baseline report on the first run.
export function message(report, { full = false } = {}) {
  const top = [...FLAGS].reverse().find((f) => report.flags[f]);
  const head = {
    refuse: "🔴 **sk-meter: REFUSE** (95%): non-essential requests are refused until the window resets.",
    degrade: "🟠 **sk-meter: DEGRADE** (80%): heartbeats 60 s, retention 7 days, bundles paused, no new leases, Workers AI off.",
    alert: "🟡 **sk-meter: 50%** of an allowance is used.",
  }[top] ?? "✅ **sk-meter**: every metric is under 50% of its allowance.";
  const lines = [(report.drill ? "[DRILL] " : "") + head];
  for (const m of Object.values(report.metrics)) {
    if (m.used != null && (full || m.level !== "ok")) lines.push(line(m));
  }
  for (const [id, t] of Object.entries(report.topScripts ?? {})) {
    lines.push(`Top script for ${report.metrics[id].label}: ${scriptName(t.script)}, ${n(t.used)} ${report.metrics[id].unit.split(" (")[0]} (${pct(t.share)} of the account's).`);
  }
  const gw = report.gateways;
  if (gw?.workersAi?.length) lines.push(`AI Gateways sending requests to Workers AI: ${gw.workersAi.join(", ")}.`);
  else if (full && gw?.all) lines.push(`AI Gateways with traffic this month: ${gw.all.length}; none send requests to Workers AI.`);
  else if (full && gw?.transient) lines.push(`AI Gateway traffic is unknown this run (${gw.error}).`);
  else if (full && gw?.error) lines.push(`Can't read AI Gateway traffic (${gw.error}).`);
  if (report.overPace.length) {
    lines.push(`On pace to pass the allowance before it resets: ${report.overPace.map((id) => report.metrics[id].label).join(", ")}.`);
  }
  if (report.errors.length) {
    lines.push(`Can't read ${report.errors.map((id) => report.metrics[id].label).join(", ")} (${report.metrics[report.errors[0]].error}); flags keep their last known values.`);
  }
  if (report.unknown?.length) {
    lines.push(`Unknown this run (the API said to try again later): ${report.unknown.map((id) => report.metrics[id].label).join(", ")} (${report.metrics[report.unknown[0]].unknown}); flags keep their last known values.`);
  }
  if (report.drill) lines.push(`Drill: ${report.drill.metric} allowance lowered to ${n(report.drill.allowance)} until ${when(report.drill.expiresAt)}.`);
  return { text: lines.join("\n"), mention: Boolean(report.flags.degrade || report.flags.refuse) };
}
