// What the page says, in words: the headline, each star's label, the feed lines and the summary a
// screen reader hears through the aria-live region. No DOM here, so it runs under `node --test`.
// Every string is shown with textContent, never as markup.
import { AGENTS } from "./state.js";

export const ACTION_TEXT = {
  picked_up: "started on an issue",
  opened_pr: "opened a pull request",
  approved: "approved a teammate's pull request",
  requested_changes: "asked for changes on a teammate's pull request",
  pushed: "pushed fixes to a pull request",
  posted_round: "posted in a design discussion",
  decision_pr: "wrote up a decision",
};

const DOING = {
  issue: "working on an issue",
  changes: "addressing review feedback",
  decision: "writing up a decision",
  review: "reviewing a pull request",
  discussion: "in a design discussion",
};
const SHORT = { issue: "on an issue", changes: "on review feedback", decision: "on a decision", review: "a pull request", discussion: "" };
const STATE_WORD = { WORKING: "Working", REVIEW: "Reviewing", DISCUSS: "Discussing", PAUSED: "Paused", IDLE: "Idle" };
const ACTIVE = new Set(["WORKING", "REVIEW", "DISCUSS"]);
export const OFFLINE_AFTER_MS = 120_000;

export const isActive = (info) => ACTIVE.has(info?.state);

// Times are shown in the visitor's own time zone. Every function that prints a time takes an
// optional IANA zone (tests pin "UTC" or "America/Halifax"); left out, the browser's zone is used.
const formats = new Map();
const format = (key, make) => formats.get(key) ?? formats.set(key, make()).get(key);
const toMs = (t) => (t > 1e11 ? t : t * 1000);

// Seconds or milliseconds since the epoch -> "14:02", 24-hour, in the visitor's zone.
export function clock(t, timeZone) {
  const f = format(`clock ${timeZone}`, () => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }));
  return f.format(new Date(toMs(t)));
}

// The zone's short name at that moment -> "ADT" (or "AST" in winter, "UTC", "GMT+2").
export function zoneName(t, timeZone, locale) {
  const f = format(`zone ${timeZone} ${locale}`, () => new Intl.DateTimeFormat(locale, { timeZoneName: "short", timeZone }));
  return f.formatToParts(new Date(toMs(t))).find((p) => p.type === "timeZoneName")?.value ?? "";
}

const localDay = (ms, timeZone) => format(`day ${timeZone}`, () => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone })).format(new Date(ms));

// The counters reset at midnight UTC; say when that was on the visitor's clock -> "since 21:00 ADT
// yesterday" in Halifax just after midnight, "since 00:00 GMT" in London in winter.
export function todaySince(now, timeZone, locale) {
  const ms = toMs(now), midnight = Math.floor(ms / 86_400_000) * 86_400_000;
  const when = `since ${clock(midnight, timeZone)} ${zoneName(midnight, timeZone, locale)}`.trimEnd();
  return localDay(midnight, timeZone) === localDay(ms, timeZone) ? when : `${when} yesterday`;
}

// How long ago the office last reported in -> "updated 12 s ago", "updated 3 min ago".
export function freshness(lastIngest, now = Date.now()) {
  if (!lastIngest) return "";
  const s = Math.max(0, Math.floor((now - lastIngest) / 1000));
  if (s < 2) return "updated just now";
  if (s < 60) return `updated ${s} s ago`;
  if (s < 3600) return `updated ${Math.floor(s / 60)} min ago`;
  return `updated ${Math.floor(s / 3600)} h ago`;
}

// An agent's state -> "working on an issue in setkernel-live" (or "idle", "paused").
export function doing(info) {
  if (!isActive(info)) return info?.state === "PAUSED" ? "paused" : "idle";
  const what = DOING[info.work] || (info.state === "REVIEW" ? DOING.review : info.state === "DISCUSS" ? DOING.discussion : "working");
  return info.repo ? `${what} in ${info.repo}` : what;
}

// The words beside a star: { state: "Working", detail: "on an issue · setkernel-live" }.
export function starLabel(info) {
  const state = STATE_WORD[info?.state] || "Idle";
  if (!isActive(info)) return { state, detail: "" };
  return { state, detail: [SHORT[info.work], info.repo].filter(Boolean).join(" · ") };
}

// Today's numbers for one agent -> "2 PRs · 4 reviews · 130 Claude", leaving out zeros.
export function tally(c) {
  const parts = [[c?.prs, "PR", "PRs"], [c?.reviews, "review", "reviews"], [c?.claude, "Claude", "Claude"]].filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  return parts.length ? parts.join(" · ") : "nothing yet today";
}

