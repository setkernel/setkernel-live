// live.setkernel.com/usage (setkernel-live#78): option B from setkernel-live#71, drawn from GET
// /usage/data through buildMonth (table.js). Everything is built with textContent. Hovering,
// focusing or tapping a number shows its box; Esc or a tap elsewhere closes it.
// Tested with a stand-in document in test/usage-page.test.mjs.
import { homeDay } from "../lib/state.js";
import { asOf, buildMonth, monthName, shiftMonth, tip } from "./table.js";

const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// What the page says when GET /usage/data doesn't answer with a month. 0 is no answer at all: an
// expired login is a redirect to Access's login page, which the CSP stops.
export function failure(status) {
  if (status === 403) return "This login can't read usage. Reload the page to sign in again.";
  if (status === 503) return "Usage isn't set up on this site, so there is nothing to show.";
  return `Usage didn't load (${status ? `HTTP ${status}` : "no answer"}). Reload the page to try again; if your login expired, that signs you in.`;
}

// An arrow drawn, not typed: the page's fonts have no left or right arrow (setkernel-live#80).
// The month's name beside it says where the link goes.
function arrow(d) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  for (const [k, v] of Object.entries({ class: "arrow", viewBox: "0 0 12 12", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(k, v);
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

function nav(month, current) {
  const link = (m, ...kids) => { const e = m > current ? el("span", "off") : Object.assign(el("a"), { href: `?month=${m}` }); e.append(...kids); return e; };
  const prev = shiftMonth(month, -1), next = shiftMonth(month, 1);
  $("months").replaceChildren(link(prev, arrow("M10.5 6H1.5M5.5 2L1.5 6l4 4"), el("span", null, monthName(prev))), el("b", null, `${monthName(month)} ${month.slice(0, 4)}`), link(next, el("span", null, monthName(next)), arrow("M1.5 6h9M6.5 2l4 4-4 4")));
}

// A number: its data-* attributes are the exact values its box shows.
function num(x, cls) {
  const td = el("td", `h ${cls}`);
  td.tabIndex = 0;
  Object.assign(td.dataset, { who: x.who, when: x.when, f: x.f, c: x.c, u: x.u });
  td.setAttribute("aria-label", x.label);
  return td;
}
const dash = (cls = "") => el("td", `none ${cls}`, "–");

function bar(px) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  for (const [k, v] of Object.entries({ class: "bar", width: px, height: 4, "aria-hidden": "true" })) svg.setAttribute(k, v);
  for (const [k, v] of Object.entries({ width: px, height: 4, rx: 2 })) rect.setAttribute(k, v);
  svg.append(rect);
  return svg;
}

function draw(v, newest) {
  $("title").textContent = `Tokens per seat, ${v.name}`;
  $("asof").textContent = newest ? `Newest hour ends ${asOf(newest)}` : "Nothing stored yet";
  const t = v.total.all;
  $("sum").replaceChildren(...[["Fresh tokens this month", t?.text], ["Cache reads", t?.cached], ["At API prices, about", t?.usd], ["Busiest seat", v.busiest]]
    .map(([k, val]) => { const li = el("li"); li.append(el("span", "k", k), el("span", "v", val ?? "–")); return li; }));
  if (v.empty) $("status").textContent = `Nothing is stored for ${v.name} yet.`;
  else $("status").hidden = true;

  const head = el("tr");
  head.append(...["Day", ...v.seats].map((s) => el("th", null, s)), el("th", "tot", "All seats"));
  for (const th of head.children) th.setAttribute("scope", "col");
  const body = el("tbody");
  for (const r of v.rows) {
    const tr = el("tr", [r.weekend && "we", r.today && "today"].filter(Boolean).join(" "));
    const day = el("td", null, `${r.d} `);
    day.append(el("span", "wd", r.wd));
    if (r.today) day.append(el("span", "tag", "so far"));
    tr.append(day, ...r.cells.map((c) => {
      if (!c) return dash();
      const td = num(c, `t${c.heat}`);
      td.append(el("span", "m", c.text));
      return td;
    }));
    if (r.all) {
      const td = num(r.all, "tot"), m = el("span", "m", `${r.all.text} `);
      m.append(el("span", "usd", r.all.usd));
      td.append(m);
      if (r.all.bar) td.append(bar(r.all.bar));
      tr.append(td);
    } else tr.append(dash("tot"));
    body.append(tr);
  }
  const foot = el("tr");
  foot.append(el("td", null, v.name.split(" ")[0]), ...v.total.cells.map((c) => {
    if (!c) return dash();
    const td = num(c, "");
    td.append(el("span", "m", c.text), el("span", "s", c.usd));
    return td;
  }));
  if (t) {
    const td = num(t, "tot");
    td.append(el("span", "m", t.text), el("span", "s", `${t.cached} cached`), el("span", "s", t.usd));
    foot.append(td);
  } else foot.append(dash("tot"));
  const thead = el("thead"), tfoot = el("tfoot");
  thead.append(head);
  tfoot.append(foot);
  $("usage").replaceChildren(thead, body, tfoot);
  for (const id of ["sum", "scroll", ...(v.empty ? [] : ["hint"])]) $(id).hidden = false;
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
  // the window's scroll and the table's own: move a pinned or focused box with its number (Tab
  // scrolls a number into view after focusin), drop a hovered one
  document.addEventListener("scroll", () => { const td = pinned ?? focused; td ? show(td) : hide(); }, { capture: true, passive: true });
}

async function load() {
  const today = homeDay(Date.now()), current = today.slice(0, 7);
  const asked = new URLSearchParams(location.search).get("month") ?? "";
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) && asked <= current ? asked : current;
  nav(month, current);
  let res, data;
  try {
    res = await fetch(`/usage/data?month=${month}`, { cache: "no-store", redirect: "manual" });
    if (res.ok) data = await res.json();
  } catch {}
  if (!data) {
    $("status").textContent = failure(res?.status ?? 0);
    $("asof").textContent = "Not loaded";
    return;
  }
  draw(buildMonth(data, today), res.headers.get("Usage-Newest-Hour"));
  listen();
}

export const ready = load();
