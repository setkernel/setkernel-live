// live.setkernel.com, v2 "Sky + Line" (setkernel-live#36). Connects to /ws (or, with ?demo, runs
// the sample simulation through the same reducer as the Durable Object) and shows one picture two
// ways: the sky, where each engineer is a star, and the line under it, a board of where each
// engineer's job is. Replay drives both. Everything shown is built with textContent and
// attributes, never innerHTML, so nothing in a batch can inject markup.
import { AGENTS, ENGINEERS, POLE, PULSE_KINDS, applyBatch, emptyReplay, emptyState, recordReplay, replaySince, view } from "/lib/state.js";
import { OFFLINE_AFTER_MS, ciSummary, ciWhere, ciWord, clock, createAnnouncer, deed, fitHeadline, freshness, headline, isActive, reviewTarget, stateWords, todaySince, whereWork, zoneName } from "/lib/words.js";
import { NARROW_BELOW, PLACES, PLACE_NAMES, PLACE_X, skyLayout } from "/lib/layout.js";
import { STAGES, STAGE_NAME, column, replayAgents, reviewers, stepLines } from "/lib/line.js";
import { SESSION_NOTE, cardText, cardWords, starCard, tokenPile } from "/lib/card.js";
import { createSky } from "/lib/sky.js";
import { createDemo } from "/lib/demo.js";
import { REPLAYS, eventsBefore, plan } from "/lib/replay.js";

const $ = (id) => document.getElementById(id);
const make = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") e.textContent = v;
    else if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
};
const SVG_NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}, ...kids) => {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
};
const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const root = document.documentElement;
const css = getComputedStyle(root);
const color = (k) => css.getPropertyValue(`--${k}`).trim();
const reducedQuery = matchMedia("(prefers-reduced-motion: reduce)");
let reduced = reducedQuery.matches;
// a star's colour is --<name>; Polaris's three Claudes share --pole
const starVar = (n) => (POLE.includes(n) && n !== "Polaris" ? "pole" : n.toLowerCase());
const COLORS = Object.fromEntries([...AGENTS.map((n) => [n, color(starVar(n))]), ...PLACES.map((k) => [k, color(k)]), ["pole", color("pole")]]);
const fmt = new Intl.NumberFormat("en");
const rem = () => parseFloat(getComputedStyle(root).fontSize) || 16;
const plural = (n, one, many = `${one}s`) => `${fmt.format(n)} ${n === 1 ? one : many}`;

let skew = 0; // server clock minus ours
const serverNow = () => Date.now() + skew;
const nowS = () => Math.trunc(serverNow() / 1000);
let current = { agents: {}, counts: {}, byAgent: {}, seen: {}, line: {}, feed: [], ci: [], hours: [], lastIngest: 0 };
let rp = null; // the replay's own picture while one plays: { lines, last, feed, agents, nowS }

// One picture drives the sky, the headline, the star card and the line: the live one, or the
// replay's while it plays.
function picture() {
  if (!rp) return { ...current, nowS: nowS() };
  return { ...current, agents: rp.agents, line: rp.lines, feed: rp.feed, nowS: rp.nowS };
}
// { author: reviewer } for the line's chips, and { reviewer: author } for the words
const reviewing = (pic) => reviewers(pic.agents, pic.line, ENGINEERS);
const invert = (o) => Object.fromEntries(Object.entries(o).map(([a, b]) => [b, a]));

// A name in its colour, underlined: used in the headline and the Latest line
const nameEl = (name) => {
  const e = make("span", { class: "n", text: name });
  e.style.setProperty("--star", COLORS[name]);
  return e;
};
const showParts = (el, parts) => el.replaceChildren(...parts.map((p) => (typeof p === "string" ? p : nameEl(p.name))));
// a small four-pointed star in a star's colour, for lists
const glyph = (name) => {
  const g = svg("svg", { class: "glyph", viewBox: "0 0 24 24", "aria-hidden": "true" },
    svg("path", { d: name === "Polaris" ? "M12 0l1.7 10.3L24 12l-10.3 1.7L12 24l-1.7-10.3L0 12l10.3-1.7z" : "M12 1.5C13 8.6 15.4 11 22.5 12 15.4 13 13 15.4 12 22.5 11 15.4 8.6 13 1.5 12 8.6 11 11 8.6 12 1.5Z" }));
  g.style.setProperty("--star", COLORS[name] || COLORS.Vega);
  return g;
};
// A public repo -> its name, linked to GitHub. Private repos never have a name on this page.
const repoLink = (repo) => make("a", { href: `https://github.com/setkernel/${encodeURIComponent(repo)}`, rel: "noopener", text: repo });

