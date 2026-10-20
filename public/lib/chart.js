// Draws the Day page's chart (docs/design/v3/day) from what public/lib/day.js works out: the lanes
// across the page with the Now column (wide, and the wall), across without it (medium), or down
// the page (the phone); the Now list, the key and the table. Every string goes in with
// textContent, and every colour comes from a class in style.css, so the CSP needs no inline style.
import { STAR_NOTE, ciSummary, clock, stateWords, tally, zoneName } from "./words.js";
import { BIN, BINS, ROWS, band, binTime, ciLabel, label, levels, moment, momentTitle, poleMerges, poleTally } from "./day.js";
import { GRID, hourRules, labelFits } from "./layout.js";

const SVG_NS = "http://www.w3.org/2000/svg";
export const node = (tag, attrs = {}, parent = null) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  parent?.appendChild(n);
  return n;
};
const text = (parent, x, y, s, cls, anchor) => {
  const t = node("text", { x, y, class: cls, ...(anchor ? { "text-anchor": anchor } : {}) }, parent);
  t.textContent = s;
  return t;
};
// Cut a line that doesn't fit its room, with an ellipsis (the whole line is in the table and the hover).
const fit = (t, w) => {
  if (!t.textContent || t.getComputedTextLength() <= w) return t;
  let s = t.textContent;
  while (s.length > 1 && t.getComputedTextLength() > w) {
    s = s.slice(0, -1);
    t.textContent = `${s.trimEnd()}…`;
  }
  return t;
};
const mark = (parent, id, x, y, r, title, cls = "mark") => {
  const g = node("g", { class: cls }, parent);
  node("use", { href: `#m-${id}`, x: x - r, y: y - r, width: 2 * r, height: 2 * r }, g);
  node("title", {}, g).textContent = title;
  return g;
};
const markCls = (action) => (action === "requested_changes" ? "mark sig" : "mark");
// The stages' styles: Building a plain line, In review heavy, Fixing red and dashed.
const STAGE_STYLE = { started: { w: 2.5, cls: "st-building" }, building: { w: 2.5, cls: "st-building" }, review: { w: 5, cls: "st-review" }, fixing: { w: 2.5, cls: "st-fixing", dash: "6 4" } };
const STAGE_STYLE_TALL = { started: { w: 1, cls: "st-started" }, building: { w: 2, cls: "st-building" }, review: { w: 4, cls: "st-review" }, fixing: { w: 2, cls: "st-fixing", dash: "4 4" } };

const sliderAttrs = (label) => ({ tabindex: 0, role: "slider", "aria-label": label, "aria-valuemin": 0, "aria-valuemax": BINS - 1, "aria-valuenow": BINS - 1 });

