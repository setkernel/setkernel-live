// What the Day page (setkernel-live#48, the design in docs/design/v3/day; v5's "The team, right now",
// setkernel-live#94) shows, worked out from the public view and the replay buffer: the 24-hour lanes
// and their stages, the marks, the Now column's words, the key, the table and the scrub readout.
// Pure: no DOM, so it runs under `node --test`; public/lib/chart.js draws what this returns.
// One lane per engineer the feed sends, then CI: no director's lane, and no one's usage (no Claude
// or chat counts), only what they did.
import { CI_RECENT, ENGINEERS, REPLAY_WORK, columnOf, homeMidnight, isRequest } from "./state.js";
import { STAGE_NAME, STARTED_FOR_S, column, seedLanes, stepLines } from "./line.js";
import { ACTION_TEXT, OFFLINE_AFTER_MS, age, ciWhere, ciWord, clock, dayOf as dayFrom, deed, doing, isActive, isSilent } from "./words.js";

export const SPAN = 86_400; // the chart is the last 24 hours
export const BIN = 600; // in ten-minute columns
export const BINS = SPAN / BIN;
// Only three marks carry the story; every other action is words (Now column, readout, table).
export const KEY_MARKS = ["merged", "requested_changes"];
const PULSES = ["claude", "chat", "helper"];

// The lanes: the engineers the feed sends (a state, a lane or a count), in ENGINEERS' order; all
// four before anything has arrived, so the first load has the chart's shape.
export function lanesOf(s) {
  const sent = ENGINEERS.filter((n) => s?.agents?.[n] || s?.line?.[n] || s?.byAgent?.[n] || s?.seen?.[n]);
  return sent.length ? sent : [...ENGINEERS];
}
// The rows, top to bottom: a lane each, a light gap ("sep"), then CI.
export const rowsOf = (D) => [...D.lanes.map((id) => ({ id, kind: "eng" })), { kind: "sep" }, { id: "CI", kind: "ci" }];

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
  const lanes = lanesOf(s);
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

  // what the page shows: the lanes' own actions (the director's reviews still move a lane's stage, above)
  const D = {
    s: s ?? {}, nowS, end, t0, lastS, bins, lanes, ci, spans,
    work: work.filter((w) => lanes.includes(w.agent)),
    // where the data stops: older actions or CI runs were dropped by the caps
    workFrom: (replay?.work ?? []).length >= REPLAY_WORK ? work[0]?.ts ?? null : null,
    ciFrom: (s?.ci ?? []).length >= CI_RECENT && ci.length ? ci[0].ts : null,
    mid: homeMidnight(nowS),
  };
  D.marks = Object.fromEntries(lanes.map((n) => [n, laneMarks(D, n)]));
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

// The lanes of the engineers whose VM stopped reporting (setkernel-live#54): [{ name, lastRun, from,
// to }], lastRun null when the time isn't known. The hatch runs from the last run (or the window's
// start) to now; when the office has gone quiet, to its last word, where the office's own hatch
// takes over. Only while the VM is down: the replay keeps no states, so a past outage isn't drawn.
export function silentLanes(D) {
  if (!D.s.lastIngest) return [];
  const to = (D.nowS - D.lastS) * 1000 > OFFLINE_AFTER_MS ? D.lastS : D.nowS;
  return D.lanes.filter((n) => isSilent(D.s.agents?.[n]))
    .map((name) => { const lastRun = D.s.agents[name].lastRun ?? null; return { name, lastRun, from: Math.max(D.t0, lastRun ?? D.t0), to }; })
    .filter((l) => l.to > l.from);
}

