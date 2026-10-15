// Lays out one snapshot from DATA (built by build.mjs with the live page's own wording). Everything
// is built with textContent, as on the live page. The controls read and write the URL hash:
//   #mood=live|quiet|offline|waiting  &data=busy|quiet  &layout=page|wall  &still  &clean
// "still" shows the live mood's last step without playing; "clean" hides the controls (screenshots).

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const SVG = "http://www.w3.org/2000/svg";
const svg = (tag, attrs) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

// The state glyphs from words.js (● ◎ ⋯ ○ ‖), drawn so they look the same on every system.
function glyph(state) {
  const g = svg("svg", { class: "glyph", viewBox: "0 0 12 12", "aria-hidden": "true" });
  const ring = (r) => svg("circle", { cx: 6, cy: 6, r, fill: "none", stroke: "currentColor", "stroke-width": 1.6 });
  if (state === "WORKING") g.append(svg("circle", { cx: 6, cy: 6, r: 5.2, fill: "currentColor" }));
  else if (state === "REVIEW") g.append(ring(4.9), svg("circle", { cx: 6, cy: 6, r: 2, fill: "currentColor" }));
  else if (state === "DISCUSS") for (const x of [1.8, 6, 10.2]) g.append(svg("circle", { cx: x, cy: 6, r: 1.5, fill: "currentColor" }));
  else if (state === "PAUSED") g.append(svg("rect", { x: 2.6, y: 1.5, width: 2.2, height: 9, fill: "currentColor" }), svg("rect", { x: 7.2, y: 1.5, width: 2.2, height: 9, fill: "currentColor" }));
  else if (state === "NONE") g.append(svg("rect", { x: 1.5, y: 5.2, width: 9, height: 1.6, fill: "currentColor" }));
  else g.append(ring(4.9));
  return g;
}

const STAGES = ["Started", "Building", "In review", "Fixing", "Merged"];
function stageCell(stage, none) {
  const cell = el("span", "stage");
  if (none) return cell; // nothing reported yet: one "No report yet" on the row says it
  if (!stage) {
    cell.append(el("span", "dim", "No job yet"));
    return cell;
  }
  const track = el("span", "track");
  track.setAttribute("aria-hidden", "true");
  track.title = stage.track.map((s, i) => `${STAGES[i]}${stage.times[i] ? ` ${stage.times[i]}` : s === "skip" ? " (passed)" : ""}`).join(" · ");
  for (const s of stage.track) track.append(el("i", s));
  cell.append(track, el("span", "", stage.word));
  return cell;
}

function engineer(r, prev, offline) {
  const li = el("li");
  const row = el("div", `row s-${r.state}${offline ? " offline" : ""}`);
  row.dataset.name = r.name;
  const state = el("span", "state");
  state.append(glyph(r.state), el("span", "word", r.word));
  const what = el("span", "what");
  if (r.detail) what.append(r.detail);
  if (r.where) what.append(el("span", "where", `${r.detail ? " " : ""}in ${r.where}`));
  if (!r.detail && !r.where) what.append(el("span", "dim", r.state === "NONE" ? "" : "nothing seen yet"));
  if (r.today) what.append(el("span", "tally", r.today));
  const time = el("span", "time");
  if (r.time) {
    time.append(r.time);
    time.append(el("small", "", `since ${r.since}`));
  }
  row.append(el("span", "name", r.name), state, what, stageCell(r.stage, r.state === "NONE"), time, el("span", "today", r.today));
  // for screen readers, the row as one sentence
  row.setAttribute("aria-label", `${r.name}: ${r.word}${r.detail ? ` ${r.detail}` : ""}${r.where ? ` in ${r.where}` : ""}${r.stage ? `. On the line: ${r.stage.word}` : ""}${r.time ? `, for ${r.time}` : ""}.${r.today ? ` Today: ${r.today}.` : ""}`);
  if (prev && prev !== r.word) row.classList.add("changed");
  li.append(row);
  return li;
}

// Polaris and its three Claudes: seen only through GitHub, so a last action in place of a state
function pole(p, waiting) {
  const box = $("pole");
  box.replaceChildren();
  const row = el("div", "row");
  const last = waiting ? null : p.polaris.last;
  row.append(
    el("span", "name", "Polaris"),
    el("span", "state note", p.polaris.note),
    el("span", `what${last ? "" : " dim"}`, last ? last.text : waiting ? "" : "Nothing yet today"),
    el("span", "time", last ? last.time : ""),
    el("span", "today", waiting ? "" : p.polaris.today),
  );
  box.append(row);
  for (const s of p.subs) {
    const line = el("div", "sub-line");
    line.append(el("span", "name", s.name), el("span", s.last.dim ? "what dim" : "what", waiting ? "" : s.last.text), el("span", "time", waiting ? "" : s.last.time), el("span", "today", waiting ? "" : s.today));
    box.append(line);
  }
}

function logList(items, mood) {
  const ol = $("log");
  ol.replaceChildren();
  if (!items.length) {
    ol.append(el("li", "empty", mood === "waiting" ? "Nothing has arrived yet. Each pull request, review, merge and test run will be listed here as a sentence." : "Nothing yet today."));
    return;
  }
  for (const e of items) {
    const li = el("li");
    const p = el("span");
    if (e.name) p.append(el("b", "", e.name));
    p.append(e.text);
    li.append(el("time", "", e.time), p);
    ol.append(li);
  }
}

