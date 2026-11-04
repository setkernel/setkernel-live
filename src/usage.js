// Daily tokens per seat (setkernel-live#66, setkernel/hq#721): hourly usage buckets pushed to
// POST /ingest/usage and read back, summed per Halifax day, from GET /usage/data. Private: the
// Usage Durable Object keeps them apart from the Hub, so no public route can return them. Pure and
// tested (test/usage.test.mjs); the Durable Object is in src/worker.js.
import { homeDay } from "../public/lib/state.js";
import registry from "./hq-registry.json" with { type: "json" };

// Who may push usage (setkernel-live#96): each employee in the hq registry's copy (written by
// scripts/copy-hq-registry.mjs, never by hand), then the seats that are no one there: polaris (Raghav's
// own sessions), codex and other. A person added to or removed from the registry needs no code edit.
export const usageSeats = (employees) => [...employees, "polaris", "codex", "other"];
export const SEATS = usageSeats(registry.employees);
export const SURFACES = ["vm", "desktop", "cli", "cloud", "codex"];
export const COUNTS = ["input", "output", "cache_read", "cache_write", "usd_micros", "requests"];
export const KEEP_DAYS = 400;

const HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,99}$/;
const DAY_MS = 86_400_000;

// "2026-10-14T03" -> its start in ms, or NaN unless it is a real UTC hour.
export function hourMs(hour) {
  if (typeof hour !== "string" || !HOUR.test(hour)) return NaN;
  const ms = Date.parse(`${hour}:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 13) === hour ? ms : NaN;
}
export const hourOf = (ms) => new Date(ms).toISOString().slice(0, 13);

// { buckets: [{ hour, seat, model, surface, input, output, cache_read, cache_write, usd_micros,
// requests }] } -> the buckets with only those fields, or null if any of them is not allowed.
export function cleanUsage(body, seats = SEATS) {
  if (!body || typeof body !== "object" || !Array.isArray(body.buckets)) return null;
  const out = [];
  for (const b of body.buckets) {
    if (!b || typeof b !== "object") return null;
    if (Number.isNaN(hourMs(b.hour)) || !seats.includes(b.seat) || !SURFACES.includes(b.surface)) return null;
    if (typeof b.model !== "string" || !MODEL.test(b.model)) return null;
    if (!COUNTS.every((k) => Number.isSafeInteger(b[k]) && b[k] >= 0)) return null;
    out.push({ hour: b.hour, seat: b.seat, model: b.model, surface: b.surface, ...Object.fromEntries(COUNTS.map((k) => [k, b[k]])) });
  }
  return out;
}

// Each seat's 5-hour and weekly limit windows (setkernel-live#88): the newest reading per seat, pushed
// to POST /ingest/limits and read back as `limits` from GET /usage/data, in the shape
// public/usage/limits.js reads. Codex has no Claude limits, and "other" is no seat, so neither has any.
export const limitSeats = (employees) => usageSeats(employees).filter((s) => s !== "codex" && s !== "other");
export const LIMIT_SEATS = limitSeats(registry.employees);
export const WINDOWS = ["five_hour", "seven_day"];
export const STATUSES = ["allowed", "allowed_warning", "rejected"];
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

// An ISO 8601 time with a zone, "2026-11-04T12:00:00Z" or "...12:00:00.123456+00:00" -> the same
// instant as toISOString() gives it, or null unless it is a real date and time.
export function isoTime(t) {
  const m = typeof t === "string" && t.length <= 40 ? ISO.exec(t) : null;
  if (!m) return null;
  const [y, mo, d, h, mi, s, oh, om] = m.slice(1).map((x) => Number(x ?? 0));
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || h > 23 || mi > 59 || s > 59 || oh > 23 || om > 59) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const plain = (o) => !!o && typeof o === "object" && !Array.isArray(o);
// A reset time may be unknown: null or absent is null, a bad one is undefined.
const resetsAt = (t) => (t == null ? null : (isoTime(t) ?? undefined));
// A window or an event with only the fields the page reads; null if null or absent; undefined if bad.
function cleanWindow(w) {
  if (w == null) return null;
  if (!plain(w) || typeof w.utilization !== "number" || !Number.isFinite(w.utilization) || w.utilization < 0) return undefined;
  const resets_at = resetsAt(w.resets_at), observed_at = isoTime(w.observed_at);
  return resets_at === undefined || !observed_at ? undefined : { utilization: w.utilization, resets_at, observed_at };
}
function cleanEvent(e) {
  if (e == null) return null;
  if (!plain(e) || !STATUSES.includes(e.status) || !WINDOWS.includes(e.rate_limit_type)) return undefined;
  const resets_at = resetsAt(e.resets_at), received_at = isoTime(e.received_at);
  return resets_at === undefined || !received_at ? undefined : { status: e.status, rate_limit_type: e.rate_limit_type, resets_at, received_at };
}

// { <seat>: { five_hour, seven_day, event } } -> the same with only the seats given (LIMIT_SEATS), each window's
// utilization (a fraction, 0.84), resets_at and observed_at, and the event's status, rate_limit_type,
// resets_at and received_at, times as toISOString() gives them and a missing part null; or null if any
// seat, window or event is not allowed. Fields it doesn't name are dropped.
export function cleanLimits(body, seats = LIMIT_SEATS) {
  if (!plain(body)) return null;
  const out = {};
  for (const [seat, s] of Object.entries(body)) {
    if (!seats.includes(seat) || !plain(s)) return null;
    const five_hour = cleanWindow(s.five_hour), seven_day = cleanWindow(s.seven_day), event = cleanEvent(s.event);
    if (five_hour === undefined || seven_day === undefined || event === undefined) return null;
    out[seat] = { five_hour, seven_day, event };
  }
  return out;
}

// "2026-10" -> the UTC hours to read, [from, to), a day wider on each side than the month, since a
// Halifax day starts at 03:00 or 04:00 UTC; or null for anything else. sumByDay keeps the month.
export function monthRange(month) {
  if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const [y, m] = month.split("-").map(Number);
  return { from: hourOf(Date.UTC(y, m - 1, 1) - DAY_MS), to: hourOf(Date.UTC(y, m, 1) + DAY_MS) };
}

// Rows of { hour, seat, ...COUNTS } -> { days: { "2026-10-14": { seat: counts } }, totals: { seat:
// counts } }, by the Halifax day each hour falls in (a whole hour never straddles its midnight).
// With `month`, only that month's Halifax days.
export function sumByDay(rows, month) {
  const days = {};
  const totals = {};
  const add = (into, seat, row) => {
    const t = (into[seat] ??= Object.fromEntries(COUNTS.map((k) => [k, 0])));
    for (const k of COUNTS) t[k] += row[k];
  };
  for (const row of rows) {
    const day = homeDay(hourMs(row.hour));
    if (month && !day.startsWith(`${month}-`)) continue;
    add((days[day] ??= {}), row.seat, row);
    add(totals, row.seat, row);
  }
  return { days, totals };
}

// The oldest hour kept at `now`: anything before it is deleted.
export const keepFrom = (now) => hourOf(now - KEEP_DAYS * DAY_MS);