// The lanes across: Polaris, the four engineers and CI, time running left to right to now. With
// `now` the Now column sits on the right on its own ground (the wide page and the wall).
// Returns { svg, drawMoment(i), drawCursor(i), pick(ev) }.
export function drawWide(box, D, { tz, offline, now = true }) {
  const S = GRID;
  box.textContent = "";
  const W = box.clientWidth;
  const gutR = now ? S.gutR : 0;
  const px0 = S.gutL + S.gap, px1 = W - gutR - (now ? S.gap : 8), pw = px1 - px0;
  const x = (ts) => px0 + ((ts - D.t0) / (D.end - D.t0)) * pw;
  const rows = ROWS.map((r) => ({ ...r }));
  let y = S.axis;
  for (const r of rows) { r.y = y; r.h = S[r.kind]; y += r.h; }
  const H = y + 8;
  const top = S.axis - 8; // where the rules start, above the first row
  const lab = S.axis - 12; // the axis labels' baseline
  const svg = node("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, ...sliderAttrs("The last 24 hours. Use the arrow keys to move through the day.") }, box);
  const bg = node("g", {}, svg), fg = node("g", {}, svg), cur = node("g", {}, svg);
  const nowX = x(D.nowS);
  const ys = (r, k) => r.y + k; // a baseline k px down the row

  // the Now column sits on its own ground, so it is the first thing the eye lands on
  if (now) node("rect", { x: px1 + S.gap / 2, y: -8, width: W - px1 - S.gap / 2, height: H + 8, rx: 4, class: "f-surface" }, bg);

  // hour rules and labels; midnight in Halifax is "today"
  const midX = x(D.mid);
  for (const { ts, mid } of hourRules(D.t0, D.nowS, D.mid)) {
    const hx = x(ts);
    node("line", { x1: hx, x2: hx, y1: top, y2: H - 8, class: mid ? "s-rule-2" : "s-rule" }, bg);
    if (mid) {
      text(bg, hx + 6, lab, `Today · ${clock(ts, tz)} ${zoneName(ts, tz)}`, "t-axis-strong");
      text(bg, hx - 6, lab, "Yesterday", "t-axis", "end");
    } else if (labelFits(hx, midX, nowX)) text(bg, hx, lab, clock(ts, tz), "t-axis", "middle");
  }
  // the now edge
  node("line", { x1: nowX, x2: nowX, y1: top, y2: H - 8, class: "s-ink", "stroke-width": 2 }, bg);
  text(bg, nowX - 6, lab, clock(D.nowS, tz), "t-axis-strong", "end");

  // row rules and the name gutter
  for (const r of rows) {
    if (r.kind === "sep") continue;
    const base = r.y + r.h;
    node("line", { x1: 0, x2: now ? px1 + S.gap / 2 : W, y1: base, y2: base, class: "s-rule" }, bg);
    const g = node("g", {}, fg);
    const live = Boolean(D.s.lastIngest);
    if (r.kind === "eng") {
      fit(text(g, 0, ys(r, 48), r.id, "t-name"), S.gutL);
      fit(text(g, 0, ys(r, 72), live ? tally(D.s.byAgent?.[r.id]) : "", "t-meta"), S.gutL);
    } else if (r.kind === "pole") {
      const n = text(g, 0, ys(r, 28), "Polaris", "t-name");
      text(g, n.getComputedTextLength() + 8, ys(r, 28), STAR_NOTE.Polaris, "t-meta");
      fit(text(g, 0, ys(r, 52), live ? poleTally(D.s.byAgent?.Polaris) : "", "t-meta"), S.gutL);
    } else if (r.kind === "ci") {
      text(g, 0, ys(r, 20), "CI", "t-name");
      fit(text(g, 0, ys(r, 36), live ? ciSummary(D.s.counts) : "", "t-label"), S.gutL);
    }
  }

  // where the data stops: hatched, and said in words
  const hatch = (from, to, y0, y1, words) => {
    if (!(to > from)) return;
    node("rect", { x: x(from), y: y0, width: x(to) - x(from), height: y1 - y0, class: "f-hatch" }, bg);
    if (words && x(to) - x(from) > 120) {
      const t = text(bg, x(from) + 8, (y0 + y1) / 2 + 4, words, "t-label");
      node("rect", { x: x(from) + 2, y: (y0 + y1) / 2 - 10, width: t.getComputedTextLength() + 12, height: 20, class: "f-bg" }, bg).after(t);
    }
  };
  const ciRow = rows.find((r) => r.kind === "ci");
  if (offline && D.lastS) hatch(D.lastS, D.nowS, rows[0].y, ciRow.y + ciRow.h, `No word since ${clock(D.lastS, tz)}`);
  if (!D.s.lastIngest) hatch(D.t0, D.nowS, rows[0].y, ciRow.y + ciRow.h, "Nothing has arrived yet");
  if (D.ciFrom) hatch(D.t0, D.ciFrom, ciRow.y + 4, ciRow.y + ciRow.h - 4, "Older runs aren't kept");
  if (D.workFrom) for (const r of rows.filter((r) => r.kind === "eng" || r.kind === "pole")) hatch(D.t0, D.workFrom, r.y + 4, r.y + r.h - 4, "Older actions aren't kept");

  // engineer lanes: one quiet activity band, and the stage line through the lane
  for (const r of rows.filter((r) => r.kind === "eng")) {
    const base = ys(r, 48), bandH = 32, track = ys(r, 68);
    const sm = band(D, r.id);
    if (sm.some((n) => n > 0)) {
      const pts = sm.map((n, i) => [x(binTime(D, i) + BIN / 2), base - (bandH * n) / D.maxAct]);
      const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join("");
      node("path", { d: `${line}L${pts.at(-1)[0].toFixed(1)} ${base}L${pts[0][0].toFixed(1)} ${base}Z`, class: "f-band" }, fg);
      // the edge only where there is activity: an empty stretch draws nothing, not a second rule
      const edge = pts.map(([px, py], i) => (sm[i] > 0 || sm[i - 1] > 0 ? `${i && (sm[i - 1] > 0 || sm[i - 2] > 0) ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}` : "")).join("");
      node("path", { d: edge, class: "s-bar", "stroke-width": 1, "stroke-linejoin": "round" }, fg);
    }
    node("line", { x1: px0, x2: nowX, y1: track, y2: track, class: "s-rule-2", "stroke-width": 1 }, fg);
    for (const sp of D.spans[r.id]) {
      const st = STAGE_STYLE[sp.stage];
      const a = x(sp.from), z = Math.max(x(sp.to), a + 1);
      node("line", { x1: a, x2: z, y1: track, y2: track, class: st.cls, "stroke-width": st.w, ...(st.dash ? { "stroke-dasharray": st.dash } : {}) }, fg);
    }
    for (const { w, dy } of levels(D.marks[r.id], x, 2 * S.r + 2, [0, -12])) mark(fg, w.action, x(w.ts), track + dy, S.r, w.title, markCls(w.action));
  }
  // Polaris: one quiet tick per merge, on a light rule
  for (const r of rows.filter((r) => r.kind === "pole")) {
    const yy = ys(r, 40);
    node("line", { x1: px0, x2: nowX, y1: yy, y2: yy, class: "s-rule", "stroke-width": 1 }, bg);
    for (const w of poleMerges(D)) mark(fg, "tick", x(w.ts), yy, 2 * S.r, label(w, tz), "tick");
  }
  // CI: one shared row with no owner; a pass is a quiet tick, a failure the red bar
  const ciY = ciRow.y + 16;
  for (const c of D.ci) {
    const pass = c.result === "pass";
    mark(fg, pass ? "tick" : "ci-fail", x(c.ts), ciY, pass ? 1.6 * S.r : 1.2 * S.r, ciLabel(c, tz), pass ? "tick" : "mark sig");
  }
  node("rect", { class: "plotframe", x: px0 - 4, y: top, width: pw + 8, height: H - top - 2 }, bg);

  // the Now column: now, or the scrubbed ten minutes
  const mom = node("g", {}, svg);
  const mx = px1 + S.gap;
  const room = S.gutR - S.gap;
  function drawMoment(i) {
    mom.textContent = "";
    if (!now) return;
    text(mom, mx, lab, momentTitle(D, i, offline, tz), i != null ? "t-axis-strong" : "t-now-h");
    // a lane's headline: big, and a step smaller only when a scrubbed line wouldn't fit; a live
    // lane's state goes before it as a shape, sized and centred on the text
    const big = (yy, s, idle, state) => {
      const cls = `t-now-do${idle ? " idle" : ""}`;
      const t = text(mom, mx, yy, s, cls);
      const shift = () => (state && s ? parseFloat(getComputedStyle(t).fontSize) * 1.15 : 0);
      if (t.getComputedTextLength() > room - shift()) t.setAttribute("class", `${cls} small`);
      const f = parseFloat(getComputedStyle(t).fontSize), dx = shift();
      if (dx) {
        t.setAttribute("x", mx + dx);
        const r = f * 0.42, gl = node("g", { class: "mark st" }, mom);
        node("use", { href: `#s-${state}`, x: mx, y: yy - f * 0.34 - r, width: 2 * r, height: 2 * r }, gl);
        node("title", {}, gl).textContent = stateWords({ state }).state;
      }
      return fit(t, room - dx);
    };
    for (const r of rows) {
      if (r.kind === "sep") continue;
      const lines = moment(D, r, i, tz);
      if (r.kind === "eng") {
        text(mom, mx, ys(r, 24), lines[0] ? r.id : "", "t-now-who");
        big(ys(r, 48), lines[0] ?? "", lines.idle, lines.state);
        fit(text(mom, mx, ys(r, 72), lines[1] ?? "", "t-now-detail"), room);
      } else if (r.kind === "pole") {
        fit(text(mom, mx, ys(r, 28), lines[0] ?? "", "t-now-pole"), room);
        fit(text(mom, mx, ys(r, 52), lines[1] ?? "", "t-label"), room);
      } else {
        fit(text(mom, mx, ys(r, 20), lines[0] ?? "", "t-now-pole"), room);
        if (lines[1]) fit(text(mom, mx, ys(r, 36), lines[1], "t-label"), room);
      }
    }
  }
  // the scrub cursor
  function drawCursor(i) {
    cur.textContent = "";
    if (i == null) return;
    const cx = x(binTime(D, i) + BIN / 2);
    node("rect", { x: x(binTime(D, i)), y: top, width: Math.max(2, pw / BINS), height: H - top - 2, class: "cursor-band" }, cur);
    node("line", { x1: cx, x2: cx, y1: top, y2: H - 8, class: "s-focus", "stroke-width": 1.5 }, cur);
    const t = text(cur, cx, lab, clock(binTime(D, i), tz), "t-cur", "middle");
    const w = t.getComputedTextLength() + 12;
    node("rect", { x: cx - w / 2, y: lab - 14, width: w, height: 20, rx: 2, class: "f-focus" }, cur).after(t);
  }
  drawMoment(null);
  const pick = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) * (W / r.width);
    return px < px0 - 2 || px > px1 + 2 ? undefined : Math.min(BINS - 1, Math.max(0, Math.floor(((px - px0) / pw) * BINS)));
  };
  return { svg, drawMoment, drawCursor, pick, vertical: false };
}

