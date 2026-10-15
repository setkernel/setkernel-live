// What the page says, in words: the headline, each star's label, the feed lines and the summary a
// screen reader hears through the aria-live region. No DOM here, so it runs under `node --test`.
// Every string is shown with textContent, never as markup.
import { homeMidnight } from "./state.js";

export const ACTION_TEXT = {
  picked_up: "started on an issue",
  opened_pr: "opened a pull request",
  approved: "approved a teammate's pull request",
  requested_changes: "asked for changes on a teammate's pull request",
  pushed: "pushed fixes to a pull request",
  posted_round: "posted in a design discussion",
  decision_pr: "wrote up a decision",
  merged: "had a pull request merged",
  merged_by: "merged a pull request",
  // requests (setkernel-live#35): what was asked is never on the page, only that it was
  opened_issue: "sent the team a request",
  commented: "commented",
};

// Who a star is, when its name alone doesn't say: shown under the name.
export const STAR_NOTE = { Polaris: "the director" };

// Where a GitHub action happened, when the event names no repo: a private one. A design-discussion
// post isn't in a repo, and a request is sent to the team, so they say nothing.
export const whereWork = (e) => (e?.action === "opened_issue" ? "" : e?.repo || (e?.action === "posted_round" ? "" : "a private project"));

const DOING = {
  issue: "working on an issue",
  changes: "addressing review feedback",
  decision: "writing up a decision",
  review: "reviewing a pull request",
  discussion: "in a design discussion",
};
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

