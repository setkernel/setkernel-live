// Where the stars and the places their work goes sit in the sky, for any size from a 320 px phone
// to a wall screen. Landscape: the four engineers spread across the sky, Polaris and its three
// Claudes sit together as their own small figure, and the places stand in a column on the right,
// so light travels left to right. Portrait: the engineers zigzag down the sky, the pole group sits
// under them and the places along the bottom, so light falls downwards. Pure, so it is tested.
import { AGENTS } from "./state.js";

export const PLACES = ["claude", "github", "chat"];
export const PLACE_NAMES = { claude: "Claude", github: "GitHub", chat: "Team chat" };

// Fractions of the sky's width and height, and optionally which side a star's words go. Hand-placed,
// like a star chart, not a grid. Wide: the engineers in two loose rows, far enough apart side by
// side that each star's words fit beside it, and the pole group between them and the places, in
// Ursa Minor's shape: Polaris at the end of the handle, Yildun next, then Kochab and Pherkad.
const WIDE = {
  stars: {
    Vega: [0.03, 0.22], Rigel: [0.13, 0.74], Lyra: [0.35, 0.12], Orion: [0.43, 0.8],
    Polaris: [0.62, 0.29], Yildun: [0.67, 0.47], Kochab: [0.62, 0.65], Pherkad: [0.76, 0.7],
  },
  places: { claude: [1, 0.2], github: [1, 0.5], chat: [1, 0.8] },
};
const TALL = {
  stars: {
    Vega: [0.14, 0.08], Rigel: [0.64, 0.2], Lyra: [0.16, 0.32], Orion: [0.66, 0.44],
    Polaris: [0.12, 0.58, "right"], Yildun: [0.36, 0.66, "right"], Kochab: [0.62, 0.62, "right"], Pherkad: [0.72, 0.77, "left"],
  },
  places: { claude: [0.17, 1], github: [0.5, 1], chat: [0.83, 1] },
};

export function skyLayout(w, h) {
  const mode = w / h >= 1.1 ? "wide" : "tall";
  const L = mode === "wide" ? WIDE : TALL;
  const pad = Math.max(20, Math.round(Math.min(w, h) * 0.06));
  const x = (f) => Math.round(pad + f * (w - 2 * pad));
  const y = (f) => Math.round(pad + f * (h - 2 * pad));
  const stars = {};
  for (const name of AGENTS) {
    const [fx, fy, side] = L.stars[name];
    stars[name] = { x: x(fx), y: y(fy), label: side ?? (mode === "wide" || fx < 0.5 ? "right" : "left") };
  }
  const places = {};
  for (const key of PLACES) {
    const [fx, fy] = L.places[key];
    places[key] = mode === "wide"
      ? { x: x(fx) - 6, y: y(fy), label: "above" }
      : { x: x(fx), y: y(fy) - 46, label: "below" }; // room for the label underneath
  }
  return { mode, w, h, pad, stars, places };
}
