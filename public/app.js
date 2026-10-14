// live.setkernel.com page. Connects to /ws (or, with ?demo, runs the sample simulation through the
// same reducer as the Durable Object), and shows: one line of what's happening now, the sky, today
// in a few numbers, the last 24 hours, the latest test runs, and the recent-work stream. Everything
// shown is built with textContent and attributes, never innerHTML, so nothing in a batch can
// inject markup.
import { AGENTS, applyBatch, emptyReplay, emptyState, recordReplay, replaySince, view } from "/lib/state.js";
import { ACTION_TEXT, OFFLINE_AFTER_MS, ciSummary, ciWhere, ciWord, clock, createAnnouncer, freshness, headline, isActive, reviewTarget, starLabel, tally, todaySince, zoneName } from "/lib/words.js";
import { PLACES, PLACE_NAMES, skyLayout } from "/lib/layout.js";
import { createSky } from "/lib/sky.js";
import { createDemo } from "/lib/demo.js";
import { REPLAYS, plan } from "/lib/replay.js";

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
const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
const css = getComputedStyle(document.documentElement);
const color = (k) => css.getPropertyValue(`--${k}`).trim();
const reducedQuery = matchMedia("(prefers-reduced-motion: reduce)");
const COLORS = Object.fromEntries([...AGENTS.map((n) => [n, color(n.toLowerCase())]), ...PLACES.map((k) => [k, color(k)])]);

let skew = 0; // server clock minus ours
const serverNow = () => Date.now() + skew;
let current = { agents: {}, counts: {}, byAgent: {}, seen: {}, feed: [], ci: [], hours: [], lastIngest: 0 };
let replaying = null;

// ---- the sky and the labels over it
const skyEl = $("sky");
const sky = createSky($("sky-canvas"), { reduced: reducedQuery.matches, colors: COLORS });
const starEls = {}, placeEls = {};
for (const name of AGENTS) {
  const li = make("li", { class: "idle" }, make("b", { text: name }), make("span", { class: "state" }), make("span", { class: "tally" }));
  li.style.setProperty("--star", COLORS[name]);
  starEls[name] = li;
  $("stars").append(li);
}
for (const key of PLACES) {
  const li = make("li", {}, PLACE_NAMES[key], make("small"));
  placeEls[key] = li;
  $("places").append(li);
}
function layoutSky() {
  const { width, height } = skyEl.getBoundingClientRect();
  if (!width || !height) return;
  const L = skyLayout(width, height);
  sky.resize(L, devicePixelRatio);
  const place = (li, p) => {
    li.style.setProperty("--x", `${p.x}px`);
    li.style.setProperty("--y", `${p.y}px`);
  };
  for (const name of AGENTS) {
    const st = L.stars[name], left = st.label === "left";
    place(starEls[name], st);
    starEls[name].classList.toggle("left", left);
    // the words wrap rather than run off the sky
    starEls[name].style.maxWidth = `${Math.max(120, (left ? st.x : width - st.x) - 26)}px`;
  }
  for (const key of PLACES) {
    place(placeEls[key], L.places[key]);
    placeEls[key].className = L.places[key].label;
  }
  declutter();
}
new ResizeObserver(layoutSky).observe(skyEl);

// Where a star's words would run into a place's label (mid-size skies), drop the tally first,
// then the detail. The name and state always stay.
function declutter() {
  for (const name of AGENTS) starEls[name].classList.remove("compact", "tiny");
  const overlap = (r, b) => r.left < b.right + 8 && r.right + 8 > b.left && r.top < b.bottom && r.bottom > b.top;
  const others = (me) => [...PLACES.map((k) => placeEls[k]), ...AGENTS.filter((n) => n !== me).map((n) => starEls[n])];
  const hits = (name) => {
    const r = starEls[name].getBoundingClientRect();
    return others(name).some((el) => overlap(r, el.getBoundingClientRect()));
  };
  for (const name of AGENTS) {
    if (hits(name)) starEls[name].classList.add("compact");
    if (hits(name)) starEls[name].classList.add("tiny");
  }
}

// draw only while someone can see it
let onScreen = true;
const wake = () => (onScreen && !document.hidden ? sky.start() : sky.stop());
new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; wake(); }).observe(skyEl);
document.addEventListener("visibilitychange", wake);

// ---- rendering the picture
// Times are in the visitor's own zone; the labels that explain them name it ("times in ADT").
const zoneLabel = (zone) => zone ? `times in ${zone}` : "your local time";