// What the Now column says for a row: now (or at the last word), or at a scrubbed column `i`.
// Returns a list of lines; an engineer's also carries `idle` and `state` (drawn as a shape), and
// `silent` when the VM has stopped reporting (drawn in the signal colour).
const THEIR_OWN = { started: "Their own issue started at", building: "Their own issue started at", review: "Their own pull request has waited since", fixing: "Changes asked on their own pull request at" };
export function moment(D, row, i, tz) {
  const s = D.s;
  if (!s.lastIngest) return [];
  const when = (ts) => clock(ts, tz);
  // a stage can be days old (a lane keeps its job until the next one): say which day, unless today
  const dayOf = (ts) => dayFrom(ts, D.nowS, tz);
  const whenDay = (ts) => `${dayOf(ts)}${when(ts)}`;
  if (row.kind === "ci") {
    if (i == null) {
      const c = D.ci.at(-1);
      return c ? [`${capital(ciWord(c))}, ${when(c.ts)}`, `in ${ciWhere(c)}`] : ["No runs yet"];
    }
    const list = inBin(D, D.ci, i);
    return list.length ? list.map((c) => `${capital(ciWord(c))} in ${ciWhere(c)}`).slice(0, 2) : ["No runs"];
  }
  const mine = D.work.filter((w) => w.agent === row.id);
  const info = s.agents?.[row.id];
  const lastRun = isSilent(info) ? info.lastRun ?? null : null;
  if (i == null && isSilent(info)) {
    // as of the last word, as the column's heading: "Since 14:05 · 2 h 35 min"
    const out = ["Not reporting", lastRun ? `Since ${whenDay(lastRun)} · ${age((D.lastS ?? D.nowS) - lastRun)}` : ""];
    out.idle = false;
    out.state = "SILENT";
    out.silent = true;
    return out;
  }
  if (i == null) {
    const lane = s.line?.[row.id];
    const live = isActive(info);
    const col = lane?.job ? column(lane, info, D.lastS ?? D.nowS) : null;
    const since = col && (lane.steps?.[col] ?? lane.at);
    // the stage is the lane's own job; an idle lane keeps only a review that waits on others, and
    // someone reviewing a teammate's work has their own job said in plain words
    let own = "";
    if (col === "merged") own = `Merged ${dayOf(since)}at ${when(since)}`;
    else if (col && !live) own = col === "review" ? `Waiting for review since ${whenDay(since)}` : "";
    else if (col && info.state === "REVIEW") own = `${THEIR_OWN[col]} ${whenDay(col === "building" ? lane.at : since)}`;
    else if (col) own = `${STAGE_NAME[col]} since ${whenDay(since)}`;
    const where = live && info.repo && info.state !== "REVIEW" ? info.repo : "";
    const out = [capital(live && info.repo ? doing(info).replace(` in ${info.repo}`, "") : doing(info)), [where, own].filter(Boolean).join(" · ")];
    out.idle = !live;
    out.state = live ? info.state : null;
    return out;
  }
  const st = stageAt(D, row.id, binTime(D, i) + BIN - 1);
  const b = D.bins[row.id];
  const here = inBin(D, mine, i);
  // Claude requests and chat posts only say the lane was active then, never how many (usage)
  const active = b.claude[i] > 0 || b.chat[i] > 0;
  // the ten minutes after the last run of a VM that is still down
  if (lastRun && binTime(D, i) >= lastRun) return Object.assign(["Not reporting", st ? STAGE_NAME[st] : ""], { silent: true });
  return [here.length ? `${capital(ACTION_TEXT[here.at(-1).action])}${here.length > 1 ? `, and ${here.length - 1} more` : ""}` : active ? "Active" : "No activity", st ? STAGE_NAME[st] : ""];
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
  const on = new Set(D.lanes.flatMap((n) => D.spans[n].map((sp) => (sp.stage === "started" ? "building" : sp.stage))));
  return ["building", "review", "fixing"].filter((st) => on.has(st));
}

// The key lists only what this day draws, so it never explains a mark that isn't there:
// [{ kind: "stages" | "merged" | "requested_changes" | "ci-fail" | "silent", words, stages? }].
export function keyItems(D) {
  const out = [];
  const stages = stagesDrawn(D);
  if (stages.length) out.push({ kind: "stages", stages, words: stages.map((st) => STAGE_NAME[st]).join(", ") });
  const marks = new Set(D.lanes.flatMap((n) => D.marks[n].map((m) => m.action)));
  if (marks.has("merged")) out.push({ kind: "merged", words: "Merged" });
  if (marks.has("requested_changes")) out.push({ kind: "requested_changes", words: "Changes asked for" });
  if (D.ci.some((c) => c.result === "fail")) out.push({ kind: "ci-fail", words: "CI failed" });
  if (silentLanes(D).length) out.push({ kind: "silent", words: "Not reporting" });
  return out;
}

// "The day as a table": every action on the lanes and CI run, newest first, in deed()'s words; the three key
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
  for (const n of D.lanes) {
    const [what, st] = moment(D, { id: n, kind: "eng" }, i, tz);
    if (what !== "No activity" || st) parts.push(`${n}: ${[st, what.charAt(0).toLowerCase() + what.slice(1)].filter(Boolean).join(", ")}.`);
  }
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
