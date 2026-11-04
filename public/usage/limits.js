// live.setkernel.com/usage (setkernel-live#86): each seat's 5-hour and weekly limit windows, as the
// page says them. Pure and tested (test/usage-page.test.mjs). GET /usage/data is to carry them as
// `limits`, from the seat view the wall reads (setkernel/hq observability/wall/limits.py):
//   { <seat>: { five_hour: { utilization: 0.84, resets_at, observed_at } | null, seven_day: { ... } | null,
//               event: { status: "rejected", rate_limit_type: "five_hour", resets_at, received_at } | null } }
// with times as ISO 8601 strings. Until it does, the page says it can't check limits and shows no figure.
// The rules are the wall's: a window with no reset time resets a window's length after it was read.
import { homeDay } from "../lib/state.js";
import { seatName } from "./table.js";

// The alerts, in percent, as on the wall. usage.css places their ticks: .at80 and .at70.
export const THRESHOLD = { five_hour: 80, seven_day: 70 };
export const WINDOWS = [["five_hour", "5-hour"], ["seven_day", "weekly"]];
const LENGTH = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 };

// Codex has no Claude limits, and "other" is usage no seat claimed: neither has a window to read.
export const hasLimits = (seat) => seat !== "codex" && seat !== "other";

const ms = (t) => (typeof t === "string" ? Date.parse(t) : typeof t === "number" ? t : NaN);
const clock = new Intl.DateTimeFormat("en-US", { timeZone: "America/Halifax", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
// An instant in Halifax: "16:10" on the same day as `now`, else "Thu 21:00".
export function when(t, now) {
  const p = Object.fromEntries(clock.formatToParts(t).map((x) => [x.type, x.value]));
  return homeDay(t) === homeDay(now) ? `${p.hour}:${p.minute}` : `${p.weekday} ${p.hour}:${p.minute}`;
}

// One window of one seat at `now`:
//   nolimits  the seat has none (Codex): never 0%
//   unread    the page has no limits at all
//   none      not reported
//   stale     read before the window last reset, so it says nothing about now: the figure is not shown
//   fresh     { level: ok | over | limit, pct, resets, read, hit }
// The figure is rounded down, so what the page shows and the alert agree: over is pct >= the alert, as
// on the wall; the limit is 100% or a request rejected for this window since it last opened.
export function windowOf(limits, seat, name, now) {
  if (!hasLimits(seat)) return { kind: "nolimits" };
  if (!limits) return { kind: "unread" };
  const s = limits[seat], w = s?.[name], read = ms(w?.observed_at);
  if (!Number.isFinite(w?.utilization) || w.utilization < 0 || !Number.isFinite(read)) return { kind: "none" };
  const resets = Number.isFinite(ms(w.resets_at)) ? ms(w.resets_at) : read + LENGTH[name];
  if (resets <= now) return { kind: "stale", read };
  const ev = s.event, at = ms(ev?.received_at);
  const hit = ev?.status === "rejected" && ev.rate_limit_type === name && at > resets - LENGTH[name] && !(ms(ev.resets_at) <= now) ? at : null;
  const pct = Math.floor(w.utilization * 100 + 1e-9);
  return { kind: "fresh", level: pct >= 100 || hit != null ? "limit" : pct >= THRESHOLD[name] ? "over" : "ok", pct, resets, read, hit };
}

// What a meter says: the big figure, the flag beside it, the lines under it, and one label for a
// screen reader. Colour only repeats the words.
export function meter(v, seat, name, label, now) {
  const t = THRESHOLD[name], who = `${seatName(seat)} ${label}`;
  if (v.kind === "fresh") {
    const flag = v.level === "limit" ? "LIMIT HIT" : `${v.level === "over" ? "over" : "under"} ${t}%`;
    const meta = [`resets ${when(v.resets, now)}`, `read ${when(v.read, now)}`, ...(v.hit != null ? [`rejected ${when(v.hit, now)}`] : [])];
    return { pct: v.pct, flag, meta, label: `${who}: ${v.pct}%, ${v.level === "limit" ? "limit hit" : flag}, ${meta.join(", ")}` };
  }
  if (v.kind === "stale") return { flag: `no fresh reading since ${when(v.read, now)}`, meta: ["it reset since; the old figure is not shown"], label: `${who}: no fresh reading since ${when(v.read, now)}` };
  return { flag: "not reported", meta: ["no reading from this seat"], label: `${who}: not reported` };
}

// The sticky strip's few characters for a window.
export const mini = (v) => (v.kind === "stale" ? "stale" : v.kind === "none" ? "not reported" : v.level === "limit" ? "LIMIT HIT" : `${v.pct}%`);

// The worst of a seat's windows, for the mark down its row's left edge.
export const alertOf = (views) =>
  views.some((v) => v.level === "limit") ? "limit" : views.some((v) => v.level === "over") ? "over" : views.some((v) => v.kind === "stale" || v.kind === "none") ? "gap" : null;

// "Needs a look": a sentence per problem, worst first, then in seat order; [] is nothing; null is
// that there are no limits to check.
export function needs(limits, seats, now) {
  if (!limits) return null;
  const items = [];
  for (const seat of seats.filter(hasLimits)) {
    const name = seatName(seat), gaps = [];
    for (const [w, label] of WINDOWS) {
      const v = windowOf(limits, seat, w, now), resets = v.resets && when(v.resets, now);
      if (v.level === "limit") items.push({ sev: 0, kind: "limit", seat, text: v.hit != null ? `${name} hit the ${label} limit at ${when(v.hit, now)}, resets ${resets}` : `${name}'s ${label} is at ${v.pct}%, resets ${resets}` });
      else if (v.level === "over") items.push({ sev: 1, kind: "over", seat, text: `${name}'s ${label} is at ${v.pct}%, resets ${resets}` });
      else if (v.kind === "stale") items.push({ sev: 2, kind: "gap", seat, text: `${name}'s ${label} has no fresh reading since ${when(v.read, now)}` });
      else if (v.kind === "none") gaps.push(label);
    }
    if (gaps.length === 2) items.push({ sev: 2, kind: "gap", seat, text: `${name} is not reporting` });
    else if (gaps.length) items.push({ sev: 2, kind: "gap", seat, text: `${name}'s ${gaps[0]} is not reported` });
  }
  return items.sort((a, b) => a.sev - b.sev);
}