// The phone: time runs down the page, newest at the top, one column per row.
export function drawTall(box, D, { tz, offline }) {
  box.textContent = "";
  const W = box.clientWidth;
  const ax = 40, colW = { pole: 24, eng: Math.floor((W - ax - 24 - 24 - 12) / 4), ci: 24 };
  const cols = [];
  let cx = ax;
  for (const r of ROWS) {
    if (r.kind === "sep") { cx += 6; continue; }
    cols.push({ ...r, x: cx, w: colW[r.kind] });
    cx += colW[r.kind];
  }
  const top = 70, binH = 5, H = top + BINS * binH + 12;
  const y = (ts) => top + ((D.end - ts) / (D.end - D.t0)) * BINS * binH;
  const svg = node("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, ...sliderAttrs("The last 24 hours, newest first. Use the arrow keys to move through the day.") }, box);
  const bg = node("g", {}, svg), fg = node("g", {}, svg), cur = node("g", {}, svg);
  // headers: the engineers across the top, Polaris set vertically over its narrow column
  for (const c of cols) {
    if (c.kind === "eng") { text(bg, c.x + c.w / 2, top - 10, c.id, "t-sub t-ink", "middle"); continue; }
    if (c.kind === "ci") { text(bg, c.x + c.w / 2, top - 10, "CI", "t-sub", "middle"); continue; }
    text(bg, 0, 0, c.id, "t-sub t-ink").setAttribute("transform", `translate(${c.x + c.w / 2 + 4} ${top - 8}) rotate(-90)`);
  }
  node("line", { x1: 0, x2: W, y1: top - 4, y2: top - 4, class: "s-rule" }, bg);
  for (const { ts, mid } of hourRules(D.t0, D.nowS, D.mid)) {
    node("line", { x1: mid ? 0 : ax - 4, x2: W, y1: y(ts), y2: y(ts), class: mid ? "s-rule-2" : "s-rule" }, bg);
    if (mid) { text(bg, 0, y(ts) - 5, "Today", "t-axis-strong"); text(bg, 0, y(ts) + 13, clock(ts, tz), "t-axis"); }
    else if (y(ts) - y(D.nowS) > 24) text(bg, 0, y(ts) + 4, clock(ts, tz), "t-axis");
  }
  text(bg, 0, y(D.nowS) + 4, clock(D.nowS, tz), "t-axis-strong");
  node("line", { x1: ax - 4, x2: W, y1: y(D.nowS), y2: y(D.nowS), class: "s-ink", "stroke-width": 1.5 }, bg);
  const hatch = (from, to, x0, x1, words) => {
    if (!(to > from)) return;
    node("rect", { x: x0, y: y(to), width: x1 - x0, height: y(from) - y(to), class: "f-hatch" }, bg);
    if (words && y(from) - y(to) > 30) {
      const t = text(bg, x0 + 6, y(to) + 16, words, "t-label");
      node("rect", { x: x0 + 2, y: y(to) + 4, width: t.getComputedTextLength() + 8, height: 16, class: "f-bg" }, bg).after(t);
    }
  };
  const ciCol = cols.find((c) => c.kind === "ci");
  if (offline && D.lastS) hatch(D.lastS, D.nowS, ax, W, `No word since ${clock(D.lastS, tz)}`);
  if (!D.s.lastIngest) hatch(D.t0, D.nowS, ax, W, "Nothing has arrived yet");
  if (D.ciFrom) hatch(D.t0, D.ciFrom, ciCol.x + 2, ciCol.x + ciCol.w - 2);
  for (const c of cols) {
    if (c.kind === "eng") {
      const left = c.x + 4, barW = c.w * 0.5, track = c.x + c.w * 0.68;
      const total = D.total[c.id];
      for (let i = 0; i < BINS; i++) {
        if (total[i]) node("rect", { x: left, y: y(binTime(D, i) + BIN), width: Math.max(1.5, (barW * total[i]) / D.maxAct), height: binH, class: "f-band" }, fg);
      }
      for (const sp of D.spans[c.id]) {
        const st = STAGE_STYLE_TALL[sp.stage];
        node("line", { x1: track, x2: track, y1: y(sp.to), y2: Math.max(y(sp.from), y(sp.to) + 1), class: st.cls, "stroke-width": st.w, ...(st.dash ? { "stroke-dasharray": st.dash } : {}) }, fg);
      }
      for (const w of D.marks[c.id]) mark(fg, w.action, track, y(w.ts), 4.5, w.title, markCls(w.action));
      node("line", { x1: c.x + c.w, x2: c.x + c.w, y1: top, y2: H - 12, class: "s-rule" }, bg);
    } else if (c.kind === "ci") {
      for (const r of D.ci) {
        const pass = r.result === "pass";
        mark(fg, pass ? "tick" : "ci-fail", c.x + c.w / 2, y(r.ts), pass ? 6 : 5, ciLabel(r, tz), pass ? "tick" : "mark sig").setAttribute("transform", `rotate(90 ${c.x + c.w / 2} ${y(r.ts)})`);
      }
    } else {
      node("line", { x1: c.x + c.w / 2, x2: c.x + c.w / 2, y1: top, y2: H - 12, class: "s-rule" }, bg);
      for (const w of poleMerges(D)) mark(fg, "tick", c.x + c.w / 2, y(w.ts), 8, label(w, tz), "tick").setAttribute("transform", `rotate(90 ${c.x + c.w / 2} ${y(w.ts)})`);
    }
  }
  node("rect", { class: "plotframe", x: ax - 4, y: top - 2, width: W - ax + 4, height: H - top - 8 }, bg);
  function drawCursor(i) {
    cur.textContent = "";
    if (i == null) return;
    const yy = y(binTime(D, i) + BIN / 2);
    node("rect", { x: ax - 4, y: y(binTime(D, i) + BIN), width: W - ax + 4, height: binH, class: "cursor-band" }, cur);
    node("line", { x1: ax - 4, x2: W, y1: yy, y2: yy, class: "s-focus", "stroke-width": 1.5 }, cur);
    node("rect", { x: 0, y: yy - 9, width: ax - 6, height: 18, rx: 2, class: "f-focus" }, cur);
    text(cur, 3, yy + 4, clock(binTime(D, i), tz), "t-cur");
  }
  const pick = (ev) => {
    const r = svg.getBoundingClientRect();
    const py = (ev.clientY - r.top) * (H / r.height);
    return py < top ? undefined : Math.min(BINS - 1, Math.max(0, BINS - 1 - Math.floor((py - top) / binH)));
  };
  return { svg, drawCursor, pick, vertical: true };
}

const el = (tag, cls, words) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (words != null) e.textContent = words;
  return e;
};
const stateShape = (state) => {
  const g = node("svg", { class: "st", viewBox: "0 0 12 12", "aria-hidden": "true" });
  node("use", { href: `#s-${state}`, width: 12, height: 12 }, g);
  return g;
};

