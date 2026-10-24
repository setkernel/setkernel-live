// ?demo: sample data so the page can be shown any time, clearly labelled as such on the page.
// A small seeded simulation of four agents picking up issues, opening pull requests, reviewing
// each other's and talking in the team chat, with a test run each time they open or push to a pull
// request, and a merge a while after each approval. Polaris and its three Claudes are seen only
// through GitHub, as on the live page: Polaris reviews a waiting pull request now and then, and
// Kochab, Pherkad and Yildun each open one now and then, merged later. Polaris (and now and then
// Kochab) sends the team requests, Polaris merges most pull requests, and Yildun's Claude requests
// show while it works (setkernel-live#35). It produces only events the
// Worker's allowlist accepts unchanged
// (test/page-logic.test.mjs checks that), and the page feeds them through the same reducer as the
// Durable Object. No DOM here.
import { AGENTS, ENGINEERS, POLE, applyBatch, emptyReplay, emptyState, homeDay, recordReplay } from "./state.js";

// Public repos are named on the live page and private ones never are; null stands for private.
// The page names only a repo a visitor could check, so the one public repo is a real one.
const REPOS = ["setkernel-live", null, null, null, null];

const CI_PASS = 0.85; // share of test runs that pass

// Seconds between requests to the team, and the share of merges Polaris makes.
const REQUEST_GAP = [900, 3600];
const POLARIS_MERGES = 0.7;
const YILDUN_CLAUDE = 0.05; // Yildun's Claude requests per second while it works

// Seconds between a pole star's pull requests (or, for Polaris, its reviews): [shortest, longest].
const POLE_GAP = { Polaris: [1500, 4800], Kochab: [3600, 9000], Pherkad: [1800, 6000], Yildun: [3000, 8400] };

// Events per second while busy, per kind.
const RATE = {
  WORKING: { claude: 0.08, chat: 0.004, helper: 0.008 },
  REVIEW: { claude: 0.07, chat: 0.008, helper: 0.006 },
  DISCUSS: { claude: 0.05, chat: 0.02, helper: 0 },
};

// mulberry32: a tiny seeded PRNG, so a seed always tells the same story.
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// Poisson-distributed count for a mean (small means only).
function poisson(rand, mean) {
  let n = 0, p = Math.exp(-mean), s = p;
  const u = rand();
  while (u > s && n < 50) { n++; p *= mean / n; s += p; }
  return n;
}

