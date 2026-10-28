// Before the first paint, in place of public/early.js: the page runs only on the prototype's data
// (?demo), so with no address it starts on option B and one engineer down. Then the classes:
// ?wall (as early.js), ?theme=dark, the option, and ?shot (no switcher).
(() => {
  const q = new URLSearchParams(location.search);
  if (!q.has("demo")) return location.replace("?demo&opt=b&down=one");
  const c = document.documentElement.classList;
  if (q.has("wall")) c.add("wall");
  else if (q.get("theme") === "dark") c.add("dark");
  const opt = ["today", "a", "b", "c"].includes(q.get("opt")) ? q.get("opt") : "b";
  c.add(`opt-${opt}`);
  if (q.has("shot")) c.add("shot");
})();
