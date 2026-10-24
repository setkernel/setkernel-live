// The prototype's switcher, built with textContent: one link per choice, keeping the others.
(() => {
  const q = new URLSearchParams(location.search);
  const bar = document.createElement("nav");
  bar.className = "proto-bar";
  bar.setAttribute("aria-label", "Prototype");
  const groups = [
    ["Option", "opt", "b", [["today", "Main today"], ["a", "A · Words"], ["b", "B · Hatched lane"], ["c", "C · Flagged"]]],
    ["Down", "down", "one", [["one", "Orion, 2 h 35 min"], ["two", "Vega and Orion, 12 h"], ["none", "Nobody"]]],
    ["Theme", "theme", "light", [["light", "Light"], ["dark", "Dark"]]],
    ["Layout", "wall", "page", [["page", "Page"], ["wall", "Wall"]]],
  ];
  for (const [title, key, def, choices] of groups) {
    const g = document.createElement("span");
    const b = document.createElement("b");
    b.textContent = title;
    g.append(b);
    const cur = key === "wall" ? (q.has("wall") ? "wall" : "page") : q.get(key) ?? def;
    for (const [value, words] of choices) {
      const next = new URLSearchParams(q);
      if (key === "wall") { if (value === "wall") next.set("wall", ""); else next.delete("wall"); } else next.set(key, value);
      const a = document.createElement("a");
      a.href = `?${next}`.replace(/=(&|$)/g, "$1");
      a.textContent = words;
      if (value === cur) a.setAttribute("aria-current", "true");
      g.append(a);
    }
    bar.append(g);
  }
  document.body.append(bar);
})();