// ---- the sky: real buttons and text over the canvas
const skyEl = $("sky");
const stationEls = {};
const sky = createSky($("sky-canvas"), {
  reduced, colors: COLORS,
  onArrive: (place) => {
    const el = stationEls[place];
    if (!el) return;
    el.classList.add("hit");
    clearTimeout(el.hitTimer);
    el.hitTimer = setTimeout(() => el.classList.remove("hit"), 450);
  },
});
const starEls = {};
const orb = (...parts) => make("span", { class: "orb", "aria-hidden": "true" }, ...parts.map((p) => make("span", { class: p })));
for (const name of AGENTS) {
  const kind = ENGINEERS.includes(name) ? "eng" : name === "Polaris" ? "polaris" : "sm";
  const b = make("button", { type: "button", class: `star ${kind}`, "data-star": name, "aria-haspopup": "dialog", "aria-expanded": "false" });
  b.style.setProperty("--star", COLORS[name]);
  if (kind === "eng") {
    b.dataset.state = "IDLE";
    b.append(orb("halo", "ring", "ring2", "core"), make("span", { class: "lbl" }, make("span", { class: "nm", text: name }), make("span", { class: "st" }), make("span", { class: "tl" })));
  } else if (kind === "polaris") {
    const pole = svg("svg", { viewBox: "-32 -32 64 64" },
      svg("circle", { r: "27", fill: "none", stroke: "#ffffff", "stroke-opacity": ".28", "stroke-width": "1" }),
      svg("path", { d: "M0 -30L4 -4L30 0L4 4L0 30L-4 4L-30 0L-4 -4Z", fill: "#eaf2ff" }),
      svg("circle", { r: "4.4", fill: "#ffffff" }));
    b.append(make("span", { class: "orb", "aria-hidden": "true" }, pole), make("span", { class: "lbl" }, make("span", { class: "nm", text: name }), make("span", { class: "tl" })));
  } else {
    b.append(orb("halo", "core"), make("span", { class: "lbl" }, make("span", { class: "nm", text: name }), make("span", { class: "tl" })));
  }
  starEls[name] = b;
  $("stars").append(b);
}
const STATION_ICON = {
  claude: () => svg("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" }, svg("path", { d: "M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4", stroke: "currentColor", "stroke-width": "2.2", "stroke-linecap": "round" })),
  github: () => svg("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "aria-hidden": "true" },
    svg("circle", { cx: "6", cy: "5.5", r: "2.3" }), svg("circle", { cx: "6", cy: "18.5", r: "2.3" }), svg("circle", { cx: "18", cy: "18.5", r: "2.3" }),
    svg("path", { d: "M6 8v8M18 16v-6a3 3 0 0 0-3-3h-4m2-2.5L10.5 7 13 9.5" })),
  chat: () => svg("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linejoin": "round", "aria-hidden": "true" }, svg("path", { d: "M4 5h16v11H9l-5 4z" })),
};
const STATION_UNIT = { claude: "requests", github: "actions", chat: "posts" };
for (const key of PLACES) {
  const li = make("li", { class: `station ${key}` },
    make("span", { class: "ic" }, STATION_ICON[key]()),
    make("span", { class: "sx" }, make("span", { class: "pn", text: PLACE_NAMES[key] }), make("span", {}, make("b", { text: "0" }), make("span", { class: "u", text: STATION_UNIT[key] }))));
  li.style.setProperty("--x", `${PLACE_X[key] * 100}%`);
  stationEls[key] = li;
  $("stations").append(li);
}

let L = null;
// The box of an element over the sky, in the sky's coordinates, or null when it isn't over it.
function over(el) {
  const s = skyEl.getBoundingClientRect(), r = el.getBoundingClientRect();
  if (!r.width || r.bottom <= s.top || r.top >= s.bottom || r.right <= s.left || r.left >= s.right) return null;
  return { left: r.left - s.left, right: r.right - s.left, top: r.top - s.top, bottom: r.bottom - s.top };
}
function layoutSky() {
  const { width: w, height: h } = skyEl.getBoundingClientRect();
  if (!w || !h) return;
  const narrow = w < NARROW_BELOW;
  skyEl.classList.toggle("narrow", narrow);
  const f = rem();
  skyEl.style.setProperty("--lblw", `${Math.round(narrow ? w * 0.42 : Math.min(Math.max(w * 0.26, 15 * f), 20 * f))}px`);
  const labels = {};
  for (const name of POLE) labels[name] = starEls[name].querySelector(".lbl").offsetWidth;
  const hud = over($("hud")), status = over($("hud-right"));
  L = skyLayout(w, h, { rem: f, hud, status, labels });
  for (const name of AGENTS) {
    const p = L.stars[name], el = starEls[name];
    el.style.setProperty("--x", `${p.x}px`);
    el.style.setProperty("--xr", `${w - p.x}px`);
    el.style.setProperty("--y", `${p.y}px`);
    el.classList.toggle("left", p.side === "left");
  }
  const s = skyEl.getBoundingClientRect();
  const points = Object.fromEntries(PLACES.map((k) => {
    const r = stationEls[k].getBoundingClientRect();
    return [k, { x: r.left - s.left + r.width / 2, y: r.top - s.top + 2 }];
  }));
  sky.resize(L, devicePixelRatio, points);
  placeCard();
}
new ResizeObserver(() => { layoutSky(); showHeadline(picture()); }).observe(skyEl);

// draw only while someone can see it
let onScreen = true;
const wake = () => (onScreen && !document.hidden ? sky.start() : sky.stop());
new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; wake(); }).observe(skyEl);
document.addEventListener("visibilitychange", wake);

// "2 PRs · 6 reviews · 340 Claude requests", with the numbers in bold
function tallyParts(items) {
  const out = [];
  items.forEach(([n, one, many], i) => {
    if (i) out.push(" · ");
    out.push(make("b", { text: fmt.format(n ?? 0) }), ` ${(n ?? 0) === 1 ? one : many}`);
  });
  return out;
}
function poleTally(name) {
  const c = current.byAgent?.[name] ?? {};
  return name === "Polaris" ? [[c.reviews, "review", "reviews"], [c.prs, "PR", "PRs"]] : [[c.prs, "PR", "PRs"]];
}

function showStars(pic, targets) {
  for (const name of ENGINEERS) {
    const el = starEls[name], info = pic.agents?.[name];
    const sw = stateWords(info);
    if (info?.state === "REVIEW" && targets[name]) sw.words = `reviewing ${targets[name]}'s pull request`;
    el.dataset.state = STATE_KEYS.includes(info?.state) ? info.state : "IDLE";
    el.querySelector(".st").replaceChildren(make("i", { "aria-hidden": "true", text: sw.glyph }), sw.words, ...(sw.repo ? [" · ", make("span", { class: "rp", text: sw.repo })] : []));
    const c = current.byAgent?.[name] ?? {};
    el.querySelector(".tl").replaceChildren(...tallyParts([[c.prs, "PR", "PRs"], [c.reviews, "review", "reviews"], [c.claude, "Claude request", "Claude requests"]]));
    el.setAttribute("aria-label", `${name}: ${sw.words}${sw.repo ? ` in ${sw.repo}` : ""}. Open details.`);
  }
  for (const name of POLE) {
    const el = starEls[name], items = poleTally(name);
    el.querySelector(".tl").replaceChildren(...tallyParts(items));
    const note = name === "Polaris" ? "the director" : SESSION_NOTE[name];
    el.setAttribute("aria-label", `${name}, ${note}: ${items.map(([n, one, many]) => plural(n ?? 0, one, many)).join(", ")} today. Open details.`);
  }
  const c = current.counts || {};
  const count = { claude: c.claude, github: (c.started ?? 0) + (c.prs ?? 0) + (c.reviews ?? 0) + (c.merged ?? 0), chat: c.chat };
  for (const key of PLACES) stationEls[key].querySelector("b").textContent = fmt.format(count[key] ?? 0);
}
const STATE_KEYS = ["WORKING", "REVIEW", "DISCUSS", "IDLE", "PAUSED"];

