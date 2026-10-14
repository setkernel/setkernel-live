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
import { AGENTS, ENGINEERS, POLE } from "./state.js";

// Public repos are named on the live page and private ones never are; null stands for private.
const REPOS = ["setkernel-live", null, null, "example-site", null];

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
