// live.setkernel.com/usage (setkernel-live#86): v5, Headroom's "Needs a look" and seat rows over
// Ledger's month totals and seat-by-day table (setkernel/hq#972), from GET /usage/data for the month
// and the two before it (the 30-day trend reaches back that far) through table.js and limits.js.
// Everything is built with textContent. Hovering, focusing or tapping a number in the table shows its
// box; Esc or a tap elsewhere closes it. Tested with a stand-in document in test/usage-page.test.mjs.
import { homeDay } from "../lib/state.js";
import { BAR, asOf, buildMonth, changeWords, colour, dayName, firstDay, monthName, seatName, shiftDay, shiftMonth, tip, trend, who } from "./table.js";
import { THRESHOLD, WINDOWS, alertOf, hasLimits, meter, mini, needs, windowOf } from "./limits.js";

const SVG = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function svg(tag, attrs, ...kids) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

// What the page says when GET /usage/data doesn't answer with a month. 0 is no answer at all: an
// expired login is a redirect to Access's login page, which the CSP stops.
export function failure(status) {
  if (status === 403) return "This login can't read usage. Reload the page to sign in again.";
  if (status === 503) return "Usage isn't set up on this site, so there is nothing to show.";
  return `Usage didn't load (${status ? `HTTP ${status}` : "no answer"}). Reload the page to try again; if your login expired, that signs you in.`;
}

