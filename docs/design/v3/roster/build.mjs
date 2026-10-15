// Builds docs/design/v3/roster/index.html (setkernel-live#44): the Roster prototype, as one file that
// opens from disk with no server and no network. Run from the repo root:
//   node docs/design/v3/roster/build.mjs
//
// The fixtures are not hand-written. The page's own demo (public/lib/demo.js) runs through the same
// reducer as the Durable Object (applyBatch, recordReplay, view in public/lib/state.js), every
// event checked against the Worker's allowlist (cleanEvent in src/logic.js) on the way. Each row is
// then worded here, ahead of time, with the live page's own functions (words.js, line.js), so the
// prototype says exactly what the live page would. The page itself only lays the words out.
//
// One change from the live page, to show the recommendation in hq#177: "today" runs on the Halifax
// day (applyBatch is given the Halifax date as its day), not the UTC one.

import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEvent } from "../../../../src/logic.js";
import { createDemo } from "../../../../public/lib/demo.js";
import { ENGINEERS, POLE, applyBatch, emptyReplay, emptyState, recordReplay, view } from "../../../../public/lib/state.js";
import { STAGE_NAME, column, steps } from "../../../../public/lib/line.js";
import { STATE_WORDS, clock, deed, doing, headline, isActive, plain, tally, whereWork, ciWord, ciWhere, zoneName } from "../../../../public/lib/words.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../../..");
const TZ = "America/Halifax";
const BATCH_S = 5; // sk-obs01 sends a batch every 5 s (hq observability/wall/public.py INTERVAL)

const halifaxDay = (s) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(s * 1000));
const utc = (h, m) => Date.UTC(2026, 9, 15, h, m) / 1000; // 15 Oct 2026; Halifax is UTC-3 (ADT)

// ---- the simulation: every 5 s batch through cleanEvent, applyBatch and recordReplay, with a copy
// of the state kept each minute so the fixtures can pick their moments afterwards.
function simulate({ seed, fromS, toS, keep = () => true, quietAfterS = Infinity }) {
  const demo = createDemo(seed, fromS);
  let state = emptyState(halifaxDay(fromS));
  let replay = emptyReplay();
  const minutes = new Map(); // minute start (s) -> { state, replay }
  for (let t = fromS + BATCH_S; t <= toS; t += BATCH_S) {
    const raw = demo.advance(t);
    let events = raw.events.filter((e) => keep(e.ts));
    let agents = raw.agents;
    if (t > quietAfterS) {
      // the quiet day: the office still reports in, but nobody is working
      events = [];
      agents = Object.fromEntries(ENGINEERS.map((n) => [n, { state: "IDLE" }]));
    }
    for (const e of events) {
      const clean = cleanEvent(e);
      if (!isDeepStrictEqual(clean, e)) throw new Error(`demo event changed by cleanEvent: ${JSON.stringify(e)}`);
    }
    const batch = { events, agents };
    state = applyBatch(state, batch, t * 1000, halifaxDay(t));
    replay = recordReplay(replay, batch, t * 1000);
    if (t % 60 === 0) minutes.set(t, { state, replay });
  }
  return minutes;
}

// ---- wording: one snapshot of view() -> what each region of the page says.