// The Now list above the chart (the phone, and the medium width): the same words as the Now column.
export function drawNowList(ul, D, i, { tz, offline }) {
  ul.textContent = "";
  if (!D.s.lastIngest) return;
  ul.appendChild(el("li", "when", momentTitle(D, i, offline, tz)));
  for (const r of ROWS) {
    if (r.kind === "sep") continue;
    const lines = moment(D, r, i, tz);
    const li = el("li");
    const a = el("span", r.kind === "eng" ? `l1${lines.idle ? " idle" : ""}` : "l2", lines[0] || (r.kind === "pole" ? poleTally(D.s.byAgent?.Polaris) : ""));
    if (lines.state && lines[0]) a.prepend(stateShape(lines.state));
    const extra = r.kind === "ci" ? [lines[1], ciSummary(D.s.counts)].filter(Boolean).join(" · ") : lines[1] ?? "";
    li.append(el("span", "who", r.id), a, el("span", "l2", extra));
    ul.appendChild(li);
  }
}

// The key: only what this day draws (keyItems), each with its own shape beside the words.
export function fillLegend(ul, items) {
  ul.textContent = "";
  for (const it of items) {
    const li = el("li");
    const s = node("svg", { "aria-hidden": "true" });
    if (it.kind === "band") {
      s.setAttribute("class", "sw band");
      s.setAttribute("viewBox", "0 0 24 16");
      node("path", { d: "M0 14L6 9L12 11L18 4L24 8V14Z", class: "f-band" }, s);
      node("path", { d: "M0 14L6 9L12 11L18 4L24 8", class: "s-bar" }, s);
    } else if (it.kind === "stages") {
      // the stages as one entry: a short swatch each, the words beside them
      s.setAttribute("class", `sw sw-${it.stages.length}`);
      s.setAttribute("viewBox", `0 0 ${it.stages.length * 28 - 4} 16`);
      it.stages.forEach((st, k) => {
        const sty = STAGE_STYLE[st];
        node("line", { x1: k * 28, x2: k * 28 + 24, y1: 8, y2: 8, class: sty.cls, "stroke-width": sty.w, ...(sty.dash ? { "stroke-dasharray": sty.dash } : {}) }, s);
      });
    } else {
      s.setAttribute("viewBox", "-6 -6 12 12");
      if (it.kind !== "merged") s.setAttribute("class", "sig");
      node("use", { href: `#m-${it.kind}`, x: -6, y: -6, width: 12, height: 12 }, s);
    }
    li.append(s, it.words);
    ul.appendChild(li);
  }
}

// "The day as a table": every action and CI run, newest first.
export function fillTable(box, rows, tz) {
  box.textContent = "";
  const t = el("table");
  t.appendChild(el("caption", "", rows.length
    ? `${rows.length} ${rows.length === 1 ? "action" : "actions"} in the last 24 hours, newest first. Claude requests and chat posts are counted per ten minutes in the chart, not listed.`
    : "Nothing in the last 24 hours."));
  const head = t.createTHead().insertRow();
  for (const h of ["Time", "Who", "What"]) {
    const th = el("th", "", h);
    th.scope = "col";
    head.appendChild(th);
  }
  const body = t.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    tr.insertCell().textContent = `${clock(r.ts, tz)} ${zoneName(r.ts, tz)}`;
    tr.insertCell().textContent = r.who;
    const td = tr.insertCell();
    const s = node("svg", { viewBox: "-6 -6 12 12", "aria-hidden": "true", ...(r.mark && r.mark !== "merged" ? { class: "sig" } : {}) });
    if (r.mark) node("use", { href: `#m-${r.mark}`, x: -6, y: -6, width: 12, height: 12 }, s);
    td.append(s, r.what);
  }
  box.appendChild(t);
}
