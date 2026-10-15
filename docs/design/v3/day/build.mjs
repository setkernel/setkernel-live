// Builds the fixtures for the Day prototype and writes them, with the page's wording (words.js),
// the stages (line.js) and the fonts, into index.html, so the page opens from disk with no server.
// Every event goes through the real cleanEvent first and must come out unchanged; the state and
// the replay are built by the real applyBatch and recordReplay. Run from the repo root:
//   node docs/design/v3/day/build.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { deepStrictEqual } from "node:assert";
import { cleanEvent, cleanBatch } from "../../../../src/logic.js";
import { applyBatch, emptyReplay, emptyState, recordReplay, ENGINEERS } from "../../../../public/lib/state.js";
import { createDemo } from "../../../../public/lib/demo.js";

const here = new URL(".", import.meta.url);
const root = new URL("../../../../", import.meta.url);

// The page's clock stops here: Wednesday 14 October 2026, 16:40 in Halifax (ADT, UTC-3).
const NOW = Date.UTC(2026, 9, 14, 19, 40, 0) / 1000;
const DAY_START = NOW - 86_400;
const OFFLINE_AT = NOW - 47 * 60; // the office stopped reporting at 15:53
// "Today" is the Halifax day (hq#177, question 5): applyBatch's day key is the Halifax date, so
// the counts reset at midnight ADT. October is ADT all month.
const halifaxDay = (s) => Math.floor((s - 3 * 3600) / 86_400);

// Run batches ({ at, events, agents }) through the allowlist and the real reducers; snapshot
// the public view at each time in `at`.
function run(batches, snapshots) {
  let state = emptyState(halifaxDay(DAY_START));
  let replay = emptyReplay();
  const out = {};
  const take = (t) => ({ ...state, now: t });
  const todo = [...snapshots].sort((a, b) => a - b);
  for (const b of batches) {
    while (todo.length && todo[0] < b.at) { const t = todo.shift(); out[t] = { state: take(t), replay }; }
    for (const e of b.events) deepStrictEqual(cleanEvent(e), e, `not clean: ${JSON.stringify(e)}`);
    const clean = cleanBatch({ events: b.events, agents: b.agents });
    deepStrictEqual(clean.agents, b.agents, "agent states must pass the allowlist unchanged");
    state = applyBatch(state, clean, b.at * 1000, halifaxDay(b.at));
    replay = recordReplay(replay, clean, b.at * 1000);
  }
  for (const t of todo) out[t] = { state: take(t), replay };
  return out;
}

// The busy day: the real demo, slowed to a quarter of its speed. At its own speed the demo makes
// about 800 GitHub actions a day and the replay's 300-action cap keeps only the last 9 hours; a
// quarter is about 200 a day, the real team's busy day (state.js: "a busy day is under 200").
// Only the times change: every event is the demo's own.
// The demo names one made-up repo, "example-site". The page shows only what a visitor could check, so
// in the fixtures it is a private project, as the demo's other repo-less jobs already are.
const noExample = (o) => {
  const walk = (v) => (v && v.repo === "example-site" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "repo")) : v);
  return o.repo !== undefined || o.t ? walk(o) : Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v)]));
};
function busyBatches() {
  const SLOW = 4;
  const demoStart = 1_800_000_000;
  const demo = createDemo(17, demoStart);
  const out = [];
  for (let t = DAY_START + 60; t <= NOW; t += 60) {
    const { events, agents } = demo.advance(demoStart + (t - DAY_START) / SLOW);
    out.push({ at: t, agents: noExample(agents), events: events.map((e) => ({ ...noExample(e), ts: DAY_START + (e.ts - demoStart) * SLOW })) });
  }
  return out;
}

