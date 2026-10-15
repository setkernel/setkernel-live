// The page's pure modules: the words it shows, the ?demo simulation, the replay show and the sky
// layout. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { COLUMNS, POLE, cleanBatch, cleanEvent, emptyReplay, emptyState, recordReplay, applyBatch } from "../src/logic.js";
import { ENGINEERS } from "../src/logic.js";
import { STAR_NOTE, ciSummary, ciWhere, ciWord, clock, createAnnouncer, deed, doing, fitHeadline, freshness, headline, headlineForms, plain, reviewTarget, sentence, stateWords, summarise, tally, todaySince, whereWork, zoneName } from "../public/lib/words.js";
import { SESSION_NOTE, cardText, cardWords, ringPile, starCard, tokenPile } from "../public/lib/card.js";
import { stepLines } from "../public/lib/line.js";
import { createDemo, seeded } from "../public/lib/demo.js";
import { eventsBefore, plan } from "../public/lib/replay.js";
import { skyLayout } from "../public/lib/layout.js";

const T0 = 490_000 * 3600; // seconds; 2025-11-23 16:00 UTC

const AG = {
  Rigel: { state: "REVIEW", work: "review", repo: "setkernel-live" }, Orion: { state: "WORKING", work: "issue" },
  Lyra: { state: "DISCUSS", work: "discussion" }, Vega: { state: "IDLE" },
};

test("headline: one sentence naming every engineer, then shorter forms", () => {
  const forms = headlineForms(AG, ["Rigel", "Orion", "Lyra", "Vega"], { Rigel: "Lyra" }).map(plain);
  assert.deepEqual(forms, [
    "Rigel is reviewing Lyra's pull request, Orion is working on an issue, Lyra is in a design discussion and Vega is idle.",
    "Orion is working, Rigel is reviewing, Lyra is in a discussion and Vega is idle.",
    "Three engineers are at work: Rigel, Orion and Lyra.",
  ]);
  // every name is its own part, so the page can underline it in its colour
  const names = headlineForms(AG, ["Rigel", "Orion", "Lyra", "Vega"], { Rigel: "Lyra" })[0].filter((p) => typeof p === "object").map((p) => p.name);
  assert.deepEqual(names, ["Rigel", "Lyra", "Orion", "Lyra", "Vega"]);
  // a review the page can't tie to an author says so; the same kind of thing is grouped; idle goes last
  const two = { Vega: { state: "IDLE" }, Rigel: { state: "REVIEW" }, Orion: { state: "WORKING", work: "issue" }, Lyra: { state: "WORKING", work: "issue" } };
  assert.equal(plain(headlineForms(two, ["Vega", "Orion", "Rigel", "Lyra"])[0]), "Orion and Lyra are working on issues, Rigel is reviewing a pull request and Vega is idle.");
  assert.equal(plain(headlineForms(two, ["Vega", "Orion", "Rigel", "Lyra"])[1]), "Orion and Lyra are working, Rigel is reviewing and Vega is idle.");
  const quiet = { Vega: { state: "IDLE" }, Rigel: { state: "PAUSED" } };
  assert.deepEqual(headlineForms(quiet, ["Vega", "Rigel", "Lyra", "Orion"]).map(plain), [
    "Vega, Lyra and Orion are idle and Rigel is paused.", "Vega, Lyra and Orion are idle and Rigel is paused.", "The engineers are between tasks.",
  ]);
  const all = Object.fromEntries(ENGINEERS.map((n) => [n, { state: "WORKING", work: "changes" }]));
  assert.equal(plain(headlineForms(all, ENGINEERS)[2]), "All four engineers are at work: Vega, Rigel, Lyra and Orion.");
  assert.equal(plain(headlineForms({ Vega: { state: "WORKING" } }, ["Vega"])[0]), "Vega is working.");
});