// ---- the headline: the longest form that fits in three lines
const headEl = $("headline");
function showHeadline(pic) {
  const targets = invert(reviewing(pic));
  const h = headline({ ...pic, now: serverNow(), names: ENGINEERS, targets });
  const max = parseFloat(getComputedStyle(headEl).lineHeight || "0") * 3.2 || Infinity;
  fitHeadline(h.forms, (form) => {
    showParts(headEl, form);
    return headEl.offsetHeight <= max;
  });
  showParts($("latest"), h.latest);
  $("hero").dataset.mood = h.mood;
  $("offer").hidden = DEMO || !!rp || !(h.mood === "quiet" || h.mood === "waiting");
}

// ---- the line
const STEP_DEF = { started: "issues picked up", building: "issues under way", review: "pull requests opened", fixing: "changes requested", merged: "pull requests merged" };
const COUNT_KEY = { started: "started", building: "building", review: "prs", fixing: "changes", merged: "merged" };
const colEls = {}, cardEls = {}, countEls = {};
STAGES.forEach((stage, i) => {
  countEls[stage] = make("b", { text: "0" });
  const head = make("header", { class: `colhead${i === STAGES.length - 1 ? " last" : ""}` },
    make("span", { class: "step", text: String(i + 1).padStart(2, "0") }), " ", make("h3", { text: STAGE_NAME[stage] }), " ",
    make("span", { class: "tput" }, make("i", { "aria-hidden": "true", text: "· " }), countEls[stage], " today"),
    make("p", { class: "def", text: STEP_DEF[stage] }));
  const body = make("div", { class: "colbody" });
  if (stage === "merged") {
    body.append(make("div", { class: "pile" },
      make("span", { class: "pilecount", id: "pile-count", text: "0" }),
      make("p", { class: "pilelabel", text: "pull requests merged today" }),
      make("ol", { class: "tokens", id: "tokens", role: "img", "aria-label": "No pull requests merged yet today" }),
      make("p", { class: "toklegend", id: "tok-legend" })));
  }
  colEls[stage] = make("div", { class: "cards" });
  body.append(colEls[stage]);
  $("cols").append(make("section", { class: "col", "data-stage": stage, "aria-label": STAGE_NAME[stage] }, head, body));
});
for (const name of ENGINEERS) {
  const el = make("div", { class: "card", role: "button", tabindex: "0", "data-card": name });
  el.style.setProperty("--star", COLORS[name]);
  cardEls[name] = el;
  colEls.started.append(el);
}
const since = {}; // when each card reached its column, for "9 min here"
const dur = (s) => { const m = Math.floor(Math.max(0, s) / 60); return m < 1 ? "<1 min" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

function fillCard(name, pic, col, reviewer) {
  const info = pic.agents?.[name], lane = pic.line?.[name];
  const target = invert(reviewing(pic))[name];
  const w = cardWords(info, lane, col, target);
  const el = cardEls[name];
  since[name] = lane?.job ? lane.steps?.[col] ?? null : null;
  const st = make("p", { class: "cst" }, make("b", {}, make("i", { "aria-hidden": "true", text: w.glyph }), ` ${w.state}`));
  if (w.rest) st.append(` · ${w.rest}`);
  if (w.repo !== undefined) st.append(" · ", w.repo ? make("span", { class: "rp", text: w.repo }) : make("span", { class: "priv", text: "private project" }));
  const kids = [make("div", { class: "who" }, make("span", { class: "dot", "aria-hidden": "true" }), make("span", { text: name }), make("span", { class: "t", text: since[name] ? `${dur(pic.nowS - since[name])} here` : "" })), st];
  if (reviewer) {
    const row = make("div", { class: "rrow" }, make("span", { class: "rchip" }, glyph(reviewer), `${reviewer} reviewing`));
    row.style.setProperty("--rc", COLORS[reviewer]);
    kids.push(row);
  }
  el.replaceChildren(...kids);
  el.classList.toggle("idle", !isActive(info));
  el.dataset.state = info?.state ?? "IDLE";
  el.setAttribute("aria-label", `${name}, ${STAGE_NAME[col]}: ${cardText(w)}${reviewer ? `, ${reviewer} reviewing` : ""}. Find ${name} in the sky.`);
}

let linkTimer = 0;
function showLine(pic) {
  const authors = reviewing(pic);
  const first = Object.fromEntries(ENGINEERS.map((n) => [n, cardEls[n].getBoundingClientRect()]));
  const moved = new Set();
  for (const name of ENGINEERS) {
    const col = column(pic.line?.[name], pic.agents?.[name], pic.nowS);
    fillCard(name, pic, col, authors[name]);
    if (cardEls[name].parentNode !== colEls[col]) {
      colEls[col].append(cardEls[name]);
      moved.add(name);
    }
  }
  const c = current.counts || {};
  for (const stage of STAGES) countEls[stage].textContent = fmt.format(c[COUNT_KEY[stage]] ?? 0);
  showPile();
  const links = $("links");
  let anyMove = false;
  if (!reduced) {
    for (const name of ENGINEERS) {
      const a = first[name], b = cardEls[name].getBoundingClientRect(), dx = a.left - b.left, dy = a.top - b.top;
      if (!a.width || Math.abs(dx) + Math.abs(dy) < 1) continue;
      anyMove = true;
      const el = cardEls[name];
      el.classList.add("moving");
      el.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }], { duration: moved.has(name) ? 750 : 380, easing: "cubic-bezier(.2,.75,.25,1)" }).onfinish = () => el.classList.remove("moving");
    }
    for (const name of moved) {
      cardEls[name].classList.remove("arrive");
      void cardEls[name].offsetWidth;
      cardEls[name].classList.add("arrive");
    }
  }
  clearTimeout(linkTimer);
  if (anyMove) {
    links.style.opacity = "0";
    linkTimer = setTimeout(() => { drawLinks(pic); links.style.opacity = "1"; }, 780);
  } else {
    drawLinks(pic);
    links.style.opacity = "1";
  }
}

