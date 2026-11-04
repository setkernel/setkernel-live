// live.setkernel.com/usage (setkernel-live#71, v5 in #86): GET /usage/data's months -> the seats, the
// month's totals, its seat-by-day rows and each seat's trend. Pure and tested (test/usage-page.test.mjs).
// Fresh tokens are input + output + cache writes; cache reads are shown apart.
const ORDER = ["vega", "rigel", "lyra", "orion", "polaris", "codex", "other"]; // then any other seat, A to Z
const COLOURS = ["vega", "rigel", "lyra", "orion", "polaris", "codex"]; // usage.css's .k-*; the rest are grey
const WHO = { polaris: "Raghav's own sessions", codex: "not a Claude seat", other: "usage no seat claimed" };
const KEYS = ["input", "output", "cache_read", "cache_write", "usd_micros", "requests"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const HEAT = 8; // shading steps, one CSS class each: the CSP allows no style attribute
export const BAR = 100; // the busiest day's bar, in percent of its column

export const exact = (n) => n.toLocaleString("en-US");
export const dollars = (micros) => `$${exact(Math.round(micros / 1e6))}`;
const fresh = (c) => c.input + c.output + c.cache_write;
const add = (a, b) => Object.fromEntries(KEYS.map((k) => [k, (a?.[k] ?? 0) + (b[k] ?? 0)]));
export const seatName = (s) => s[0].toUpperCase() + s.slice(1);
export const who = (s) => WHO[s] ?? "";
export const colour = (s) => (COLOURS.includes(s) ? s : "x");

// 13,698,537 -> "14M", 2,372,363 -> "2.4M", 816,743 -> "817K", 15,045,054,434 -> "15.0B".
export function short(n) {
  for (const [d, s] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]]) {
    if (n < d * 0.9995) continue;
    const x = n / d;
    return `${x < 9.95 || s === "B" ? x.toFixed(1) : Math.round(x)}${s}`;
  }
  return String(n);
}

// "2026-10" moved by `by` months.
export function shiftMonth(month, by) {
  const [y, m] = month.split("-").map(Number);
  const n = y * 12 + m - 1 + by;
  return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}`;
}

// "2026-10-28" moved by `by` days.
export function shiftDay(day, by) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + by)).toISOString().slice(0, 10);
}

// "2026-09" -> "September"; "2026-10-27" -> "Tue 27 Oct".
export const monthName = (month) => MONTHS[Number(month.slice(5, 7)) - 1];
export const dayName = (day) => `${WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()]} ${Number(day.slice(8))} ${monthName(day).slice(0, 3)}`;

// The newest hour stored ("2026-10-31T14", a UTC hour) -> when it ended, in Halifax: "31 Oct, 12:00 ADT".
const halifax = new Intl.DateTimeFormat("en-US", { timeZone: "America/Halifax", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" });
export function asOf(hour) {
  const p = Object.fromEntries(halifax.formatToParts(Date.parse(`${hour}:00:00Z`) + 3_600_000).map((x) => [x.type, x.value]));
  return `${p.day} ${p.month}, ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