// createDemo(seed, startS) -> { advance(toS) -> { events, agents } }. Time is in seconds; each
// call returns what happened since the last call, in time order, and the agents' picture now.
export function createDemo(seed = 17, startS = Math.trunc(Date.now() / 1000)) {
  const rand = seeded(seed);
  const ciRand = seeded(seed ^ 0x5eed); // its own stream, so test runs don't change the rest of the story
  const poleRand = seeded(seed ^ 0x9013); // and one for requests, Polaris's merges and Yildun's Claude
  const between = (lo, hi) => lo + rand() * (hi - lo);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  let t = startS;
  const a = Object.fromEntries(AGENTS.map((n, i) => [n, { state: "IDLE", until: t + 5 + i * between(6, 20), todo: null }]));
  const waiting = []; // pull requests waiting for a review: { author, repo }
  const merging = []; // approved pull requests waiting for a person to merge them: { author, repo, at }

  const gh = (agent, action, repo, ts) => ({ t: "msg", kind: "github", agent, action, ...(repo ? { repo } : {}), ts });
  // a test run has no agent: only the result, and the repo when it is public
  const ci = (repo, ts) => ({ t: "msg", kind: "ci", result: ciRand() < CI_PASS ? "pass" : "fail", ...(repo ? { repo } : {}), ts });
  const set = (agent, state, work, repo, until) => Object.assign(a[agent], { state, work, repo, until });
  // a request names who sent it and, for a public repo, where; never what it asked
  let requestAt = t + REQUEST_GAP[0] * poleRand();
  function request(ts) {
    const agent = poleRand() < 0.8 ? "Polaris" : "Kochab";
    const action = agent === "Polaris" && poleRand() < 0.6 ? "opened_issue" : "commented";
    const repo = REPOS[Math.floor(poleRand() * REPOS.length)];
    return { t: "msg", kind: "request", agent, action, ...(repo ? { repo } : {}), ts };
  }

  // A pole star's turn. Polaris reviews a waiting pull request when there is one. Its Claudes work
  // on one of their own for a while, then open it; it is merged later (they share Polaris's
  // account, which can't approve its own pull requests).
  function nextPole(name, at, out) {
    const me = a[name];
    const [lo, hi] = POLE_GAP[name];
    if (name === "Polaris") {
      const pr = waiting.findIndex((p) => ENGINEERS.includes(p.author));
      if (pr >= 0 && rand() < 0.6) {
        const { author, repo } = waiting.splice(pr, 1)[0];
        const ok = rand() < 0.85;
        out.push(gh(name, ok ? "approved" : "requested_changes", repo, at));
        if (ok) merging.push({ author, repo, at: at + between(60, 600) });
        else a[author].todo = { repo };
      }
      return set(name, "IDLE", undefined, undefined, at + between(lo, hi));
    }
    if (me.state === "WORKING") {
      out.push(gh(name, "opened_pr", me.repo, at));
      out.push(ci(me.repo, at));
      merging.push({ author: name, repo: me.repo, at: at + between(600, 2400) });
      return set(name, "IDLE", undefined, undefined, at + between(lo, hi));
    }
    return set(name, "WORKING", "issue", pick(REPOS), at + between(900, 2400));
  }

  // An agent's current task ends at time `at`: what it did, then what it does next.
  function next(name, at, out) {
    if (POLE.includes(name)) return nextPole(name, at, out);
    const me = a[name];
    if (me.state === "WORKING") {
      if (me.work === "changes") out.push(gh(name, "pushed", me.repo, at));
      else out.push(gh(name, "opened_pr", me.repo, at));
      out.push(ci(me.repo, at));
      waiting.push({ author: name, repo: me.repo });
      return set(name, "IDLE", undefined, undefined, at + between(60, 420));
    }
    if (me.state === "REVIEW") {
      const ok = rand() < 0.7;
      out.push(gh(name, ok ? "approved" : "requested_changes", me.repo, at));
      if (ok && me.reviewing) merging.push({ author: me.reviewing, repo: me.repo, at: at + between(120, 1200) });
      if (!ok && me.reviewing) a[me.reviewing].todo = { repo: me.repo };
      me.reviewing = null;
      return set(name, "IDLE", undefined, undefined, at + between(60, 300));
    }
    if (me.state === "DISCUSS") {
      out.push(gh(name, rand() < 0.35 ? "decision_pr" : "posted_round", null, at));
      return set(name, "IDLE", undefined, undefined, at + between(30, 240));
    }
    // idle or paused: start something
    if (me.todo) {
      const { repo } = me.todo;
      me.todo = null;
      return set(name, "WORKING", "changes", repo, at + between(180, 600));
    }
    const pr = waiting.findIndex((p) => p.author !== name);
    if (pr >= 0 && rand() < 0.75) {
      const { author, repo } = waiting.splice(pr, 1)[0];
      me.reviewing = author;
      return set(name, "REVIEW", "review", repo, at + between(120, 420));
    }
    if (rand() < 0.1) {
      out.push(gh(name, "posted_round", null, at));
      return set(name, "DISCUSS", "discussion", undefined, at + between(60, 150));
    }
    if (rand() < 0.04) return set(name, "PAUSED", undefined, undefined, at + between(60, 300));
    const repo = pick(REPOS);
    out.push(gh(name, "picked_up", repo, at));
    return set(name, "WORKING", "issue", repo, at + between(1200, 3000));
  }

  function picture() {
    const out = {};
    for (const n of ENGINEERS) { // the pole stars have no state on the page
      const { state, work, repo } = a[n];
      out[n] = { state, ...(work ? { work } : {}), ...(repo ? { repo } : {}) };
    }
    return out;
  }

  return {
    advance(toS) {
      const out = [];
      while (t < toS) {
        const step = Math.min(5, toS - t); // fine enough that tasks end close to when they're due
        for (const n of AGENTS) {
          const me = a[n];
          const rate = POLE.includes(n) ? null : RATE[me.state]; // the pole stars' chat and helpers never reach the page; Yildun's Claude comes below
          if (rate) {
            for (const [kind, r] of Object.entries(rate)) {
              for (let i = poisson(rand, r * step); i > 0; i--) out.push({ t: "msg", kind, agent: n, ts: Math.trunc(t + rand() * step) });
            }
          }
          if (me.until <= t + step) next(n, Math.trunc(Math.max(t, me.until)), out);
        }
        if (a.Yildun.state === "WORKING") {
          for (let i = poisson(poleRand, YILDUN_CLAUDE * step); i > 0; i--) out.push({ t: "msg", kind: "claude", agent: "Yildun", ts: Math.trunc(t + poleRand() * step) });
        }
        if (requestAt <= t + step) {
          out.push(request(Math.trunc(Math.max(t, requestAt))));
          requestAt += REQUEST_GAP[0] + poleRand() * (REQUEST_GAP[1] - REQUEST_GAP[0]);
        }
        for (let i = merging.length - 1; i >= 0; i--) {
          const m = merging[i];
          if (m.at > t + step) continue;
          merging.splice(i, 1);
          const at = Math.trunc(Math.max(t, m.at));
          out.push(gh(m.author, "merged", m.repo, at));
          // the director's Claudes share its account, so their merges are always Polaris's
          if (POLE.includes(m.author) || poleRand() < POLARIS_MERGES) out.push(gh("Polaris", "merged_by", m.repo, at));
        }
        t += step;
      }
      out.sort((x, y) => x.ts - y.ts);
      return { events: out, agents: picture() };
    },
  };
}

