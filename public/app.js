// live.setkernel.com page. Connects to /ws, draws the four agents and the places their work goes,
// and moves a dot along a pipe for each event. Everything shown is built with textContent and
// attributes, never innerHTML, so nothing in a batch can inject markup.
(() => {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.getElementById("flow");
  const css = getComputedStyle(document.documentElement);
  const C = (k) => css.getPropertyValue("--" + k).trim();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const AGENTS = ["Vega", "Rigel", "Lyra", "Orion"];
  const OFFLINE_AFTER_MS = 120_000;

  const ACTION_TEXT = {
    picked_up: "started on an issue",
    opened_pr: "opened a pull request",
    approved: "approved a teammate's pull request",
    requested_changes: "asked for changes on a teammate's pull request",
    pushed: "pushed fixes to a pull request",
    posted_round: "posted in a design discussion",
    decision_pr: "wrote up a decision",
  };
  const DOING = {
    issue: "Working on an issue", changes: "Addressing review feedback", decision: "Writing up a decision",
    review: "Reviewing a pull request", discussion: "In a design discussion",
  };
  const PILL = { WORKING: ["WORKING", "claude"], REVIEW: ["REVIEWING", "chat"], DISCUSS: ["DISCUSSING", "github"], PAUSED: ["PAUSED", "warn"], IDLE: ["IDLE", "line"] };

  // ---- drawing
  const el = (tag, attrs = {}, parent = svg) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    parent.appendChild(e);
    return e;
  };
  const text = (str, attrs, parent) => {
    const t = el("text", attrs, parent);
    t.textContent = str;
    return t;
  };

  const nodes = {
    github: { x: 70, label: "GitHub", sub: "issues, pull requests, reviews", color: "github" },
    claude: { x: 380, label: "Claude", sub: "the model doing the work", color: "claude" },
    chat: { x: 690, label: "Team chat", sub: "status updates", color: "chat" },
  };
  const pipeLayer = el("g");
  const nodeLayer = el("g");
  const dotLayer = el("g");
  for (const n of Object.values(nodes)) {
    n.y = 24; n.w = 240; n.h = 76;
    el("rect", { x: n.x, y: n.y, width: n.w, height: n.h, rx: 6, class: "node" }, nodeLayer);
    text(n.label, { x: n.x + 16, y: n.y + 32, class: "n-name" }, nodeLayer);
    text(n.sub, { x: n.x + 16, y: n.y + 54, class: "n-sub" }, nodeLayer);
    n.count = text("", { x: n.x + n.w - 14, y: n.y + 28, class: "n-count", "text-anchor": "end" }, nodeLayer);
  }

  const agents = {};
  AGENTS.forEach((name, i) => {
    const a = { name, x: 22 + i * 246, y: 290, w: 215, h: 150 };
    agents[name] = a;
    const cx = a.x + a.w / 2;
    const offsets = { github: -30, claude: 0, chat: 30 };
    for (const [key, n] of Object.entries(nodes)) {
      const x1 = cx + offsets[key], y1 = a.y, x2 = n.x + 40 + i * 53, y2 = n.y + n.h, m = (y1 + y2) / 2;
      a["pipe_" + key] = el("path", { d: `M${x1},${y1} C${x1},${m} ${x2},${m} ${x2},${y2}`, class: "pipe" }, pipeLayer);
    }
    a.rect = el("rect", { x: a.x, y: a.y, width: a.w, height: a.h, rx: 6, class: "tile" }, nodeLayer);
    text(name, { x: a.x + 16, y: a.y + 34, class: "a-name" }, nodeLayer);
    text("AI engineer", { x: a.x + 16, y: a.y + 54, class: "a-role" }, nodeLayer);
    a.pillBg = el("rect", { x: a.x + a.w - 92, y: a.y + 16, width: 78, height: 20, rx: 10, fill: C("line") }, nodeLayer);
    a.pill = text("IDLE", { x: a.x + a.w - 53, y: a.y + 30, class: "pill-text", "text-anchor": "middle", fill: C("ink-dim") }, nodeLayer);
    a.doing = text("Waiting for work", { x: a.x + 16, y: a.y + 92, class: "a-doing" }, nodeLayer);
    a.repo = text("", { x: a.x + 16, y: a.y + 114, class: "a-repo" }, nodeLayer);
  });

  function showAgent(name, info) {
    const a = agents[name];
    if (!a) return;
    const state = info?.state || "IDLE";
    const [label, color] = PILL[state] || PILL.IDLE;
    a.pill.textContent = label;
    a.pill.setAttribute("fill", color === "line" ? C("ink-dim") : C("bg"));
    a.pillBg.setAttribute("fill", C(color));
    a.doing.textContent = state === "IDLE" ? "Waiting for work" : state === "PAUSED" ? "Paused" : DOING[info.work] || "Working";
    a.repo.textContent = info?.repo && state !== "IDLE" ? info.repo : "";
  }

  // ---- dots
  const dots = [];
  function dot(name, key) {
    const a = agents[name], n = nodes[key];
    if (!a || !n || document.hidden) return;
    const p = a["pipe_" + key], color = C(n.color);
    a.rect.style.stroke = color;
    setTimeout(() => { a.rect.style.stroke = ""; }, 300);
    if (reduced) {
      p.style.stroke = color;
      setTimeout(() => { p.style.stroke = ""; }, 500);
      return;
    }
    if (dots.length > 120) return;
    const c = el("circle", { r: key === "claude" ? 4 : 5, fill: color, class: "dot" }, dotLayer);
    c.style.color = color;
    dots.push({ c, p, len: p.getTotalLength(), t0: performance.now(), dur: 1500 });
  }
  function frame(now) {
    for (let i = dots.length - 1; i >= 0; i--) {
      const d = dots[i], f = (now - d.t0) / d.dur;
      if (f >= 1) { d.c.remove(); dots.splice(i, 1); continue; }
      const pt = d.p.getPointAtLength(f * d.len);
      d.c.setAttribute("cx", pt.x);
      d.c.setAttribute("cy", pt.y);
      d.c.setAttribute("opacity", f < 0.1 ? f * 10 : f > 0.9 ? (1 - f) * 10 : 1);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---- counters and feed
  const countsEl = document.getElementById("counts");
  function showCounts(c = {}) {
    const rows = [["Issues started", c.started], ["Pull requests opened", c.prs], ["Reviews", c.reviews], ["Claude requests", c.claude], ["Team-chat posts", c.chat]];
    countsEl.replaceChildren(...rows.flatMap(([label, v]) => {
      const dt = document.createElement("dt"); dt.textContent = label;
      const dd = document.createElement("dd"); dd.textContent = String(v ?? 0);
      return [dt, dd];
    }));
    nodes.claude.count.textContent = `${c.claude ?? 0} today`;
    nodes.github.count.textContent = `${(c.started ?? 0) + (c.prs ?? 0) + (c.reviews ?? 0)} today`;
    nodes.chat.count.textContent = `${c.chat ?? 0} today`;
  }

  let skew = 0; // server clock minus ours
  const ago = (ts) => {
    const s = Math.max(0, Math.round((Date.now() + skew) / 1000 - ts));
    return s < 90 ? "about a minute ago" : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
  };
  const feedEl = document.getElementById("feed");
  let feed = [];
  function showFeed() {
    if (!feed.length) {
      const li = document.createElement("li"); li.className = "empty"; li.textContent = "Nothing yet today.";
      feedEl.replaceChildren(li);
      return;
    }
    feedEl.replaceChildren(...feed.map((f) => {
      const li = document.createElement("li");
      const who = document.createElement("b"); who.textContent = f.agent;
      li.append(who, ` ${ACTION_TEXT[f.action] || "did something"}`);
      if (f.repo) {
        const a = document.createElement("a");
        a.href = `https://github.com/setkernel/${encodeURIComponent(f.repo)}`;
        a.textContent = f.repo;
        a.rel = "noopener";
        li.append(" in ", a);
      }
      const t = document.createElement("time"); t.textContent = ago(f.ts);
      li.append(t);
      return li;
    }));
  }

  // ---- connection
  const statusEl = document.getElementById("status"), statusText = document.getElementById("status-text");
  const offlineEl = document.getElementById("offline"), offlineMin = document.getElementById("offline-min");
  let lastIngest = 0, retry = 1000, ws;

  function apply(msg) {
    if (typeof msg.now === "number") skew = msg.now - Date.now();
    if (typeof msg.lastIngest === "number") lastIngest = msg.lastIngest;
    for (const name of AGENTS) showAgent(name, msg.agents?.[name]);
    showCounts(msg.counts);
    if (Array.isArray(msg.feed)) { feed = msg.feed; showFeed(); }
    if (msg.t === "batch" && Array.isArray(msg.events)) {
      const msgs = msg.events.filter((e) => e.t === "msg");
      const first = msgs.length ? Math.min(...msgs.map((e) => e.ts || 0)) : 0;
      for (const e of msgs) {
        const key = e.kind === "claude" ? "claude" : e.kind === "chat" ? "chat" : "github";
        const delay = Math.min(5000, Math.max(0, ((e.ts || first) - first) * 1000));
        setTimeout(() => dot(e.agent, key), delay); // spread a 5 s batch the way it happened
      }
    }
    tick();
  }

  function tick() {
    const quiet = !lastIngest || Date.now() + skew - lastIngest > OFFLINE_AFTER_MS;
    offlineEl.hidden = !quiet || !lastIngest;
    if (quiet && lastIngest) offlineMin.textContent = String(Math.round((Date.now() + skew - lastIngest) / 60000));
    if (ws?.readyState === WebSocket.OPEN) {
      statusEl.className = quiet ? "status down" : "status live";
      statusText.textContent = quiet ? (lastIngest ? "Office offline" : "Waiting for the office") : "Live · about a minute behind";
    }
  }
  setInterval(() => { tick(); if (feed.length) showFeed(); }, 30_000);

  function connect() {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = () => { retry = 1000; tick(); };
    ws.onmessage = (m) => {
      try { apply(JSON.parse(m.data)); } catch (err) { console.error(err); }
    };
    ws.onclose = () => {
      statusEl.className = "status down";
      statusText.textContent = "Reconnecting…";
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30_000);
    };
  }
  showCounts();
  connect();
})();