// The counters reset at midnight in Halifax (homeMidnight); say when that was on the visitor's
// clock -> "since 00:00 ADT" in Halifax, "since 04:00 BST" in London, "since 13:00 JST yesterday"
// in Tokyo just after midnight there.
export function todaySince(now, timeZone, locale) {
  const ms = toMs(now), midnight = homeMidnight(Math.floor(ms / 1000)) * 1000;
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

// Today's numbers for one agent -> "2 PRs · 4 reviews · 130 Claude", leaving out zeros.
export function tally(c) {
  const parts = [[c?.prs, "PR", "PRs"], [c?.reviews, "review", "reviews"], [c?.claude, "Claude", "Claude"]].filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  return parts.length ? parts.join(" · ") : "nothing yet today";
}

// One GitHub event -> "Vega opened a pull request in lafka-plugin.", "Pherkad opened a pull
// request in a private project."
export function sentence(e) {
  return `${e.agent} ${deed(e)}.`;
}

// The same without the name or the full stop -> "opened a pull request in lafka-plugin".
export function deed(e) {
  const where = whereWork(e);
  return `${ACTION_TEXT[e.action] || "did something"}${where ? ` in ${where}` : ""}`;
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

// ---- the headline (setkernel-live#36): one sentence naming every engineer, each name shown
// in its colour. A form is a list of parts: strings, and { name } where a name goes, so the page
// can underline each name without building markup. Three forms, longest first; the page shows
// the first that fits in three lines (fitHeadline).

// Each state as a glyph too, so the colour of a ring is never the only way to tell.
export const GLYPH = { WORKING: "●", REVIEW: "◎", DISCUSS: "⋯", IDLE: "○", PAUSED: "‖" };
export const STATE_WORDS = STATE_WORD;

// "Vega", "Vega and Rigel", "Vega, Rigel and Lyra", as parts.
export function nameList(names) {
  const out = [];
  names.forEach((name, i) => {
    if (i) out.push(i === names.length - 1 ? " and " : ", ");
    out.push({ name });
  });
  return out;
}

// [one, many] for each kind of thing an engineer can be doing, in the long form.
const LONG = {
  changes: ["is addressing review feedback", "are addressing review feedback"],
  issue: ["is working on an issue", "are working on issues"],
  decision: ["is writing up a decision", "are writing up decisions"],
  review: ["is reviewing a pull request", "are reviewing pull requests"],
  discussion: ["is in a design discussion", "are in a design discussion"],
  working: ["is working", "are working"],
  idle: ["is idle", "are idle"],
  paused: ["is paused", "are paused"],
};
const SHORT_VERB = {
  WORKING: ["is working", "are working"],
  REVIEW: ["is reviewing", "are reviewing"],
  DISCUSS: ["is in a discussion", "are in a discussion"],
  IDLE: ["is idle", "are idle"],
  PAUSED: ["is paused", "are paused"],
};
const COUNT = ["No", "One", "Two", "Three", "All four"];

// What kind of thing an engineer is doing, as a key of LONG.
function kindOf(info) {
  if (!isActive(info)) return info?.state === "PAUSED" ? "paused" : "idle";
  if (info.work && LONG[info.work]) return info.work;
  return info.state === "REVIEW" ? "review" : info.state === "DISCUSS" ? "discussion" : "working";
}

// Join groups of parts into one sentence: "A, B and C."
function sentenceOf(groups) {
  const out = [];
  groups.forEach((g, i) => {
    if (i) out.push(i === groups.length - 1 ? " and " : ", ");
    out.push(...g);
  });
  out.push(".");
  return merge(out);
}

// Adjacent strings become one, so the page makes fewer nodes and tests read easily.
function merge(parts) {
  const out = [];
  for (const p of parts) {
    if (typeof p === "string" && typeof out.at(-1) === "string") out[out.length - 1] += p;
    else out.push(p);
  }
  return out;
}

// The three forms of the headline. names: the engineers, most recently active first; targets:
// { reviewer: author } where the page knows whose pull request is being reviewed.
export function headlineForms(agents = {}, names = [], targets = {}) {
  const groups = new Map();
  const add = (key, name) => (groups.get(key) ?? groups.set(key, []).get(key)).push(name);
  const own = [];
  const rank = (k) => (k === "idle" ? 1 : k === "paused" ? 2 : 0); // the busy first, idle and paused last
  for (const name of names) {
    const info = agents[name];
    if (info?.state === "REVIEW" && targets[name]) own.push([{ name }, " is reviewing ", { name: targets[name] }, "'s pull request"]);
    else add(kindOf(info), name);
  }
  const keys = [...groups.keys()].sort((a, b) => rank(a) - rank(b));
  const long = [...own, ...keys.map((k) => { const g = groups.get(k); return [...nameList(g), ` ${LONG[k][g.length > 1 ? 1 : 0]}`]; })];
  const byState = new Map();
  for (const name of names) {
    const st = SHORT_VERB[agents[name]?.state] ? agents[name].state : "IDLE";
    (byState.get(st) ?? byState.set(st, []).get(st)).push(name);
  }
  const order = ["WORKING", "REVIEW", "DISCUSS", "IDLE", "PAUSED"].filter((k) => byState.has(k));
  const short = order.map((k) => { const g = byState.get(k); return [...nameList(g), ` ${SHORT_VERB[k][g.length > 1 ? 1 : 0]}`]; });
  const active = names.filter((n) => isActive(agents[n]));
  const count = active.length
    ? merge([`${COUNT[Math.min(active.length, 4)]} ${active.length === 1 ? "engineer is" : "engineers are"} at work: `, ...nameList(active), "."])
    : ["The engineers are between tasks."];
  return [sentenceOf(long), sentenceOf(short), count];
}

// The first form that fits, by the page's measure; the last if none does.
export function fitHeadline(forms, fits) {
  return forms.find(fits) ?? forms.at(-1);
}

// The parts as plain text, for screen readers and tests.
export const plain = (parts) => parts.map((p) => (typeof p === "string" ? p : p.name)).join("");

// The headline block: { forms, latest, mood }. mood is "live", "quiet", "offline" or "waiting";
// latest is the "Latest" line as parts ("Latest, 14:07 ADT: Orion approved …"). names: the
// engineers in order; targets as for headlineForms.
export function headline({ agents = {}, seen = {}, feed = [], lastIngest = 0, now = Date.now(), timeZone, names = [], targets = {} } = {}) {
  const last = feed[0];
  const latest = last ? merge([`Latest, ${clock(last.ts, timeZone)} ${zoneName(last.ts, timeZone)}`.trimEnd() + ": ", { name: last.agent }, ` ${deed(last)}.`]) : [];
  if (!lastIngest) {
    return { forms: [["Waiting for the office to report in."]], latest: ["Nothing has arrived yet. Replay the last 24 hours, or watch the demo."], mood: "waiting" };
  }
  if (now - lastIngest > OFFLINE_AFTER_MS) {
    return { forms: [[`No word from the office since ${clock(lastIngest, timeZone)}.`]], latest: ["The engineers may still be working. This page catches up by itself."], mood: "offline" };
  }
  const order = [...names].sort((a, b) => (seen[b] ?? 0) - (seen[a] ?? 0));
  const mood = names.some((n) => isActive(agents[n])) ? "live" : "quiet";
  return { forms: headlineForms(agents, order, targets), latest, mood };
}

// The words beside a star, and on its card: { glyph, state: "Working", words: "working on an
// issue", repo } where repo is a public repo's name or "".
export function stateWords(info) {
  const st = STATE_WORD[info?.state] ? info.state : "IDLE";
  const words = doing({ ...info, repo: undefined });
  return { glyph: GLYPH[st], state: STATE_WORD[st], words, repo: isActive(info) && info.repo ? info.repo : "" };
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

// New GitHub events and requests, oldest first -> one short summary, or "" when there is nothing
// to say. Claude requests and chat posts are too frequent to read out; the counters cover them.
const spoken = (e) => e?.t === "msg" && (e.kind === "github" || e.kind === "request");
export function summarise(events) {
  const work = events.filter(spoken);
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
      pending.push(...events.filter(spoken));
      if (!pending.length || timer) return;
      const wait = last + every - now();
      if (wait <= 0) flush();
      else timer = setTimer(flush, wait);
    },
  };
}
