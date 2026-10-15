// The Day page's pure modules (setkernel-live#48): public/lib/day.js (lanes, stages, marks, the Now
// column's words, the key, the table, scrubbing) and public/lib/layout.js (the page's modes, the
// hour rules and fitWall). Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { ENGINEERS, cleanEvent } from "../src/logic.js";
import { BIN, BINS, activeBins, chartWindow, keyItems, moment, momentTitle, poleTally, prep, readout, scrubKey, tableRows } from "../public/lib/day.js";
import { GRID, WALL, fitWall, hourRules, labelFits, pageMode } from "../public/lib/layout.js";
import { busyDay, quietDay, runDay } from "../public/lib/demo.js";

const TZ = "America/Halifax";
const NOW = Date.UTC(2026, 9, 14, 19, 40) / 1000; // Wednesday 14 October 2026, 16:40 ADT
const adt = (h, m) => NOW - (16 * 60 + 40 - (h * 60 + m)) * 60; // today on the Halifax clock
const gh = (agent, action, ts, repo) => ({ t: "msg", kind: "github", agent, action, ...(repo ? { repo } : {}), ts });
const claude = (agent, ts) => ({ t: "msg", kind: "claude", agent, ts });
const idle = () => Object.fromEntries(ENGINEERS.map((n) => [n, { state: "IDLE" }]));

// A day from a list of events and the agents' states at the end, through the real reducers, one
// batch a minute, as the Durable Object would have built it.
function day(events, agents = idle(), until = NOW) {
  for (const e of events) assert.deepEqual(cleanEvent(e), e, JSON.stringify(e));
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const batches = [];
  let i = 0;
  for (let t = NOW - 86_400 - 3600 + 60; t <= until; t += 60) {
    const evs = [];
    while (i < sorted.length && sorted[i].ts < t) evs.push(sorted[i++]);
    batches.push({ at: t, events: evs, agents: t >= until - 60 ? agents : idle() });
  }
  const { state, replay } = runDay(batches);
  return prep(state, replay, until);
}
const stages = (D, n) => D.spans[n].map((sp) => [sp.stage, sp.from, sp.to]);

test("the chart's window: 24 hours of ten-minute columns ending on a ten-minute boundary", () => {
  assert.deepEqual(chartWindow(NOW), { nowS: NOW, end: NOW, t0: NOW - 86_400 });
  const w = chartWindow(NOW + 61);
  assert.equal(w.end, NOW + 600);
  assert.equal(w.end - w.t0, 86_400);
  assert.equal(BINS * BIN, 86_400);
});

