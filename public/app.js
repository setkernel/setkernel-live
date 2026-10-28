// live.setkernel.com, v3 "Day" (setkernel-live#48; the design is docs/design/v3/day). One sentence on
// top says who is doing what; under it, the last 24 hours, one lane per engineer, with the Now
// column at the right edge. Live data comes from /api/state and /api/replay, then the WebSocket
// (/ws); ?demo runs a sample day through the same reducers as the Durable Object. Everything shown
// is built with textContent and attributes, never innerHTML, so nothing in a batch can inject markup.
import { ENGINEERS, applyBatch, emptyReplay, homeDay, recordReplay, view } from "/lib/state.js";
import { OFFLINE_AFTER_MS, createAnnouncer, fitHeadline, freshness, headline, plain, todaySince, zoneName } from "/lib/words.js";
import { reviewers } from "/lib/line.js";
import { BIN, BINS, keyItems, prep, readout, scrubKey, tableRows } from "/lib/day.js";
import { fitWall, pageMode } from "/lib/layout.js";
import { drawNowList, drawTall, drawWide, fillLegend, fillTable } from "/lib/chart.js";
import { busyDay, downDay, quietDay, runDay } from "/lib/demo.js";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const params = new URLSearchParams(location.search);
const DEMO = params.has("demo") ? params.get("demo") || "live" : null;
const WALL = root.classList.contains("wall");
const TZ = undefined; // times in the visitor's own zone, as words.js does

let skew = 0; // server clock minus ours
const serverNow = () => Date.now() + skew;
let current = { agents: {}, counts: {}, byAgent: {}, seen: {}, line: {}, feed: [], ci: [], lastIngest: 0 };
let replay = emptyReplay();

// ---- drawing
let D = null, plot = null, scrub = null, mode = null, drawing = false, tableKey = "";
const offline = () => Boolean(current.lastIngest) && serverNow() - current.lastIngest > OFFLINE_AFTER_MS;

function fillWords() {
  const targets = Object.fromEntries(Object.entries(reviewers(current.agents, current.line, ENGINEERS)).map(([author, reviewer]) => [reviewer, author]));
  const hl = headline({ ...current, now: serverNow(), timeZone: TZ, names: ENGINEERS, targets });
  root.classList.remove("mood-live", "mood-quiet", "mood-offline", "mood-waiting");
  root.classList.add(`mood-${hl.mood}`);
  const h1 = $("headline");
  const put = (el, parts) => {
    el.textContent = "";
    for (const p of parts) {
      if (typeof p === "string") el.append(p);
      else {
        const b = document.createElement("b");
        b.textContent = p.name;
        el.append(b);
      }
    }
  };
  const lh = parseFloat(getComputedStyle(h1).lineHeight);
  const maxLines = mode === "narrow" ? 4 : 2;
  put(h1, fitHeadline(hl.forms, (f) => { put(h1, f); return h1.offsetHeight <= lh * maxLines + 1; }));
  put($("latest"), hl.latest);
  document.title = `${DEMO ? "Demo · " : ""}${plain(fitHeadline(hl.forms, () => true))} · setkernel live`;
  // the Halifax day (hq#177, question 5), on the visitor's clock
  const now = serverNow();
  $("chart-sub").textContent = `Times in ${zoneName(now, TZ)}. Today's counts ${todaySince(now, TZ)}.`;
  showFresh(hl.mood);
}

// "About a minute behind" in place of LIVE (hq#177, question 4): events leave the office 60 s late.
// Offline says only how long ago; waiting, and the demo, say nothing of the office.
function showFresh(mood = root.classList.contains("mood-offline") ? "offline" : "live") {
  const fresh = DEMO ? "" : freshness(current.lastIngest, serverNow());
  $("fresh").textContent = !fresh ? "" : mood === "offline" ? fresh : `About a minute behind · ${fresh}`;
}

function render() {
  if (!$("plot").clientWidth) return; // not laid out (yet): nothing to measure the chart by
  mode = pageMode(innerWidth, WALL);
  root.dataset.mode = mode;
  const nowS = Math.floor(serverNow() / 1000);
  const oldT0 = D?.t0;
  D = prep(current, replay, nowS);
  // a scrubbed column stays on its ten minutes when the window moves on
  if (scrub != null && oldT0 != null) scrub -= (D.t0 - oldT0) / BIN;
  if (scrub != null && scrub < 0) scrub = null;
  fillWords();
  const opts = { tz: TZ, offline: offline() };
  const listed = mode === "narrow" || mode === "medium";
  $("now").hidden = !listed;
  const hadFocus = plot && document.activeElement === plot.svg;
  drawing = true;
  plot = mode === "narrow" ? drawTall($("plot"), D, opts) : drawWide($("plot"), D, { ...opts, now: !listed });
  plot.drawMoment ??= () => {};
  if (listed) {
    const inner = plot.drawMoment;
    plot.drawMoment = (i) => { inner(i); drawNowList($("now"), D, i, opts); };
  }
  wire(plot);
  setScrub(scrub, false);
  if (hadFocus) plot.svg.focus({ preventScroll: true });
  drawing = false;
  fillLegend($("legend"), keyItems(D));
  // the table only when what it lists changed, so a reader in it keeps their place
  const rows = tableRows(D);
  const key = `${rows.length} ${rows[0]?.ts} ${rows.at(-1)?.ts}`;
  if (key !== tableKey) {
    tableKey = key;
    fillTable($("table"), rows, TZ);
  }
  placeWall();
}