test("headline shortens itself: the first form that fits in three lines, else the last", () => {
  const forms = headlineForms(AG, ["Rigel", "Orion", "Lyra", "Vega"], { Rigel: "Lyra" });
  const lines = (f) => Math.ceil(plain(f).length / 36); // a narrow column, 36 characters a line
  assert.equal(fitHeadline(forms, (f) => lines(f) <= 3), forms[1], "the long form needs four lines here");
  assert.equal(fitHeadline(forms, () => true), forms[0]);
  assert.equal(fitHeadline(forms, () => false), forms[2]);
});

test("headline block: most recently active first, the Latest line, and waiting or offline", () => {
  const now = T0 * 1000;
  const feed = [{ agent: "Orion", action: "approved", repo: "agent-plugins", ts: T0 - 60 }];
  const h = headline({ agents: AG, seen: { Vega: T0 - 5, Orion: T0 - 50 }, feed, lastIngest: now - 5000, now, timeZone: "America/Halifax", names: ENGINEERS, targets: { Rigel: "Lyra" } });
  assert.equal(h.mood, "live");
  assert.equal(plain(h.forms[0]), "Rigel is reviewing Lyra's pull request, Orion is working on an issue, Lyra is in a design discussion and Vega is idle.");
  assert.equal(plain(h.latest), "Latest, 11:59 AST: Orion approved a teammate's pull request in agent-plugins.");
  assert.ok(h.latest.some((p) => p.name === "Orion"));
  assert.equal(headline({ agents: { Vega: { state: "IDLE" } }, lastIngest: now, now, names: ENGINEERS }).mood, "quiet");
  assert.equal(plain(headline({ lastIngest: now - 10 * 60_000, now, timeZone: "UTC" }).forms[0]), "No word from the office since 15:50.");
  assert.equal(headline({ lastIngest: 0, now }).mood, "waiting");
});

test("labels, tallies and feed sentences", () => {
  assert.equal(doing({ state: "DISCUSS" }), "in a design discussion");
  assert.equal(doing({ state: "WORKING", work: "changes", repo: "hq" }), "addressing review feedback in hq");
  assert.equal(doing({ state: "IDLE", work: "issue" }), "idle");
  assert.deepEqual(stateWords({ state: "WORKING", work: "issue", repo: "setkernel-live" }), { glyph: "●", state: "Working", words: "working on an issue", repo: "setkernel-live" });
  assert.deepEqual(stateWords({ state: "REVIEW", work: "review" }), { glyph: "◎", state: "Reviewing", words: "reviewing a pull request", repo: "" });
  assert.deepEqual(stateWords({ state: "DISCUSS", work: "discussion", repo: "hq" }), { glyph: "⋯", state: "Discussing", words: "in a design discussion", repo: "hq" });
  assert.deepEqual(stateWords({ state: "IDLE", repo: "x" }), { glyph: "○", state: "Idle", words: "idle", repo: "" });
  assert.deepEqual(stateWords({ state: "PAUSED" }), { glyph: "‖", state: "Paused", words: "paused", repo: "" });
  assert.deepEqual(stateWords(undefined), { glyph: "○", state: "Idle", words: "idle", repo: "" });
  assert.equal(deed({ agent: "Vega", action: "opened_pr", repo: "hq" }), "opened a pull request in hq");
  assert.equal(tally({ prs: 2, reviews: 4, claude: 130, started: 3, helpers: 1 }), "2 PRs · 4 reviews · 130 Claude");
  assert.equal(tally({ prs: 1, reviews: 1, started: 1 }), "1 PR · 1 review");
  assert.equal(tally(undefined), "nothing yet today");
  assert.equal(sentence({ agent: "Orion", action: "decision_pr" }), "Orion wrote up a decision in a private project.");
  assert.equal(sentence({ agent: "Orion", action: "posted_round" }), "Orion posted in a design discussion.", "a discussion isn't in a repo");
  assert.equal(sentence({ agent: "Pherkad", action: "opened_pr" }), "Pherkad opened a pull request in a private project.");
  assert.equal(sentence({ agent: "Polaris", action: "approved", repo: "setkernel-live" }), "Polaris approved a teammate's pull request in setkernel-live.");
  assert.equal(sentence({ agent: "Kochab", action: "merged", repo: "hq" }), "Kochab had a pull request merged in hq.");
  assert.equal(whereWork({ action: "merged" }), "a private project");
  assert.deepEqual(STAR_NOTE, { Polaris: "the director" });
});