const pad = (n) => String(n).padStart(2, "0");
function span(s) {
  const m = Math.max(0, Math.floor(s / 60));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${pad(m % 60)} min`;
}
const at = (ts) => clock(ts, TZ);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// What follows the state word on a row: the words.js phrase without the verb the state word
// already says ("working on an issue" after "Working" is "on an issue").
function detail(info) {
  if (!isActive(info)) return "";
  const words = doing({ ...info, repo: undefined });
  const verb = STATE_WORDS[info.state].toLowerCase();
  if (info.state === "DISCUSS") return "in the team chat"; // "Discussing in a design discussion" says it twice
  return words.startsWith(`${verb} `) ? words.slice(verb.length + 1) : words;
}

function engineerRow(name, v, nowS, mood) {
  const info = v.agents?.[name];
  const lane = v.line?.[name];
  const today = v.byAgent?.[name];
  if (mood === "waiting") return { name, state: "NONE", word: "No report yet", detail: "", where: "", stage: null, time: "", since: "", today: "" };
  // offline: the rows are as the office last reported them, so time is counted to that report
  if (mood === "offline") nowS = Math.trunc(v.lastIngest / 1000);
  const st = STATE_WORDS[info?.state] ? info.state : "IDLE";
  const col = lane?.job || isActive(info) ? column(lane, info, nowS) : null;
  const track = col ? steps(lane, col) : null;
  let where = "";
  if (isActive(info)) where = info.state === "DISCUSS" ? "" : info.repo || "a private project";
  else if (lane?.job) where = lane.repo || "a private project";
  // Time in that state: an active engineer, since its stage began (line.js keeps when each step was
  // reached); an idle one, since it last did anything (state.seen). The state itself keeps no start time.
  let since = null;
  if (isActive(info)) since = track?.find((s) => s.status === "now")?.ts ?? v.seen?.[name] ?? null;
  else since = v.seen?.[name] ?? null;
  const idleNote = !isActive(info) && lane?.job ? { review: "pull request open", merged: "last pull request merged", started: "issue picked up" }[lane.job] : "";
  return {
    name,
    state: st,
    word: STATE_WORDS[st],
    detail: isActive(info) ? detail(info) : idleNote ?? "",
    where,
    stage: col ? { word: STAGE_NAME[col], track: track.map((s) => s.status), times: track.map((s) => (s.ts ? at(s.ts) : "")) } : null,
    time: since ? span(nowS - since) : "",
    since: since ? at(since) : "",
    today: tally(today),
  };
}

function lastOf(feed, agent) {
  const e = feed.find((f) => f.agent === agent);
  return e ? { time: at(e.ts), text: cap(deed(e)) } : null;
}

function poleRows(v) {
  const c = (n) => v.byAgent?.[n] ?? {};
  const p = c("Polaris");
  const polaris = {
    name: "Polaris",
    note: "the director",
    today: [plural(p.requests ?? 0, "request"), plural(p.merges ?? 0, "merge"), plural(p.reviews ?? 0, "review")].join(" · "),
    last: lastOf(v.feed, "Polaris"),
  };
  const subs = POLE.slice(1).map((name) => {
    const k = c(name);
    const bits = [];
    if (k.prs) bits.push(plural(k.prs, "PR"));
    if (k.requests) bits.push(plural(k.requests, "request"));
    if (k.claude) bits.push(`${k.claude} Claude`);
    // the feed keeps the latest 30 actions, so a star that did something earlier has no line of its own
    return { name, today: bits.join(" · "), last: lastOf(v.feed, name) ?? { time: "", text: bits.length ? "Earlier today" : "Nothing yet today", dim: true } };
  });
  return { polaris, subs };
}

// The log: the feed's GitHub actions and requests, with the test runs between them, newest first.
function log(v, n = 14) {
  const work = (v.feed ?? []).map((e) => ({ ts: e.ts, name: e.agent, text: ` ${deed(e)}.` }));
  const ci = (v.ci ?? []).map((r) => ({ ts: r.ts, name: "", text: `Tests ${ciWord(r)} in ${ciWhere(r)}.` }));
  return [...work, ...ci].sort((a, b) => b.ts - a.ts).slice(0, n).map((e) => ({ time: at(e.ts), name: e.name, text: e.text }));
}

function strip(v) {
  const today = halifaxDay(v.now / 1000);
  return (v.hours ?? []).map((h, i, all) => {
    const s = h.h * 3600;
    const hour = Number(at(s).slice(0, 2));
    return { hour, claude: h.claude, github: h.github, today: halifaxDay(s) === today, now: i === all.length - 1 };
  });
}

function snapshot(v, mood) {
  const nowS = Math.trunc(v.now / 1000);
  const zone = zoneName(nowS, TZ);
  const h = headline({ ...v, timeZone: TZ, names: ENGINEERS });
  let head, sub;
  if (mood === "live") {
    head = plain(h.forms[2]); // the count form: the rows below carry the rest
    // not words.js's "Latest" line: the log under the rows already starts with it
    const c = v.counts;
    sub = `Today so far: ${plural(c.prs, "pull request")} opened, ${c.merged} merged and ${c.claude.toLocaleString("en-US")} Claude requests.`;
  } else if (mood === "quiet") {
    head = plain(h.forms[2]);
    const lastSeen = Math.max(0, ...ENGINEERS.map((n) => v.seen?.[n] ?? 0));
    const merge = (v.feed ?? []).find((e) => e.action === "merged");
    // Lyra's quiet line from hq#177: "Quiet since 14:02. Last merge: Orion, setkernel-live."
    sub = `Quiet since ${at(lastSeen)}.${merge ? ` Last merge: ${merge.agent}, ${whereWork(merge)}, at ${at(merge.ts)}.` : ""}`;
  } else {
    head = plain(h.forms[0]);
    sub = plain(h.latest);
  }
  const fresh = mood === "waiting" ? "No report yet"
    : mood === "offline" ? `Last report ${at(v.lastIngest)} ${zone}, ${span(nowS - v.lastIngest / 1000)} ago`
      : "About a minute behind";
  return {
    mood,
    clock: `${at(nowS)} ${zone}`,
    asOf: mood === "offline" ? at(v.lastIngest) : "",
    head,
    sub,
    fresh,
    since: `00:00 ${zoneName(utc(3, 0), TZ)}`,
    pole: poleRows(v),
    waiting: mood === "waiting",
    rows: ENGINEERS.map((n) => engineerRow(n, v, nowS, mood)),
    log: log(v),
    hours: strip(v),
    counts: mood === "waiting" ? null : { merged: v.counts.merged, prs: v.counts.prs, reviews: v.counts.reviews, claude: v.counts.claude, ci: v.counts.ci, ciPass: v.counts.ciPass },
  };
}

const viewAt = (minutes, s, nowS = s) => {
  const m = minutes.get(s);
  if (!m) throw new Error(`no minute at ${s}`);
  return view(m.state, m.replay, nowS * 1000);
};
const busyCount = (v) => ENGINEERS.filter((n) => isActive(v.agents?.[n])).length;

// The live moment: the most varied picture (most different states, then most busy) in a window,
// that changed at least twice in the minutes the page plays up to it.
function pickLive(minutes, fromS, toS) {
  let best = null;
  for (let s = fromS; s <= toS; s += 60) {
    const v = viewAt(minutes, s);
    const states = new Set(ENGINEERS.map((n) => v.agents?.[n]?.state ?? "IDLE"));
    let changes = 0;
    for (let k = 1; k <= PLAY_STEPS; k++) {
      const a = viewAt(minutes, s - k * 60), b = viewAt(minutes, s - (k - 1) * 60);
      changes += ENGINEERS.filter((n) => a.agents?.[n]?.state !== b.agents?.[n]?.state).length;
    }
    const score = (changes >= 2 ? 100 : 0) + states.size * 10 + busyCount(v) + ((v.byAgent?.Polaris?.merges ?? 0) > 0 ? 1 : 0);
    if (!best || score > best.score) best = { s, score };
  }
  return best.s;
}

const PLAY_STEPS = 8; // the live mood plays the last 8 minutes, one step a minute

function moods(minutes, liveS, quietS, offlineAtS, offlineNowS) {
  const play = [];
  for (let k = PLAY_STEPS; k >= 0; k--) play.push(snapshot(viewAt(minutes, liveS - k * 60), "live"));
  const offline = viewAt(minutes, offlineAtS, offlineNowS);
  const waiting = view(emptyState(halifaxDay(liveS)), emptyReplay(), liveS * 1000);
  return {
    live: play,
    quiet: [snapshot(viewAt(minutes, quietS), "quiet")],
    offline: [snapshot(offline, "offline")],
    waiting: [snapshot(waiting, "waiting")],
  };
}

// Busy day: the demo running since yesterday morning; the moments are this afternoon, Halifax time.
const busy = simulate({ seed: 5, fromS: utc(17, 7) - 30 * 3600, toS: utc(20, 0) });
const busyLive = pickLive(busy, utc(16, 0), utc(18, 30));
let busyQuiet = null;
for (let s = utc(10, 0); s <= utc(20, 0); s += 60) if (busyCount(viewAt(busy, s)) === 0) busyQuiet = s;
if (!busyQuiet) throw new Error("the busy day has no quiet minute; pick another seed");

// Quiet day: a short morning's work (08:05 to 10:20 Halifax), then nothing until mid-afternoon,
// with the office still reporting in.
const QUIET_FROM = utc(11, 5), QUIET_UNTIL = utc(13, 20), QUIET_NOW = utc(18, 40);
const quiet = simulate({ seed: 11, fromS: QUIET_FROM, toS: QUIET_NOW, quietAfterS: QUIET_UNTIL });
const quietLive = pickLive(quiet, QUIET_FROM + 30 * 60, QUIET_UNTIL);

const DATA = {
  zone: TZ,
  busy: moods(busy, busyLive, busyQuiet, busyLive - 9 * 60, busyLive),
  quiet: moods(quiet, quietLive, QUIET_NOW, QUIET_NOW - 30 * 60, QUIET_NOW),
};

// ---- the page: template, CSS and script inlined, fonts embedded, data as JSON.
const font = (f) => readFileSync(join(ROOT, "public/fonts", f)).toString("base64");
const fonts = [
  ["Manrope", 400, "manrope-latin-400-normal.woff2"],
  ["Manrope", 500, "manrope-latin-500-normal.woff2"],
  ["Manrope", 600, "manrope-latin-600-normal.woff2"],
  ["Manrope", 700, "manrope-latin-700-normal.woff2"],
].map(([family, weight, file]) => `@font-face{font-family:"${family}";font-weight:${weight};font-style:normal;font-display:block;src:url(data:font/woff2;base64,${font(file)}) format("woff2")}`).join("\n");

const src = (f) => readFileSync(join(HERE, "src", f), "utf8");
const json = JSON.stringify(DATA).replace(/</g, "\\u003c");
const html = src("page.html")
  .replace("/*FONTS*/", () => fonts)
  .replace("/*CSS*/", () => src("roster.css"))
  .replace("/*DATA*/", () => json)
  .replace("/*JS*/", () => src("roster.js"));
writeFileSync(join(HERE, "index.html"), html);
const t = (s) => `${at(s)} ${zoneName(s, TZ)}`;
console.log(`index.html: ${(html.length / 1024).toFixed(0)} KiB; busy live ${t(busyLive)}, quiet ${t(busyQuiet)}; quiet day live ${t(quietLive)}`);