function series(label, hours, key, short) {
  const peak = Math.max(0, ...hours.map((h) => h[key]));
  const box = el("div", "series");
  const head = el("div", "series-head");
  const at = hours.findIndex((h) => h[key] === peak);
  head.append(el("span", "", label), el("span", "peak", peak ? `peak ${peak.toLocaleString("en-US")} at ${String(hours[at].hour).padStart(2, "0")}:00` : "none"));
  const bars = el("div", `bars${short ? " short" : ""}`);
  bars.setAttribute("aria-hidden", "true");
  hours.forEach((h) => {
    const b = el("i", `${h.today ? "" : "old"}${h[key] ? "" : " zero"}`);
    if (h[key]) b.style.height = `${Math.max(4, (100 * h[key]) / peak)}%`;
    b.title = `${String(h.hour).padStart(2, "0")}:00: ${h[key].toLocaleString("en-US")}${h.now ? " (so far)" : ""}`;
    bars.append(b);
  });
  const mid = hours.findIndex((h) => h.today);
  if (mid > 0) {
    const m = el("span", "midnight");
    m.style.left = `calc(${(100 * mid) / 24}% - 1px)`;
    bars.append(m);
  }
  box.append(head, bars);
  return box;
}

function strip(hours, mood, zone) {
  const box = $("strip");
  box.replaceChildren();
  box.append(series("Claude requests, each hour", hours, "claude"), series("GitHub actions, each hour", hours, "github", true));
  const labels = el("div", "hours");
  labels.setAttribute("aria-hidden", "true");
  const mid = hours.findIndex((h) => h.today);
  hours.forEach((h, i) => {
    let t = "";
    if (i === mid && mid > 0) t = "Today";
    else if (h.now) t = "now";
    else if (h.hour % 6 === 0 && Math.abs(i - mid) > 2 && i < 22) t = String(h.hour).padStart(2, "0");
    labels.append(el("span", i === mid ? "today-mark" : "", t));
  });
  box.append(labels);
  // the table a screen reader gets in place of the bars
  const table = el("table", "sr");
  const cap = el("caption", "", `Each hour of the last 24, ${zone} time`);
  table.append(cap);
  for (const h of hours) {
    const tr = el("tr");
    tr.append(el("th", "", `${String(h.hour).padStart(2, "0")}:00`), el("td", "", `${h.claude} Claude requests`), el("td", "", `${h.github} GitHub actions`));
    table.append(tr);
  }
  box.append(table);
  const total = hours.reduce((n, h) => n + h.claude + h.github, 0);
  const note = mood === "waiting" || !total ? "Nothing recorded in the last 24 hours yet." : "Darker bars are today, from midnight in Halifax. Lighter bars are yesterday.";
  box.append(el("p", "strip-note", note));
}

// ---- state: what the controls chose, kept in the hash so a link (or a screenshot) can say it
const opts = { mood: "live", data: "busy", layout: "page" };
const flags = new Set();
function readHash() {
  for (const part of location.hash.slice(1).split("&").filter(Boolean)) {
    const [k, v] = part.split("=");
    if (v != null && k in opts) opts[k] = decodeURIComponent(v);
    else flags.add(k);
  }
}
const writeHash = () => history.replaceState(null, "", `#${Object.entries(opts).map(([k, v]) => `${k}=${v}`).join("&")}`);

let last = {}; // each engineer's state word, so a change can be shown
let timer = null;

function render(snap) {
  const offline = snap.mood === "offline";
  document.documentElement.dataset.mood = snap.mood;
  $("head").textContent = snap.head;
  $("sub").textContent = snap.sub;
  $("fresh").textContent = snap.fresh;
  $("clock").textContent = snap.clock;
  $("h-state").textContent = offline ? `At ${snap.asOf}` : "Now";
  $("h-today").textContent = `Today, since ${snap.since}`;
  pole(snap.pole, snap.waiting);
  const rows = $("rows");
  rows.replaceChildren(...snap.rows.map((r) => engineer(r, last[r.name], offline)));
  last = Object.fromEntries(snap.rows.map((r) => [r.name, r.word]));
  logList(snap.log, snap.mood);
  strip(snap.hours, snap.mood, "Halifax");
}

function show({ play = false } = {}) {
  clearTimeout(timer);
  const root = document.documentElement;
  root.classList.toggle("wall", opts.layout === "wall");
  root.classList.toggle("clean", flags.has("clean"));
  for (const b of document.querySelectorAll(".proto button[data-k]")) b.setAttribute("aria-pressed", String(opts[b.dataset.k] === b.dataset.v));
  const steps = DATA[opts.data]?.[opts.mood] ?? DATA.busy.live;
  $("play").hidden = opts.mood !== "live";
  last = {};
  if (!play) return render(steps.at(-1));
  // the live mood: play the minutes up to now, one every 2.5 s, then hold
  let i = 0;
  const step = () => {
    render(steps[i]);
    if (++i < steps.length) timer = setTimeout(step, 2500);
  };
  step();
}

readHash();
document.querySelector(".proto").addEventListener("click", (ev) => {
  const b = ev.target.closest("button");
  if (!b) return;
  if (b.id === "play") return show({ play: true });
  opts[b.dataset.k] = b.dataset.v;
  writeHash();
  show();
});
show({ play: opts.mood === "live" && !flags.has("still") });