test("requests and Polaris's merges in words: who sent it, never what it said", () => {
  assert.equal(sentence({ agent: "Polaris", action: "opened_issue" }), "Polaris sent the team a request.");
  assert.equal(sentence({ agent: "Polaris", action: "opened_issue", repo: "setkernel-live" }), "Polaris sent the team a request.", "a request goes to the team, not to a repo");
  assert.equal(sentence({ agent: "Polaris", action: "commented" }), "Polaris commented in a private project.");
  assert.equal(sentence({ agent: "Kochab", action: "commented", repo: "setkernel-live" }), "Kochab commented in setkernel-live.");
  assert.equal(sentence({ agent: "Polaris", action: "merged_by" }), "Polaris merged a pull request in a private project.");
  assert.equal(sentence({ agent: "Vega", action: "merged" }), "Vega had a pull request merged in a private project.");
  // read out like any other news
  assert.equal(summarise([{ t: "msg", kind: "request", agent: "Polaris", action: "opened_issue" }, { t: "msg", kind: "claude", agent: "Vega" }]), "Polaris sent the team a request.");
  // the Latest line under the headline
  const h = headline({ agents: AG, feed: [{ agent: "Polaris", action: "commented", ts: T0 }], lastIngest: T0 * 1000, now: T0 * 1000, timeZone: "UTC", names: ENGINEERS });
  assert.equal(plain(h.latest), "Latest, 16:00 UTC: Polaris commented in a private project.");
});

test("clock: 24-hour HH:MM in the visitor's zone, seconds or milliseconds", () => {
  assert.equal(clock(T0 + 125, "UTC"), "16:02");
  assert.equal(clock((T0 + 125) * 1000, "UTC"), "16:02");
  assert.equal(clock(T0 + 125, "America/Halifax"), "12:02", "AST in November");
  assert.equal(clock(T0 - 140 * 86_400, "America/Halifax"), "13:00", "ADT in July");
  assert.equal(clock(T0 + 8 * 3600, "UTC"), "00:00", "midnight is 00, never 24");
  assert.equal(clock(T0, "Asia/Kolkata"), "21:30", "half-hour zones");
  assert.equal(zoneName(T0, "UTC", "en-US"), "UTC");
  assert.equal(zoneName(T0, "America/Halifax", "en-US"), "AST");
  assert.equal(zoneName(T0 - 140 * 86_400, "America/Halifax", "en-US"), "ADT");
});

test("today: the counters' UTC midnight on the visitor's clock", () => {
  assert.equal(todaySince(T0 * 1000, "UTC", "en-US"), "since 00:00 UTC");
  assert.equal(todaySince(T0, "America/Halifax", "en-US"), "since 20:00 AST yesterday", "12:00 in Halifax: the count began last evening");
  assert.equal(todaySince(T0 + 9 * 3600, "America/Halifax", "en-US"), "since 20:00 AST", "21:00 in Halifax: it began this evening");
  assert.equal(todaySince((T0 - 140 * 86_400) * 1000, "America/Halifax", "en-US"), "since 21:00 ADT yesterday");
  assert.equal(todaySince(T0, "Asia/Kolkata", "en-US"), "since 05:30 GMT+5:30");
});

test("freshness: how long since the office last reported in, ticking up", () => {
  const now = T0 * 1000;
  assert.equal(freshness(0, now), "", "nothing yet: nothing to say");
  assert.equal(freshness(now - 500, now), "updated just now");
  assert.equal(freshness(now + 3000, now), "updated just now", "a server clock ahead of ours");
  assert.equal(freshness(now - 12_400, now), "updated 12 s ago");
  assert.equal(freshness(now - 13_400, now), "updated 13 s ago");
  assert.equal(freshness(now - 3 * 60_000 - 5000, now), "updated 3 min ago");
  assert.equal(freshness(now - 2 * 3_600_000, now), "updated 2 h ago");
});

