// The night sky's canvas (setkernel-live#36): the slowly turning star field round Polaris, Ursa
// Minor's lines and faint stars, the horizon, the review arcs from reviewer to author, and the
// pulses of work falling from a star to its place on the horizon. The stars themselves, their
// words and the places are real buttons and text over the canvas (app.js), so nothing here needs
// to be read: the canvas is aria-hidden. It stops drawing when the tab is hidden or the sky is off
// screen. With prefers-reduced-motion nothing travels or turns: a place lights up when work
// reaches it, and arcs appear whole.
// In Day (setkernel-live#37) the same sky is a printed star chart: ink stars sized by brightness
// on paper, a faint grid of rings and hour lines centred on Polaris, Ursa Minor in ink, and arcs
// and pulses in the darkened star colours with no glow. colors is read on every draw, so the
// page can swap its values when the theme changes.
import { FAINT, UMI_LINES } from "./layout.js";
import { seeded } from "./demo.js";

const MAX_PULSES = 40;
const MAX_ARCS = 5;
const ARC_DRAW_MS = 1600;
const TURN = 8.7e-7; // radians per ms: one turn in about two hours

export function createSky(canvas, { reduced = false, day = false, colors, onArrive = () => {} }) {
  const ctx = canvas.getContext("2d");
  let L = null, dpr = 1, places = {}, field = [], running = false, raf = 0, still = false;
  const pulses = []; // { a, b, c1, c2, place, t0, dur }
  let arcs = []; // { from, to, t0 }

  // A field of faint stars, seeded so it is the same on every visit, spread round Polaris so it
  // can turn without running out.
  function seedField() {
    const rand = seeded(4242);
    const r = Math.hypot(L.w, L.h) * 1.4;
    const n = Math.min(1600, Math.round((L.w * L.h) / 900));
    field = Array.from({ length: n }, () => {
      const z = rand();
      return {
        r: r * Math.sqrt(rand()), a: rand() * Math.PI * 2,
        size: z > 0.94 ? 1.5 + rand() : z > 0.7 ? 1 + rand() * 0.5 : 0.6 + rand() * 0.4,
        alpha: 0.2 + rand() * 0.55, warm: rand() < 0.14,
      };
    });
  }

  function resize(layout, ratio, stationPoints) {
    L = layout;
    dpr = Math.min(ratio || 1, 2);
    places = stationPoints;
    canvas.width = Math.round(L.w * dpr);
    canvas.height = Math.round(L.h * dpr);
    seedField();
    draw(performance.now());
  }

  const at = (name) => L?.stars[name] ?? L?.faint[name];

  function drawField(t) {
    const P = L.stars.Polaris, turn = reduced ? 0 : t * TURN;
    if (day) ctx.fillStyle = colors.ink;
    for (const s of field) {
      const x = P.x + Math.cos(s.a + turn) * s.r, y = P.y + Math.sin(s.a + turn) * s.r;
      if (x < -4 || y < -4 || x > L.w + 4 || y > L.horizon + 8) continue;
      if (day) { // a printed dot: the brighter the star, the bigger and blacker
        ctx.globalAlpha = s.size >= 1.5 ? 0.55 : s.size >= 1 ? 0.32 : 0.16;
        ctx.beginPath();
        ctx.arc(x, y, s.size * (s.size >= 1.5 ? 0.75 : 0.5), 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.globalAlpha = s.alpha;
      ctx.fillStyle = s.warm ? "#ffe2c4" : "#dfe8ff";
      ctx.fillRect(x, y, s.size, s.size);
    }
    ctx.globalAlpha = 1;
  }

  // Day's chart grid: rings and the twelve hour lines round Polaris, in faint ink
  function drawGrid() {
    const P = L.stars.Polaris, M = Math.max(L.w, L.h);
    ctx.save();
    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = 1;
    for (let i = 1; i <= 8; i++) {
      ctx.globalAlpha = i % 2 ? 0.08 : 0.15;
      ctx.beginPath();
      ctx.arc(P.x, P.y, i * M * 0.13, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let h = 0; h < 12; h++) {
      const a = (h * Math.PI) / 6;
      ctx.globalAlpha = h % 3 ? 0.06 : 0.12;
      ctx.beginPath();
      ctx.moveTo(P.x, P.y);
      ctx.lineTo(P.x + Math.cos(a) * M * 1.3, P.y + Math.sin(a) * M * 1.3);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPole() {
    if (day) return drawUmi(colors.ink, 0.6, colors.ink, 1, 2.3);
    const P = L.stars.Polaris, M = Math.max(L.w, L.h);
    ctx.save();
    ctx.setLineDash([2, 7]);
    ctx.strokeStyle = "#c4d4ff";
    [0.3, 0.56, 0.86].forEach((k, i) => {
      ctx.globalAlpha = 0.08 - i * 0.018;
      ctx.beginPath();
      ctx.arc(P.x, P.y, k * M, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.05;
    ctx.beginPath();
    ctx.moveTo(P.x, 0);
    ctx.lineTo(P.x, L.horizon);
    ctx.stroke();
    ctx.restore();
    drawUmi(colors.pole, 0.4, "#d8edff", 0.75, 1.9);
  }

  // Ursa Minor's lines, and the three faint stars that complete its shape
  function drawUmi(line, lineAlpha, dot, dotAlpha, r) {
    ctx.save();
    ctx.globalAlpha = lineAlpha;
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [a, b] of UMI_LINES) {
      ctx.moveTo(at(a).x, at(a).y);
      ctx.lineTo(at(b).x, at(b).y);
    }
    ctx.stroke();
    ctx.globalAlpha = dotAlpha;
    ctx.fillStyle = dot;
    for (const k of FAINT) {
      ctx.beginPath();
      ctx.arc(at(k).x, at(k).y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawHorizon() {
    const R = Math.max(L.w * 1.5, 1200), cx = L.w / 2, cy = L.horizon + R;
    if (day) { // the ground as a wash of paper under an ink line
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.globalAlpha = 0.94;
      ctx.fillStyle = colors.wash;
      ctx.fill();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = colors.ink;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
      return;
    }
    const earth = ctx.createLinearGradient(0, L.horizon, 0, L.h);
    earth.addColorStop(0, "rgba(43,66,150,.4)");
    earth.addColorStop(0.22, "rgba(11,19,48,.75)");
    earth.addColorStop(1, "rgba(3,5,14,.92)");
    ctx.fillStyle = earth;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
    const limb = ctx.createLinearGradient(0, 0, L.w, 0);
    limb.addColorStop(0, "rgba(159,184,255,0)");
    limb.addColorStop(0.5, "rgba(212,226,255,.85)");
    limb.addColorStop(1, "rgba(159,184,255,0)");
    ctx.strokeStyle = limb;
    for (const [width, alpha] of [[9, 0.2], [1.3, 1]]) {
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.arc(cx, cy, R, Math.PI, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // A review arc bows upwards from reviewer to author, coloured from one to the other. The newest
  // draws itself in; older ones fade.
  function drawArcs(t) {
    arcs.forEach((arc, i) => {
      const a = L.stars[arc.from], b = L.stars[arc.to];
      if (!a || !b) return;
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      let px = -dy / len, py = dx / len;
      if (py > 0) { px = -px; py = -py; }
      const cx = (a.x + b.x) / 2 + px * len * 0.28, cy = (a.y + b.y) / 2 + py * len * 0.28;
      const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      g.addColorStop(0, colors[arc.from]);
      g.addColorStop(1, colors[arc.to]);
      const k = reduced ? 1 : Math.min(1, (t - arc.t0) / ARC_DRAW_MS);
      const op = [1, 0.7, 0.5, 0.35, 0.25][i] ?? 0.2;
      ctx.strokeStyle = g;
      ctx.beginPath();
      const steps = 40;
      for (let j = 0; j <= steps * k; j++) {
        const s = j / steps, u = 1 - s;
        const x = u * u * a.x + 2 * u * s * cx + s * s * b.x, y = u * u * a.y + 2 * u * s * cy + s * s * b.y;
        if (j) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      if (!day) { // the glow under the line; Day prints the line alone
        ctx.globalAlpha = op * 0.14;
        ctx.lineWidth = 7;
        ctx.stroke();
      }
      ctx.globalAlpha = op * 0.9;
      ctx.lineWidth = day ? 1.7 : 1.5;
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
  }

  const bez = (p, t) => {
    const u = 1 - t, A = u * u * u, B = 3 * u * u * t, C = 3 * u * t * t, D = t * t * t;
    return { x: A * p.a.x + B * p.c1.x + C * p.c2.x + D * p.b.x, y: A * p.a.y + B * p.c1.y + C * p.c2.y + D * p.b.y };
  };

  function drawPulses(t) {
    ctx.globalCompositeOperation = day ? "source-over" : "lighter";
    ctx.lineCap = "round";
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      const k = Math.min(1, (t - p.t0) / p.dur);
      if (k >= 0) {
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        const tail = Math.max(0, e - 0.18), h = bez(p, e), s0 = bez(p, tail), c = rgb(colors[p.place]);
        ctx.beginPath();
        for (let j = 0; j <= 12; j++) {
          const q = bez(p, tail + ((e - tail) * j) / 12);
          if (j) ctx.lineTo(q.x, q.y);
          else ctx.moveTo(q.x, q.y);
        }
        const g = ctx.createLinearGradient(s0.x, s0.y, h.x + 0.01, h.y + 0.01);
        g.addColorStop(0, `rgba(${c},0)`);
        g.addColorStop(1, `rgba(${c},.8)`);
        ctx.strokeStyle = g;
        ctx.lineWidth = 1.8;
        ctx.stroke();
        if (day) { // a printed head, no glow
          ctx.fillStyle = `rgb(${c})`;
          ctx.beginPath();
          ctx.arc(h.x, h.y, 3, 0, Math.PI * 2);
          ctx.fill();
        } else {
          const rg = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, 8);
          rg.addColorStop(0, "rgba(255,255,255,.95)");
          rg.addColorStop(0.3, `rgba(${c},.85)`);
          rg.addColorStop(1, `rgba(${c},0)`);
          ctx.fillStyle = rg;
          ctx.beginPath();
          ctx.arc(h.x, h.y, 8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (k >= 1) {
        pulses.splice(i, 1);
        onArrive(p.place);
      }
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function draw(t) {
    if (!L) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, L.w, L.h);
    if (day) drawGrid();
    drawField(t);
    drawPole();
    drawArcs(t);
    drawHorizon();
    drawPulses(t);
  }

  // Redraw while something moves; under reduced motion, only when something changes.
  function frame(t) {
    raf = 0;
    if (!running) return;
    draw(t);
    still = reduced && !pulses.length;
    if (!still) raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (running && !raf) raf = requestAnimationFrame(frame); };

  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",");

  return {
    resize,
    // A pulse of work from a star to its place. Under reduced motion it arrives at once.
    event(from, place) {
      const a = L?.stars[from], b = places[place];
      if (!a || !b || reduced || !running || pulses.length >= MAX_PULSES) return onArrive(place);
      const dy = b.y - a.y;
      pulses.push({ a, b, c1: { x: a.x, y: a.y + dy * 0.5 }, c2: { x: b.x, y: b.y - dy * 0.45 }, place, t0: performance.now(), dur: 1500 + Math.random() * 600 });
      kick();
    },
    review(from, to) {
      arcs = [{ from, to, t0: performance.now() }, ...arcs.filter((x) => !(x.from === from && x.to === to))].slice(0, MAX_ARCS);
      kick();
      if (!running) draw(performance.now());
    },
    clear() {
      pulses.length = 0;
      arcs = [];
      draw(performance.now());
    },
    setDay(on) {
      day = on;
      draw(performance.now());
    },
    setReduced(on) {
      reduced = on;
      for (const p of pulses.splice(0)) onArrive(p.place);
      kick();
      draw(performance.now());
    },
    start() {
      if (running) return;
      running = true;
      kick();
    },
    stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      for (const p of pulses.splice(0)) onArrive(p.place);
    },
  };
}
