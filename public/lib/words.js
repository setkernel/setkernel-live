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

// Seconds or milliseconds since the epoch -> "14:02" (UTC; the page says so once).
export function clock(t) {
  const d = new Date(t > 1e11 ? t : t * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
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

// The one line at the top: what's happening now. Returns { main, sub, mood } where mood is
// "live", "quiet", "offline" or "waiting".
export function headline({ agents = {}, seen = {}, feed = [], lastIngest = 0, now = Date.now() } = {}) {
  if (!lastIngest) return { main: "Waiting for the office to report in.", sub: "Nothing has arrived yet. Replay the last 24 hours below the sky, or watch the demo.", mood: "waiting" };
  if (now - lastIngest > OFFLINE_AFTER_MS) {
    return {
      main: `No word from the office since ${clock(lastIngest)} UTC.`,
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
    main: last ? `All four are quiet, since ${clock(last)} UTC.` : "All four are quiet. Nothing yet today.",
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