function showZone() {
  const now = serverNow();
  const zone = zoneName(now);
  $("today-since").textContent = todaySince(now);
  for (const id of ["hours-zone", "stream-zone"]) $(id).textContent = zoneLabel(zone);
  return zone;
}

function showNow() {
  const h = headline({ ...current, now: serverNow() });
  $("now-main").textContent = h.main;
  $("now-sub").textContent = h.sub;
  document.querySelector(".now").className = `now ${h.mood}`;
  $("offer").hidden = DEMO || h.mood === "live";
}

function showStars() {
  for (const name of AGENTS) {
    const info = current.agents?.[name];
    const { state, detail } = starLabel(info);
    const li = starEls[name];
    li.classList.toggle("idle", !isActive(info));
    const st = li.querySelector(".state");
    st.replaceChildren(state, ...(detail ? [" ", make("em", { text: detail })] : []));
    li.querySelector(".tally").textContent = tally(current.byAgent?.[name]);
  }
  const c = current.counts || {};
  const placeCount = { claude: c.claude, github: (c.started ?? 0) + (c.prs ?? 0) + (c.reviews ?? 0), chat: c.chat };
  for (const key of PLACES) placeEls[key].querySelector("small").textContent = `${fmt.format(placeCount[key] ?? 0)} today`;
  sky.setAgents(current.agents);
  declutter();
}

const fmt = new Intl.NumberFormat("en");
function showNumbers() {
  const c = current.counts || {};
  const big = [["Pull requests opened", c.prs], ["Reviews", c.reviews], ["Issues started", c.started], ["Claude requests", c.claude]];
  $("numbers").replaceChildren(...big.map(([label, v]) => make("div", {}, make("dt", { text: label }), make("dd", { text: fmt.format(v ?? 0) }))));
  $("minor").replaceChildren(
    make("span", { text: `${fmt.format(c.chat ?? 0)} team-chat posts` }),
    make("span", { text: `${fmt.format(c.helpers ?? 0)} helpers used` }),
  );
}

const ROWS = [["claude", "Claude requests"], ["github", "GitHub actions"], ["chat", "Team-chat posts"]];
function showHours(zone) {
  const hours = Array.isArray(current.hours) && current.hours.length === 24 ? current.hours : null;
  if (!hours) return;
  const said = [];
  const rows = ROWS.map(([key, name]) => {
    const vals = hours.map((b) => (Number.isFinite(b[key]) && b[key] > 0 ? b[key] : 0));
    const peak = Math.max(...vals), total = vals.reduce((a, v) => a + v, 0);
    const bars = make("div", { class: "hbars", "aria-hidden": "true" }, ...vals.map((v, i) => {
      const bar = make("i", { title: `${clock(hours[i].h * 3600)}: ${fmt.format(v)} ${name.toLowerCase()}` });
      if (!v) bar.className = "zero";
      bar.style.setProperty("--v", peak ? String(v / peak) : "0");
      bar.style.setProperty("--c", COLORS[key]);
      return bar;
    }));
    said.push(total ? `${name}: ${total}, busiest at ${clock(hours[vals.indexOf(peak)].h * 3600)} with ${peak}.` : `${name}: none.`);
    return make("div", { class: "hrow" }, make("p", {}, name, make("small", { text: total ? `${fmt.format(total)} · peak ${fmt.format(peak)}/h` : "none" })), bars);
  });
  const ticks = make("div", { class: "hticks", "aria-hidden": "true" }, make("span"),
    make("div", {}, ...[0, 6, 12, 18].map((i) => make("span", { text: clock(hours[i].h * 3600) }))));
  $("hours").replaceChildren(...rows, ticks);
  $("hours-desc").textContent = `Per hour over the last 24 hours, ${clock(hours[0].h * 3600)} to now, ${zoneLabel(zone)}. ${said.join(" ")}`;
}

// A public repo -> its name, linked to GitHub. Private repos never have a name on this page.
const repoLink = (repo) => make("a", { href: `https://github.com/setkernel/${encodeURIComponent(repo)}`, rel: "noopener", text: repo });