// One GitHub event -> "Vega opened a pull request in lafka-plugin."
export function sentence(e) {
  return `${e.agent} ${ACTION_TEXT[e.action] || "did something"}${e.repo ? ` in ${e.repo}` : ""}.`;
}

// ---- CI runs (setkernel-live#14). A run has no agent; a public repo is named, a private one is not.
export const ciWord = (r) => (r?.result === "pass" ? "passed" : "failed");
export const ciWhere = (r) => r?.repo || "a private project";

// Today's CI counts -> "14 runs today · 92% passed". The rate rounds down, so a day with a failure
// never says 100%.
export function ciSummary(c) {
  const runs = c?.ci > 0 ? c.ci : 0;
  if (!runs) return "No runs yet today";
  const pass = Math.min(runs, c.ciPass > 0 ? c.ciPass : 0);
  return `${runs} run${runs === 1 ? "" : "s"} today · ${Math.floor((100 * pass) / runs)}% passed`;
}

// The one line at the top: what's happening now. Returns { main, sub, mood } where mood is
// "live", "quiet", "offline" or "waiting".
export function headline({ agents = {}, seen = {}, feed = [], lastIngest = 0, now = Date.now(), timeZone } = {}) {
  if (!lastIngest) return { main: "Waiting for the office to report in.", sub: "Nothing has arrived yet. Replay the last 24 hours below the sky, or watch the demo.", mood: "waiting" };
  if (now - lastIngest > OFFLINE_AFTER_MS) {
    return {
      main: `No word from the office since ${clock(lastIngest, timeZone)}.`,
      sub: "The agents may still be working. This page catches up by itself.",
      mood: "offline",
    };
  }
  const active = AGENTS.filter((n) => isActive(agents[n])).sort((a, b) => (seen[b] ?? 0) - (seen[a] ?? 0));
  const paused = AGENTS.filter((n) => agents[n]?.state === "PAUSED");
  if (active.length) {
    const [first, ...rest] = active;
    const sub = [...rest.map((n) => `${n} is ${doing(agents[n])}.`), ...paused.map((n) => `${n} is paused.`)];
    return { main: `${first} is ${doing(agents[first])}.`, sub: sub.join(" "), mood: "live" };
  }
  const last = Math.max(0, ...Object.values(seen).filter(Number.isFinite));
  return {
    main: last ? `All four are quiet, since ${clock(last, timeZone)}.` : "All four are quiet. Nothing yet today.",
    sub: feed[0] ? `Last: ${sentence(feed[0])}` : "",
    mood: "quiet",
  };
}

// Whose work a review was about, when the page can tell: an approval or change request in a
// public repo where another agent recently opened or pushed to a pull request. Private repos have
// no name on this page, so their reviews draw no line. recent: GitHub events, newest first.
export function reviewTarget(e, recent, within = 86_400) {
  if (e?.action !== "approved" && e?.action !== "requested_changes") return null;
  if (!e.repo) return null;
  const hit = recent.find((w) => w.repo === e.repo && w.agent !== e.agent && (w.action === "opened_pr" || w.action === "pushed")
    && (e.ts ?? Infinity) - w.ts <= within && w.ts <= (e.ts ?? Infinity));
  return hit ? hit.agent : null;
}

// ---- spoken summary (from setkernel-live PR #8): at most one aria-live update every 30 s

export const ANNOUNCE_EVERY_MS = 30_000;
const MAX_SENTENCES = 3;

// New GitHub events, oldest first -> one short summary, or "" when there is nothing to say.
// Claude requests and chat posts are too frequent to read out; the counters cover them.
export function summarise(events) {
  const work = events.filter((e) => e?.t === "msg" && e.kind === "github");
  if (!work.length) return "";
  const said = work.slice(-MAX_SENTENCES).map(sentence);
  const more = work.length - said.length;
  if (more) said.unshift(`${more} more update${more === 1 ? "" : "s"}.`);
  return said.join(" ");
}

// Collects events and calls say(summary) at most once every `every` ms. The first batch is
// spoken straight away; anything inside the next window waits and is spoken together.
export function createAnnouncer({ say, now = Date.now, setTimer = setTimeout, every = ANNOUNCE_EVERY_MS }) {
  let pending = [], last = -Infinity, timer = null;
  const flush = () => {
    timer = null;
    const text = summarise(pending);
    pending = [];
    if (!text) return;
    last = now();
    say(text);
  };
  return {
    add(events) {
      pending.push(...events.filter((e) => e?.t === "msg" && e.kind === "github"));
      if (!pending.length || timer) return;
      const wait = last + every - now();
      if (wait <= 0) flush();
      else timer = setTimer(flush, wait);
    },
  };
}