// The dashed line from a reviewer's card to the chip on the author's card.
function drawLinks(pic = picture()) {
  const box = $("board").getBoundingClientRect();
  const out = [];
  for (const [author, reviewer] of Object.entries(reviewing(pic))) {
    const row = cardEls[author].querySelector(".rrow");
    if (!row) continue;
    const a = cardEls[reviewer].getBoundingClientRect(), au = cardEls[author].getBoundingClientRect(), r = row.getBoundingClientRect();
    const y1 = a.top + a.height / 2 - box.top, y2 = r.top + r.height / 2 - box.top;
    let x1, x2, d;
    if (Math.abs(a.left - au.left) < 4) {
      x1 = a.right - box.left;
      x2 = au.right - box.left;
      const bend = Math.max(x1, x2) + 16;
      d = `M${x1} ${y1}C${bend} ${y1} ${bend} ${y2} ${x2} ${y2}`;
    } else {
      const toRight = au.left > a.left;
      x1 = (toRight ? a.right : a.left) - box.left;
      x2 = (toRight ? au.left : au.right) - box.left;
      const mx = (x1 + x2) / 2;
      d = `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
    }
    out.push(svg("path", { d, stroke: COLORS[reviewer] }), svg("circle", { cx: x1, cy: y1, r: "3.5", fill: COLORS[reviewer] }), svg("circle", { cx: x2, cy: y2, r: "2.5", fill: COLORS[reviewer] }));
  }
  $("links").replaceChildren(...out);
}
let linksTimer = 0;
new ResizeObserver(() => { clearTimeout(linksTimer); linksTimer = setTimeout(() => drawLinks(), 60); }).observe($("board"));

// Merged keeps a big count and a token per merge in its author's colour, up to 36 (10 on a wall).
const tokenCap = () => (root.classList.contains("wall") && innerWidth >= 1200 ? 10 : 36);
function showPile() {
  const c = current.counts || {};
  const by = AGENTS.map((n) => [n, current.byAgent?.[n]?.merged ?? 0]).filter(([, n]) => n > 0);
  $("pile-count").textContent = fmt.format(c.merged ?? 0);
  const cap = tokenCap();
  const tokens = tokenPile(by, cap);
  $("tokens").replaceChildren(...tokens.map((n) => {
    const t = make("li", { class: "tok", "aria-hidden": "true", text: n[0], title: n });
    t.style.setProperty("--star", COLORS[n]);
    return t;
  }));
  const said = by.sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n} ${k}`).join(" · ");
  const total = c.merged ?? 0;
  $("tok-legend").textContent = said + (total > cap ? ` · the pile shows ${cap}, in proportion` : "");
  $("tokens").setAttribute("aria-label", total ? `${plural(total, "pull request")} merged today: ${said}` : "No pull requests merged yet today");
}

// The director strip: Polaris's reviews and pull requests today, then its three Claude sessions.
// Polaris's requests and merges come with setkernel-live#35; until those events exist, nothing.
const sessionEls = {};
for (const name of POLE.slice(1)) {
  const b = make("button", { type: "button", class: "schip", "data-star": name, id: `chip-${name}` }, glyph(name), name, " ", make("small", {}, make("span", { class: "sn", text: `${SESSION_NOTE[name]} · ` }), make("span", { class: "sc" })));
  sessionEls[name] = b;
  $("sessions").append(make("li", {}, b));
}
function showDirector() {
  const c = current.byAgent?.Polaris ?? {};
  $("pstats").replaceChildren(...[[c.reviews ?? 0, "reviews"], [c.prs ?? 0, "PRs opened"]].map(([n, label]) => make("div", {}, make("dt", { text: label }), make("dd", { text: fmt.format(n) }))));
  $("director-compact").replaceChildren(make("b", { text: fmt.format(c.reviews ?? 0) }), " reviews · 3 sessions");
  for (const name of POLE.slice(1)) {
    const n = current.byAgent?.[name]?.prs ?? 0;
    sessionEls[name].querySelector(".sc").textContent = plural(n, "PR");
    sessionEls[name].setAttribute("aria-label", `${name}, ${SESSION_NOTE[name]}: ${plural(n, "PR")} today. Find ${name} in the sky.`);
  }
}

// ---- the Today strip, the rail and Recent work
const zoneLabel = (zone) => (zone ? `times in ${zone}` : "your local time");
function showZone() {
  const now = serverNow(), zone = zoneName(now), since = todaySince(now);
  $("since").textContent = `Today's numbers ${since}`;
  $("today-since").textContent = since;
  $("zone").textContent = zone;
  for (const id of ["hours-zone", "feed-zone"]) $(id).textContent = zoneLabel(zone);
  return zone;
}

function ciNumbers() {
  const c = current.counts || {};
  const runs = c.ci > 0 ? c.ci : 0, pass = Math.min(runs, c.ciPass > 0 ? c.ciPass : 0);
  return { runs, pass, pct: runs ? `${Math.floor((100 * pass) / runs)}%` : "–" };
}

function spark(id, key) {
  const hours = Array.isArray(current.hours) && current.hours.length === 24 ? current.hours : null;
  const el = $(id);
  if (!hours) return el.replaceChildren();
  const vals = hours.map((b) => (Number.isFinite(b[key]) && b[key] > 0 ? b[key] : 0));
  const max = Math.max(1, ...vals), w = 120, h = 28;
  const pts = vals.map((v, i) => `${((i * w) / 23).toFixed(1)},${(h - 2 - (v / max) * (h - 5)).toFixed(1)}`).join(" ");
  el.replaceChildren(svg("polygon", { points: `0,${h} ${pts} ${w},${h}` }), svg("polyline", { points: pts }));
  el.setAttribute("aria-label", `${key === "claude" ? "Claude requests" : "GitHub actions"} per hour over the last 24 hours: peak ${fmt.format(Math.max(...vals))}, this hour ${fmt.format(vals[23])}`);
}

function showNumbers() {
  const c = current.counts || {};
  const ci = ciNumbers();
  $("k-prs").textContent = fmt.format(c.prs ?? 0);
  $("k-reviews").textContent = fmt.format(c.reviews ?? 0);
  $("k-started").textContent = fmt.format(c.started ?? 0);
  $("k-ci").textContent = ci.pct;
  $("k-ci-words").textContent = ci.runs ? `CI passed (${ci.pass} of ${ci.runs})` : "CI: no runs yet";
  spark("sp-claude", "claude");
  spark("sp-github", "github");
  const nums = [[c.prs, "pull requests opened"], [c.reviews, "reviews"], [c.claude, "Claude requests"], [c.chat, "team-chat posts"], [c.started, "issues started"], [c.helpers, "helpers used"]];
  $("nums").replaceChildren(...nums.map(([n, label]) => make("div", {}, make("dt", { text: label }), make("dd", { text: fmt.format(n ?? 0) }))));
  $("per-engineer").replaceChildren(...ENGINEERS.map((name) => {
    const a = current.byAgent?.[name] ?? {};
    return make("tr", {}, make("td", {}, make("span", {}, glyph(name), name)), make("td", { text: fmt.format(a.prs ?? 0) }), make("td", { text: fmt.format(a.reviews ?? 0) }), make("td", { text: fmt.format(a.claude ?? 0) }));
  }));
}

const ROWS = [["claude", "Claude"], ["github", "GitHub"], ["chat", "Team chat"]];
const ROW_WORDS = { claude: "Claude requests", github: "GitHub actions", chat: "team-chat posts" };
function showHours(zone) {
  const hours = Array.isArray(current.hours) && current.hours.length === 24 ? current.hours : null;
  if (!hours) return;
  const said = [];
  const rows = ROWS.map(([key, name]) => {
    const vals = hours.map((b) => (Number.isFinite(b[key]) && b[key] > 0 ? b[key] : 0));
    const peak = Math.max(...vals), total = vals.reduce((a, v) => a + v, 0);
    const bars = make("div", { class: "hbars", "aria-hidden": "true" }, ...vals.map((v, i) => {
      const bar = make("i", { title: `${clock(hours[i].h * 3600)}: ${fmt.format(v)} ${ROW_WORDS[key]}` });
      bar.style.setProperty("--v", peak ? String(v / peak) : "0");
      bar.style.setProperty("--place", COLORS[key]);
      return bar;
    }));
    said.push(total ? `${ROW_WORDS[key]}: ${total}, busiest at ${clock(hours[vals.indexOf(peak)].h * 3600)} with ${peak}.` : `${ROW_WORDS[key]}: none.`);
    return make("div", { class: "hrow" }, make("p", {}, make("span", { class: `place ${key}`, text: name }), make("small", { text: `${fmt.format(vals[23])} this hour` })), bars);
  });
  const ticks = make("div", { class: "hticks", "aria-hidden": "true" }, ...[0, 6, 12, 18].map((i) => make("span", { text: clock(hours[i].h * 3600) })), make("span", { text: "now" }));
  $("hours").replaceChildren(...rows, ticks);
  $("hours-desc").textContent = `Per hour over the last 24 hours, ${clock(hours[0].h * 3600)} to now, ${zoneLabel(zone)}. ${said.join(" ")}`;
}

// The latest test runs as ticks, oldest first: a full bar passed, a short outlined one with a ×
// failed, so the shape says it as well as the colour. Each carries its words for screen readers.
function showCi(zone) {
  const at = (r) => (Number.isFinite(r.ts) ? ` at ${clock(r.ts)}${zone ? ` ${zone}` : ""}` : "");
  const runs = (Array.isArray(current.ci) ? current.ci : []).slice(0, 20);
  $("ci-runs").replaceChildren(...runs.slice().reverse().map((r) => {
    const said = `${ciWhere(r)} ${ciWord(r)}${at(r)}`;
    return make("li", { class: r.result === "pass" ? "pass" : "fail", title: said }, make("span", { class: "visually-hidden", text: said }));
  }));
  const ci = ciNumbers();
  $("ci-pct").textContent = ci.pct;
  $("ci-today").textContent = ci.runs ? `passed today · ${ci.pass} of ${plural(ci.runs, "run")}` : ciSummary(current.counts);
  const last = runs[0];
  $("ci-last").replaceChildren(...(last ? ["Last: ", last.repo ? repoLink(last.repo) : ciWhere(last), ` ${ciWord(last)}${at(last)}.`] : []));
}

function feedItem(f) {
  const who = make("b", { text: f.agent });
  who.style.setProperty("--star", COLORS[f.agent] || COLORS.Vega);
  const words = deed(f), where = whereWork(f);
  const p = make("p", {}, who, " ");
  // the repo, when public, is a link; the rest of the words stay plain text
  if (f.repo && where && words.endsWith(` in ${f.repo}`)) p.append(words.slice(0, -f.repo.length), repoLink(f.repo));
  else p.append(words);
  return make("li", {}, make("time", { datetime: new Date(f.ts * 1000).toISOString(), text: clock(f.ts) }), glyph(f.agent), p);
}
function showFeed(pic) {
  const feed = (pic.feed || []).slice(0, 14);
  $("feed").replaceChildren(...(feed.length ? feed.map(feedItem) : [make("li", { class: "empty", text: "Nothing yet." })]));
}

// ---- the star card: beside its star (a bottom sheet on phones)
const card = $("scard");
let openName = null, opener = null;
function showCard() {
  if (!openName) return;
  const pic = picture();
  const c = starCard(openName, pic, pic.nowS, invert(reviewing(pic)));
  card.style.setProperty("--star", COLORS[openName]);
  $("sc-eyebrow").textContent = c.eyebrow;
  $("sc-title").textContent = c.title;
  const body = [];
  const zone = zoneName(serverNow());
  if (c.director) {
    body.push(make("p", { class: "cnote", text: c.note }));
  } else {
    const s = make("p", { class: "cstate" }, make("span", { class: "chipst" }, make("i", { "aria-hidden": "true", text: c.state.glyph }), c.state.state));
    if (isActive(pic.agents?.[openName])) s.append(` ${c.state.words}`);
    if (c.state.repo) s.append(" · ", make("span", { class: "rp", text: c.state.repo }));
    body.push(s);
  }
  body.push(make("p", { class: "online" }, "On the line: ", make("b", { text: c.column })));
  if (c.steps) {
    const MARK = { done: "✓", now: "●", todo: "○", skip: "–" };
    const SAY = { done: ", done", now: ", now", todo: ", not yet", skip: ", passed" };
    body.push(make("h4", {}, c.task, make("span", { text: zone })), make("ol", { class: "life" }, ...c.steps.map((s) => make("li", { class: s.status },
      make("span", { class: "mk", "aria-hidden": "true", text: MARK[s.status] }),
      make("span", { class: "sn" }, STAGE_NAME[s.stage], make("span", { class: "visually-hidden", text: SAY[s.status] })),
      make("time", { text: s.ts ? clock(s.ts) : "—" }),
      s.status === "now" ? make("em", { text: "now" }) : make("span")))));
  }
  body.push(make("h4", { text: "Today" }), make("dl", { class: "cnums" }, ...c.numbers.map(([n, label]) => make("div", {}, make("dt", { text: label }), make("dd", { text: fmt.format(n) })))));
  body.push(make("h4", { text: "Latest" }), c.latest.length
    ? make("ul", { class: "clast" }, ...c.latest.map((l) => make("li", {}, make("span", { text: l.text }), make("time", { text: clock(l.ts) }))))
    : make("p", { class: "cnote", text: "No GitHub actions in the recent work." }));
  $("sc-body").replaceChildren(...body);
  $("sc-see").textContent = c.director ? "See it in the director strip ↓" : "See it on the line ↓";
  placeCard();
}
function placeCard() {
  if (!openName || card.hidden || !L) return;
  if (innerWidth < 760) {
    for (const k of ["--left", "--top", "--maxh"]) card.style.removeProperty(k);
    return;
  }
  const W = L.w, H = L.h, g = 12;
  card.style.setProperty("--maxh", `${H - 16}px`);
  const p = L.stars[openName], b = over(starEls[openName]) ?? { left: p.x, right: p.x };
  const cw = card.offsetWidth, ch = card.offsetHeight;
  let x = b.right + g + cw <= W - 8 ? b.right + g : b.left - g - cw >= 8 ? b.left - g - cw : p.x < W / 2 ? p.x + 2.2 * rem() : p.x - 2.2 * rem() - cw;
  x = Math.max(8, Math.min(x, W - cw - 8));
  card.style.setProperty("--left", `${x}px`);
  card.style.setProperty("--top", `${Math.max(8, Math.min(p.y - ch * 0.3, H - ch - 8))}px`);
}
function openCard(name, from) {
  openName = name;
  opener = from;
  card.hidden = false;
  for (const n of AGENTS) starEls[n].setAttribute("aria-expanded", String(n === name));
  showCard();
  $("sc-title").focus({ preventScroll: true });
}
function closeCard(back) {
  if (!openName) return;
  card.hidden = true;
  openName = null;
  for (const n of AGENTS) starEls[n].setAttribute("aria-expanded", "false");
  if (back && opener) opener.focus({ preventScroll: true });
}

// ---- links both ways: a star's card finds its board card, a board card pulses its star
const restart = (el, cls, ms) => {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  clearTimeout(el[`${cls}Timer`]);
  el[`${cls}Timer`] = setTimeout(() => el.classList.remove(cls), ms);
};
function reveal(el) {
  const r = el.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight) el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
}
function toLine(name) {
  const el = ENGINEERS.includes(name) ? cardEls[name] : name === "Polaris" ? $("pole-btn") : sessionEls[name];
  reveal(el);
  restart(el, "spot", 2800);
  el.focus({ preventScroll: true });
}
function toSky(name) {
  const el = starEls[name];
  if (!el) return;
  reveal(el);
  restart(el, "spot", 2800);
  el.focus({ preventScroll: true });
}
document.addEventListener("click", (ev) => {
  const star = ev.target.closest(".star");
  if (star) {
    const name = star.dataset.star;
    return openName === name ? closeCard(true) : openCard(name, star);
  }
  if (openName && !card.contains(ev.target)) closeCard(false);
  const other = ev.target.closest("[data-card], [data-star]");
  if (other) toSky(other.dataset.card || other.dataset.star);
});
$("sc-close").addEventListener("click", () => closeCard(true));
$("sc-see").addEventListener("click", () => {
  const name = openName;
  closeCard(false);
  toLine(name);
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && openName) return closeCard(true);
  if ((ev.key === "Enter" || ev.key === " ") && ev.target?.dataset?.card) {
    ev.preventDefault();
    toSky(ev.target.dataset.card);
  }
});

