// Draws a not-reporting engineer (setkernel-live#54) over public/lib/chart.js: it draws the chart as
// main does, then adds to the lane and marks the Now column's words, by option.
//   A: the lane's faint track stops at the last run, with an end cap and "Last ran 14:05".
//   B: the same, and the lane is hatched from the last run to now, as the page already hatches
//      "where it doesn't know"; the Now column's words are regular weight, not light.
//   C: the hatch and the end cap in the signal red, and the Now column's words in red.
// The geometry is chart.js's own (GRID, the rows, the time scale), worked out again here.
import * as C from "../../../../../public/lib/chart.js";
import { BINS, ROWS } from "../../../../../public/lib/day.js";
import { GRID } from "../../../../../public/lib/layout.js";
import { downIn } from "./proto-day.js";
import { whenDay } from "./proto-words.js";
import { OPT } from "./config.js";

const { node } = C;
const sig = OPT === "c";
const label = (parent, x, y, s, anchor) => {
  const t = node("text", { x, y, class: "t-label", ...(anchor ? { "text-anchor": anchor } : {}) }, parent);
  t.textContent = s;
  return t;
};

// The Now column's "Not reporting" (and its shape) get the class `down`, styled by option.
function markNow(svg) {
  for (const t of svg.querySelectorAll("text.t-now-do")) {
    if (t.textContent !== "Not reporting") continue;
    t.classList.add("down");
    if (t.nextElementSibling?.matches("g.st")) t.nextElementSibling.classList.add("down");
  }
}

export function drawWide(box, D, opts) {
  const p = C.drawWide(box, D, opts);
  const down = downIn(D);
  if (!down.length) return p;
  const now = opts.now ?? true;
  const W = box.clientWidth, S = GRID;
  const px0 = S.gutL + S.gap, px1 = W - (now ? S.gutR : 0) - (now ? S.gap : 8), pw = px1 - px0;
  const x = (ts) => px0 + ((ts - D.t0) / (D.end - D.t0)) * pw;
  const endX = x(Math.min(D.nowS, D.lastS ?? D.nowS)); // to the last word: past it, the office's own hatch
  let y = S.axis;
  const rowY = {};
  for (const r of ROWS) { rowY[r.id ?? `sep${y}`] = y; y += S[r.kind]; }
  const [bg, fg] = p.svg.children;
  for (const { name, lastRun } of down) {
    const top = rowY[name], track = top + 68;
    const from = lastRun == null ? D.t0 : Math.max(D.t0, lastRun), xl = x(from);
    // the faint track stops at the last run
    for (const l of fg.querySelectorAll("line.s-rule-2")) if (+l.getAttribute("y1") === track && +l.getAttribute("y2") === track) l.setAttribute("x2", xl);
    if (OPT !== "a") node("rect", { x: xl, y: top + 4, width: Math.max(0, endX - xl), height: S.eng - 8, class: sig ? "f-hatch-sig" : "f-hatch" }, bg);
    if (lastRun != null && lastRun >= D.t0) node("line", { x1: xl, x2: xl, y1: track - 8, y2: track + 8, class: sig ? "st-fixing" : "s-ink", "stroke-width": 2 }, fg);
    // the words: in the hatch when it has room, else before the end cap, under the track
    const when = lastRun == null ? "" : whenDay(lastRun, D.nowS, opts.tz);
    const t = label(fg, xl + 8, top + 52, OPT === "a" ? `Last ran ${when}` : when ? `Not reporting since ${when}` : "Not reporting");
    if (OPT !== "a" && endX - xl > t.getComputedTextLength() + 24) {
      node("rect", { x: xl + 2, y: top + 38, width: t.getComputedTextLength() + 12, height: 20, class: "f-bg" }, fg).after(t);
    } else if (when) {
      t.textContent = `Last ran ${when}`;
      t.setAttribute("x", xl - 6);
      t.setAttribute("y", track + 16);
      t.setAttribute("text-anchor", "end");
    } else t.remove();
  }
  const inner = p.drawMoment;
  p.drawMoment = (i) => { inner(i); markNow(p.svg); };
  markNow(p.svg);
  return p;
}

// The phone: the lane is a column, newest at the top; no words in it (the Now list above says them).
export function drawTall(box, D, opts) {
  const p = C.drawTall(box, D, opts);
  const down = downIn(D);
  if (!down.length) return p;
  const W = box.clientWidth, ax = 40, colW = { pole: 24, eng: Math.floor((W - ax - 24 - 24 - 12) / 4), ci: 24 };
  const colX = {};
  let cx = ax;
  for (const r of ROWS) {
    if (r.kind === "sep") { cx += 6; continue; }
    colX[r.id] = cx;
    cx += colW[r.kind];
  }
  const top = 70, binH = 5;
  const y = (ts) => top + ((D.end - ts) / (D.end - D.t0)) * BINS * binH;
  const end = Math.min(D.nowS, D.lastS ?? D.nowS);
  const [bg, fg] = p.svg.children;
  for (const { name, lastRun } of down) {
    const c0 = colX[name], w = colW.eng, track = c0 + w * 0.68;
    const from = lastRun == null ? D.t0 : Math.max(D.t0, lastRun);
    if (OPT !== "a") node("rect", { x: c0 + 2, y: y(end), width: w - 4, height: Math.max(0, y(from) - y(end)), class: sig ? "f-hatch-sig" : "f-hatch" }, bg);
    if (lastRun != null && lastRun >= D.t0) node("line", { x1: track - 8, x2: track + 8, y1: y(from), y2: y(from), class: sig ? "st-fixing" : "s-ink", "stroke-width": 2 }, fg);
  }
  return p;
}

// The Now list (the phone, and medium widths): the same class on "Not reporting".
export function drawNowList(ul, D, i, opts) {
  C.drawNowList(ul, D, i, opts);
  for (const s of ul.querySelectorAll("span.l1")) if (s.textContent === "Not reporting") s.classList.add("down");
}
