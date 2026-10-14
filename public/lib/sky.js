// The night sky, drawn on a canvas. Each engineer is a star whose glow follows its activity; each
// event is a pulse of light from the star to where the work went; a review draws a line between
// two stars. Polaris, the director, is a fixed eight-pointed figure inside a faint ring, and its
// three Claudes (Kochab, Pherkad, Yildun) are smaller, steady stars joined to it as Ursa Minor;
// they have no state, so only their own events brighten them. Text never goes on the canvas (app.js puts real, accessible text over it), and the
// canvas is aria-hidden. Stops drawing when the tab is hidden or the sky is off screen; with
// prefers-reduced-motion nothing travels: stars and places brighten and fade in place.
import { AGENTS, ENGINEERS, POLE } from "./state.js";
import { PLACES } from "./layout.js";
import { seeded } from "./demo.js";

const BASE = { WORKING: 0.55, REVIEW: 0.5, DISCUSS: 0.45, PAUSED: 0.18, IDLE: 0.1 };
const POLE_BASE = { Polaris: 0.42, Kochab: 0.22, Pherkad: 0.22, Yildun: 0.22 }; // fixed: no state
// Ursa Minor's line, simplified: the handle from Polaris to Yildun, then the bowl.
const URSA_MINOR = ["Polaris", "Yildun", "Kochab", "Pherkad", "Yildun"];
const KICK = { claude: 0.08, chat: 0.14, helper: 0.12, github: 0.3 };
const MAX_PULSES = 160;
const MAX_LINES = 6;