test("review lines: only when a public repo ties the review to a teammate's pull request", () => {
  const recent = [
    { agent: "Vega", action: "approved", repo: "setkernel-live", ts: T0 - 10 },
    { agent: "Rigel", action: "opened_pr", repo: "setkernel-live", ts: T0 - 100 },
    { agent: "Lyra", action: "opened_pr", repo: "example-site", ts: T0 - 90_000 },
  ];
  assert.equal(reviewTarget({ agent: "Vega", action: "approved", repo: "setkernel-live", ts: T0 }, recent), "Rigel");
  assert.equal(reviewTarget({ agent: "Rigel", action: "requested_changes", repo: "setkernel-live", ts: T0 }, recent), null, "not your own");
  assert.equal(reviewTarget({ agent: "Vega", action: "approved", ts: T0 }, recent), null, "private repo: no line");
  assert.equal(reviewTarget({ agent: "Vega", action: "approved", repo: "example-site", ts: T0 }, recent), null, "too long ago");
  assert.equal(reviewTarget({ agent: "Vega", action: "pushed", repo: "setkernel-live", ts: T0 }, recent), null);
});

test("announcer (from PR #8): first news at once, then at most one summary per 30 s", () => {
  let clockMs = 0;
  const said = [], timers = [];
  const a = createAnnouncer({ say: (t) => said.push(t), now: () => clockMs, setTimer: (fn, ms) => timers.push([fn, ms]) });
  const gh = (agent) => ({ t: "msg", kind: "github", agent, action: "pushed" });
  a.add([{ t: "msg", kind: "claude", agent: "Vega" }]);
  assert.deepEqual(said, []);
  a.add([gh("Vega")]);
  assert.deepEqual(said, ["Vega pushed fixes to a pull request in a private project."]);
  clockMs = 1000;
  a.add([gh("Rigel"), gh("Lyra"), gh("Orion"), gh("Vega")]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0][1], 29_000);
  timers[0][0]();
  assert.equal(said[1], "1 more update. Lyra pushed fixes to a pull request in a private project. Orion pushed fixes to a pull request in a private project. Vega pushed fixes to a pull request in a private project.");
  assert.equal(summarise([]), "");
});

test("test runs in words: public repos named, private ones not, the rate never rounds up to 100%", () => {
  assert.equal(`${ciWhere({ result: "pass", repo: "setkernel-live" })} ${ciWord({ result: "pass" })}`, "setkernel-live passed");
  assert.equal(`${ciWhere({ result: "fail" })} ${ciWord({ result: "fail" })}`, "a private project failed");
  assert.equal(ciSummary({}), "No runs yet today");
  assert.equal(ciSummary(undefined), "No runs yet today");
  assert.equal(ciSummary({ ci: 1, ciPass: 1 }), "1 run today · 100% passed");
  assert.equal(ciSummary({ ci: 3, ciPass: 2 }), "3 runs today · 66% passed");
  assert.equal(ciSummary({ ci: 200, ciPass: 199 }), "200 runs today · 99% passed");
  assert.equal(ciSummary({ ci: 4 }), "4 runs today · 0% passed");
});

