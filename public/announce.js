// What the page says about new work, in words: the feed lines and the summary a screen reader
// hears through the aria-live region. No DOM here, so it runs under `node --test`.

export const ACTION_TEXT = {
  picked_up: "started on an issue",
  opened_pr: "opened a pull request",
  approved: "approved a teammate's pull request",
  requested_changes: "asked for changes on a teammate's pull request",
  pushed: "pushed fixes to a pull request",
  posted_round: "posted in a design discussion",
  decision_pr: "wrote up a decision",
};

export const ANNOUNCE_EVERY_MS = 30_000;
const MAX_SENTENCES = 3;

// One GitHub event -> "Vega opened a pull request in lafka-plugin."
export function sentence(e) {
  return `${e.agent} ${ACTION_TEXT[e.action] || "did something"}${e.repo ? ` in ${e.repo}` : ""}.`;
}

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