export function createSky(canvas, { reduced = false, colors }) {
  const ctx = canvas.getContext("2d");
  let L = null, dpr = 1, field = null, running = false, raf = 0, slowTimer = 0, lastFrame = 0, prevDraw = 0;
  const energy = Object.fromEntries(AGENTS.map((n) => [n, { base: POLE_BASE[n] ?? BASE.IDLE, kick: 0 }]));
  const flash = Object.fromEntries(PLACES.map((k) => [k, 0]));
  const rings = []; // helper flares: { agent, t0 }
  const pulses = []; // { agent, place, t0, dur, bend }
  const lines = []; // review lines: { from, to, t0 }
  const sprites = {};

  // A soft round glow in one colour, drawn once and stamped many times.
  function sprite(color) {
    if (sprites[color]) return sprites[color];
    const s = document.createElement("canvas");
    s.width = s.height = 64;
    const g = s.getContext("2d");
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.18, color);
    grad.addColorStop(0.5, color + "33");
    grad.addColorStop(1, color + "00");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return (sprites[color] = s);
  }

  // Background: faint fixed stars, the dotted figure joining the four engineers like a star chart,
  // and Ursa Minor with the ring round Polaris.
  function drawField() {
    const { w, h } = L;
    field = document.createElement("canvas");
    field.width = Math.round(w * dpr);
    field.height = Math.round(h * dpr);
    const g = field.getContext("2d");
    g.scale(dpr, dpr);
    const rand = seeded(Math.round(w) * 7919 + Math.round(h));
    const n = Math.min(1400, Math.round((w * h) / 2600));
    for (let i = 0; i < n; i++) {
      const r = rand() ** 3 * 1.1 + 0.35, a = 0.12 + rand() * 0.5;
      g.fillStyle = rand() < 0.2 ? `rgba(255,214,170,${a})` : rand() < 0.4 ? `rgba(190,210,255,${a})` : `rgba(236,231,220,${a})`;
      g.beginPath();
      g.arc(rand() * w, rand() * h, r, 0, Math.PI * 2);
      g.fill();
    }
    g.strokeStyle = "rgba(236,231,220,0.13)";
    g.lineWidth = 1;
    g.setLineDash([2, 6]);
    const figure = (names) => {
      g.beginPath();
      names.forEach((name, i) => {
        const s = L.stars[name];
        if (i) g.lineTo(s.x, s.y);
        else g.moveTo(s.x, s.y);
      });
      g.stroke();
    };
    figure(ENGINEERS);
    g.strokeStyle = "rgba(255,236,190,0.28)";
    figure(URSA_MINOR);
    g.setLineDash([]);
    const p = L.stars.Polaris;
    g.strokeStyle = "rgba(255,236,190,0.22)";
    g.beginPath();
    g.arc(p.x, p.y, 26 * starScale(), 0, Math.PI * 2);
    g.stroke();
    // the routes light takes, barely there until a pulse runs along one
    g.strokeStyle = "rgba(236,231,220,0.045)";
    for (const name of AGENTS) for (const key of PLACES) {
      const [a, c, b] = route(name, key);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.quadraticCurveTo(c.x, c.y, b.x, b.y);
      g.stroke();
    }
  }

  // The curve from a star to a place: a gentle arc, bending the same way every time.
  function route(name, key, bend = 0) {
    const a = L.stars[name], b = L.places[key];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y;
    const k = 0.18 + bend;
    return [a, { x: mx - dy * k, y: my + dx * k }, b];
  }
  const starScale = () => Math.min(1.25, Math.max(0.8, Math.min(L.w, L.h) / 520));
  const at = ([a, c, b], f) => {
    const u = 1 - f;
    return { x: u * u * a.x + 2 * u * f * c.x + f * f * b.x, y: u * u * a.y + 2 * u * f * c.y + f * f * b.y };
  };

  function resize(layout, ratio) {
    L = layout;
    // a big wall screen at 2x would be 30 megapixels a frame; 1.5x looks the same at that distance
    dpr = Math.min(ratio || 1, layout.w * layout.h > 1_500_000 ? 1.5 : 2);
    canvas.width = Math.round(layout.w * dpr);
    canvas.height = Math.round(layout.h * dpr);
    drawField();
    draw(performance.now());
  }

  // A star's brightness now, its kick fading over a few seconds.
  function levelOf(name, dt) {
    const en = energy[name];
    en.kick *= Math.exp(-dt / 4000);
    return Math.min(1.3, en.base + en.kick);
  }
  function glow(s, color, r, alpha) {
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprite(color), s.x - r, s.y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
  }
  // a cross of `long` spikes, and when `short` is set a second, diagonal one; alpha is 0 to 255
  function spikes(s, color, long, short, alpha) {
    ctx.strokeStyle = color + Math.round(Math.min(255, alpha)).toString(16).padStart(2, "0");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(s.x - long, s.y); ctx.lineTo(s.x + long, s.y);
    ctx.moveTo(s.x, s.y - long); ctx.lineTo(s.x, s.y + long);
    if (short) {
      const d = short / Math.SQRT2;
      ctx.moveTo(s.x - d, s.y - d); ctx.lineTo(s.x + d, s.y + d);
      ctx.moveTo(s.x - d, s.y + d); ctx.lineTo(s.x + d, s.y - d);
    }
    ctx.stroke();
  }
  function core(s, r) {
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function draw(now) {
    if (!L) return;
    const dt = Math.min(250, Math.max(0, now - (prevDraw || now)));
    prevDraw = now;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, L.w, L.h);
    ctx.drawImage(field, 0, 0, L.w, L.h);
    ctx.globalCompositeOperation = "lighter";

    // review lines: grow from the reviewer to the author, then fade over a minute
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i], age = now - ln.t0;
      if (age > 90_000) { lines.splice(i, 1); continue; }
      const a = L.stars[ln.from], b = L.stars[ln.to];
      const grow = reduced ? 1 : Math.min(1, age / 900);
      const alpha = age < 4000 ? 0.7 : 0.7 * Math.max(0.12, 1 - (age - 4000) / 60_000) * (age > 80_000 ? (90_000 - age) / 10_000 : 1);
      ctx.strokeStyle = `rgba(236,231,220,${alpha})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(a.x + (b.x - a.x) * grow, a.y + (b.y - a.y) * grow);
      ctx.stroke();
    }

    // pulses: a bright head and a short fading tail
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i], f = (now - p.t0) / p.dur;
      if (f >= 1) { pulses.splice(i, 1); flash[p.place] = 1; continue; }
      if (f < 0) continue;
      const curve = route(p.agent, p.place, p.bend);
      const e = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2; // ease in-out
      const color = colors[p.place];
      for (let s = 1; s <= 8; s++) {
        const q = Math.max(0, e - s * 0.018);
        const pt = at(curve, q), prev = at(curve, Math.max(0, q - 0.018));
        ctx.strokeStyle = color + Math.round((1 - s / 9) * 150).toString(16).padStart(2, "0");
        ctx.lineWidth = 2.2 - s * 0.2;
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(pt.x, pt.y);
        ctx.stroke();
      }
      const head = at(curve, e);
      ctx.drawImage(sprite(color), head.x - 9, head.y - 9, 18, 18);
    }

    // places: a small ring, flaring when light arrives
    for (const key of PLACES) {
      const p = L.places[key], fl = flash[key];
      ctx.strokeStyle = colors[key];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.drawImage(sprite(colors[key]), p.x - 8 - 18 * fl, p.y - 8 - 18 * fl, 16 + 36 * fl, 16 + 36 * fl);
      flash[key] = Math.max(0, fl - dt / 450);
    }

    // stars: glow and a slow breath that quickens with work; cross spikes when busy
    const scale = starScale();
    for (const name of ENGINEERS) {
      const s = L.stars[name], level = levelOf(name, dt);
      const breath = reduced ? 1 : 1 + 0.08 * Math.sin(now / (1400 - 700 * Math.min(1, level)) + s.x);
      glow(s, colors[name], (14 + 46 * level) * breath * scale, 0.35 + 0.5 * Math.min(1, level));
      spikes(s, colors[name], (8 + 34 * level) * scale, 0, Math.min(1, level) * 110);
      core(s, (2 + 2.2 * Math.min(1, level)) * scale);
    }
    // Polaris: the fixed pole star. It doesn't breathe; eight points, the long ones always there.
    {
      const s = L.stars.Polaris, level = levelOf("Polaris", dt);
      glow(s, colors.Polaris, (16 + 40 * level) * scale, 0.45 + 0.4 * Math.min(1, level));
      spikes(s, colors.Polaris, (24 + 14 * level) * scale, (9 + 6 * level) * scale, 150 + 60 * Math.min(1, level));
      core(s, 3.4 * scale);
    }
    // its three Claudes: smaller and steady, a little glow and no spikes
    for (const name of POLE.slice(1)) {
      const s = L.stars[name], level = levelOf(name, dt);
      glow(s, colors[name], (7 + 26 * level) * scale, 0.4 + 0.5 * Math.min(1, level));
      core(s, (1.4 + 1.2 * Math.min(1, level)) * scale);
    }

    // helper flares: a thin ring leaving the star
    for (let i = rings.length - 1; i >= 0; i--) {
      const g = rings[i], f = (now - g.t0) / 1100;
      if (f >= 1) { rings.splice(i, 1); continue; }
      const s = L.stars[g.agent];
      ctx.strokeStyle = colors[g.agent] + Math.round((1 - f) * 200).toString(16).padStart(2, "0");
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 10 + (reduced ? 18 : 44 * f), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function loop(now) {
    raf = 0;
    if (!running) return;
    // full rate while light is moving; a calm 20 fps when only the stars breathe
    const busy = pulses.length || rings.length || lines.some((l) => now - l.t0 < 1000) || PLACES.some((k) => flash[k] > 0);
    if (busy || now - lastFrame > 50) {
      draw(now);
      lastFrame = now;
    }
    raf = requestAnimationFrame(loop);
  }

  return {
    resize,
    setAgents(agents) {
      for (const n of ENGINEERS) energy[n].base = BASE[agents?.[n]?.state] ?? BASE.IDLE;
    },
    // An event: kind is claude, chat, helper or github.
    event(agent, kind) {
      if (!energy[agent] || !L) return;
      energy[agent].kick = Math.min(0.8, energy[agent].kick + (KICK[kind] ?? 0.1));
      if (kind === "helper") { rings.push({ agent, t0: performance.now() }); return; }
      if (reduced) { flash[kind] = 1; return; }
      if (pulses.length >= MAX_PULSES) return;
      pulses.push({ agent, place: kind, t0: performance.now(), dur: 1700 + Math.random() * 900, bend: (Math.random() - 0.5) * 0.14 });
    },
    review(from, to) {
      if (!energy[from] || !energy[to] || from === to) return;
      lines.push({ from, to, t0: performance.now() });
      if (lines.length > MAX_LINES) lines.shift();
    },
    start() {
      if (running) return;
      running = true;
      if (reduced) {
        // no animation loop: redraw a few times a second so brightness changes still show
        const slow = () => { if (!running) return; draw(performance.now()); slowTimer = setTimeout(slow, 250); };
        slow();
      } else if (!raf) raf = requestAnimationFrame(loop);
    },
    stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(slowTimer);
      raf = 0;
    },
    clear() {
      pulses.length = 0;
      rings.length = 0;
    },
  };
}
