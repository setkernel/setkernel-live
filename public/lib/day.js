// What the Day page (setkernel-live#48, the design in docs/design/v3/day) shows, worked out from the
// public view and the replay buffer: the 24-hour lanes and their stages, the marks, the Now column's
// words, the key, the table and the scrub readout. Pure: no DOM, so it runs under `node --test`;
// public/lib/chart.js draws what this returns.
import { CI_RECENT, ENGINEERS, POLE, REPLAY_WORK, columnOf, homeMidnight, isRequest } from "./state.js";
import { STAGE_NAME, STARTED_FOR_S, column, seedLanes, stepLines } from "./line.js";
import { ACTION_TEXT, ciWhere, ciWord, clock, deed, doing, isActive, sentence } from "./words.js";

export const SPAN = 86_400; // the chart is the last 24 hours
export const BIN = 600; // in ten-minute columns
export const BINS = SPAN / BIN;
// Polaris's guardians (its three Claude sessions) have no rows: they are a count in Polaris's line.
export const GUARDIANS = POLE.filter((n) => n !== "Polaris");
// Only three marks carry the story; every other action is words (Now column, readout, table).
export const KEY_MARKS = ["merged", "requested_changes"];
const PULSES = ["claude", "chat", "helper"];

// The rows, top to bottom, with a light gap ("sep") between the groups.
export const ROWS = [{ id: "Polaris", kind: "pole" }, { kind: "sep" }, ...ENGINEERS.map((id) => ({ id, kind: "eng" })), { kind: "sep" }, { id: "CI", kind: "ci" }];

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// The stage a lane's job is in, from its lane alone (no agent state in the replay).
const stageOf = (lane) => (!lane?.job ? null : lane.job === "started" ? (lane.built ? "building" : "started") : lane.job === "review" ? (lane.asked ? "fixing" : "review") : "merged");

// The chart's window for a clock at `nowS`: ten-minute columns that end on a ten-minute boundary,
// so a scrubbed column reads "10:20–10:30" and the columns don't shift as the clock ticks.
export function chartWindow(nowS) {
  const end = Math.ceil(nowS / BIN) * BIN;
  return { nowS, end, t0: end - SPAN };
}

// Everything the chart needs, from the view (/api/state, the WebSocket or ?demo) and the replay
// buffer (/api/replay). `nowS` is the server's clock.
export function prep(s, replay, nowS) {
  const { end, t0 } = chartWindow(nowS);
  const lastS = s?.lastIngest ? Math.floor(s.lastIngest / 1000) : null;
  const rows = replay?.pulses ?? [];
  const binOf = (ts) => Math.floor((ts - t0) / BIN);
  const bins = Object.fromEntries(ENGINEERS.map((n) => [n, Object.fromEntries(PULSES.map((k) => [k, new Array(BINS).fill(0)]))]));
  for (const r of rows) {
    const i = binOf(r[0] * 60);
    if (i < 0 || i >= BINS) continue;
    for (const n of ENGINEERS) for (const k of PULSES) bins[n][k][i] += r[1 + columnOf(n, k)] || 0;
  }
  const work = (replay?.work ?? []).filter((w) => w.ts >= t0 && w.ts <= nowS);
  const ci = (s?.ci ?? []).filter((c) => c.ts >= t0 && c.ts <= nowS).slice().reverse(); // oldest first

  // The stages along each lane: the replay's actions and Claude requests, in time order, through
  // line.js's own stepLines, from the live lanes older than the window (seedLanes).
  let lines = seedLanes(s?.line, t0);
  const claudeCol = Object.fromEntries(ENGINEERS.map((n) => [n, columnOf(n, "claude")]));
  const events = [
    ...work.map((w) => ({ t: "msg", kind: isRequest(w) ? "request" : "github", ...w })),
    ...rows.flatMap((r) => ENGINEERS.filter((n) => r[1 + claudeCol[n]] > 0).map((agent) => ({ t: "msg", kind: "claude", agent, ts: r[0] * 60 }))),
  ].filter((e) => e.ts >= t0 && e.ts <= nowS).sort((a, b) => a.ts - b.ts);
  const spans = Object.fromEntries(ENGINEERS.map((n) => [n, []]));
  const open = {};
  const close = (n, to) => {
    const o = open[n];
    if (!o) return;
    if (o.stage === "started" && to - o.from > STARTED_FOR_S) {
      // on to Building after the wait, as the live line does
      spans[n].push({ stage: "started", from: o.from, to: o.from + STARTED_FOR_S }, { stage: "building", from: o.from + STARTED_FOR_S, to });
    } else spans[n].push({ ...o, to });
    delete open[n];
  };
  for (const n of ENGINEERS) {
    const st = stageOf(lines[n]);
    if (st && st !== "merged") open[n] = { stage: st, from: t0, seeded: true };
  }
  for (const e of events) {
    lines = stepLines(lines, [e], ENGINEERS).lines;
    for (const n of ENGINEERS) {
      const st = stageOf(lines[n]);
      if ((open[n]?.stage ?? null) === st || (st === "merged" && !open[n])) continue;
      close(n, e.ts);
      if (st && st !== "merged") open[n] = { stage: st, from: e.ts };
    }
  }
  const stop = Math.min(lastS ?? nowS, nowS);
  // Someone who is idle isn't building: a job with no review yet stops at the last sign of work, so
  // a lane never says Idle and runs a Building line up to the edge. A review waiting on others stays.
  for (const n of ENGINEERS) {
    const last = Math.max(0, ...events.filter((e) => e.agent === n).map((e) => e.ts));
    const idle = s?.lastIngest && !isActive(s.agents?.[n]);
    close(n, idle && open[n] && open[n].stage !== "review" && last > open[n].from ? Math.min(last + 60, stop) : stop);
  }

  // Claude requests and chat posts together, per ten minutes: the activity band
  const total = Object.fromEntries(ENGINEERS.map((n) => [n, bins[n].claude.map((c, i) => c + bins[n].chat[i])]));
  const D = {
    s: s ?? {}, nowS, end, t0, lastS, bins, total, work, ci, spans,
    maxAct: Math.max(1, ...ENGINEERS.flatMap((n) => total[n])),
    // where the data stops: older actions or CI runs were dropped by the caps
    workFrom: (replay?.work ?? []).length >= REPLAY_WORK ? work[0]?.ts ?? null : null,
    ciFrom: (s?.ci ?? []).length >= CI_RECENT && ci.length ? ci[0].ts : null,
    mid: homeMidnight(nowS),
  };
  D.marks = Object.fromEntries(ENGINEERS.map((n) => [n, laneMarks(D, n)]));
  return D;
}