// Shapes, drawn rather than typed (setkernel-live#80), each beside words that say the same: a stop
// for a limit hit, a triangle for over an alert, a dashed ring for no reading, a tick for all clear.
const SHAPES = {
  limit: [["path", { class: "fg", d: "M5 1h6l4 4v6l-4 4H5l-4-4V5z" }], ["rect", { class: "cut", x: 4, y: 7, width: 8, height: 2 }]],
  over: [["path", { class: "fg", d: "M8 1.2 15.2 14H.8z" }], ["rect", { class: "cut", x: 7.1, y: 5.6, width: 1.8, height: 4.4 }], ["rect", { class: "cut", x: 7.1, y: 11, width: 1.8, height: 1.8 }]],
  gap: [["circle", { class: "ring", cx: 8, cy: 8, r: 6.2 }]],
  ok: [["circle", { class: "fg", cx: 8, cy: 8, r: 7 }], ["path", { class: "tick", d: "M4.6 8.2 7 10.6l4.4-4.8" }]],
};
const shape = (kind) => svg("svg", { class: "i", viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" }, ...SHAPES[kind].map(([t, a]) => svg(t, a)));
const arrow = (d) => svg("svg", { viewBox: "0 0 12 12", "aria-hidden": "true", focusable: "false" }, svg("path", { d }));

function nav(month, current) {
  const link = (m, ...kids) => { const e = m > current ? el("span", "off") : Object.assign(el("a"), { href: `?month=${m}` }); e.append(...kids); return e; };
  const prev = shiftMonth(month, -1), next = shiftMonth(month, 1);
  $("months").replaceChildren(link(prev, arrow("M10.5 6H1.5M5.5 2L1.5 6l4 4"), el("span", null, monthName(prev))), el("b", null, `${monthName(month)} ${month.slice(0, 4)}`), link(next, el("span", null, monthName(next)), arrow("M1.5 6h9M6.5 2l4 4-4 4")));
}

// The newest hour stored, and how long ago it ended once that is two hours or more.
function freshness(newest, now) {
  if (!newest) return void ($("asof").textContent = "Nothing stored yet");
  const late = Math.floor((now - Date.parse(`${newest}:00:00Z`) - 3_600_000) / 3_600_000);
  const words = el("span", null, `Newest hour ends ${asOf(newest)}${late >= 2 ? `, ${late} hours ago` : ""}`);
  $("asof").replaceChildren(...(late >= 2 ? [shape("over"), words] : [words]));
  if (late >= 2) $("fresh").classList.add("late");
}

// Needs a look: a sentence per problem, each a link to its seat; all clear; or why it can't check.
function drawNeeds(v, now) {
  const line = (kind, text, seat) => {
    const li = el("li");
    li.dataset.k = kind;
    li.append(shape(kind === "wait" ? "gap" : kind), seat ? Object.assign(el("a", null, text), { href: `#seat-${seat}` }) : el("span", null, text));
    return li;
  };
  const items = v.current ? needs(v.limits, v.keys, now) : null;
  let lines;
  if (!v.current) lines = [line("wait", "Limits are read live, so they show on the current month only.")];
  else if (!items) lines = [line("wait", "Seat limits aren't sent to this page yet, so it can't check them. Usage is below.")];
  else if (!items.length) lines = [line("ok", "Nothing needs a look")];
  else lines = items.map((i) => line(i.kind, i.text, i.seat));
  $("need").dataset.sev = !items ? "wait" : items[0]?.kind ?? "ok";
  $("needs").replaceChildren(...lines);
  $("need").hidden = false;
}

function tiles(v) {
  const t = v.total.all;
  $("sum").replaceChildren(...[
    ["Fresh tokens", t?.text, v.current ? "this month so far" : `in ${v.name}`],
    ["Cache reads", t?.cached, "counted apart"],
    ["At API prices, about", t?.usd, "a size guide, not a bill"],
    ["Busiest seat", v.busiest?.name, v.busiest && `${v.busiest.text} fresh tokens`],
  ].map(([k, val, s]) => {
    const li = el("li");
    li.append(el("span", "k", k), el("span", val ? "v" : "v na", val ?? "–"), el("span", "s", val ? s : "no data"));
    return li;
  }));
  $("sum").hidden = false;
}

// A limit meter: the figure and its word, the bar with the alert's tick, the reset and the reading.
function meterBox(v, seat, name, label, now) {
  const m = meter(v, seat, name, label, now), t = THRESHOLD[name];
  const box = el("div", `meter ${name === "five_hour" ? "m5" : "mw"}`);
  box.dataset.kind = v.kind;
  if (v.level) box.dataset.level = v.level;
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", m.label);
  const head = el("div", "m-head"), flag = el("span", "m-flag"), track = el("div", "m-track"), scale = el("div", "m-scale"), meta = el("div", "m-meta");
  if (m.pct != null) {
    const pct = el("span", "m-pct", String(m.pct));
    pct.append(el("small", null, "%"));
    head.append(pct);
    track.append(svg("svg", { class: "m-bar", viewBox: "0 0 100 10", preserveAspectRatio: "none", "aria-hidden": "true", focusable: "false" }, svg("rect", { class: "m-fill", width: Math.min(m.pct, 100), height: 10 })));
  }
  const kind = v.level === "limit" || v.level === "over" ? v.level : v.kind === "fresh" ? null : "gap";
  if (kind) flag.append(shape(kind));
  flag.append(el("span", null, m.flag));
  head.append(flag);
  track.append(el("span", `m-tick at${t}`));
  scale.append(el("span", `m-tl at${t}`, `alert ${t}%`));
  meta.append(...m.meta.map((x) => el("span", x.startsWith("rejected") ? "ev" : null, x)));
  box.append(el("span", "cap", label === "5-hour" ? "5-hour" : "Weekly"), head, track, scale, meta);
  return box;
}

// Codex has no Claude limits, never 0%; "other" has no seat; and with no limits sent, no figure at all.
function noLimits(seat) {
  const box = el("div", "nl nolimit");
  box.append(shape("gap"), el("span", null, seat === "codex" ? "No Claude limits: Codex isn't a Claude seat" : hasLimits(seat) ? "No limit readings yet" : "No limits: no seat to read them from"));
  return box;
}

// Today or the month: the fresh tokens big, the dollars and cache reads small; a dash for no data.
function figure(cls, cap, c, sub) {
  const box = el("div", cls);
  box.append(el("span", "cap", cap));
  if (!c) box.append(el("div", "fig na", "–"), el("span", "sub", "no data, not zero"));
  else box.append(el("div", "fig", c.text), el("span", "sub", sub(c)));
  return box;
}

// A seat's trend: its complete days as a line from zero, then today so far apart, dashed and hollow.
const W = 150, H = 38, PAD = 5;
function spark(points, today, label) {
  const n = points.length + (today == null ? 0 : 1), step = (W - 2 * PAD) / Math.max(1, n - 1);
  const top = Math.max(1, ...points.filter((p) => p != null), today ?? 0);
  const x = (i) => +(PAD + i * step).toFixed(1), y = (p) => +(H - PAD - (p / top) * (H - 2 * PAD)).toFixed(1);
  const pts = points.map((p, i) => p != null && [x(i), y(p)]).filter(Boolean);
  const kids = [svg("line", { class: "base", x1: PAD, y1: H - PAD, x2: W - PAD, y2: H - PAD })];
  if (pts.length) {
    const line = pts.map(([a, b]) => `${a},${b}`).join(" ");
    kids.push(svg("polygon", { class: "area", points: `${pts[0][0]},${H - PAD} ${line} ${pts.at(-1)[0]},${H - PAD}` }), svg("polyline", { class: "line", points: line }));
    if (today != null) kids.push(svg("line", { class: "link", x1: pts.at(-1)[0], y1: pts.at(-1)[1], x2: x(n - 1), y2: y(today) }));
    kids.push(svg("circle", { class: "end", cx: pts.at(-1)[0], cy: pts.at(-1)[1], r: 3.5 }));
  }
  if (today != null) kids.push(svg("circle", { class: "now", cx: x(n - 1), cy: y(today), r: 3.5 }));
  return svg("svg", { class: "spark", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": label }, ...kids);
}

let span = 7;
const trendsDrawn = [];
function drawTrends(v, days, first) {
  const last = v.current ? shiftDay(v.rows[0]?.key ?? `${v.month}-01`, -1) : v.rows[0]?.key;
  $("since").textContent = last
    ? `Each line is a seat's fresh tokens a day over the ${span} days to ${dayName(last)}, from zero${v.current ? "; the hollow dot is today so far" : ""}.`
    : "";
  for (const { box, seat, i } of trendsDrawn) {
    const t = trend(days, seat, last, span, first), words = changeWords(t.change, span);
    const today = v.current ? v.today[i]?.n ?? 0 : null;
    box.replaceChildren(el("span", "cap", `Trend, ${span} days`), spark(t.points, today, `${seatName(seat)}, fresh tokens a day: ${words}`), el("span", "chg", words));
  }
  if ($("trendcol")) $("trendcol").textContent = `Trend, ${span} days`;
}

function seatRows(v, now) {
  const head = el("div", "cols");
  head.setAttribute("aria-hidden", "true");
  const trendCol = el("span", null, `Trend, ${span} days`);
  trendCol.id = "trendcol";
  head.append(...(v.current ? ["Seat", "5-hour", "Weekly", "Today", "This month"] : ["Seat", "Month"]).map((t) => el("span", null, t)), trendCol);
  trendsDrawn.length = 0;
  const rows = v.keys.map((seat, i) => {
    const row = el("article", `seat k-${colour(seat)}`), id = el("div", "s-id"), h = el("h3");
    row.id = `seat-${seat}`;
    h.append(el("span", "chip"), el("span", null, seatName(seat)));
    id.append(h);
    if (who(seat)) id.append(el("span", "who", who(seat)));
    row.append(id);
    if (v.current) {
      if (hasLimits(seat) && v.limits) {
        const views = WINDOWS.map(([w]) => windowOf(v.limits, seat, w, now));
        row.append(...WINDOWS.map(([w, label], j) => meterBox(views[j], seat, w, label, now)));
        const alert = alertOf(views);
        if (alert) row.dataset.alert = alert;
      } else row.append(noLimits(seat));
      row.append(figure("td-f", "Today", v.today[i], (c) => `so far · about ${c.usd}`));
    }
    row.append(figure("mo-f", v.current ? "This month" : "Month", v.total.cells[i], (c) => `${c.cached} cache reads · about ${c.usd}`));
    const box = el("div", "trend");
    trendsDrawn.push({ box, seat, i });
    row.append(box);
    return row;
  });
  $("rows").className = v.current ? "rows" : "rows past";
  $("rows").replaceChildren(head, ...rows);
  $("seats").hidden = false;
}

// A number in the table: its data-* attributes are the exact values its box shows.
function num(x, cls) {
  const td = el("td", `h ${cls}`.trim());
  td.tabIndex = 0;
  Object.assign(td.dataset, { who: x.who, when: x.when, f: x.f, c: x.c, u: x.u });
  td.setAttribute("aria-label", x.label);
  return td;
}
const dash = (cls) => el("td", cls ? `none ${cls}` : "none", "–");
const dbar = (pct) => svg("svg", { class: "dbar", viewBox: `0 0 ${BAR} 4`, preserveAspectRatio: "none", "aria-hidden": "true", focusable: "false" }, svg("rect", { width: pct, height: 4 }));

// The sticky strip under each seat's name, once the table's head is stuck: both windows, briefly.
function strip(v, seat, now) {
  const box = el("div", "mini"), views = WINDOWS.map(([w]) => windowOf(v.limits, seat, w, now));
  if (!hasLimits(seat)) box.append(el("span", null, "no Claude limits"));
  else if (views.every((x) => x.kind === "none")) box.append(el("span", null, "not reporting"));
  else for (const [j, [, label]] of WINDOWS.entries()) {
    const x = views[j], cls = x.level === "limit" || x.level === "over" ? x.level : null, s = el("span", cls);
    if (cls) s.append(shape(cls));
    s.append(el("span", null, `${label === "5-hour" ? "5h" : "wk"} ${mini(x)}`));
    box.append(s);
  }
  return box;
}

function drawTable(v, now) {
  const cols = el("colgroup"), head = el("tr");
  cols.append(el("col", "d"), ...v.keys.map(() => el("col")), el("col", "a"));
  head.append(el("th", null, "Day"), ...v.keys.map((seat) => {
    const th = el("th", `sh k-${colour(seat)}`), nm = el("div", "nm");
    nm.append(el("span", "chip"), el("span", null, seatName(seat)));
    th.append(nm);
    if (v.current && v.limits) th.append(strip(v, seat, now));
    return th;
  }), el("th", "all", "All seats"));
  for (const th of head.children) th.setAttribute("scope", "col");
  const body = el("tbody");
  for (const r of v.rows) {
    const tr = el("tr", [r.weekend && "we", r.today && "today"].filter(Boolean).join(" ")), day = el("th");
    day.setAttribute("scope", "row");
    day.append(el("span", "n", dayName(r.key)));
    if (r.today) day.append(el("span", "tag", "so far"));
    tr.append(day, ...r.cells.map((c) => {
      if (!c) return dash();
      const td = num(c, `t${c.heat}`);
      td.append(el("span", "n", c.text));
      return td;
    }));
    if (r.all) {
      const td = num(r.all, "tot"), row = el("div", "row");
      row.append(el("span", "n", r.all.text), dbar(r.all.bar), el("span", "n d", r.all.usd));
      td.append(row);
      tr.append(td);
    } else tr.append(dash("tot"));
    body.append(tr);
  }
  const foot = el("tr"), t = v.total.all, month = el("th", null, monthName(v.month));
  month.setAttribute("scope", "row");
  foot.append(month, ...v.total.cells.map((c) => {
    if (!c) return dash();
    const td = num(c, "");
    td.append(el("span", "n", c.text), el("span", "s", c.usd));
    return td;
  }));
  if (t) {
    const td = num(t, "tot");
    td.append(el("span", "n", t.text), el("span", "s", `${t.cached} cache reads`), el("span", "s", t.usd));
    foot.append(td);
  } else foot.append(dash("tot"));
  const thead = el("thead"), tfoot = el("tfoot");
  thead.append(head);
  tfoot.append(foot);
  $("usage").replaceChildren(cols, thead, body, tfoot);
}

// Under 1180 px the table gives way to a <details> per day, the newest open.
function drawDays(v) {
  const chev = () => svg("svg", { class: "chev", viewBox: "0 0 12 12", "aria-hidden": "true", focusable: "false" }, svg("path", { d: "M2.5 4.5 6 8l3.5-3.5" }));
  $("daylist").replaceChildren(...v.rows.map((r, n) => {
    const li = el("li", r.weekend ? "we" : null), details = el("details"), sum = el("summary"), dn = el("span", "dn", dayName(r.key)), list = el("ul");
    details.open = n === 0;
    if (r.today) dn.append(el("span", "tag", "so far"));
    sum.append(dn, el("span", "dt n", r.all?.text ?? "–"), el("span", "dd n", r.all?.usd ?? ""), chev());
    if (r.all?.bar) sum.append(dbar(r.all.bar));
    list.append(...v.keys.map((seat, i) => {
      const c = r.cells[i], item = el("li", c ? null : "nodata"), nm = el("span", `nm k-${colour(seat)}`);
      nm.append(el("span", "dot"), el("span", null, seatName(seat)));
      item.append(nm, el("span", c ? `heat n t${c.heat}` : "heat n", c?.text ?? "–"), el("span", "dl n", c?.usd ?? ""), el("span", "more", c ? `${c.cached} cache reads · ${c.req} requests` : "no data, not zero"));
      return item;
    }));
    details.append(sum, list);
    li.append(details);
    return li;
  }));
}

function draw(v, months, newest, now) {
  $("title").textContent = `Usage per seat, ${v.name}`;
  freshness(newest, now);
  if (v.empty) $("status").textContent = `Nothing is stored for ${v.name} yet.`;
  else $("status").hidden = true;
  drawNeeds(v, now);
  if (!v.empty) tiles(v);
  if (v.keys.length) {
    const days = Object.assign({}, ...months.map((d) => d.days)), first = firstDay(months);
    seatRows(v, now);
    drawTrends(v, days, first);
    for (const n of [7, 30]) {
      $(`span${n}`).addEventListener("click", () => {
        span = n;
        for (const m of [7, 30]) $(`span${m}`).setAttribute("aria-pressed", String(m === n));
        drawTrends(v, days, first);
      });
    }
  }
  if (!v.empty) {
    drawTable(v, now);
    drawDays(v);
    $("days").hidden = false;
  }
}

// The table's head sticks to the top of the window; once it does, each seat's strip shows. The
// observed area runs far below the window, so a jump past the table (End, a link) still crosses its edge.
function stick() {
  if (!("IntersectionObserver" in globalThis)) return;
  new IntersectionObserver((seen) => $("usage").classList.toggle("stuck", !seen.at(-1).isIntersecting), { rootMargin: "0px 0px 100000px 0px" }).observe($("top"));
}

// The box, from the reference in setkernel-live#71: placed with the CSSOM, which the CSP allows.
let pinned = null, focused = null;
function show(td) {
  const box = $("tip"), t = tip(td.dataset), dl = el("dl");
  for (const [k, val] of t.rows) dl.append(el("dt", null, k), el("dd", null, val));
  box.replaceChildren(el("div", "t-h", t.head), dl);
  box.hidden = false;
  const r = td.getBoundingClientRect(), w = box.offsetWidth, h = box.offsetHeight;
  const x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), document.documentElement.clientWidth - w - 8);
  const y = r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8;
  box.style.left = `${x}px`;
  box.style.top = `${y}px`;
}
function hide() {
  pinned?.classList.remove("on");
  pinned = focused = null;
  $("tip").hidden = true;
}
function listen() {
  const table = $("usage");
  const cell = (n) => { const td = n?.closest?.("td.h"); return td && table.contains(td) ? td : null; };
  table.addEventListener("mouseover", (e) => { const td = cell(e.target); if (td && !pinned) show(td); });
  table.addEventListener("mouseout", (e) => { if (!pinned && cell(e.target) && !cell(e.relatedTarget)) hide(); });
  table.addEventListener("focusin", (e) => { const td = cell(e.target); if (td) show(focused = td); });
  table.addEventListener("focusout", () => { if (!pinned) hide(); });
  document.addEventListener("click", (e) => {
    const td = cell(e.target), again = td && td === pinned;
    hide();
    if (td && !again) { pinned = td; td.classList.add("on"); show(td); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
  // a scroll anywhere: move a pinned or focused box with its number (Tab scrolls a number into view
  // after focusin), drop a hovered one
  document.addEventListener("scroll", () => { const td = pinned ?? focused; td ? show(td) : hide(); }, { capture: true, passive: true });
}

async function get(month) {
  let res;
  try {
    res = await fetch(`/usage/data?month=${month}`, { cache: "no-store", redirect: "manual" });
    if (res.ok) return { data: await res.json(), newest: res.headers.get("Usage-Newest-Hour") };
  } catch {}
  return { status: res?.status ?? 0 };
}

async function load() {
  const now = Date.now(), today = homeDay(now), current = today.slice(0, 7);
  const asked = new URLSearchParams(location.search).get("month") ?? "";
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) && asked <= current ? asked : current;
  nav(month, current);
  const got = await Promise.all([0, -1, -2].map((by) => get(shiftMonth(month, by))));
  const bad = got.find((g) => !g.data);
  if (bad) {
    $("status").textContent = failure(bad.status);
    $("asof").textContent = "Not loaded";
    return;
  }
  draw(buildMonth(got[0].data, today), got.map((g) => g.data), got[0].newest, now);
  stick();
  listen();
}

export const ready = load();
