// Turning the replay buffer (/api/replay, or the demo's) into a timed show: an hour in a minute,
// a day in two. No DOM here.
import { AGENTS, COLUMNS, PULSE_KINDS } from "./state.js";

export const REPLAYS = {
  1: { hours: 1, durationMs: 60_000, maxPulses: 900 },
  24: { hours: 24, durationMs: 120_000, maxPulses: 1800 },
};

// plan({ pulses, work }, { from, to, durationMs, maxPulses, rand }) -> [{ at, ts, agent, kind,
// action?, repo? }] in time order. `from` and `to` are seconds; `at` is ms into the show. Each
// minute row is spread over its minute. Claude, chat and helper pulses are thinned evenly when
// there are more than maxPulses, so a busy day doesn't flood the sky; GitHub actions are always
// kept, because the stream and the review lines need every one.
export function plan(data, { from, to, durationMs, maxPulses, rand = Math.random }) {
  const span = Math.max(1, to - from);
  const out = [];
  const rows = (data?.pulses ?? []).filter((r) => Array.isArray(r) && r[0] * 60 + 59 >= from && r[0] * 60 <= to);
  let total = 0;
  for (const r of rows) {
    COLUMNS.forEach(([, kind], i) => { if (PULSE_KINDS.includes(kind) && r[1 + i] > 0) total += r[1 + i]; });
  }
  const keep = total > maxPulses ? maxPulses / total : 1;
  for (const r of rows) {
    COLUMNS.forEach(([agent, kind], c) => {
      if (!PULSE_KINDS.includes(kind)) return; // GitHub actions come from `work`, one by one
      const n = r[1 + c];
      if (!(n > 0)) return;
      // thin with probabilistic rounding, so 0.3 of a pulse per minute still shows up sometimes
      const want = Math.floor(n * keep + rand());
      for (let i = 0; i < want; i++) {
        const ts = Math.min(to, Math.max(from, r[0] * 60 + rand() * 60));
        out.push({ ts, agent, kind });
      }
    });
  }
  for (const w of data?.work ?? []) {
    if (w.ts < from || w.ts > to || !AGENTS.includes(w.agent)) continue;
    out.push({ ts: w.ts, agent: w.agent, kind: "github", action: w.action, ...(w.repo ? { repo: w.repo } : {}) });
  }
  out.sort((x, y) => x.ts - y.ts);
  for (const e of out) e.at = Math.round(((e.ts - from) / span) * durationMs);
  return out;
}

// The replay's events before `from`, oldest first, so the line can catch up silently before the
// show starts: each minute row that ends before it (a row that runs past `from` belongs to the
// show, see plan) as one event per engineer and kind that had any, and every GitHub action. Only
// the order and the kinds matter to the lanes, not the counts.
export function eventsBefore(data, from) {
  const out = [];
  for (const r of data?.pulses ?? []) {
    if (!Array.isArray(r) || r[0] * 60 + 59 >= from) continue;
    COLUMNS.forEach(([agent, kind], i) => {
      if (PULSE_KINDS.includes(kind) && r[1 + i] > 0) out.push({ t: "msg", kind, agent, ts: r[0] * 60 });
    });
  }
  for (const w of data?.work ?? []) {
    if (w.ts < from && AGENTS.includes(w.agent)) out.push({ t: "msg", kind: "github", agent: w.agent, action: w.action, ...(w.repo ? { repo: w.repo } : {}), ts: w.ts });
  }
  return out.sort((x, y) => x.ts - y.ts);
}