test("demo: every event and agent state passes the Worker's allowlist unchanged", () => {
  const demo = createDemo(17, T0);
  const { events, agents } = demo.advance(T0 + 86_400);
  assert.ok(events.length > 1000, `${events.length} events`);
  for (const e of events) assert.deepEqual(cleanEvent(e), e, JSON.stringify(e));
  assert.deepEqual(cleanBatch({ events: [], agents }).agents, agents);
  const kinds = new Set(events.map((e) => e.kind === "github" || e.kind === "request" ? e.action : e.kind));
  for (const k of ["claude", "chat", "helper", "ci", "picked_up", "opened_pr", "approved", "requested_changes", "pushed", "posted_round", "decision_pr", "merged", "merged_by", "opened_issue", "commented"]) {
    assert.ok(kinds.has(k), `demo shows ${k}`);
  }
  // the pole stars are seen only through GitHub, as on the live page, and have no state: Polaris
  // reviews, merges and sends requests, its three Claudes open pull requests and have them merged,
  // Kochab comments now and then, and Yildun's Claude requests come from its own machine
  const polaris = events.filter((e) => e.agent === "Polaris");
  assert.ok(polaris.length >= 4 && polaris.every((e) => (e.kind === "github" && ["approved", "requested_changes", "merged_by"].includes(e.action)) || e.kind === "request"), `${polaris.length} Polaris events`);
  for (const action of ["approved", "merged_by", "opened_issue", "commented"]) assert.ok(polaris.some((e) => e.action === action), `Polaris ${action}`);
  const allowed = { Kochab: ["github", "request"], Pherkad: ["github"], Yildun: ["github", "claude"] };
  for (const name of ["Kochab", "Pherkad", "Yildun"]) {
    const mine = events.filter((e) => e.agent === name);
    assert.ok(mine.length >= 2 && mine.every((e) => allowed[name].includes(e.kind)), `${mine.length} ${name} events`);
    assert.ok(mine.some((e) => e.action === "opened_pr"), `${name} opens a pull request`);
  }
  assert.ok(events.some((e) => e.agent === "Yildun" && e.kind === "claude"), "Yildun's Claude requests");
  assert.ok(events.filter((e) => e.kind === "request").every((e) => e.agent === "Polaris" || e.agent === "Kochab"));
  // every one of Polaris's merges is a merge of someone's pull request at the same moment
  for (const m of polaris.filter((e) => e.action === "merged_by")) {
    assert.ok(events.some((e) => e.action === "merged" && e.ts === m.ts && e.repo === m.repo), JSON.stringify(m));
  }
  for (const name of ["Polaris", "Kochab", "Pherkad", "Yildun"]) assert.equal(agents[name], undefined, `${name} has no state`);
  assert.doesNotMatch(JSON.stringify(events) + JSON.stringify(agents), /raghav/i, "no Raghav in the demo");
  assert.ok(!events.some((e) => e.agent === "Claude") && !("Claude" in agents), "no Claude star in the demo");
  assert.ok(events.every((e, i) => e.ts >= T0 && e.ts <= T0 + 86_400 && (i === 0 || e.ts >= events[i - 1].ts)), "in time order, inside the window");
  // states change as time goes on: the next minute is a continuation, not a restart
  const later = demo.advance(T0 + 86_400 + 60);
  assert.ok(later.events.every((e) => e.ts >= T0 + 86_400 - 5));
});

test("demo: the same seed tells the same story; it has review lines to draw", () => {
  const a = createDemo(5, T0).advance(T0 + 7200), b = createDemo(5, T0).advance(T0 + 7200);
  assert.deepEqual(a, b);
  assert.notDeepEqual(createDemo(6, T0).advance(T0 + 7200).events, a.events);
  const work = createDemo(17, T0).advance(T0 + 86_400).events.filter((e) => e.kind === "github").reverse();
  const lines = work.filter((e, i) => reviewTarget(e, work.slice(i + 1)));
  assert.ok(lines.length >= 5, `${lines.length} reviews tied to a teammate`);
});

test("demo state comes from the real reducer and stays inside the replay cap", () => {
  const { events, agents } = createDemo(17, T0).advance(T0 + 86_400);
  const batch = { events, agents };
  const s = applyBatch(emptyState("d"), batch, (T0 + 86_400) * 1000, "d");
  const r = recordReplay(emptyReplay(), batch, (T0 + 86_400) * 1000);
  assert.equal(s.counts.claude, events.filter((e) => e.kind === "claude").length);
  const ci = events.filter((e) => e.kind === "ci");
  assert.equal(s.counts.ci, ci.length);
  assert.ok(s.counts.ciPass > 0 && s.counts.ciPass < s.counts.ci, "the demo shows passes and failures");
  assert.equal(s.ci.length, 20);
  assert.ok(r.pulses.length <= 1440 && r.work.length <= 300);
});