export const binTime = (D, i) => D.t0 + i * BIN;
export const inBin = (D, list, i) => list.filter((w) => w.ts >= binTime(D, i) && w.ts < binTime(D, i) + BIN);
const stageAt = (D, n, ts) => D.spans[n].find((sp) => ts >= sp.from && ts < sp.to)?.stage ?? null;

// A mark's or tick's words, for its <title> and the table: "Orion had a pull request merged in
// setkernel-live, 14:02".
export const label = (e, tz) => `${e.agent} ${deed(e)}, ${clock(e.ts, tz)}`;
export const ciLabel = (c, tz) => `CI ${ciWord(c)} in ${ciWhere(c)}, ${clock(c.ts, tz)}`;

// The marks on a lane's stage line: ● each merge of its pull requests, and ✕ where Fixing begins
// (changes asked for), drawn on the author's lane; the hover names the reviewer when it can.
// A pull request opened has no mark: it is where the heavy In review line begins.
export function laneMarks(D, n, tz) {
  const asks = D.spans[n].filter((sp) => sp.stage === "fixing" && !sp.seeded).map((sp) => {
    const by = D.work.find((w) => w.action === "requested_changes" && Math.abs(w.ts - sp.from) < 300);
    return { action: "requested_changes", ts: sp.from, title: by ? label(by, tz) : `Changes asked for, ${clock(sp.from, tz)}` };
  });
  const merges = D.work.filter((w) => w.agent === n && w.action === "merged").map((w) => ({ ...w, title: label(w, tz) }));
  return [...merges, ...asks].sort((a, b) => a.ts - b.ts);
}

// Polaris's row is one idea: a quiet tick per merge.
export const poleMerges = (D) => D.work.filter((w) => w.agent === "Polaris" && w.action === "merged_by");

// Marks that would sit on top of each other go on separate levels (offsets from the line), so
// a burst reads as a stack, not a blot. Time stays exact: only the height moves.
export function levels(list, x, gap, offsets) {
  const last = offsets.map(() => -Infinity);
  return [...list].sort((a, b) => a.ts - b.ts).map((w) => {
    let k = last.findIndex((lx) => x(w.ts) - lx >= gap);
    if (k < 0) k = last.indexOf(Math.min(...last));
    last[k] = x(w.ts);
    return { w, dy: offsets[k] };
  });
}

// The band for a lane: ten-minute totals smoothed over three.
export function band(D, n) {
  const t = D.total[n];
  return t.map((_, i) => ((t[i - 1] ?? t[i]) + 2 * t[i] + (t[i + 1] ?? t[i])) / 4);
}

