// The v3 Roster prototype (docs/design/v3/roster/index.html, setkernel-live#44): it opens from disk
// with no network, and its fixtures carry nothing the live page may not show. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AGENTS, hasNever } from "../src/logic.js";

const html = readFileSync(new URL("../docs/design/v3/roster/index.html", import.meta.url), "utf8");
const DATA = JSON.parse(html.match(/const DATA = (\{.*?\});\n/s)[1]);
const strings = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);

test("roster prototype: one file, no network", () => {
  // the only URL is the SVG namespace, which is a name and never fetched
  const urls = html.match(/\b(?:https?:|wss?:)\/\/[^\s"'`)]+/g) ?? [];
  assert.deepEqual([...new Set(urls)], ["http://www.w3.org/2000/svg"]);
  for (const bad of ["<link", "<script src", "@import", "fetch(", "WebSocket", "XMLHttpRequest", "innerHTML", "localStorage"]) {
    assert.ok(!html.includes(bad), `index.html uses ${bad}`);
  }
  // the fonts are embedded
  assert.match(html, /@font-face\{font-family:"Manrope";[^}]*src:url\(data:font\/woff2;base64,/);
});

test("roster prototype: every mood for both days, and nothing private in the fixtures", () => {
  for (const day of ["busy", "quiet"]) {
    for (const mood of ["live", "quiet", "offline", "waiting"]) {
      const snaps = DATA[day][mood];
      assert.ok(snaps?.length >= 1, `${day} ${mood}`);
      for (const s of snaps) {
        assert.equal(s.mood, mood);
        assert.deepEqual(s.rows.map((r) => r.name), ["Vega", "Rigel", "Lyra", "Orion"]);
        assert.ok(s.log.every((e) => e.name === "" || AGENTS.includes(e.name)));
      }
    }
  }
  assert.ok(!hasNever(DATA), "a NEVER field in the fixtures");
  // a repo is named only when it is public (the demo's two); anything else is "a private project"
  const named = strings(DATA).flatMap((s) => [...s.matchAll(/\bin (?!a private project|a design discussion|the team chat)([\w-]+(?:\.[\w-]+)*)/g)].map((m) => m[1]));
  assert.deepEqual([...new Set(named)].filter((r) => !["setkernel-live", "example-site"].includes(r)), []);
  assert.ok(strings(DATA).some((s) => s === "a private project" || s.includes("in a private project")));
});