test("replay plan: an hour in a minute, thinned evenly, GitHub actions all kept", () => {
  const { events, agents } = createDemo(17, T0).advance(T0 + 86_400);
  const r = recordReplay(emptyReplay(), { events, agents }, (T0 + 86_400) * 1000);
  const rand = seeded(1);
  const day = plan(r, { from: T0, to: T0 + 86_400, durationMs: 120_000, maxPulses: 1800, rand });
  const github = day.filter((e) => e.kind === "github" || e.kind === "request");
  assert.equal(github.length, r.work.length);
  assert.ok(day.some((e) => e.kind === "request" && e.action === "opened_issue"), "requests stay requests in the show");
  assert.ok(day.length - github.length <= 1800 * 1.1, `${day.length - github.length} pulses`);
  assert.ok(day.every((e, i) => e.at >= 0 && e.at <= 120_000 && (i === 0 || e.at >= day[i - 1].at)));
  const hour = plan(r, { from: T0 + 82_800, to: T0 + 86_400, durationMs: 60_000, maxPulses: 100_000, rand });
  const pulseCols = (p) => p.slice(1).filter((_, i) => COLUMNS[i][1] !== "github"); // every column but GitHub's
  const want = r.pulses.filter((p) => p[0] * 60 >= T0 + 82_800).reduce((n, p) => n + pulseCols(p).reduce((x, y) => x + y, 0), 0);
  assert.equal(hour.filter((e) => e.kind !== "github" && e.kind !== "request").length, want, "nothing thinned under the cap");
  assert.deepEqual(plan(undefined, { from: 0, to: 1, durationMs: 1, maxPulses: 1 }), []);
});

test("sky layout: every star inside the sky at every size, the engineers never crowded", () => {
  const sizes = [[320, 500], [343, 500], [375, 500], [812, 351], [768, 560], [1024, 600], [1440, 724], [1536, 1340], [2560, 1300], [3840, 1600]];
  for (const [w, h] of sizes) {
    const L = skyLayout(w, h);
    const points = [...Object.values(L.stars), ...Object.values(L.faint)];
    for (const p of points) assert.ok(p.x >= 16 && p.x <= w - 16 && p.y >= 16 && p.y < L.horizon, `${w}x${h}: ${JSON.stringify(p)}`);
    for (let i = 0; i < ENGINEERS.length; i++) {
      for (let j = i + 1; j < ENGINEERS.length; j++) {
        const [a, b] = [L.stars[ENGINEERS[i]], L.stars[ENGINEERS[j]]];
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 80, `${w}x${h}: ${ENGINEERS[i]} and ${ENGINEERS[j]}`);
      }
    }
    // Ursa Minor keeps its shape: Polaris at the top, the bowl to its right
    assert.ok(L.stars.Polaris.y < Math.min(...ENGINEERS.map((n) => L.stars[n].y)), `${w}x${h}: Polaris above the engineers`);
    assert.ok(L.stars.Kochab.x > L.stars.Yildun.x && L.stars.Pherkad.y > L.stars.Kochab.y);
  }
});

test("sky layout: Polaris and its group clear the headline and the controls over the sky", () => {
  const hud = { right: 560, bottom: 300 }, status = { left: 1100, bottom: 140 };
  const L = skyLayout(1440, 724, { hud, status });
  assert.ok(L.stars.Polaris.x - 1.9 * 16 - 9 * 16 > hud.right, "its label is right of the headline");
  for (const n of ENGINEERS) assert.ok(L.stars[n].y > hud.bottom, `${n} under the headline`);
  for (const n of ["Yildun", "Kochab", "Pherkad"]) {
    const p = L.stars[n];
    assert.ok(p.x + 7.8 * 16 < status.left || p.y > status.bottom, `${n} and its label clear the controls`);
  }
});