// ---- the status, the clock and LIVE
let lastStatus = "";
function showAge() {
  const age = rp ? (rp.hours === 1 ? "replaying the last hour" : "replaying the last 24 h") : freshness(current.lastIngest, serverNow());
  $("status-age").textContent = age ? ` · ${age}` : "";
}
function showStatus(connected) {
  const quiet = !current.lastIngest || serverNow() - current.lastIngest > OFFLINE_AFTER_MS;
  let cls, text;
  if (rp) [cls, text] = ["replay", "Replay"];
  else if (DEMO) [cls, text] = ["demo", "Demo · sample data"];
  else if (!connected) [cls, text] = ["down", "Reconnecting…"];
  else if (quiet) [cls, text] = ["down", current.lastIngest ? "Office offline" : "Waiting for the office"];
  else [cls, text] = ["live", "Live"];
  if (cls + text !== lastStatus) { // only on change, so screen readers aren't told twice
    lastStatus = cls + text;
    $("status").className = `status ${cls}`;
    $("status-text").textContent = text;
    const mini = $("live-mini");
    mini.className = `livemini ${cls}`;
    mini.textContent = cls === "live" ? "LIVE" : cls === "replay" ? "REPLAY" : cls === "demo" ? "DEMO" : "OFFLINE";
  }
  showAge();
}
const clockFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function tick() {
  $("clock").textContent = clockFormat.format(new Date(serverNow()));
  if (document.hidden) return;
  showAge();
  const pic = picture();
  for (const name of ENGINEERS) {
    const t = cardEls[name].querySelector(".t");
    if (t && since[name]) t.textContent = `${dur(pic.nowS - since[name])} here`;
  }
}

