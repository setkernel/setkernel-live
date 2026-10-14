// The page's pure modules: the words it shows, the ?demo simulation, the replay show and the sky
// layout. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { COLUMNS, POLE, cleanBatch, cleanEvent, emptyReplay, emptyState, recordReplay, applyBatch } from "../src/logic.js";
import { STAR_NOTE, ciSummary, ciWhere, ciWord, clock, createAnnouncer, doing, freshness, headline, reviewTarget, sentence, starLabel, summarise, tally, todaySince, whereWork, zoneName } from "../public/lib/words.js";
import { createDemo, seeded } from "../public/lib/demo.js";
import { plan } from "../public/lib/replay.js";
import { skyLayout } from "../public/lib/layout.js";

const T0 = 490_000 * 3600; // seconds; 2025-11-23 16:00 UTC

test("headline: who is doing what, most recently active first", () => {
  const now = T0 * 1000;
  const h = headline({
    agents: { Rigel: { state: "WORKING", work: "issue", repo: "setkernel-live" }, Lyra: { state: "REVIEW", work: "review" }, Vega: { state: "IDLE" }, Orion: { state: "PAUSED" } },
    seen: { Rigel: T0 - 5, Lyra: T0 - 50 }, lastIngest: now - 5000, now,
  });
  assert.equal(h.main, "Rigel is working on an issue in setkernel-live.");
  assert.equal(h.sub, "Lyra is reviewing a pull request. Orion is paused.");
  assert.equal(h.mood, "live");
});

test("headline: quiet says since when and what came last; offline and waiting say so", () => {
  const now = T0 * 1000;
  const feed = [{ agent: "Vega", action: "opened_pr", repo: "lafka-plugin", ts: T0 - 600 }];
  const quiet = headline({ agents: { Vega: { state: "IDLE" } }, seen: { Vega: T0 - 600, Rigel: T0 - 900 }, feed, lastIngest: now - 5000, now, timeZone: "UTC" });
  assert.deepEqual(quiet, { main: "All quiet, since 15:50.", sub: "Last: Vega opened a pull request in lafka-plugin.", mood: "quiet" });
  assert.equal(headline({ agents: {}, lastIngest: now, now }).main, "All quiet. Nothing yet today.");
  assert.equal(headline({ lastIngest: now - 10 * 60_000, now, timeZone: "UTC" }).main, "No word from the office since 15:50.");
  assert.equal(headline({ lastIngest: now - 10 * 60_000, now, timeZone: "America/Halifax" }).main, "No word from the office since 11:50.");
  assert.equal(headline({ lastIngest: 0, now }).mood, "waiting");
});

test("labels, tallies and feed sentences", () => {
  assert.equal(doing({ state: "DISCUSS" }), "in a design discussion");
  assert.equal(doing({ state: "WORKING", work: "changes", repo: "hq" }), "addressing review feedback in hq");
  assert.equal(doing({ state: "IDLE", work: "issue" }), "idle");
  assert.deepEqual(starLabel({ state: "WORKING", work: "issue", repo: "setkernel-live" }), { state: "Working", detail: "on an issue · setkernel-live" });
  assert.deepEqual(starLabel({ state: "REVIEW", work: "review" }), { state: "Reviewing", detail: "a pull request" });
  assert.deepEqual(starLabel({ state: "DISCUSS", work: "discussion", repo: "hq" }), { state: "Discussing", detail: "hq" });
  assert.deepEqual(starLabel({ state: "IDLE", repo: "x" }), { state: "Idle", detail: "" });
  assert.deepEqual(starLabel(undefined), { state: "Idle", detail: "" });
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
  const kinds = new Set(events.map((e) => e.kind === "github" ? e.action : e.kind));
  for (const k of ["claude", "chat", "helper", "ci", "picked_up", "opened_pr", "approved", "requested_changes", "pushed", "posted_round", "decision_pr", "merged"]) {
    assert.ok(kinds.has(k), `demo shows ${k}`);
  }
  // the pole stars are seen only through GitHub, as on the live page, and have no state: Polaris
  // reviews, its three Claudes open pull requests and have them merged
  const polaris = events.filter((e) => e.agent === "Polaris");
  assert.ok(polaris.length >= 4 && polaris.every((e) => e.kind === "github" && (e.action === "approved" || e.action === "requested_changes")), `${polaris.length} Polaris events`);
  for (const name of ["Kochab", "Pherkad", "Yildun"]) {
    const mine = events.filter((e) => e.agent === name);
    assert.ok(mine.length >= 2 && mine.every((e) => e.kind === "github"), `${mine.length} ${name} events`);
    assert.ok(mine.some((e) => e.action === "opened_pr"), `${name} opens a pull request`);
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
  const github = day.filter((e) => e.kind === "github");
  assert.equal(github.length, r.work.length);
  assert.ok(day.length - github.length <= 1800 * 1.1, `${day.length - github.length} pulses`);
  assert.ok(day.every((e, i) => e.at >= 0 && e.at <= 120_000 && (i === 0 || e.at >= day[i - 1].at)));
  const hour = plan(r, { from: T0 + 82_800, to: T0 + 86_400, durationMs: 60_000, maxPulses: 100_000, rand });
  const pulseCols = (p) => p.slice(1).filter((_, i) => COLUMNS[i][1] !== "github"); // every column but GitHub's
  const want = r.pulses.filter((p) => p[0] * 60 >= T0 + 82_800).reduce((n, p) => n + pulseCols(p).reduce((x, y) => x + y, 0), 0);
  assert.equal(hour.filter((e) => e.kind !== "github").length, want, "nothing thinned under the cap");
  assert.deepEqual(plan(undefined, { from: 0, to: 1, durationMs: 1, maxPulses: 1 }), []);
});

test("sky layout: every star and place inside the sky at every size, never crowded", () => {
  const sizes = [[320, 520], [375, 560], [812, 300], [768, 560], [1440, 620], [2560, 900], [3840, 1600], [1024, 700], [600, 640]];
  for (const [w, h] of sizes) {
    const L = skyLayout(w, h);
    assert.equal(L.mode, w / h >= 1.1 ? "wide" : "tall", `${w}x${h}`);
    const points = [...Object.values(L.stars), ...Object.values(L.places)];
    for (const p of points) assert.ok(p.x >= 16 && p.x <= w - 16 && p.y >= 16 && p.y <= h - 16, `${w}x${h}: ${JSON.stringify(p)}`);
    // an engineer has room for its words from every other star; the pole group, whose words are
    // short, sits closer together
    const names = Object.keys(L.stars);
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const [a, b] = [names[i], names[j]], d = Math.hypot(L.stars[a].x - L.stars[b].x, L.stars[a].y - L.stars[b].y);
        const min = POLE.includes(a) && POLE.includes(b) ? 44 : 80;
        assert.ok(d >= min, `${w}x${h}: ${a} and ${b} are ${Math.round(d)} px apart`);
      }
    }
  }
  assert.equal(skyLayout(375, 560).places.github.label, "below");
});