// The seats a month names, in the team's order: those with usage and, on the current month, those the
// seat limits name. Nothing else: a seat with neither isn't on the page.
export function seatsOf(totals, limits) {
  const rank = (s) => (ORDER.includes(s) ? ORDER.indexOf(s) : ORDER.length);
  return [...new Set([...Object.keys(totals ?? {}), ...Object.keys(limits ?? {})])].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// One number: what it shows, and the exact values its box and aria-label give.
function cell(who, when, c) {
  const f = exact(fresh(c)), r = exact(c.cache_read), u = dollars(c.usd_micros);
  return { who, when, n: fresh(c), text: short(fresh(c)), usd: u, cached: short(c.cache_read), f, c: r, u, req: exact(c.requests ?? 0), label: `${who}, ${when}: ${f} fresh tokens, ${r} cache reads, about ${u}` };
}

// The box: a heading and three label-value lines.
export const tip = (x) => ({ head: `${x.who} · ${x.when}`, rows: [["Fresh tokens", x.f], ["Cache reads", x.c], ["At API prices", `about ${x.u}`]] });

// { month, days, totals, limits? } and today's Halifax date -> { name, keys, seats, current, limits,
// rows (newest day first, none after today), today, total, empty, busiest }. A seat-day with no data
// is null: the page shows a dash. Limits count on the current month only: they are read live.
export function buildMonth(data, today) {
  const [y, m] = data.month.split("-").map(Number);
  const name = MONTHS[m - 1], current = today.startsWith(data.month);
  const limits = current ? data.limits ?? null : null;
  const keys = seatsOf(data.totals, limits);
  const seats = keys.map(seatName);
  const rows = [];
  for (let d = new Date(Date.UTC(y, m, 0)).getUTCDate(); d >= 1; d--) {
    const key = `${data.month}-${String(d).padStart(2, "0")}`;
    if (key > today) continue;
    const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    const when = `${wd} ${d} ${name.slice(0, 3)}${key === today ? ", so far" : ""}`;
    const day = data.days[key] ?? {};
    const all = Object.values(day).reduce(add, null);
    rows.push({ key, d, wd, when, today: key === today, weekend: wd === "Sat" || wd === "Sun", cells: keys.map((s, i) => (day[s] ? cell(seats[i], when, day[s]) : null)), all: all && cell("All seats", when, all) });
  }
  // shading scales to the month's biggest seat-day, the bar to its busiest day
  const hottest = Math.max(1, ...rows.flatMap((r) => r.cells.map((c) => c?.n ?? 0)));
  const busiest = Math.max(1, ...rows.map((r) => r.all?.n ?? 0));
  for (const r of rows) {
    for (const c of r.cells) if (c) c.heat = c.n ? Math.ceil((c.n / hottest) * HEAT) : 0;
    if (r.all) r.all.bar = r.all.n ? Math.max(1, Math.round((r.all.n / busiest) * BAR)) : 0;
  }
  const all = Object.values(data.totals).reduce(add, null);
  const top = keys.reduce((a, s) => (data.totals[s] && (!a || fresh(data.totals[s]) > fresh(data.totals[a])) ? s : a), null);
  return {
    name: `${name} ${y}`, month: data.month, keys, seats, current, limits, rows, empty: !all,
    today: current ? rows.find((r) => r.today)?.cells ?? keys.map(() => null) : null,
    busiest: top && { name: seatName(top), text: short(fresh(data.totals[top])) },
    total: { cells: keys.map((s, i) => (data.totals[s] ? cell(seats[i], name, data.totals[s]) : null)), all: all && cell("All seats", name, all) },
  };
}

// The first day any of `months` (GET /usage/data answers) holds: the trend says nothing before it.
export const firstDay = (months) => months.flatMap((d) => Object.keys(d.days).filter((k) => Object.keys(d.days[k]).length)).sort()[0] ?? null;

// A seat's fresh tokens a day over the `span` days to `last`, oldest first (null before `first`, the
// first day stored; a day stored without the seat is 0), and the change on the `span` days before as
// a whole percent of their daily mean: null when fewer than half of them are stored or they sum to 0.
export function trend(days, seat, last, span, first) {
  const at = (back) => {
    const key = shiftDay(last, -back);
    if (!first || key < first) return null;
    const c = days[key]?.[seat];
    return c ? fresh(c) : 0;
  };
  const points = Array.from({ length: span }, (_, i) => at(span - 1 - i));
  const before = Array.from({ length: span }, (_, i) => at(span + i)).filter((n) => n != null);
  const now = points.filter((n) => n != null);
  const mean = (a) => a.reduce((x, n) => x + n, 0) / a.length;
  const change = now.length && before.length >= Math.ceil(span / 2) && mean(before) > 0 ? Math.round((mean(now) / mean(before) - 1) * 100) : null;
  return { points, change };
}

// The change in words: "Up 12% on the previous 7 days".
export function changeWords(change, span) {
  if (change == null) return "No earlier days to compare with";
  if (change === 0) return `No change on the previous ${span} days`;
  return `${change > 0 ? "Up" : "Down"} ${Math.abs(change)}% on the previous ${span} days`;
}