// a brief pulse of the status dot each time data arrives (hello, batch or heartbeat); none under reduced motion
const dot = $("status").querySelector("i");
dot.addEventListener("animationend", () => dot.classList.remove("pulse"));
function pulse() {
  if (reduced) return;
  dot.classList.remove("pulse");
  void dot.offsetWidth; // restart the animation if one is still running
  dot.classList.add("pulse");
}

// Arcs for reviews the page can tie to an author: from review events (light) and from the live
// state, once per pair.
const arcsSeen = new Set();
function stateArcs(pic) {
  for (const [author, reviewer] of Object.entries(reviewing(pic))) {
    const key = `${reviewer}>${author}`;
    if (!arcsSeen.has(key)) {
      arcsSeen.add(key);
      sky.review(reviewer, author);
    }
  }
}

// Everything that depends on the picture, in one go, so star and card always agree.
function showPicture() {
  const pic = picture();
  const targets = invert(reviewing(pic));
  showStars(pic, targets);
  showHeadline(pic);
  showLine(pic);
  showFeed(pic);
  stateArcs(pic);
  if (openName) showCard();
}
function render(connected = true) {
  const zone = showZone();
  showPicture();
  showDirector();
  showNumbers();
  showHours(zone);
  showCi(zone);
  showStatus(connected);
}

