// The not-reporting prototype's data (setkernel-live#54): the proposed new state, its proposed
// allowlist check, and the busy day with one or two engineers whose VM stopped reporting. Pure, so
// build.mjs runs it under node and checks every batch against the real allowlist.

// The proposed state. Not OFFLINE: the page already says "offline" for the whole office.
export const SILENT = "SILENT";
// sk-obs01's rule (setkernel/hq#251's threshold): no run has ended for this long and none is
// running, or the watch itself stopped writing. Until then the engineer shows as today.
export const AFTER_S = 15 * 60;
// The oldest last-run time the page would accept: older than this, the engineer is still "not
// reporting", with no time.
export const KEEP_S = 7 * 86_400;

// The proposed addition to src/logic.js's agentInfo: { state: "SILENT", lastRun } where lastRun is
// whole minutes in seconds, not in the future and not older than KEEP_S. Anything else in the
// object is dropped, as for the other states. A SILENT without a usable lastRun keeps the state
// and drops the time, so the page says "Not reporting" with no time rather than a wrong one.
export function cleanSilent(v, nowS) {
  if (!v || typeof v !== "object" || v.state !== SILENT) return null;
  const t = v.lastRun;
  const ok = Number.isInteger(t) && t % 60 === 0 && t <= nowS && t >= nowS - KEEP_S;
  return ok ? { state: SILENT, lastRun: t } : { state: SILENT };
}

// The scenarios the prototype's switcher offers: who stopped, and how long before the clock.
// "one": Orion, 2 h 35 min (at 16:40, the last run ended at 14:05). "two": Vega and Orion, about
// 12 hours, as on 2026-10-16 (setkernel/hq#246).
export const SCENARIOS = {
  none: [],
  one: [["Orion", 155 * 60]],
  two: [["Vega", 12 * 3600 + 9 * 60], ["Orion", 11 * 3600 + 52 * 60]],
};

// Who is down and since when, for a clock at nowS: [{ name, from }], from on a whole minute.
export const downs = (scenario, nowS) => (SCENARIOS[scenario] ?? []).map(([name, ago]) => ({ name, from: Math.floor((nowS - ago) / 60) * 60 }));

// One batch as sk-obs01 would send it with the engineer's sk-agent stopped at `from`: nothing more
// comes from that VM (no Claude requests, chat posts or GitHub actions of its own), but a merge of
// its pull request still arrives from GitHub. The state turns SILENT once AFTER_S has passed; before
// that the engineer looks as they do today. `today` sends what main sends today instead: IDLE.
export function downBatch(batch, list, today = false) {
  if (!list.length) return batch;
  let { events, agents } = batch;
  for (const { name, from } of list) {
    if (batch.at <= from) continue;
    events = events.filter((e) => !(e.agent === name && (e.ts ?? batch.at) >= from && e.action !== "merged"));
    agents = { ...agents, [name]: batch.at - from >= AFTER_S && !today ? { state: SILENT, lastRun: from } : { state: "IDLE" } };
  }
  return { ...batch, events, agents };
}