// ---- scrubbing: keys, pointer and a live readout
function setScrub(i, speak = true) {
  scrub = i;
  plot.drawCursor(i);
  plot.drawMoment(i);
  plot.svg.setAttribute("aria-valuenow", String(i ?? BINS - 1));
  const words = readout(D, i, TZ);
  plot.svg.setAttribute("aria-valuetext", i == null ? "Now" : words);
  if (speak) $("readout").textContent = words;
}
function wire(p) {
  const svg = p.svg;
  svg.addEventListener("keydown", (ev) => {
    const next = scrubKey(ev.key, ev.shiftKey, scrub, D, p.vertical);
    if (next === undefined) return;
    ev.preventDefault();
    setScrub(next);
  });
  svg.addEventListener("pointermove", (ev) => {
    const i = p.pick(ev);
    if (i !== undefined && i !== scrub) setScrub(i, false);
  });
  svg.addEventListener("pointerleave", () => { if (document.activeElement !== svg) setScrub(null, false); });
  svg.addEventListener("click", (ev) => {
    const i = p.pick(ev);
    if (i === undefined) return;
    svg.focus({ preventScroll: true });
    setScrub(i);
  });
  svg.addEventListener("blur", () => { if (!drawing && plot?.svg === svg) setScrub(null, false); });
}

// ---- the wall: the 1440 x 810 canvas, scaled whole to the window and centred
function placeWall() {
  if (!WALL) return;
  const { k, x, y } = fitWall(innerWidth, innerHeight);
  $("day").style.transform = `translate(${x}px, ${y}px) scale(${k})`;
}

let lastW = innerWidth;
addEventListener("resize", () => {
  if (WALL) return placeWall();
  if (innerWidth === lastW) return;
  lastW = innerWidth;
  render();
});

// ---- data
const announcer = createAnnouncer({ say: (t) => { $("announce").textContent = t; } });
const KEYS = ["agents", "counts", "byAgent", "seen", "line", "feed", "ci"];
function apply(msg) {
  if (typeof msg.now === "number") skew = msg.now - Date.now();
  for (const k of KEYS) if (msg[k] && typeof msg[k] === "object") current[k] = msg[k];
  if (typeof msg.lastIngest === "number") current.lastIngest = msg.lastIngest;
  if (msg.t === "batch" && Array.isArray(msg.events)) {
    // the page keeps its own copy of the replay buffer up to date, with the same reducer
    replay = recordReplay(replay, { events: msg.events }, serverNow());
    announcer.add(msg.events);
  }
  render();
}

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}
async function loadReplay() {
  try {
    const r = await getJson("/api/replay?h=24");
    replay = { pulses: Array.isArray(r.pulses) ? r.pulses : [], work: Array.isArray(r.work) ? r.work : [] };
    render();
  } catch (err) {
    console.error(err);
  }
}

// live: the state first (the page draws at once), then the WebSocket, reconnecting with backoff;
// each connection reloads the replay, so a gap while it was down fills in
let ws, retry = 1000;
function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => { retry = 1000; loadReplay(); };
  ws.onmessage = (m) => {
    try { apply(JSON.parse(m.data)); } catch (err) { console.error(err); }
  };
  ws.onclose = () => {
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 30_000);
  };
}
async function startLive() {
  try { apply({ t: "state", ...(await getJson("/api/state")) }); } catch (err) { console.error(err); }
  connect();
}

// ?demo: a sample day through the same reducers and view as the Durable Object. ?demo=quiet is the
// hand-written quiet day, ?demo=offline the busy day as it stood 47 minutes ago, ?demo=down the
// busy day with Orion's VM stopped 2 h 35 min ago (setkernel-live#54), ?demo=waiting nothing at all.
function startDemo() {
  $("demo-note").hidden = false;
  const nowS = Math.floor(Date.now() / 1000);
  if (DEMO === "waiting") return render();
  if (DEMO === "quiet") {
    let { state, replay: r } = runDay(quietDay(nowS).batches);
    replay = r;
    const idle = Object.fromEntries(ENGINEERS.map((n) => [n, { state: "IDLE" }]));
    // the office still reports in while nobody works
    const beat = () => {
      const now = Date.now();
      state = applyBatch(state, { events: [], agents: idle }, now, homeDay(now));
      apply({ t: "batch", events: [], ...view(state, replay, now) });
    };
    beat();
    return setInterval(beat, 30_000);
  }
  const { batches, sim } = DEMO === "down" ? downDay(nowS) : busyDay(nowS);
  if (DEMO === "offline") {
    const { state, replay: r } = runDay(batches, nowS - 47 * 60);
    replay = r;
    return apply({ t: "hello", ...view(state, replay, Date.now()) });
  }
  let { state, replay: r } = runDay(batches);
  replay = r;
  apply({ t: "hello", ...view(state, replay, Date.now()) });
  setInterval(() => {
    const now = Date.now();
    const batch = sim.advance(Math.floor(now / 1000));
    state = applyBatch(state, batch, now, homeDay(now));
    apply({ t: "batch", events: batch.events, ...view(state, replay, now) });
  }, 2000);
}

// keep "updated N s ago" ticking, and the mood, the window and "Today since" moving when nothing arrives
setInterval(() => { if (!document.hidden) showFresh(); }, 1000);
setInterval(() => { if (!document.hidden) render(); }, 15_000);

render();
if (document.fonts) document.fonts.ready.then(render); // the headline and the cut lines measure text
if (DEMO) startDemo();
else startLive();
