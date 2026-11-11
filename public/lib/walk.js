// Demo mode (setkernel-live#94): one change to this page, followed in seven steps from the idea to
// production. The counts and times are one real public change's evidence, as src/evidence.js keeps
// it (docs/design/v4/showcase/evidence.json, the Day page's build): counts, times and star names,
// never a title, a number, a link or a word of its text. steps() is pure; mountStepper draws it.
import { clock } from "./words.js";

const CHANGE = {
  repo: "setkernel-live",
  idea: { at: "2026-10-15T06:21:15Z", words: 670, criteria: 11 },
  build: { by: "Lyra", commits: 6, files: 45, added: 1934, removed: 2757, opened: "2026-10-15T07:26:00Z", first: "2026-10-15T07:24:15Z", last: "2026-10-15T12:24:09Z" },
  proof: { checks: [["validate", 30]], at: "2026-10-15T12:25:35Z", screenshots: 26, tests: 5 },
  review: { automated: [["2026-10-15T07:30:50Z", 1], ["2026-10-15T08:05:52Z", 0]], peer: { by: "Rigel", at: "2026-10-15T08:19:30Z" } },
  merge: { at: "2026-10-15T14:11:12Z" },
  production: { checks: [["deploy", 344], ["validate", 31]], minutes: 6 },
};