// The quiet day, written by hand: one job all day (Orion's, reviewed by Lyra, merged by Polaris
// at 14:02), Rigel's job from yesterday evening, which was reviewed by Orion and merged before
// midnight, and one request. Rigel, Vega and the three Claudes do nothing today, so "nothing yet
// today" is true for them and no review is left open across the day. Nothing is added to fill the lanes (hq#177: "they must not be padded").
// `live` adds Vega picking up an issue at 16:31, for the live mood on a quiet day.
function quietBatches(live) {
  const adt = (h, m) => Date.UTC(2026, 9, 14, h + 3, m) / 1000; // Halifax time today
  const yday = (h, m) => adt(h, m) - 86_400;
  const ev = [];
  const gh = (agent, action, repo, ts) => ev.push({ t: "msg", kind: "github", agent, action, ...(repo ? { repo } : {}), ts });
  const pulses = (agent, kind, from, to, every) => { for (let t = from; t < to; t += every) ev.push({ t: "msg", kind, agent, ts: t }); };
  // yesterday evening: Rigel's pull request in a private repo
  gh("Rigel", "picked_up", null, yday(17, 4));
  pulses("Rigel", "claude", yday(17, 5), yday(19, 18), 70);
  pulses("Rigel", "helper", yday(17, 30), yday(19, 0), 900);
  gh("Rigel", "opened_pr", null, yday(19, 20));
  ev.push({ t: "msg", kind: "ci", result: "pass", ts: yday(19, 20) });
  pulses("Orion", "claude", yday(20, 22), yday(20, 34), 60);
  gh("Orion", "approved", null, yday(20, 35));
  gh("Rigel", "merged", null, yday(20, 50));
  gh("Polaris", "merged_by", null, yday(20, 50));
  // this morning: Polaris asks, Orion builds it, Lyra reviews, Polaris merges after lunch
  ev.push({ t: "msg", kind: "request", agent: "Polaris", action: "opened_issue", repo: "setkernel-live", ts: adt(8, 50) });
  gh("Orion", "picked_up", "setkernel-live", adt(9, 12));
  pulses("Orion", "claude", adt(9, 13), adt(10, 29), 45);
  pulses("Orion", "helper", adt(9, 40), adt(10, 20), 600);
  pulses("Orion", "chat", adt(9, 15), adt(9, 16), 60);
  gh("Orion", "opened_pr", "setkernel-live", adt(10, 31));
  ev.push({ t: "msg", kind: "ci", result: "fail", repo: "setkernel-live", ts: adt(10, 31) });
  pulses("Orion", "claude", adt(10, 33), adt(10, 47), 50);
  gh("Orion", "pushed", "setkernel-live", adt(10, 48));
  ev.push({ t: "msg", kind: "ci", result: "pass", repo: "setkernel-live", ts: adt(10, 48) });
  pulses("Lyra", "claude", adt(11, 30), adt(11, 41), 40);
  pulses("Lyra", "chat", adt(11, 41), adt(11, 42), 60);
  gh("Lyra", "approved", "setkernel-live", adt(11, 41));
  gh("Orion", "merged", "setkernel-live", adt(14, 2));
  gh("Polaris", "merged_by", "setkernel-live", adt(14, 2));
  if (live) {
    gh("Vega", "picked_up", null, adt(16, 31));
    pulses("Vega", "claude", adt(16, 32), adt(16, 40), 35);
  }
  ev.sort((a, b) => a.ts - b.ts);
  // agent states as they were: Orion working 09:12-10:48, Lyra reviewing 11:30-11:41, Vega from 16:31
  const at = (t) => {
    const a = Object.fromEntries(ENGINEERS.map((n) => [n, { state: "IDLE" }]));
    if (t >= yday(20, 22) && t < yday(20, 36)) a.Orion = { state: "REVIEW", work: "review" };
    if (t >= adt(9, 12) && t < adt(10, 49)) a.Orion = { state: "WORKING", work: "issue", repo: "setkernel-live" };
    if (t >= adt(11, 30) && t < adt(11, 42)) a.Lyra = { state: "REVIEW", work: "review", repo: "setkernel-live" };
    if (live && t >= adt(16, 31)) a.Vega = { state: "WORKING", work: "issue" };
    return a;
  };
  const out = [];
  let i = 0;
  for (let t = DAY_START - 3600 + 60; t <= NOW; t += 60) {
    const events = [];
    while (i < ev.length && ev[i].ts < t) events.push(ev[i++]);
    out.push({ at: t, agents: at(t), events });
  }
  return out;
}

const pick = ({ state, replay }) => {
  const { agents, counts, byAgent, seen, line, feed, ci, lastIngest, now } = state;
  return { agents, counts, byAgent, seen, line, feed, ci, lastIngest, now, replay };
};
const busy = run(busyBatches(), [OFFLINE_AT, NOW]);
const quiet = run(quietBatches(false), [OFFLINE_AT, NOW]);
const quietLive = run(quietBatches(true), [NOW]);
const fixtures = {
  now: NOW,
  busy: { live: pick(busy[NOW]), offline: pick(busy[OFFLINE_AT]) },
  quiet: { live: pick(quietLive[NOW]), quiet: pick(quiet[NOW]), offline: pick(quiet[OFFLINE_AT]) },
};
// The quiet mood on the busy day is the same day with every engineer between tasks: the state
// the page gets when nobody is active, so headline() says "quiet".
fixtures.busy.quiet = { ...fixtures.busy.live, agents: Object.fromEntries(ENGINEERS.map((n) => [n, { state: "IDLE" }])) };

// The page's wording and stages, inlined: a page opened from disk can't import modules.
const strip = (src) => src.replace(/^import .*$/gm, "").replace(/^export \{[^}]*\}.*$/gm, "").replace(/^export /gm, "");
const lib = [
  `const AGENTS = ${JSON.stringify(["Vega", "Rigel", "Lyra", "Orion", "Polaris", "Kochab", "Pherkad", "Yildun"])};`,
  "// ---- public/lib/line.js, verbatim but for import and export",
  strip(readFileSync(new URL("public/lib/line.js", root), "utf8")),
  "// ---- public/lib/words.js, verbatim but for import and export",
  strip(readFileSync(new URL("public/lib/words.js", root), "utf8")),
].join("\n");

const font = (file) => readFileSync(new URL(`public/fonts/${file}`, root)).toString("base64");
const faces = [["Manrope", 400, "manrope-latin-400-normal"], ["Manrope", 600, "manrope-latin-600-normal"], ["IBM Plex Mono", 400, "ibm-plex-mono-latin-400-normal"]]
  .map(([family, weight, file]) => `@font-face{font-family:"${family}";font-weight:${weight};font-style:normal;font-display:block;src:url(data:font/woff2;base64,${font(`${file}.woff2`)}) format("woff2")}`)
  .join("\n");

const page = new URL("index.html", here);
let html = readFileSync(page, "utf8");
const put = (name, body) => {
  const re = new RegExp(`(/\\* ${name} \\*/)[\\s\\S]*?(/\\* end ${name} \\*/)`);
  if (!re.test(html)) throw new Error(`index.html has no ${name} block`);
  html = html.replace(re, (_, a, b) => `${a}\n${body}\n${b}`);
};
put("fonts", faces);
put("lib", lib);
put("fixtures", `const FIXTURES = ${JSON.stringify(fixtures)};`);
writeFileSync(page, html);
const n = (f) => `${f.replay.work.length} actions, ${f.replay.pulses.length} minute rows, ${f.ci.length} CI runs kept`;
console.log(`busy: ${n(fixtures.busy.live)}; quiet: ${n(fixtures.quiet.quiet)}; index.html ${Math.round(html.length / 1024)} KiB`);