// ---- the Day page's demo (setkernel-live#48): a whole day, as minute batches { at, events, agents }

// The simulation runs at a quarter of its speed: at its own it makes about 800 GitHub actions a
// day, and the replay keeps 300; a quarter is about 200, the real team's busy day. Only the times
// change. Returns { advance(toS) } like createDemo, on the page's clock from `startS`.
export function slowDemo(seed = 17, startS = Math.trunc(Date.now() / 1000), slow = 4) {
  const base = 1_800_000_000;
  const demo = createDemo(seed, base);
  return {
    advance(toS) {
      const { events, agents } = demo.advance(base + (toS - startS) / slow);
      return { agents, events: events.map((e) => ({ ...e, ts: startS + (e.ts - base) * slow })) };
    },
  };
}

// The busy day: the slowed simulation over the 24 hours before `nowS`, as one batch a minute.
// `sim` keeps going afterwards for the live demo.
export function busyDay(nowS, seed = 17) {
  const startS = nowS - 86_400;
  const sim = slowDemo(seed, startS);
  const batches = [];
  for (let t = startS + 60; t <= nowS; t += 60) batches.push({ at: t, ...sim.advance(t) });
  return { batches, sim };
}

// ?demo=down (setkernel-live#54): the busy day with Orion's VM stopped 2 h 35 min before `nowS`
// (at 16:40, his last run ended at 14:05). Nothing more comes from his VM: no Claude requests, chat
// posts or GitHub actions of his own. A merge of his pull request still arrives from GitHub. He
// reads Idle for the first 15 minutes, as sk-obs01 sends it (setkernel/hq#396), then SILENT with
// lastRun, his last run's end on a whole minute. `sim` keeps going for the live demo, and he stays
// stopped.
export const DOWN = { name: "Orion", ago: 155 * 60, after: 15 * 60 };
export function downDay(nowS, seed = 17) {
  const from = Math.floor((nowS - DOWN.ago) / 60) * 60;
  const stop = (b) => {
    if (b.at <= from) return b;
    const events = b.events.filter((e) => !(e.agent === DOWN.name && (e.ts ?? b.at) >= from && e.action !== "merged"));
    return { ...b, events, agents: { ...b.agents, [DOWN.name]: b.at - from >= DOWN.after ? { state: "SILENT", lastRun: from } : { state: "IDLE" } } };
  };
  const { batches, sim } = busyDay(nowS, seed);
  return { batches: batches.map(stop), sim: { advance: (toS) => stop({ at: toS, ...sim.advance(toS) }) }, from };
}