test("star card: state, column, five steps with times, today's numbers and the latest three", () => {
  const events = [
    { t: "msg", kind: "github", agent: "Vega", action: "picked_up", repo: "hq", ts: T0 },
    { t: "msg", kind: "claude", agent: "Vega", ts: T0 + 60 },
    { t: "msg", kind: "github", agent: "Vega", action: "opened_pr", repo: "hq", ts: T0 + 900 },
  ];
  const v = {
    agents: { Vega: { state: "REVIEW", work: "review", repo: "setkernel-live" } },
    byAgent: { Vega: { prs: 2, reviews: 6, claude: 340 }, Kochab: { prs: 4, merged: 1 }, Polaris: { reviews: 3, requests: 5, merges: 7 }, Yildun: { prs: 1, claude: 40 } },
    line: stepLines({}, events, ENGINEERS).lines,
    feed: [
      { agent: "Kochab", action: "opened_pr", ts: T0 + 950 },
      ...events.filter((e) => e.kind === "github").reverse().map(({ agent, action, repo, ts }) => ({ agent, action, repo, ts })),
      { agent: "Vega", action: "merged", ts: T0 - 99 }, { agent: "Vega", action: "pushed", ts: T0 - 100 },
    ],
  };
  const c = starCard("Vega", v, T0 + 1000, { Vega: "Lyra" });
  assert.equal(c.director, false);
  assert.deepEqual(c.state, { glyph: "◎", state: "Reviewing", words: "reviewing Lyra's pull request", repo: "setkernel-live" });
  assert.equal(c.column, "In review", "its own pull request is open while it reviews a teammate's");
  assert.equal(c.task, "Current task");
  assert.deepEqual(c.steps.map((s) => [s.stage, s.status, s.ts]), [["started", "done", T0], ["building", "done", T0 + 60], ["review", "now", T0 + 900], ["fixing", "todo", null], ["merged", "todo", null]]);
  assert.deepEqual(c.numbers, [[2, "PRs opened"], [6, "reviews"], [340, "Claude requests"]]);
  assert.deepEqual(c.latest.map((l) => l.text), ["opened a pull request in hq", "started on an issue in hq", "had a pull request merged in a private project"], "its own three, newest first");
  const k = starCard("Kochab", v, T0 + 1000);
  assert.equal(k.director, true);
  assert.equal(k.column, "the director strip");
  assert.match(k.note, /^the lead chat · /);
  assert.deepEqual(k.numbers, [[4, "PRs opened"], [1, "merged"]]);
  assert.equal(k.steps, undefined, "no state, so no steps");
  assert.deepEqual(starCard("Polaris", v, T0).numbers, [[5, "requests"], [7, "merges"], [3, "reviews"], [0, "PRs opened"]]);
  const y = starCard("Yildun", v, T0);
  assert.deepEqual(y.numbers, [[1, "PRs opened"], [0, "merged"], [40, "Claude requests"]]);
  assert.match(y.note, /^its own machine · seen only through GitHub and its Claude requests, /);
  assert.equal(starCard("Mallory", v, T0), null);
  assert.deepEqual(SESSION_NOTE, { Kochab: "the lead chat", Pherkad: "cloud sessions", Yildun: "its own machine" });
});

test("board card words: the state, then what and where, private projects unnamed", () => {
  assert.equal(cardText(cardWords({ state: "WORKING", work: "issue", repo: "hq" }, undefined, "building")), "Working · on an issue · hq");
  assert.equal(cardText(cardWords({ state: "WORKING", work: "changes" }, undefined, "fixing")), "Working · addressing review feedback · private project");
  assert.equal(cardText(cardWords({ state: "REVIEW", repo: "hq" }, undefined, "review", "Lyra")), "Reviewing · Lyra's pull request · hq");
  assert.equal(cardText(cardWords({ state: "REVIEW" }, undefined, "merged")), "Reviewing · a pull request · private project");
  assert.equal(cardText(cardWords({ state: "IDLE" }, { job: "review", repo: "hq" }, "review")), "Idle · pull request open · hq");
  assert.equal(cardText(cardWords({ state: "IDLE" }, { job: "merged" }, "merged")), "Idle · last job merged");
  assert.equal(cardText(cardWords(undefined, undefined, "started")), "Idle · between jobs");
  assert.equal(cardText(cardWords({ state: "DISCUSS", work: "discussion", repo: "hq" }, undefined, "started")), "Discussing · in a design discussion");
  assert.equal(cardText(cardWords({ state: "PAUSED" }, undefined, "started")), "Paused");
});