// The latest test runs as marks (the shape and the key say passed or failed, not only the colour),
// then today's count and the latest run in words.
function showCi(zone) {
  const at = (r) => Number.isFinite(r.ts) ? ` at ${clock(r.ts)}${zone ? ` ${zone}` : ""}` : "";
  const runs = (Array.isArray(current.ci) ? current.ci : []).slice(0, 12);
  $("ci-runs").replaceChildren(...runs.map((r) => {
    const said = `${ciWhere(r)} ${ciWord(r)}${at(r)}`;
    return make("li", { class: r.result === "pass" ? "pass" : "fail", title: said },
      make("i", { "aria-hidden": "true" }), make("span", { class: "visually-hidden", text: said }));
  }));
  $("ci-today").textContent = ciSummary(current.counts);
  const last = runs[0];
  $("ci-last").replaceChildren(...(last ? ["Last: ", last.repo ? repoLink(last.repo) : ciWhere(last), ` ${ciWord(last)}${at(last)}.`] : []));
}

function feedItem(f) {
  const who = make("b", { text: f.agent });
  who.style.setProperty("--star", COLORS[f.agent] || COLORS.Vega);
  const p = make("span", {}, who, ` ${ACTION_TEXT[f.action] || "did something"}`);
  if (f.repo) p.append(" in ", repoLink(f.repo));
  return make("li", {}, make("time", { datetime: new Date(f.ts * 1000).toISOString(), text: clock(f.ts) }), p);
}
function showFeed() {
  const feed = (current.feed || []).slice(0, 20);
  $("feed").replaceChildren(...(feed.length ? feed.map(feedItem) : [make("li", { class: "empty", text: "Nothing yet." })]));
}

let lastStatus = "";
// The state goes in the role="status" region, read out only when it changes; the age beside it
// ticks every second, so it stays out of that region.
function showAge() {
  const age = freshness(current.lastIngest, serverNow());
  $("status-age").textContent = age ? ` · ${age}` : "";
}
function showStatus(connected) {
  const quiet = !current.lastIngest || serverNow() - current.lastIngest > OFFLINE_AFTER_MS;
  let cls, text;
  if (DEMO) [cls, text] = ["demo", "Demo · sample data"];
  else if (!connected) [cls, text] = ["down", "Reconnecting…"];
  else if (quiet) [cls, text] = ["down", current.lastIngest ? "Office offline" : "Waiting for the office"];
  else [cls, text] = ["live", "Live"];
  if (cls + text !== lastStatus) { // only on change, so screen readers aren't told twice
    lastStatus = cls + text;
    $("status").className = `status ${cls}`;
    $("status-text").textContent = text;
  }
  $("asof-time").textContent = current.lastIngest ? clock(current.lastIngest) : "--:--";
  showAge();
}

// a brief pulse of the status dot each time data arrives (hello, batch or heartbeat); none under reduced motion
// (then only the age above changes)
const dot = $("status").querySelector("i");
dot.addEventListener("animationend", () => dot.classList.remove("pulse"));
function pulse() {
  if (reducedQuery.matches) return;
  dot.classList.remove("pulse");
  void dot.offsetWidth; // restart the animation if one is still running
  dot.classList.add("pulse");
}

function render(connected = true) {
  const zone = showZone();
  showNow();
  showStars();
  showNumbers();
  showHours(zone);
  showCi(zone);
  showFeed();
  showStatus(connected);
}

// ---- events: light across the sky, spread over the seconds they really took
const announcer = createAnnouncer({ say: (t) => { $("announce").textContent = t; } });
function light(e, recent) {
  if (document.hidden) return;
  sky.event(e.agent, e.kind === "github" ? "github" : e.kind);
  const target = e.kind === "github" ? reviewTarget(e, recent) : null;
  if (target) sky.review(e.agent, target);
}
function play(events) {
  const msgs = events.filter((e) => e.t === "msg" && e.kind !== "ci"); // a test run has no star to leave
  if (!msgs.length || replaying) return;
  const first = Math.min(...msgs.map((e) => e.ts ?? Infinity));
  const recent = current.feed || [];
  for (const e of msgs) {
    const delay = Number.isFinite(first) ? Math.min(5000, Math.max(0, ((e.ts ?? first) - first) * 1000)) : 0;
    setTimeout(() => light(e, recent), delay);
  }
}

