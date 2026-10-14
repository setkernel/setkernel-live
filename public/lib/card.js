// What a star's card and an engineer's board card say (setkernel-live#36). Pure: the page shows
// these with textContent, and they are tested. A star card is the star's state, where it is on the
// line, its job as five steps with times, today's numbers and its latest three actions. Polaris and
// its three Claudes get the director's version, which points to the director strip.
import { ENGINEERS, POLE } from "./state.js";
import { STAGE_NAME, column, steps } from "./line.js";
import { GLYPH, STAR_NOTE, STATE_WORDS, deed, stateWords } from "./words.js";

// Who each of the director's Claude sessions is.
export const SESSION_NOTE = { Kochab: "the lead chat", Pherkad: "cloud sessions", Yildun: "its own machine" };

const DOING = { issue: "on an issue", changes: "addressing review feedback", decision: "writing up a decision" };

// An engineer's board card: { glyph, state, rest, repo } where repo is a public repo's name, null
// for a private project, or undefined when the card names no project (a design discussion, a
// pause, a finished job). target: whose pull request it is reviewing, when the page knows.
export function cardWords(info, lane, col, target) {
  const st = STATE_WORDS[info?.state] ? info.state : "IDLE";
  const out = { glyph: GLYPH[st], state: STATE_WORDS[st], rest: "", repo: undefined };
  if (st === "WORKING") Object.assign(out, { rest: DOING[info.work] ?? "", repo: info.repo ?? null });
  else if (st === "REVIEW") Object.assign(out, { rest: target ? `${target}'s pull request` : "a pull request", repo: info.repo ?? null });
  else if (st === "DISCUSS") Object.assign(out, info.work === "decision" ? { rest: "writing up a decision", repo: info.repo ?? null } : { rest: "in a design discussion" });
  else if (st === "IDLE") {
    if (col === "review") Object.assign(out, { rest: "pull request open", repo: lane?.repo ?? null });
    else if (col === "merged") out.rest = "last job merged";
    else out.rest = "between jobs";
  }
  return out;
}

// The card as one line of text, for a screen reader's label: "Working · on an issue · hq".
export function cardText({ state, rest, repo }) {
  return [state, rest, repo === undefined ? "" : repo ?? "private project"].filter(Boolean).join(" · ");
}

// A star's card. v: the page's picture ({ agents, byAgent, feed, line }); targets: { reviewer:
// author }. Returns { director, eyebrow, title, note?, state?, column, task?, steps?, numbers,
// latest } with numbers as [[count, label]] and latest as [{ text, ts }].
export function starCard(name, v, nowS, targets = {}) {
  const c = v?.byAgent?.[name] ?? {};
  const latest = (v?.feed ?? []).filter((f) => f.agent === name).slice(0, 3).map((f) => ({ text: deed(f), ts: f.ts }));
  if (POLE.includes(name)) {
    const polaris = name === "Polaris";
    return {
      director: true,
      eyebrow: polaris ? "The director" : "The director's group · Ursa Minor",
      title: name,
      note: `${polaris ? STAR_NOTE.Polaris : SESSION_NOTE[name]} · seen only through GitHub, with no live state`,
      column: "the director strip",
      numbers: polaris ? [[c.reviews ?? 0, "reviews"], [c.prs ?? 0, "PRs opened"]] : [[c.prs ?? 0, "PRs opened"], [c.merged ?? 0, "merged"]],
      latest,
    };
  }
  if (!ENGINEERS.includes(name)) return null;
  const info = v?.agents?.[name];
  const lane = v?.line?.[name];
  const col = column(lane, info, nowS);
  const sw = stateWords(info);
  if (info?.state === "REVIEW" && targets[name]) sw.words = `reviewing ${targets[name]}'s pull request`;
  return {
    director: false,
    eyebrow: "Engineer",
    title: name,
    state: sw,
    column: STAGE_NAME[col],
    task: col === "merged" ? "Last task" : "Current task",
    steps: steps(lane, col),
    numbers: [[c.prs ?? 0, "PRs opened"], [c.reviews ?? 0, "reviews"], [c.claude ?? 0, "Claude requests"]],
    latest,
  };
}

// The Merged pile: one token per merged pull request, in its author's colour, at most `cap`. Past
// the cap each author keeps a share in proportion (at least one each), so nobody drops off the
// pile; the count beside it stays exact. The pile goes over the cap only when there are more
// authors than tokens. counts: [[name, merged]] in the order to show.
export function tokenPile(counts, cap) {
  const live = counts.filter(([, n]) => n > 0);
  const total = live.reduce((a, [, n]) => a + n, 0);
  if (total <= cap) return live.flatMap(([name, n]) => Array(n).fill(name));
  const share = live.map(([name, n]) => ({ name, n: Math.max(1, Math.floor((n * cap) / total)), rest: (n * cap) / total % 1 }));
  let left = cap - share.reduce((a, s) => a + s.n, 0);
  // the floor of one each can push it over: take the excess back from the biggest shares
  while (left < 0) {
    const big = share.reduce((a, s) => (s.n > a.n ? s : a));
    if (big.n <= 1) break;
    big.n--;
    left++;
  }
  for (const s of [...share].sort((a, b) => b.rest - a.rest)) {
    if (left <= 0) break;
    s.n++;
    left--;
  }
  return share.flatMap((s) => Array(s.n).fill(s.name));
}