test("lanes: a job's stages from its events, Building, In review, Fixing, back to review, merged", () => {
  const D = day([
    gh("Orion", "picked_up", adt(9, 12), "setkernel-live"),
    claude("Orion", adt(9, 13)),
    gh("Orion", "opened_pr", adt(10, 31), "setkernel-live"),
    gh("Lyra", "requested_changes", adt(11, 0), "setkernel-live"),
    gh("Orion", "pushed", adt(11, 30), "setkernel-live"),
    gh("Lyra", "approved", adt(11, 41), "setkernel-live"),
    gh("Orion", "merged", adt(14, 2), "setkernel-live"),
  ]);
  assert.deepEqual(stages(D, "Orion"), [
    ["started", adt(9, 12), adt(9, 13)],
    ["building", adt(9, 13), adt(10, 31)],
    ["review", adt(10, 31), adt(11, 0)],
    ["fixing", adt(11, 0), adt(11, 30)],
    ["review", adt(11, 30), adt(14, 2)],
  ], "the line ends at the merge");
  // marks on the author's lane: ✕ where Fixing begins, naming the reviewer, and ● the merge
  const marks = D.marks.Orion.map((m) => [m.action, m.ts]);
  assert.deepEqual(marks, [["requested_changes", adt(11, 0)], ["merged", adt(14, 2)]]);
  assert.match(D.marks.Orion[0].title, /^Lyra asked for changes on a teammate's pull request in setkernel-live, /);
  assert.deepEqual(D.marks.Lyra, [], "the reviewer's side of it is words");
  assert.deepEqual(stages(D, "Vega"), [], "nothing happened: no line");
});

test("lanes: an idle lane's Building stops at its last sign of work; a review waiting on others runs to now", () => {
  const D = day([
    gh("Vega", "picked_up", adt(13, 0)), claude("Vega", adt(13, 5)), claude("Vega", adt(13, 40)),
    gh("Rigel", "picked_up", adt(8, 0)), claude("Rigel", adt(8, 1)), gh("Rigel", "opened_pr", adt(9, 0)),
  ]);
  assert.deepEqual(stages(D, "Vega").at(-1), ["building", adt(13, 5), adt(13, 41)]);
  assert.deepEqual(stages(D, "Rigel").at(-1), ["review", adt(9, 0), NOW]);
  // working now: Building runs to the edge
  const W = day([gh("Vega", "picked_up", adt(13, 0)), claude("Vega", adt(13, 5))], { ...idle(), Vega: { state: "WORKING", work: "issue" } });
  assert.deepEqual(stages(W, "Vega").at(-1), ["building", adt(13, 5), NOW]);
});

test("lanes: a job begun before the 24 hours starts the lane in its stage (seedLanes)", () => {
  const D = day([gh("Lyra", "picked_up", NOW - 90_000), claude("Lyra", NOW - 89_000), gh("Lyra", "opened_pr", NOW - 88_000)]);
  assert.deepEqual(stages(D, "Lyra"), [["review", NOW - 86_400, NOW]]);
  assert.equal(D.spans.Lyra[0].seeded, true);
});

test("the Now column: what each lane is doing, then where and its own stage since when", () => {
  const D = day([
    gh("Vega", "picked_up", adt(14, 30), "setkernel-live"), claude("Vega", adt(14, 38)),
    gh("Orion", "picked_up", adt(14, 0)), claude("Orion", adt(14, 1)), gh("Orion", "opened_pr", adt(15, 22)),
    gh("Rigel", "picked_up", adt(9, 0)), claude("Rigel", adt(9, 1)), gh("Rigel", "opened_pr", adt(10, 0), "hq-site"),
    gh("Lyra", "picked_up", NOW - 86_400 + 600), claude("Lyra", NOW - 86_400 + 660), gh("Lyra", "opened_pr", NOW - 86_400 + 1200),
    gh("Lyra", "merged", adt(0, 0) - 30 * 60),
  ], {
    Vega: { state: "WORKING", work: "issue", repo: "setkernel-live" },
    Orion: { state: "REVIEW", work: "review" },
    Rigel: { state: "IDLE" },
    Lyra: { state: "IDLE" },
  });
  const say = (id) => { const l = moment(D, { id, kind: "eng" }, null, TZ); return [l[0], l[1], l.idle, l.state]; };
  assert.deepEqual(say("Vega"), ["Working on an issue", "setkernel-live · Building since 14:32", false, "WORKING"], "Building two minutes after the pick-up, as the live line has it");
  // the reviewer's own pull request, in plain words, not "In review" beside "Reviewing"
  assert.deepEqual(say("Orion"), ["Reviewing a pull request", "Their own pull request has waited since 15:22", false, "REVIEW"]);
  // idle: only a review that waits on others, said as waiting
  assert.deepEqual(say("Rigel"), ["Idle", "Waiting for review since 10:00", true, null]);
  assert.deepEqual(say("Lyra"), ["Idle", "Merged yesterday at 23:30", true, null]);
  assert.equal(momentTitle(D, null, false, TZ), "Now");
  assert.equal(momentTitle(D, null, true, TZ), "Last word, 16:40");
  assert.equal(momentTitle(D, 106, false, TZ), "10:20–10:30");
});

test("the Now column: Polaris's last action and the guardians as one count; CI's last run", () => {
  const D = day([
    gh("Kochab", "opened_pr", adt(9, 0)), gh("Kochab", "merged", adt(9, 30)), gh("Pherkad", "opened_pr", adt(10, 0)),
    gh("Polaris", "merged_by", adt(9, 30)), gh("Polaris", "approved", adt(15, 58), "setkernel-live"),
    { t: "msg", kind: "ci", result: "fail", repo: "setkernel-live", ts: adt(16, 30) },
  ]);
  assert.deepEqual(moment(D, { id: "Polaris", kind: "pole" }, null, TZ), ["15:58 approved a teammate's pull request", "Guardians: 3 actions · Kochab 2 · Pherkad 1"]);
  assert.deepEqual(moment(D, { id: "CI", kind: "ci" }, null, TZ), ["Failed, 16:30", "in setkernel-live"]);
  const i = Math.floor((adt(9, 30) - D.t0) / BIN);
  assert.deepEqual(moment(D, { id: "Polaris", kind: "pole" }, i, TZ), ["Merged a pull request", "Guardians: Kochab had a pull request merged"]);
  assert.equal(poleTally(D.s.byAgent.Polaris), "1 merge · 1 review");
  assert.equal(poleTally(undefined), "nothing yet today");
  // nothing has arrived: the column is empty
  assert.deepEqual(moment(prep({}, {}, NOW), { id: "Vega", kind: "eng" }, null, TZ), []);
});

test("scrubbed: that ten minutes' actions or counts, and the stage then", () => {
  const D = day([gh("Orion", "picked_up", adt(9, 12)), claude("Orion", adt(9, 13)), claude("Orion", adt(9, 14)), gh("Orion", "opened_pr", adt(10, 31))]);
  const at = (h, m) => Math.floor((adt(h, m) - D.t0) / BIN);
  assert.deepEqual(moment(D, { id: "Orion", kind: "eng" }, at(9, 10), TZ).slice(0, 2), ["Started on an issue", "Building"]);
  assert.deepEqual(moment(D, { id: "Orion", kind: "eng" }, at(9, 50), TZ).slice(0, 2), ["No activity", "Building"]);
  assert.deepEqual(moment(D, { id: "Orion", kind: "eng" }, at(10, 30), TZ).slice(0, 2), ["Opened a pull request", "In review"]);
  assert.equal(readout(D, at(10, 30), TZ), "10:30 to 10:40. Orion: In review, opened a pull request.");
  assert.equal(readout(D, at(3, 0), TZ), "03:00 to 03:10. Nothing happened.");
  assert.equal(readout(D, null, TZ), "Back to now.");
  assert.equal(readout(prep({}, {}, NOW), 3, TZ), "17:10 to 17:20. Nothing has arrived yet.");
});

test("the key lists only what the day draws", () => {
  const kinds = (D) => keyItems(D).map((k) => k.kind);
  assert.deepEqual(keyItems(prep({}, {}, NOW)), [], "waiting: nothing drawn, no key");
  // the quiet day: no change was asked for, so no ✕ in the key
  const q = runDay(quietDay(NOW).batches);
  const Q = prep(q.state, q.replay, NOW);
  assert.deepEqual(kinds(Q), ["band", "stages", "merged", "ci-fail"]);
  assert.deepEqual(keyItems(Q)[1], { kind: "stages", stages: ["building", "review"], words: "Building, In review" });
  // the busy day draws all five
  const b = runDay(busyDay(NOW).batches);
  const B = prep(b.state, b.replay, NOW);
  assert.deepEqual(kinds(B), ["band", "stages", "merged", "requested_changes", "ci-fail"]);
  assert.equal(keyItems(B)[1].words, "Building, In review, Fixing");
  // a pass alone draws a quiet tick, which has no key entry
  const P = day([{ t: "msg", kind: "ci", result: "pass", ts: adt(12, 0) }]);
  assert.deepEqual(kinds(P), []);
});

test("caps: hatched from where the replay's actions or the recent CI runs stop", () => {
  const b = runDay(busyDay(NOW).batches);
  const B = prep(b.state, b.replay, NOW);
  assert.equal(B.workFrom, null, "a busy day's actions fit the 300 cap");
  assert.ok(B.ciFrom > B.t0, "only the last 20 CI runs are kept");
  assert.equal(B.ci.length, 20);
});

test("the table: every action and CI run, newest first; only the key's marks carry a glyph", () => {
  const D = day([
    gh("Orion", "opened_pr", adt(10, 31), "setkernel-live"), gh("Orion", "merged", adt(14, 2), "setkernel-live"),
    { t: "msg", kind: "ci", result: "fail", ts: adt(10, 32) },
  ]);
  assert.deepEqual(tableRows(D), [
    { ts: adt(14, 2), who: "Orion", mark: "merged", what: "had a pull request merged in setkernel-live" },
    { ts: adt(10, 32), who: "CI", mark: "ci-fail", what: "failed in a private project" },
    { ts: adt(10, 31), who: "Orion", mark: null, what: "opened a pull request in setkernel-live" },
  ]);
});

test("scrubbing keys: ten minutes, an hour, three hours, the ends, the next action, and back to now", () => {
  const D = day([gh("Orion", "picked_up", adt(9, 12)), gh("Orion", "opened_pr", adt(10, 31))]);
  const last = BINS - 1;
  assert.equal(scrubKey("ArrowLeft", false, null, D), last - 1);
  assert.equal(scrubKey("ArrowLeft", true, null, D), last - 6, "Shift: an hour");
  assert.equal(scrubKey("ArrowRight", false, last, D), last, "never past now");
  assert.equal(scrubKey("PageUp", false, 50, D), 32);
  assert.equal(scrubKey("Home", false, 50, D), 0);
  assert.equal(scrubKey("End", false, 50, D), last);
  assert.equal(scrubKey("Escape", false, 50, D), null);
  assert.equal(scrubKey("a", false, 50, D), undefined, "other keys are left alone");
  const [first, second] = activeBins(D);
  assert.equal(scrubKey("[", false, null, D), second);
  assert.equal(scrubKey("[", false, second, D), first);
  assert.equal(scrubKey("[", false, first, D), first, "nothing earlier: stay");
  assert.equal(scrubKey("]", false, 0, D), first);
  // the phone's chart runs down the page, newest at the top: up is later
  assert.equal(scrubKey("ArrowUp", false, 50, D, true), 51);
  assert.equal(scrubKey("ArrowDown", false, 50, D, true), 49);
});

test("fitWall: the 1440 x 810 canvas scaled whole and centred, filling every 16:9 screen", () => {
  assert.deepEqual(WALL, { w: 1440, h: 810 });
  for (const [w, h, k] of [[1920, 1080, 4 / 3], [2560, 1440, 16 / 9], [1440, 810, 1], [3840, 2160, 8 / 3]]) {
    const f = fitWall(w, h);
    assert.ok(Math.abs(f.k - k) < 1e-9, `${w}x${h}: ${f.k}`);
    assert.ok(Math.abs(f.x) < 1e-9 && Math.abs(f.y) < 1e-9, `${w}x${h} is filled edge to edge`);
  }
  // another shape: the largest size that fits, centred, with bars on two sides, never clipped
  const tall = fitWall(1280, 1024);
  assert.equal(tall.k, 1280 / 1440);
  assert.equal(tall.x, 0);
  assert.equal(tall.y, (1024 - 810 * tall.k) / 2);
  const wide = fitWall(2560, 1080);
  assert.equal(wide.k, 1080 / 810);
  assert.equal(wide.y, 0);
  assert.ok(wide.x > 0 && wide.x * 2 + 1440 * wide.k === 2560);
  for (const [w, h] of [[800, 600], [1366, 768], [1024, 1366], [5120, 1440]]) {
    const f = fitWall(w, h);
    assert.ok(f.x >= 0 && f.y >= 0 && f.x + 1440 * f.k <= w + 1e-9 && f.y + 810 * f.k <= h + 1e-9, `${w}x${h} fits`);
  }
});

test("page modes: the phone below 720 px, the Now list above the chart below 1232, the wall whatever its size", () => {
  assert.equal(pageMode(375), "narrow");
  assert.equal(pageMode(719), "narrow");
  assert.equal(pageMode(720), "medium");
  assert.equal(pageMode(1024), "medium");
  assert.equal(pageMode(1440), "wide");
  assert.equal(pageMode(375, true), "wall");
  // wide: the name gutter, the Now column and the gaps leave the 24 hours at least 480 px
  assert.ok(1232 - 2 * 48 - GRID.gutL - GRID.gutR - 2 * GRID.gap >= 480);
});

test("hour rules: Halifax midnight is Today, then every third hour of the Halifax day", () => {
  const { t0 } = chartWindow(NOW);
  const mid = adt(0, 0);
  const rules = hourRules(t0, NOW, mid);
  assert.ok(rules.some((r) => r.mid && r.ts === mid));
  assert.equal(rules.filter((r) => r.mid).length, 1);
  const hours = rules.map((r) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(new Date(r.ts * 1000)));
  assert.deepEqual(hours, ["18", "21", "00", "03", "06", "09", "12", "15"]);
  // labels keep clear of "Yesterday" and "Today · 00:00 ADT", and of the now label
  assert.equal(labelFits(400, 500, 900), false);
  assert.equal(labelFits(380, 500, 900), true);
  assert.equal(labelFits(650, 500, 900), false);
  assert.equal(labelFits(870, 500, 900), false);
});
