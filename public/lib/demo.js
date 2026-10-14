// ?demo: sample data so the page can be shown any time, clearly labelled as such on the page.
// A small seeded simulation of four agents picking up issues, opening pull requests, reviewing
// each other's and talking in the team chat, with a test run each time they open or push to a pull
// request, and a merge a while after each approval. Claude (Raghav's own sessions) is seen only
// through GitHub, as on the live page: it opens a pull request now and then, and it is merged later. It produces only events the Worker's allowlist accepts unchanged
// (test/page-logic.test.mjs checks that), and the page feeds them through the same reducer as the
// Durable Object. No DOM here.
import { AGENTS } from "./state.js";

// Public repos are named on the live page and private ones never are; null stands for private.
const REPOS = ["setkernel-live", null, null, "example-site", null];

const CI_PASS = 0.85; // share of test runs that pass

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

  // Claude between pull requests: working on one for a while, then opening it.
  function nextClaude(at, out) {
    const me = a.Claude;
    if (me.state === "WORKING") {
      out.push(gh("Claude", "opened_pr", me.repo, at));
      out.push(ci(me.repo, at));
      merging.push({ author: "Claude", repo: me.repo, at: at + between(600, 2400) });
      return set("Claude", "IDLE", undefined, undefined, at + between(1800, 7200));
    }
    return set("Claude", "WORKING", "issue", pick(REPOS), at + between(900, 2400));
  }

  // An agent's current task ends at time `at`: what it did, then what it does next.
  function next(name, at, out) {
    if (name === "Claude") return nextClaude(at, out);
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
    for (const n of AGENTS) {
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
          const rate = n === "Claude" ? null : RATE[me.state]; // Claude's own requests never reach the page
          if (rate) {
            for (const [kind, r] of Object.entries(rate)) {
              for (let i = poisson(rand, r * step); i > 0; i--) out.push({ t: "msg", kind, agent: n, ts: Math.trunc(t + rand() * step) });
            }
          }
          if (me.until <= t + step) next(n, Math.trunc(Math.max(t, me.until)), out);
        }
        for (let i = merging.length - 1; i >= 0; i--) {
          const m = merging[i];
          if (m.at > t + step) continue;
          merging.splice(i, 1);
          out.push(gh(m.author, "merged", m.repo, Math.trunc(Math.max(t, m.at))));
        }
        t += step;
      }
      out.sort((x, y) => x.ts - y.ts);
      return { events: out, agents: picture() };
    },
  };
}
