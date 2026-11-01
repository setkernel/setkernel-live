// live.setkernel.com/usage (setkernel-live#71): GET /usage/data's month -> the rows, cells and
// summary the page shows, option B as Raghav picked it. Pure and tested (test/usage-page.test.mjs).
// Fresh tokens are input + output + cache writes; cache reads are shown apart.
const SEATS = ["vega", "rigel", "lyra", "orion", "polaris"]; // then codex and other, when they have data
const KEYS = ["input", "output", "cache_read", "cache_write", "usd_micros"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const HEAT = 8; // shading steps, one CSS class each: the CSP allows no style attribute
export const BAR = 96; // the busiest day's bar, in px

export const exact = (n) => n.toLocaleString("en-US");
export const dollars = (micros) => `$${exact(Math.round(micros / 1e6))}`;
const fresh = (c) => c.input + c.output + c.cache_write;
const add = (a, b) => Object.fromEntries(KEYS.map((k) => [k, (a?.[k] ?? 0) + b[k]]));
const title = (s) => s[0].toUpperCase() + s.slice(1);

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

// "2026-09" -> "September".
export const monthName = (month) => MONTHS[Number(month.slice(5)) - 1];

// The newest hour stored ("2026-10-31T14", a UTC hour) -> when it ended, in Halifax: "31 Oct, 12:00 ADT".
const halifax = new Intl.DateTimeFormat("en-US", { timeZone: "America/Halifax", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" });
export function asOf(hour) {
  const p = Object.fromEntries(halifax.formatToParts(Date.parse(`${hour}:00:00Z`) + 3_600_000).map((x) => [x.type, x.value]));
  return `${p.day} ${p.month}, ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

// One number: what its cell shows, and the exact values its box and aria-label give.
function cell(who, when, c) {
  const f = exact(fresh(c)), r = exact(c.cache_read), u = dollars(c.usd_micros);
  return { who, when, n: fresh(c), text: short(fresh(c)), usd: u, cached: short(c.cache_read), f, c: r, u, label: `${who}, ${when}: ${f} fresh tokens, ${r} cache reads, about ${u}` };
}

// The box: a heading and three label-value lines.
export const tip = (x) => ({ head: `${x.who} · ${x.when}`, rows: [["Fresh tokens", x.f], ["Cache reads", x.c], ["At API prices", `about ${x.u}`]] });

// { month, days, totals } and today's Halifax date -> { name, seats, rows (newest day first, none
// after today), total, empty }. A day or seat with no data is null: the page shows a dash.
export function buildMonth(data, today) {
  const [y, m] = data.month.split("-").map(Number);
  const name = MONTHS[m - 1];
  const keys = [...SEATS, ...["codex", "other"].filter((s) => data.totals[s])];
  const seats = keys.map(title);
  const rows = [];
  for (let d = new Date(Date.UTC(y, m, 0)).getUTCDate(); d >= 1; d--) {
    const key = `${data.month}-${String(d).padStart(2, "0")}`;
    if (key > today) continue;
    const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    const when = `${wd} ${d} ${name.slice(0, 3)}${key === today ? ", so far" : ""}`;
    const day = data.days[key] ?? {};
    const all = Object.values(day).reduce(add, null);
    rows.push({ d, wd, today: key === today, weekend: wd === "Sat" || wd === "Sun", cells: keys.map((s, i) => day[s] && cell(seats[i], when, day[s])), all: all && cell("All seats", when, all) });
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
    name: `${name} ${y}`, seats, rows, empty: !all, busiest: top && title(top),
    total: { cells: keys.map((s, i) => data.totals[s] && cell(seats[i], name, data.totals[s])), all: all && cell("All seats", name, all) },
  };
}
