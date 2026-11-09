// The read model (hq#208): what the control Worker publishes to the board, checked, and the views
// built from the board's rows. Pure functions; board.js stores, index.js serves.
//
// The control Worker publishes what its objects already answer (the control Worker's data model):
//   items: WorkItem.get() results, { item: { ref, kind, state, rev, seat, pr, updated_at }, dispatch }
//          (dispatch is the control Worker's last routine fire, with session_url; it may be absent)
// Anything else is dropped with a reason, so one bad entry never blocks the rest of a batch.
// The queue, running work and seats are no longer shown (hq#1330): a batch's `seats`
// is ignored, and items only feed the "last 24 h" list.

// The control Worker's work item states, so an item is never rejected for a state the control Worker can reach. Kept in
// step by hand with STATES in the control Worker's model.js; status has no import from the control Worker.
export const STATES = ["new", "queued", "dispatched", "running", "pr_open", "reviewing", "merged", "failed", "closed"];
// off the board: finished, closed without a merge, or back to new (out of the agent flow,
// the control Worker). These rows are pruned after a day; they would otherwise stay forever.
export const ENDED = ["merged", "failed", "closed", "new"];
// the ends the "last 24 h" list counts: one event each time an item reaches one
export const LOGGED = ["merged", "failed"];
export const DAY_MS = 24 * 3600_000;
export const BATCH_MAX = { items: 100 };
export const EVENTS_SHOWN = 50;

const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const REPO = /^[a-z0-9._-]{1,100}$/;
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const REF = /^([^/#]+)\/([^/#]+)#([1-9][0-9]{0,9})$/;

const iso = (v) => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const login = (v) => (typeof v === "string" && LOGIN.test(v.toLowerCase()) ? v.toLowerCase() : null);
const posInt = (v) => (Number.isInteger(v) && v > 0 && v < 1e10 ? v : null);

// "owner/repo#N" -> { repo, number }, or null. Lower-cased, as the control Worker keys its objects.
export function parseRef(ref) {
  const m = typeof ref === "string" ? REF.exec(ref.toLowerCase()) : null;
  if (!m || !OWNER.test(m[1]) || !REPO.test(m[2]) || m[2] === "." || m[2] === "..") return null;
  return { ref: `${m[1]}/${m[2]}#${m[3]}`, repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
}

// Only a claude.ai session link is ever shown or linked (the control Worker keeps the same rule).
export const sessionUrl = (v) => (typeof v === "string" && v.length <= 200 && /^https:\/\/claude\.ai\/[A-Za-z0-9/_?=&.-]*$/.test(v) ? v : null);

// One WorkItem.get() result -> a board row, or { error }.
export function itemRow(entry) {
  const item = entry?.item ?? null;
  if (!item || typeof item !== "object") return { error: "no item" };
  const name = parseRef(item.ref);
  if (!name) return { error: "ref must be owner/repo#N" };
  if (!STATES.includes(item.state)) return { error: `state must be one of ${STATES.join(", ")}` };
  const rev = posInt(item.rev);
  if (!rev) return { error: "rev must be a positive integer" };
  const updated = iso(item.updated_at);
  if (!updated) return { error: "updated_at must be a time" };
  const seat = item.seat == null ? null : login(item.seat);
  if (item.seat != null && !seat) return { error: "seat must be a GitHub login" };
  // the session link belongs to the dispatch that put the item on its current seat
  const d = entry.dispatch;
  const session = d && d.outcome === "fired" && (d.seat == null || login(d.seat) === seat) ? sessionUrl(d.session_url) : null;
  return {
    row: {
      ref: name.ref, repo: name.repo, number: name.number,
      kind: item.kind === "pr" ? "pr" : "issue",
      state: item.state, rev, seat, pr: posInt(item.pr), session_url: session, updated_at: updated,
    },
  };
}

// { items } -> { items: rows, rejected: [{ kind, index, error }] }
export function checkBatch(batch) {
  if (!batch || typeof batch !== "object" || Array.isArray(batch)) return { error: "batch must be { items }" };
  const items = batch.items ?? [];
  if (!Array.isArray(items)) return { error: "items must be an array" };
  if (items.length > BATCH_MAX.items) return { error: `at most ${BATCH_MAX.items} items a batch` };
  const out = { items: [], rejected: [] };
  items.forEach((e, index) => {
    const r = itemRow(e);
    if (r.error) out.rejected.push({ kind: "item", index, error: r.error });
    else out.items.push(r.row);
  });
  return out;
}

const github = (repo, kind, n) => `https://github.com/${repo}/${kind === "pr" ? "pull" : "issues"}/${n}`;
const byTime = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The guard as the page shows it: the levels, and the metrics and reset time of the highest one.
export function guardView(guard) {
  const level = guard.refuse ? "refuse" : guard.degrade ? "degrade" : guard.alert ? "alert" : "ok";
  const d = guard.detail?.[level];
  return {
    level, alert: guard.alert, degrade: guard.degrade, refuse: guard.refuse,
    metrics: Array.isArray(d?.metrics) ? d.metrics.filter((m) => typeof m === "string") : [],
    until: iso(d?.until),
    ...(guard.error ? { unreadable: true } : {}),
  };
}

// The internal view: for Raghav, the wall (hq#127) and Polaris. snapshot is Board.snapshot().
export function internalView(snapshot, guard, now) {
  const since = now.getTime() - DAY_MS;
  const events = snapshot.events.filter((e) => Date.parse(e.at) > since).sort((a, b) => byTime(b.at, a.at));
  return {
    generated_at: now.toISOString(),
    // the board's data as of this time: a reused snapshot can be up to FRESH seconds older
    snapshot_at: iso(snapshot.at),
    guard: guardView(guard),
    last_24h: {
      merged: events.filter((e) => e.state === "merged").length,
      failed: events.filter((e) => e.state === "failed").length,
      events: events.slice(0, EVENTS_SHOWN).map((e) => ({
        at: e.at, state: e.state, ref: e.ref, seat: e.seat, pr: e.pr,
        url: github(e.repo, e.kind, e.number), pr_url: e.pr ? github(e.repo, "pr", e.pr) : null,
      })),
    },
  };
}

// The sanitized view for the public showcase's publisher (hq#213). Built field by field from the
// internal view, never by deleting from it: counts only. No repo, ref, URL, login, session or guard
// detail can reach it, because none is copied.
export function publicView(internal) {
  return {
    generated_at: internal.generated_at,
    last_24h: { merged: internal.last_24h.merged, failed: internal.last_24h.failed },
  };
}
