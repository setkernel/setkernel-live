// The Day page's geometry (docs/design/v3/day): the grid, which layout a width gets, the axis
// labels and the wall's scale. Pure, so it is tested; public/lib/chart.js and app.js use it.

// One grid for every layout: widths, gaps and row heights in multiples of 8 (4 for the half step).
// gutL is the name gutter, gutR the Now column; the rows are Polaris, a lane, CI and the gap
// between groups. The wall uses the same numbers: fitWall scales the whole canvas.
export const GRID = { gutL: 232, gutR: 376, gap: 24, r: 5, axis: 32, pole: 64, eng: 88, ci: 40, sep: 16 };

// The wall is the page drawn once on a fixed 16:9 canvas and scaled whole to the screen.
export const WALL = { w: 1440, h: 810 };

// Below this the lanes run down the page under the Now list (the phone layout). Between it and
// WIDE the chart runs across with the Now list above it, since the Now column needs its 376 px.
export const NARROW_BELOW = 720;
export const WIDE_FROM = 1232;

// "wall", "wide", "medium" or "narrow" for a window `width` px wide.
export function pageMode(width, wall = false) {
  if (wall) return "wall";
  if (width < NARROW_BELOW) return "narrow";
  return width < WIDE_FROM ? "medium" : "wide";
}

// fitWall: scale the canvas by min(width / 1440, height / 810) and centre it. A 16:9 screen is
// filled edge to edge; any other shape gets bars of the background on two sides, and nothing is
// ever laid out at the screen's own size, so nothing can scroll or clip. -> { k, x, y }
export function fitWall(width, height) {
  const k = Math.min(width / WALL.w, height / WALL.h);
  return { k, x: (width - WALL.w * k) / 2, y: (height - WALL.h * k) / 2 };
}

// The hour rules across the window [t0, end] (seconds): midnight in Halifax ("Today") and every
// third hour of the Halifax day. Each is { ts, mid } where mid marks the day's start.
export function hourRules(t0, end, mid) {
  const out = [];
  for (let h = Math.ceil(t0 / 3600) * 3600; h <= end; h += 3600) {
    const isMid = h === mid;
    const hourHere = Math.round((h - mid) / 3600 + 48) % 24;
    if (isMid || hourHere % 3 === 0) out.push({ ts: h, mid: isMid });
  }
  return out;
}

// Whether an hour's label fits beside the midnight labels ("Yesterday" to its left, "Today ·
// 00:00 ADT" to its right) and before the now label. Distances in px on the chart.
export const labelFits = (hx, midX, nowX) => (hx > midX ? hx - midX > 160 : midX - hx > 112) && nowX - hx > 56;
