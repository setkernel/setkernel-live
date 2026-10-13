// Where the stars and the places their work goes sit in the sky, for any size from a 320 px phone
// to a wall screen. Landscape: the four stars spread across the sky and the places stand in a
// column on the right, so light travels left to right. Portrait: the stars zigzag down the sky and
// the places sit along the bottom, so light falls downwards. Pure, so it is tested.
import { AGENTS } from "./state.js";

export const PLACES = ["claude", "github", "chat"];
export const PLACE_NAMES = { claude: "Claude", github: "GitHub", chat: "Team chat" };

// Fractions of the sky's width and height. Hand-placed, like a star chart, not a grid.
// Wide: two loose rows, far enough apart side by side that each star's words fit beside it.
const WIDE = {
  stars: { Vega: [0.04, 0.24], Rigel: [0.17, 0.7], Lyra: [0.46, 0.14], Orion: [0.59, 0.8] },
  places: { claude: [1, 0.2], github: [1, 0.5], chat: [1, 0.8] },
};
const TALL = {
  stars: { Vega: [0.14, 0.13], Rigel: [0.64, 0.3], Lyra: [0.16, 0.47], Orion: [0.66, 0.64] },
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
    const [fx, fy] = L.stars[name];
    stars[name] = { x: x(fx), y: y(fy), label: mode === "wide" || fx < 0.5 ? "right" : "left" };
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