// Polaris's numbers today, in tally()'s form -> "3 requests · 20 merges · 3 reviews".
export function poleTally(c) {
  const parts = [[c?.requests, "request", "requests"], [c?.merges, "merge", "merges"], [c?.reviews, "review", "reviews"]].filter(([k]) => k > 0).map(([k, a, b]) => plural(k, a, b));
  return parts.length ? parts.join(" · ") : "nothing yet today";
}

// What the Now column says for a row: now (or at the last word), or at a scrubbed column `i`.
// Returns a list of lines; an engineer's also carries `idle` and `state` (drawn as a shape).
const THEIR_OWN = { started: "Their own issue started at", building: "Their own issue started at", review: "Their own pull request has waited since", fixing: "Changes asked on their own pull request at" };
export function moment(D, row, i, tz) {
  const s = D.s;
  if (!s.lastIngest) return [];
  const when = (ts) => clock(ts, tz);
  if (row.kind === "ci") {
    if (i == null) {
      const c = D.ci.at(-1);
      return c ? [`${capital(ciWord(c))}, ${when(c.ts)}`, `in ${ciWhere(c)}`] : ["No runs yet"];
    }
    const list = inBin(D, D.ci, i);
    return list.length ? list.map((c) => `${capital(ciWord(c))} in ${ciWhere(c)}`).slice(0, 2) : ["No runs"];
  }
  const mine = D.work.filter((w) => w.agent === row.id);
  if (row.kind === "pole") {
    // Polaris's last action; the guardians as one count (who did what is in the table, the hover
    // and the scrub readout)
    const guard = D.work.filter((w) => GUARDIANS.includes(w.agent));
    if (i != null) {
      const here = inBin(D, mine, i), g = inBin(D, guard, i);
      return [
        here.length ? `${capital(ACTION_TEXT[here[0].action])}${here.length > 1 ? `, and ${here.length - 1} more` : ""}` : "",
        g.length ? `Guardians: ${g.map((w) => `${w.agent} ${ACTION_TEXT[w.action]}`).join(", ")}` : "",
      ];
    }
    const last = mine.at(-1);
    const per = GUARDIANS.map((n) => [n, guard.filter((w) => w.agent === n).length]).filter(([, k]) => k);
    return [
      last ? `${when(last.ts)} ${ACTION_TEXT[last.action]}` : "",
      per.length ? `Guardians: ${plural(guard.length, "action", "actions")} · ${per.map(([n, k]) => `${n} ${k}`).join(" · ")}` : "Guardians: nothing in 24 hours",
    ];
  }
  if (i == null) {
    const info = s.agents?.[row.id];
    const lane = s.line?.[row.id];
    const live = isActive(info);
    const col = lane?.job ? column(lane, info, D.lastS ?? D.nowS) : null;
    const since = col && (lane.steps?.[col] ?? lane.at);
    // the stage is the lane's own job; an idle lane keeps only a review that waits on others, and
    // someone reviewing a teammate's work has their own job said in plain words
    let own = "";
    if (col === "merged") own = `Merged ${since < D.mid ? "yesterday " : ""}at ${when(since)}`;
    else if (col && !live) own = col === "review" ? `Waiting for review since ${when(since)}` : "";
    else if (col && info.state === "REVIEW") own = `${THEIR_OWN[col]} ${when(col === "building" ? lane.at : since)}`;
    else if (col) own = `${STAGE_NAME[col]} since ${when(since)}`;
    const where = live && info.repo && info.state !== "REVIEW" ? info.repo : "";
    const out = [capital(live && info.repo ? doing(info).replace(` in ${info.repo}`, "") : doing(info)), [where, own].filter(Boolean).join(" · ")];
    out.idle = !live;
    out.state = live ? info.state : null;
    return out;
  }
  const st = stageAt(D, row.id, binTime(D, i) + BIN - 1);
  const b = D.bins[row.id];
  const here = inBin(D, mine, i);
  const pulse = [b.claude[i] && plural(b.claude[i], "Claude request", "Claude requests"), b.chat[i] && plural(b.chat[i], "chat post", "chat posts")].filter(Boolean).join(", ");
  return [here.length ? `${capital(ACTION_TEXT[here.at(-1).action])}${here.length > 1 ? `, and ${here.length - 1} more` : ""}` : pulse ? capital(pulse) : "No activity", st ? STAGE_NAME[st] : ""];
}

// The Now column's heading: "Now", "Last word, 15:53" when the office has gone quiet, or the
// scrubbed ten minutes "10:20–10:30".
export function momentTitle(D, i, offline, tz) {
  if (!D.s.lastIngest) return "";
  if (i != null) return `${clock(binTime(D, i), tz)}–${clock(binTime(D, i) + BIN, tz)}`;
  return offline ? `Last word, ${clock(D.lastS, tz)}` : "Now";
}