const MIN = 60_000;
const ms = (iso) => Date.parse(iso);
const count = (n) => n.toLocaleString("en-GB");
// 299.9 min -> "5 h", 405 -> "6 h 45 min", 44 -> "44 min"
export function span(from, to) {
  const m = Math.round((ms(to) - ms(from)) / MIN), h = Math.floor(m / 60);
  return h < 1 ? `${m} min` : m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
const secs = (s) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`);
const day = (iso, timeZone) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone }).format(new Date(ms(iso)));

// The seven steps, in the visitor's time zone. Each art is a list of parts mountStepper draws:
// ["bars", n] text left out, ["crit", n] unticked boxes, ["sub", words], ["row", icon, words, time],
// ["tiles", [[value, label]...]], ["shots", n] screenshots, ["bar", [[label, span, cls]...], [length...]] two stretches to scale.
export function steps(timeZone) {
  const c = CHANGE, at = (iso) => clock(ms(iso), timeZone);
  const checks = (list) => list.map(([name, s]) => ["row", "i-check", name, secs(s)]);
  const building = span(c.build.opened, c.build.last), waiting = span(c.build.last, c.merge.at);
  return [
    { tab: "Idea", title: "An idea is described",
      big: "Someone describes what they want, in plain words, in an issue. No template and no meeting.",
      small: `Here the idea was a change to this page, in ${c.repo}.`,
      facts: [["By", "a person"], ["Length", `${count(c.idea.words)} words`], ["Written", `${day(c.idea.at, timeZone)}, ${at(c.idea.at)}`]],
      art: { title: `Issue · ${c.repo}`, meta: `${count(c.idea.words)} words`, parts: [["bars", 6], ["sub", "The words stay in the issue"]] } },
    { tab: "Charter", title: "A charter: what done means",
      big: "Before any code, the work gets its acceptance criteria: plain sentences that say when it is done.",
      small: "The review holds the pull request to every one of them, and an unmet one blocks the merge.",
      facts: [["Acceptance criteria", String(c.idea.criteria)]],
      art: { title: "Acceptance criteria", meta: `${c.idea.criteria} criteria`, parts: [["crit", c.idea.criteria]] } },
    { tab: "Build", title: "The team builds",
      big: "An engineer picks it up and works in a pull request, in small commits that each say why.",
      small: "The size of the change is a count here, never its code.",
      facts: [["Engineer", c.build.by], ["Commits", String(c.build.commits)], ["Files changed", String(c.build.files)],
        ["Lines", `+${count(c.build.added)} and −${count(c.build.removed)}`], ["First to last commit", span(c.build.first, c.build.last)]],
      art: { title: `Pull request · ${c.repo}`, meta: `${c.build.commits} commits`, parts: [
        ["tiles", [[String(c.build.commits), "Commits"], [String(c.build.files), "Files"], [`+${count(c.build.added)}`, "Lines"]]],
        ["row", "g-live", "First commit", at(c.build.first)], ["row", "g-live", "Last commit", at(c.build.last)], ["bars", 3, "thin"]] } },
    { tab: "Evidence", title: "Evidence: tests, screenshots, checks",
      big: "Done means proven: tests run, screenshots are attached, and every check passes on the exact commit.",
      small: "The screenshots are taken by a script at fixed sizes and kept with the pull request.",
      facts: [["Checks", `${c.proof.checks.length} of ${c.proof.checks.length} passed`], ["Screenshots", String(c.proof.screenshots)], ["Test files changed", String(c.proof.tests)]],
      art: { title: "Checks", meta: `passed at ${at(c.proof.at)}`, parts: [...checks(c.proof.checks), ["sub", `${c.proof.screenshots} screenshots`], ["shots", c.proof.screenshots]] } },
    { tab: "Review", title: "An independent review",
      big: "A second model reviews the change and looks only for what would block it. Every blocker is fixed before the merge.",
      small: "The automated review found one blocker, fixed before its second pass found none. Then a second engineer approved.",
      facts: [["Automated reviews", String(c.review.automated.length)], ["Blockers found", "1, fixed"], ["Peer review", `approved by ${c.review.peer.by}`]],
      art: { title: "Review log", meta: `${c.review.automated.length + 1} entries`, parts: [
        ...c.review.automated.map(([t, n]) => ["row", n ? "g-info" : "i-check", n ? `Automated review: ${n} blocker found` : "Automated review: no blockers", at(t)]),
        ["row", "i-check", `${c.review.peer.by}, a second engineer, approved`, at(c.review.peer.at)]] } },
    { tab: "Merge", title: "The merge",
      big: "A person reads the evidence and merges. Nothing reaches production without a human sign-off.",
      small: "From the pull request opened to merged. The times are this one change's, not an average.",
      facts: [["Opened to merged", span(c.build.opened, c.merge.at)], ["Merged by", "a person"], ["Merged at", at(c.merge.at)]],
      art: { title: "Opened to merged", meta: span(c.build.opened, c.merge.at), parts: [
        ["bar", [["Opened to last commit", building, "b1"], ["Last commit to merged", waiting, "b2"]], [ms(c.build.last) - ms(c.build.opened), ms(c.merge.at) - ms(c.build.last)]],
        ["row", "i-check", "Merged by a person", at(c.merge.at)]] } },
    { tab: "Production", title: "Checked in production",
      big: "After the deploy, a smoke check confirms the new version is the one running. If it fails, the deploy rolls back by itself.",
      small: "The deploy waited until the page reported the merged version, then checked every route.",
      facts: [["Merged to checked", `${c.production.minutes} min`], ["Checks", `${c.production.checks.length} of ${c.production.checks.length} passed`], ["Rolled back", "no"]],
      art: { title: "Checks in production", meta: `${c.production.checks.length} of ${c.production.checks.length} passed`, parts: [
        ...checks(c.production.checks), ["row", "i-check", "The running version is the merged version", ""]] } },
  ];
}

// ---- drawing: built with textContent and attributes, like the rest of the page
const SVG = "http://www.w3.org/2000/svg";
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, String(v));
  for (const k of kids.flat(Infinity)) if (k != null) e.append(k);
  return e;
}
function s(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  e.append(...kids);
  return e;
}
export const ico = (id) => s("svg", { class: "ico", viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" }, s("use", { href: `#${id}` }));

// Bars stand in for text the page leaves out; their widths repeat so nothing about them is data.
const WIDTHS = ["w6", "w4", "w5", "w2", "w5", "w1", "w3"];
const bar = (i, cls = "") => h("i", { class: `rb ${WIDTHS[i % WIDTHS.length]} ${cls}`.trim() });
const bars = (n, cls) => Array.from({ length: n }, (_, i) => bar(i, cls));
function part([kind, ...a]) {
  if (kind === "bars") return bars(a[0], a[1]);
  if (kind === "sub") return h("div", { class: "sub" }, a[0]);
  if (kind === "crit") return h("div", { class: "crits", role: "img", "aria-label": `${a[0]} acceptance criteria, their words left out` },
    Array.from({ length: a[0] }, (_, i) => h("div", { class: "crit" }, ico("i-box"), bar(i * 3))));
  if (kind === "row") return h("div", { class: a[0] === "i-check" ? "row ok" : "row" }, ico(a[0]), h("span", {}, a[1]), h("span", { class: "t" }, a[2]));
  if (kind === "tiles") return h("div", { class: "tiles" }, a[0].map(([v, k]) => h("div", { class: "tile" }, h("b", {}, v), h("span", {}, k))));
  if (kind === "shots") return h("div", { class: "shots", role: "img", "aria-label": `${a[0]} screenshots` }, Array.from({ length: a[0] }, () => h("i")));
  if (kind === "bar") {
    // the two stretches drawn to scale: an SVG, since the CSP allows no style attribute for a width
    const [segs, lens] = a, total = lens.reduce((x, y) => x + y, 0);
    let x = 0;
    const svg = s("svg", { viewBox: `0 0 ${total} 10`, preserveAspectRatio: "none", "aria-hidden": "true", focusable: "false" },
      ...segs.map(([, , cls], i) => { const r = s("rect", { x, y: 0, width: lens[i], height: 10, class: cls }); x += lens[i]; return r; }));
    return [h("div", { class: "seg", role: "img", "aria-label": segs.map(([k, v]) => `${k} ${v}`).join(", ") }, svg),
      h("div", { class: "seg-l" }, segs.map(([k, v, cls]) => h("span", {}, s("svg", { class: "sw", viewBox: "0 0 14 9", "aria-hidden": "true", focusable: "false" }, s("rect", { width: 14, height: 9, class: cls })), `${k}, ${v}`)))];
  }
  return null;
}

// The stepper: a tab list of the seven steps and one panel; the arrow keys, Home and End move.
export function mountStepper(host, list) {
  const id = host.id || "steps";
  let at = 0;
  const tabs = h("div", { class: "tabs", role: "tablist", "aria-label": "Seven steps from an idea to production" });
  const panel = h("div", { class: "panel", role: "tabpanel", id: `${id}-p`, tabindex: "-1" });
  const prev = h("button", { type: "button", class: "btn ghost sm" }, ico("i-left"), "Previous");
  const next = h("button", { type: "button", class: "btn sm" }, "Next", ico("i-right"));
  const btns = list.map((t, i) => h("button", { type: "button", role: "tab", class: "tab", id: `${id}-t${i}`, "aria-controls": `${id}-p` }, h("span", { class: "n", "aria-hidden": "true" }, String(i + 1)), t.tab));
  btns.forEach((b, i) => b.addEventListener("click", () => go(i)));
  prev.addEventListener("click", () => go(at - 1));
  next.addEventListener("click", () => go(at + 1));
  tabs.append(...btns);
  tabs.addEventListener("keydown", (e) => {
    const k = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: list.length - 1 }[e.key];
    if (k === undefined) return;
    e.preventDefault();
    go(k, true);
  });
  const kb = (...c) => h("span", { class: "kbd", "aria-hidden": "true" }, ...c);
  const hint = h("span", { class: "hint" }, kb(ico("i-left")), kb(ico("i-right")), kb("Home"), kb("End"), "to move",
    h("span", { class: "sr" }, "Left and right arrow keys, Home and End, move between the steps."));
  function go(i, focus) {
    const held = [prev, next].find((b) => b === document.activeElement); // redrawing the panel would drop it
    at = Math.max(0, Math.min(list.length - 1, i));
    const t = list[at];
    btns.forEach((b, j) => { b.setAttribute("aria-selected", String(j === at)); b.tabIndex = j === at ? 0 : -1; b.classList.toggle("done", j < at); });
    panel.setAttribute("aria-labelledby", `${id}-t${at}`);
    panel.textContent = "";
    panel.append(
      h("div", {}, h("p", { class: "kick" }, `Step ${at + 1} of ${list.length}`), h("h3", {}, t.title), h("p", { class: "big" }, t.big), h("p", { class: "small" }, t.small),
        h("dl", { class: "facts" }, t.facts.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])), h("div", { class: "stepnav" }, prev, next, hint)),
      h("div", { class: "art" }, h("header", {}, h("b", {}, t.art.title), h("span", {}, t.art.meta)), h("div", { class: "body" }, t.art.parts.map(part))));
    prev.disabled = at === 0;
    next.disabled = at === list.length - 1;
    const r = btns[at].getBoundingClientRect(), box = tabs.getBoundingClientRect(); // on a phone the tabs scroll: keep this one in view
    tabs.scrollLeft += r.left - box.left - (box.width - r.width) / 2;
    if (focus) btns[at].focus();
    else if (held) (held.disabled ? (held === prev ? next : prev) : held).focus();
  }
  host.textContent = "";
  host.append(tabs, panel);
  go(0);
  return { go };
}