function apply(msg) {
  if (typeof msg.now === "number") skew = msg.now - Date.now();
  for (const k of ["agents", "counts", "byAgent", "seen", "feed", "ci", "hours"]) if (msg[k] && typeof msg[k] === "object") current[k] = msg[k];
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
  const nowS = Math.trunc(Date.now() / 1000);
  const sim = createDemo(17, nowS - 86_400);
  const day = (s) => new Date(s * 1000).toISOString().slice(0, 10);
  const midnight = Math.floor(nowS / 86_400) * 86_400;
  const history = sim.advance(nowS);
  const before = { events: history.events.filter((e) => e.ts < midnight), agents: history.agents };
  const after = { events: history.events.filter((e) => e.ts >= midnight), agents: history.agents };
  let state = applyBatch(emptyState(day(midnight - 1)), before, (midnight - 1) * 1000, day(midnight - 1));
  state = applyBatch(state, after, nowS * 1000, day(nowS));
  demoReplay = recordReplay(emptyReplay(), history, nowS * 1000);
  apply({ t: "hello", ...view(state, demoReplay, Date.now()) });
  setInterval(() => {
    const now = Date.now();
    const batch = sim.advance(Math.trunc(now / 1000));
    state = applyBatch(state, batch, now, day(now / 1000));
    demoReplay = recordReplay(demoReplay, batch, now);
    apply({ t: "batch", events: batch.events, ...view(state, demoReplay, now) });
  }, 2000);
}

// ---- replay: the last hour in a minute, the last day in two
const replayButtons = [...document.querySelectorAll("[data-replay]")];
let replayGen = 0; // bumped on every start and stop, so a replay whose data arrives late is dropped
async function startReplay(h) {
  stopReplay();
  const gen = ++replayGen;
  const cfg = REPLAYS[h];
  const to = Math.trunc(serverNow() / 1000), from = to - cfg.hours * 3600;
  let data;
  try {
    data = DEMO ? replaySince(demoReplay, from) : await (await fetch(`/api/replay?h=${h}`, { cache: "no-store" })).json();
  } catch {
    if (gen === replayGen) $("now-sub").textContent = "The replay couldn't be loaded. Try again in a moment.";
    return;
  }
  if (gen !== replayGen) return; // another click, or Back to live, came first
  const show = plan(data, { from, to, durationMs: cfg.durationMs, maxPulses: cfg.maxPulses });
  const work = show.filter((e) => e.kind === "github");
  sky.clear();
  $("replaying").hidden = false;
  $("replay-what").textContent = show.length ? `Replaying the last ${h === 1 ? "hour" : "24 hours"}` : `Nothing happened in the last ${h === 1 ? "hour" : "24 hours"}`;
  for (const b of replayButtons) if (b.closest(".controls")) b.setAttribute("aria-pressed", String(b.dataset.replay === String(h)));
  const t0 = performance.now();
  let i = 0;
  const step = () => {
    const ms = performance.now() - t0;
    while (i < show.length && show[i].at <= ms) {
      const e = show[i++];
      const recent = work.filter((w) => w.ts < e.ts).reverse();
      light(e, recent);
    }
    $("replay-at").textContent = clock(from + Math.min(1, ms / cfg.durationMs) * (to - from));
    $("replay-progress").style.width = `${Math.min(100, (ms / cfg.durationMs) * 100)}%`;
    if (ms >= cfg.durationMs + 1500) {
      if (replaying === id) stopReplay();
      else clearInterval(id);
    }
  };
  const id = setInterval(step, 100);
  replaying = id;
  step();
}
function stopReplay() {
  replayGen++;
  if (replaying) clearInterval(replaying);
  replaying = null;
  $("replaying").hidden = true;
  for (const b of replayButtons) if (b.closest(".controls")) b.setAttribute("aria-pressed", "false");
}
for (const b of replayButtons) b.addEventListener("click", () => (b.getAttribute("aria-pressed") === "true" ? stopReplay() : startReplay(Number(b.dataset.replay))));
$("replay-stop").addEventListener("click", stopReplay);

// ---- wall mode: ?wall, or the button (which also goes fullscreen where the browser allows)
const wallBtn = $("wall-toggle");
function setWall(on) {
  document.documentElement.classList.toggle("wall", on);
  wallBtn.setAttribute("aria-pressed", String(on));
}
wallBtn.addEventListener("click", async () => {
  const on = !document.documentElement.classList.contains("wall");
  setWall(on);
  try {
    if (on && document.fullscreenEnabled && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    if (!on && document.fullscreenElement) await document.exitFullscreen();
  } catch {
    // fullscreen refused (iOS, an iframe): wall mode still works in the window
  }
});
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && !params.has("wall")) setWall(false); });
if (params.has("wall")) setWall(true);

// keep "quiet since", "offline", "Today since" and the zone's name moving even when nothing
// arrives, and the age beside the status every second
setInterval(() => { showZone(); showNow(); showStatus(DEMO || ws?.readyState === WebSocket.OPEN); }, 15_000);
setInterval(() => { if (!document.hidden) showAge(); }, 1000);

render(false);
layoutSky();
wake();
if (DEMO) startDemo();
else connect();