test("the Merged pile: a token per merge up to the cap, then every author in proportion", () => {
  assert.deepEqual(tokenPile([["Vega", 2], ["Rigel", 0], ["Lyra", 1]], 36), ["Vega", "Vega", "Lyra"]);
  const pile = tokenPile([["Rigel", 23], ["Orion", 20], ["Lyra", 18], ["Kochab", 1]], 10);
  assert.equal(pile.length, 10);
  for (const n of ["Rigel", "Orion", "Lyra", "Kochab"]) assert.ok(pile.includes(n), `${n} keeps a token`);
  assert.ok(pile.filter((n) => n === "Rigel").length >= pile.filter((n) => n === "Kochab").length);
  const skewed = tokenPile([["Rigel", 100], ["Orion", 1], ["Lyra", 1], ["Vega", 1], ["Polaris", 1], ["Kochab", 1], ["Pherkad", 1], ["Yildun", 1]], 10);
  assert.equal(skewed.length, 10, "one each for the small ones doesn't push it past the cap");
  assert.equal(new Set(skewed).size, 8);
  assert.equal(skewed.filter((n) => n === "Rigel").length, 3);
});

test("the Merged pile: tokens Polaris merged are ringed, in proportion when the pile is cut down", () => {
  assert.deepEqual(ringPile([["Vega", 2, 1], ["Lyra", 1, 0]], 36), [{ name: "Vega", ring: true }, { name: "Vega", ring: false }, { name: "Lyra", ring: false }]);
  assert.deepEqual(ringPile([["Vega", 2]], 36).map((t) => t.ring), [false, false], "no ringed count, nothing ringed");
  assert.deepEqual(ringPile([["Vega", 1, 5]], 36), [{ name: "Vega", ring: true }], "never more rings than tokens");
  const pile = ringPile([["Rigel", 40, 30], ["Orion", 20, 1], ["Lyra", 10, 0]], 10);
  assert.deepEqual(pile.map((t) => t.name), tokenPile([["Rigel", 40], ["Orion", 20], ["Lyra", 10]], 10), "the same tokens as without rings");
  const rings = (n) => pile.filter((t) => t.name === n && t.ring).length;
  assert.deepEqual([rings("Rigel"), rings("Orion"), rings("Lyra")], [5, 1, 0], "Rigel: 6 tokens, three quarters of 6 rounded; Orion: at least one");
});

test("replay: the events before the show, so the line can catch up first", () => {
  const { events, agents } = createDemo(17, T0).advance(T0 + 7200);
  const r = recordReplay(emptyReplay(), { events, agents }, (T0 + 7200) * 1000);
  const pre = eventsBefore(r, T0 + 3600);
  assert.ok(pre.length > 0 && pre.every((e) => e.ts < T0 + 3600 && cleanEvent(e)), "clean events, all before the start");
  assert.ok(pre.every((e, i) => i === 0 || e.ts >= pre[i - 1].ts), "in time order");
  assert.equal(pre.filter((e) => e.kind === "github" || e.kind === "request").length, r.work.filter((w) => w.ts < T0 + 3600).length);
  assert.ok(pre.filter((e) => e.kind === "request").every((e) => ["opened_issue", "commented"].includes(e.action)));
  assert.deepEqual(eventsBefore(undefined, 0), []);
  // a show starting mid-minute: that minute's row is the show's, not the catch-up's too
  const mid = { pulses: [[(T0 + 3600) / 60, 2]], work: [] };
  assert.equal(plan(mid, { from: T0 + 3630, to: T0 + 7200, durationMs: 60_000, maxPulses: 900, rand: () => 0.5 }).length, 2);
  assert.deepEqual(eventsBefore(mid, T0 + 3630), []);
});
