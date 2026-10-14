// Where everything sits in the sky (setkernel-live#36), for any size from a 320 px phone to a wall.
// Polaris at the top as the pole star, with Kochab, Pherkad and Yildun joined to it as Ursa Minor
// (three faint unlabelled stars complete the shape); the four engineers across the middle; the
// horizon near the bottom, with the three places work goes standing on it. Wide skies keep Polaris
// clear of the headline and the controls that sit over the sky's top corners. Pure, so it is tested.
import { ENGINEERS } from "./state.js";

export const PLACES = ["claude", "github", "chat"];
export const PLACE_NAMES = { claude: "Claude", github: "GitHub", chat: "Team chat" };
export const PLACE_X = { claude: 0.17, github: 0.5, chat: 0.83 };

// Ursa Minor from Polaris, in units of the sky's scale: x right, y down. eps, zeta and eta are the
// faint stars that complete the shape.
export const UMI = { Yildun: [1, 0.2], eps: [1.5, 1], zeta: [2.4, 1.3], Kochab: [3.5, 0.9], Pherkad: [3.8, 1.7], eta: [2.8, 2] };
export const UMI_LINES = [["Polaris", "Yildun"], ["Yildun", "eps"], ["eps", "zeta"], ["zeta", "Kochab"], ["Kochab", "Pherkad"], ["Pherkad", "eta"], ["eta", "zeta"]];
export const FAINT = ["eps", "zeta", "eta"];

// Fractions for the engineers. Wide: of the width, and of the band between the pole group and the
// horizon; every label sits to the right. Narrow: of the whole sky, with the side for the label.
const WIDE = { Vega: [0.12, 0.4], Rigel: [0.47, 0], Lyra: [0.29, 0.94], Orion: [0.67, 0.72] };
const NARROW = { Vega: [0.08, 0.25, "right"], Rigel: [0.92, 0.4, "left"], Lyra: [0.08, 0.6, "right"], Orion: [0.92, 0.74, "left"] };
export const NARROW_BELOW = 560;

// skyLayout(w, h, { rem, hud, status, labels }) -> { mode, u, horizon, stars, faint }
//   rem      the root font size in px
//   hud      the headline's box over the sky's top left ({ right, bottom }), or null
//   status   the controls' box over the top right ({ left, bottom }), or null
//   labels   measured widths of the pole stars' labels, by name (estimates otherwise)
// stars: { name: { x, y, side } } for the engineers and the pole stars; side is where the words go.
export function skyLayout(w, h, { rem = 16, hud = null, status = null, labels = {} } = {}) {
  const narrow = w < NARROW_BELOW;
  // narrow skies show only the names beside the pole stars, not their tallies
  const lab = { ...(narrow ? { Polaris: 4.8 * rem, Yildun: 4.4 * rem, Kochab: 4.6 * rem, Pherkad: 4.8 * rem } : { Polaris: 9 * rem, Yildun: 6 * rem, Kochab: 6.5 * rem, Pherkad: 6.5 * rem }), ...labels };
  const gap = 1.3 * rem; // from a small star to the end of its label
  const orbR = (narrow ? 1.4 : 1.9) * rem;
  const horizon = h - (narrow ? 6.6 : 5.6) * rem;
  let u, P;
  if (narrow) {
    u = w * 0.105;
    const reach = Math.max(3.8 * u + lab.Pherkad + gap, 3.5 * u + lab.Kochab + gap);
    P = { x: Math.max(lab.Polaris + orbR + 0.5 * rem, Math.min(w / 2, w - reach - 0.5 * rem)), y: Math.max(h * 0.085, 2.4 * rem) };
  } else {
    u = Math.min(Math.max(w * 0.05, 2.2 * rem), 4.8 * rem);
    const reach = Math.max(3.8 * u + lab.Pherkad + gap, 3.5 * u + lab.Kochab + gap);
    P = { x: Math.max(w * 0.55, (hud?.right ?? 0) + lab.Polaris + orbR + 1.4 * rem), y: Math.max(h * 0.13, 3.4 * rem) };
    if (status) {
      if (P.x + orbR > status.left) P.y = Math.max(P.y, status.bottom + orbR + 0.8 * rem);
      for (const k of ["Yildun", "Kochab", "Pherkad"]) {
        if (P.x + UMI[k][0] * u + lab[k] + gap > status.left) P.y = Math.max(P.y, status.bottom + 1.3 * rem - UMI[k][1] * u);
      }
    }
    if (P.x + reach > w - rem) { // no room beside the headline: drop below it
      P = { x: Math.max(w * 0.5, lab.Polaris + orbR + 2 * rem), y: Math.max(hud?.bottom ?? 0, status?.bottom ?? 0) + 2.6 * rem };
    }
  }
  const stars = { Polaris: { x: P.x, y: P.y, side: "left" } };
  const faint = {};
  for (const [k, [dx, dy]] of Object.entries(UMI)) {
    const p = { x: P.x + dx * u, y: P.y + dy * u };
    if (FAINT.includes(k)) faint[k] = p;
    else stars[k] = { ...p, side: "right" };
  }
  if (narrow) {
    for (const name of ENGINEERS) {
      const [fx, fy, side] = NARROW[name];
      stars[name] = { x: fx * w, y: fy * h, side };
    }
  } else {
    const top = Math.max(P.y + 2 * u + 0.8 * rem, hud?.bottom ?? 0, status?.bottom ?? 0) + 2.6 * rem;
    const bot = Math.max(top + 4 * rem, horizon - 2.4 * rem);
    for (const name of ENGINEERS) {
      const [fx, fy] = WIDE[name];
      stars[name] = { x: fx * w, y: top + fy * (bot - top), side: "right" };
    }
  }
  for (const p of [...Object.values(stars), ...Object.values(faint)]) {
    p.x = Math.round(p.x);
    p.y = Math.round(p.y);
  }
  return { mode: narrow ? "narrow" : "wide", w, h, u, horizon: Math.round(horizon), stars, faint };
}
