// Daily tokens per seat (setkernel-live#66, setkernel/hq#721): hourly usage buckets pushed to
// POST /ingest/usage and summed per Halifax day. Private: the Usage Durable Object keeps them apart
// from the Hub, so no public route can return them. Nothing reads them yet (slice B, the read route,
// follows). Pure and tested (test/usage.test.mjs); the Durable Object is in src/worker.js.
import { homeDay } from "../public/lib/state.js";

export const SEATS = ["vega", "rigel", "lyra", "orion", "polaris", "codex", "other"];
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
export function cleanUsage(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.buckets)) return null;
  const out = [];
  for (const b of body.buckets) {
    if (!b || typeof b !== "object") return null;
    if (Number.isNaN(hourMs(b.hour)) || !SEATS.includes(b.seat) || !SURFACES.includes(b.surface)) return null;
    if (typeof b.model !== "string" || !MODEL.test(b.model)) return null;
    if (!COUNTS.every((k) => Number.isSafeInteger(b[k]) && b[k] >= 0)) return null;
    out.push({ hour: b.hour, seat: b.seat, model: b.model, surface: b.surface, ...Object.fromEntries(COUNTS.map((k) => [k, b[k]])) });
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