// The quiet day, written by hand (docs/design/v3/day): nothing is added to fill the lanes. One job
// today: Polaris asks, Orion builds it, CI fails, Orion pushes fixes, Lyra approves, Polaris
// merges after lunch. Rigel's job from yesterday evening was approved by Orion and merged before
// midnight. Vega and the three Claudes do nothing. The times are the design's, with "now" at
// 16:40: on another clock the story keeps its distance from now.
export function quietDay(nowS) {
  const at = (h, m) => nowS - (16 * 60 + 40 - (h * 60 + m)) * 60; // today, on the design's clock
  const yday = (h, m) => at(h, m) - 86_400;
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
  ev.push({ t: "msg", kind: "request", agent: "Polaris", action: "opened_issue", repo: "setkernel-live", ts: at(8, 50) });
  gh("Orion", "picked_up", "setkernel-live", at(9, 12));
  pulses("Orion", "claude", at(9, 13), at(10, 29), 45);
  pulses("Orion", "helper", at(9, 40), at(10, 20), 600);
  pulses("Orion", "chat", at(9, 15), at(9, 16), 60);
  gh("Orion", "opened_pr", "setkernel-live", at(10, 31));
  ev.push({ t: "msg", kind: "ci", result: "fail", repo: "setkernel-live", ts: at(10, 31) });
  pulses("Orion", "claude", at(10, 33), at(10, 47), 50);
  gh("Orion", "pushed", "setkernel-live", at(10, 48));
  ev.push({ t: "msg", kind: "ci", result: "pass", repo: "setkernel-live", ts: at(10, 48) });
  pulses("Lyra", "claude", at(11, 30), at(11, 41), 40);
  pulses("Lyra", "chat", at(11, 41), at(11, 42), 60);
  gh("Lyra", "approved", "setkernel-live", at(11, 41));
  gh("Orion", "merged", "setkernel-live", at(14, 2));
  gh("Polaris", "merged_by", "setkernel-live", at(14, 2));
  ev.sort((a, b) => a.ts - b.ts);
  // the states as they were: Orion working 09:12-10:48, Lyra reviewing 11:30-11:41
  const agents = (t) => {
    const a = Object.fromEntries(ENGINEERS.map((n) => [n, { state: "IDLE" }]));
    if (t >= yday(20, 22) && t < yday(20, 36)) a.Orion = { state: "REVIEW", work: "review" };
    if (t >= at(9, 12) && t < at(10, 49)) a.Orion = { state: "WORKING", work: "issue", repo: "setkernel-live" };
    if (t >= at(11, 30) && t < at(11, 42)) a.Lyra = { state: "REVIEW", work: "review", repo: "setkernel-live" };
    return a;
  };
  const batches = [];
  let i = 0;
  for (let t = nowS - 86_400 - 3600 + 60; t <= nowS; t += 60) {
    const events = [];
    while (i < ev.length && ev[i].ts < t) events.push(ev[i++]);
    batches.push({ at: t, agents: agents(t), events });
  }
  return { batches };
}

// Minute batches through the same reducers as the Durable Object, up to `untilS` -> { state,
// replay }. The day key is the Halifax date, as the Worker's.
export function runDay(batches, untilS = Infinity, from = { state: null, replay: emptyReplay() }) {
  let state = from.state ?? emptyState(homeDay((batches[0]?.at ?? 0) * 1000));
  let replay = from.replay;
  for (const b of batches) {
    if (b.at > untilS) break;
    state = applyBatch(state, b, b.at * 1000, homeDay(b.at * 1000));
    replay = recordReplay(replay, b, b.at * 1000);
  }
  return { state, replay };
}