// The stages drawn on this day, Started folded into Building (they share a style).
export function stagesDrawn(D) {
  const on = new Set(ENGINEERS.flatMap((n) => D.spans[n].map((sp) => (sp.stage === "started" ? "building" : sp.stage))));
  return ["building", "review", "fixing"].filter((st) => on.has(st));
}

// The key lists only what this day draws, so it never explains a mark that isn't there:
// [{ kind: "band" | "stages" | "merged" | "requested_changes" | "ci-fail", words, stages? }].
export function keyItems(D) {
  const out = [];
  if (ENGINEERS.some((n) => D.total[n].some((k) => k > 0))) out.push({ kind: "band", words: "Claude and chat" });
  const stages = stagesDrawn(D);
  if (stages.length) out.push({ kind: "stages", stages, words: stages.map((st) => STAGE_NAME[st]).join(", ") });
  const marks = new Set(ENGINEERS.flatMap((n) => D.marks[n].map((m) => m.action)));
  if (marks.has("merged")) out.push({ kind: "merged", words: "Merged" });
  if (marks.has("requested_changes")) out.push({ kind: "requested_changes", words: "Changes asked for" });
  if (D.ci.some((c) => c.result === "fail")) out.push({ kind: "ci-fail", words: "CI failed" });
  return out;
}

// "The day as a table": every action and CI run, newest first, in deed()'s words; the three key
// marks keep their glyph (`mark`).
export function tableRows(D) {
  return [
    ...D.work.map((w) => ({ ts: w.ts, who: w.agent, mark: KEY_MARKS.includes(w.action) ? w.action : null, what: deed(w) })),
    ...D.ci.map((c) => ({ ts: c.ts, who: "CI", mark: c.result === "pass" ? null : "ci-fail", what: `${ciWord(c)} in ${ciWhere(c)}` })),
  ].sort((a, b) => b.ts - a.ts);
}

// What the live region says for a scrubbed column, and the slider's aria-valuetext: "11:40 to
// 11:50. Rigel: In review, no activity. Lyra: approved a teammate's pull request."
export function readout(D, i, tz) {
  if (i == null) return "Back to now.";
  const parts = [`${clock(binTime(D, i), tz)} to ${clock(binTime(D, i) + BIN, tz)}.`];
  if (!D.s.lastIngest) return `${parts[0]} Nothing has arrived yet.`;
  for (const n of ENGINEERS) {
    const [what, st] = moment(D, { id: n, kind: "eng" }, i, tz);
    if (what !== "No activity" || st) parts.push(`${n}: ${[st, what.charAt(0).toLowerCase() + what.slice(1)].filter(Boolean).join(", ")}.`);
  }
  for (const w of inBin(D, D.work, i).filter((w) => !ENGINEERS.includes(w.agent))) parts.push(sentence(w));
  for (const c of inBin(D, D.ci, i)) parts.push(`CI ${ciWord(c)} in ${ciWhere(c)}.`);
  if (parts.length === 1) parts.push("Nothing happened.");
  return parts.join(" ");
}

// The columns with an action or a CI run, for [ and ] (the previous or next one).
export function activeBins(D) {
  const set = new Set([...D.work, ...D.ci].map((w) => Math.floor((w.ts - D.t0) / BIN)));
  return [...set].filter((i) => i >= 0 && i < BINS).sort((a, b) => a - b);
}

// A key press on the chart -> the column to scrub to, null for now, or undefined to leave the key
// alone. `at` is the scrubbed column or null; `vertical` is the phone's chart, newest at the top.
export function scrubKey(key, shift, at, D, vertical = false) {
  const cur = at ?? BINS - 1;
  const step = shift ? 6 : 1;
  const back = vertical ? ["ArrowDown", "ArrowLeft"] : ["ArrowLeft", "ArrowDown"];
  const fwd = vertical ? ["ArrowUp", "ArrowRight"] : ["ArrowRight", "ArrowUp"];
  let next;
  if (back.includes(key)) next = cur - step;
  else if (fwd.includes(key)) next = cur + step;
  else if (key === "PageUp") next = cur - 18;
  else if (key === "PageDown") next = cur + 18;
  else if (key === "Home") next = 0;
  else if (key === "End") next = BINS - 1;
  else if (key === "[") next = activeBins(D).filter((i) => i < cur).at(-1) ?? cur;
  else if (key === "]") next = activeBins(D).find((i) => i > cur) ?? cur;
  else if (key === "Escape") return null;
  else return undefined;
  return Math.max(0, Math.min(BINS - 1, next));
}