// ---- events: light across the sky, spread over the seconds they really took
const announcer = createAnnouncer({ say: (t) => { $("announce").textContent = t; } });
function light(e, recent) {
  if (document.hidden) return;
  sky.event(e.agent, e.kind === "github" ? "github" : e.kind === "helper" ? "claude" : e.kind);
  const target = e.kind === "github" ? reviewTarget(e, recent) : null;
  if (target) sky.review(e.agent, target);
  if (e.kind === "github" && POLE.includes(e.agent)) restart(starEls[e.agent], "ping", 2300);
}
function play(events) {
  const msgs = events.filter((e) => e.t === "msg" && e.kind !== "ci"); // a test run has no star to leave
  if (!msgs.length || rp) return;
  const first = Math.min(...msgs.map((e) => e.ts ?? Infinity));
  const recent = current.feed || [];
  for (const e of msgs) {
    const delay = Number.isFinite(first) ? Math.min(5000, Math.max(0, ((e.ts ?? first) - first) * 1000)) : 0;
    setTimeout(() => light(e, recent), delay);
  }
}

function apply(msg) {
  if (typeof msg.now === "number") skew = msg.now - Date.now();
  for (const k of ["agents", "counts", "byAgent", "seen", "line", "feed", "ci", "hours"]) if (msg[k] && typeof msg[k] === "object") current[k] = msg[k];
  if (typeof msg.lastIngest === "number") current.lastIngest = msg.lastIngest;
  render(true);
  if (msg.t === "hello" || msg.t === "batch") pulse();
  if (msg.t === "batch" && Array.isArray(msg.events)) {
    announcer.add(msg.events);
    play(msg.events);
  }
}

// ---- live: the WebSocket, reconnecting with backoff
let ws, retry = 1000;
function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => { retry = 1000; showStatus(true); };
  ws.onmessage = (m) => {
    try { apply(JSON.parse(m.data)); } catch (err) { console.error(err); }
  };
  ws.onclose = () => {
    showStatus(false);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 30_000);
  };
}

// ---- demo: the sample simulation, through the same reducer and view as the Durable Object
let demoReplay = emptyReplay();
function startDemo() {
  $("demo-note").hidden = false;
  document.title = `Demo · ${document.title}`;
  const start = Math.trunc(Date.now() / 1000);
  const sim = createDemo(17, start - 86_400);
  const day = (s) => new Date(s * 1000).toISOString().slice(0, 10);
  const midnight = Math.floor(start / 86_400) * 86_400;
  const history = sim.advance(start);
  const before = { events: history.events.filter((e) => e.ts < midnight), agents: history.agents };
  const after = { events: history.events.filter((e) => e.ts >= midnight), agents: history.agents };
  let state = applyBatch(emptyState(day(midnight - 1)), before, (midnight - 1) * 1000, day(midnight - 1));
  state = applyBatch(state, after, start * 1000, day(start));
  demoReplay = recordReplay(emptyReplay(), history, start * 1000);
  apply({ t: "hello", ...view(state, demoReplay, Date.now()) });
  setInterval(() => {
    const now = Date.now();
    const batch = sim.advance(Math.trunc(now / 1000));
    state = applyBatch(state, batch, now, day(now / 1000));
    demoReplay = recordReplay(demoReplay, batch, now);
    apply({ t: "batch", events: batch.events, ...view(state, demoReplay, now) });
  }, 2000);
}

// ---- replay: the last hour in a minute, the last day in two. It drives the sky and the line
// together: the lanes catch up on everything before the show silently, then move with it.
const replayButtons = [...document.querySelectorAll("[data-replay]")];
let replayTimer = 0;
let replayGen = 0; // bumped on every start and stop, so a replay whose data arrives late is dropped
async function startReplay(h) {
  stopReplay();
  const gen = ++replayGen;
  const cfg = REPLAYS[h];
  const to = nowS(), from = to - cfg.hours * 3600;
  let data;
  try {
    // the whole day, so the line knows where everyone was when the show starts
    data = DEMO ? replaySince(demoReplay, to - 86_400) : await (await fetch("/api/replay?h=24", { cache: "no-store" })).json();
  } catch {
    if (gen === replayGen) $("latest").textContent = "The replay couldn't be loaded. Try again in a moment.";
    return;
  }
  if (gen !== replayGen) return; // another click, or Back to live, came first
  const show = plan(data, { from, to, durationMs: cfg.durationMs, maxPulses: cfg.maxPulses });
  const pre = eventsBefore(data, from);
  const last = {};
  for (const e of pre) if (PULSE_KINDS.includes(e.kind)) last[e.agent] = e.ts;
  const lines = stepLines({}, pre, ENGINEERS).lines;
  const feed = pre.filter((e) => e.kind === "github").reverse().slice(0, 30).map(({ agent, action, repo, ts }) => ({ agent, action, ...(repo ? { repo } : {}), ts }));
  rp = { hours: h, lines, last, feed, nowS: from, agents: replayAgents(last, lines, ENGINEERS, from) };
  sky.clear();
  arcsSeen.clear();
  closeCard(false);
  $("replaying").hidden = false;
  $("replay-what").textContent = show.length ? `Replaying the last ${h === 1 ? "hour" : "24 hours"}` : `Nothing happened in the last ${h === 1 ? "hour" : "24 hours"}`;
  for (const b of replayButtons) if (b.closest(".controls")) b.setAttribute("aria-pressed", String(b.dataset.replay === String(h)));
  showStatus(true);
  showPicture();
  const t0 = performance.now();
  let i = 0, lastShown = 0;
  const step = () => {
    const ms = performance.now() - t0;
    let changed = false;
    while (i < show.length && show[i].at <= ms) {
      const e = show[i++];
      const ev = { t: "msg", kind: e.kind, agent: e.agent, ts: Math.trunc(e.ts), ...(e.action ? { action: e.action } : {}), ...(e.repo ? { repo: e.repo } : {}) };
      light(ev, rp.feed);
      rp.lines = stepLines(rp.lines, [ev], ENGINEERS).lines;
      if (PULSE_KINDS.includes(e.kind)) rp.last[e.agent] = ev.ts;
      if (e.kind === "github") {
        rp.feed = [{ agent: ev.agent, action: ev.action, ...(ev.repo ? { repo: ev.repo } : {}), ts: ev.ts }, ...rp.feed].slice(0, 30);
        changed = true;
      }
    }
    rp.nowS = Math.trunc(from + Math.min(1, ms / cfg.durationMs) * (to - from));
    $("replay-at").textContent = clock(rp.nowS);
    $("replay-progress").style.width = `${Math.min(100, (ms / cfg.durationMs) * 100)}%`;
    // the picture moves with the show: at once for GitHub actions, otherwise twice a second
    if (changed || ms - lastShown > 500) {
      lastShown = ms;
      rp.agents = replayAgents(rp.last, rp.lines, ENGINEERS, rp.nowS);
      showPicture();
    }
    if (ms >= cfg.durationMs + 1500) stopReplay();
  };
  replayTimer = setInterval(step, 100);
  step();
}
function stopReplay() {
  replayGen++;
  clearInterval(replayTimer);
  replayTimer = 0;
  const was = !!rp;
  rp = null;
  $("replaying").hidden = true;
  for (const b of replayButtons) if (b.closest(".controls")) b.setAttribute("aria-pressed", "false");
  if (was) {
    sky.clear();
    arcsSeen.clear();
    render(DEMO || ws?.readyState === WebSocket.OPEN);
  }
}
for (const b of replayButtons) b.addEventListener("click", () => (b.getAttribute("aria-pressed") === "true" ? stopReplay() : startReplay(Number(b.dataset.replay))));
$("replay-stop").addEventListener("click", stopReplay);

// ---- wall mode: ?wall, or the button (which also goes fullscreen where the browser allows)
const wallBtn = $("wall-toggle");
function setWall(on) {
  root.classList.toggle("wall", on);
  wallBtn.setAttribute("aria-pressed", String(on));
  showPile();
}
wallBtn.addEventListener("click", async () => {
  const on = !root.classList.contains("wall");
  setWall(on);
  try {
    if (on && document.fullscreenEnabled && !document.fullscreenElement) await root.requestFullscreen();
    if (!on && document.fullscreenElement) await document.exitFullscreen();
  } catch {
    // fullscreen refused (iOS, an iframe): wall mode still works in the window
  }
});
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && !params.has("wall")) setWall(false); });
if (params.has("wall")) setWall(true);

reducedQuery.addEventListener("change", (e) => {
  reduced = e.matches;
  sky.setReduced(reduced);
});

// keep "offline", "Today since", the zone's name and the line's two-minute rule moving even when
// nothing arrives, and the clock and the age beside the status every second
setInterval(() => {
  showZone();
  if (!rp) showPicture();
  showStatus(DEMO || ws?.readyState === WebSocket.OPEN);
}, 15_000);
setInterval(tick, 1000);

render(false);
layoutSky();
tick();
wake();
if (document.fonts) document.fonts.ready.then(() => { layoutSky(); showHeadline(picture()); drawLinks(); });
if (DEMO) startDemo();
else connect();
