// Builds the v4 showcase prototype (setkernel-live#52): writes the fonts, the publisher
// (src/evidence.js) and the redacted evidence into index.html, so the page opens from disk with no
// server. Run from the repo root:
//   node docs/design/v4/showcase/build.mjs           # rebuild index.html from evidence.json
//   node docs/design/v4/showcase/build.mjs --fetch   # first refresh evidence.json from GitHub (uses `gh api`)
// --fetch reads only setkernel's public repos, and every pull request goes through the real
// publishEvidence, so evidence.json holds only what the page may show. The numbers come from
// teamNumbers over the same public repos.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fetchEvidence, isPublicRepo, publishEvidence, teamNumbers } from "../../../../src/evidence.js";
import { AGENTS, guard } from "../../../../src/logic.js";

const here = new URL(".", import.meta.url);
const root = new URL("../../../../", import.meta.url);
const store = new URL("evidence.json", here);

// The walkthrough's example: the Day build, from its issue to the deploy that checked it.
const WALKTHROUGH = { repo: "setkernel-live", number: 49 };
// Demo mode's list: the walkthrough's example, its prototype, and the newest merged pull requests
// in the other public repos, up to this many.
const DEMO_SIZE = 6;
const DAYS = 30;

const get = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 << 20 }));
const pages = (path, key) => {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const body = get(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const list = key ? body[key] : body;
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
};

async function refresh() {
  const now = Date.now();
  const since = new Date(now - DAYS * 86_400_000).toISOString();
  const repos = pages("orgs/setkernel/repos?type=public").filter(isPublicRepo).filter((r) => !r.archived && !r.fork);
  const pulls = [];
  const runs = [];
  for (const r of repos) {
    const closed = pages(`repos/setkernel/${r.name}/pulls?state=closed&sort=updated&direction=desc`).filter((p) => p.merged_at);
    pulls.push(...closed.map((p) => ({ ...p, repo: r.name })));
    const branch = encodeURIComponent(r.default_branch);
    runs.push(...pages(`repos/setkernel/${r.name}/actions/runs?branch=${branch}&created=>=${since.slice(0, 10)}`, "workflow_runs"));
  }
  const numbers = teamNumbers({ pulls, runs }, now, DAYS);
  numbers.repos = repos.length;
  const picks = [WALKTHROUGH, { repo: "setkernel-live", number: 47 }];
  const newest = pulls.filter((p) => p.repo !== "setkernel-live").sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at));
  const seen = new Set();
  for (const p of newest) {
    if (picks.length >= DEMO_SIZE) break;
    if (seen.has(p.repo)) continue; // one per repo, so the list shows the spread
    seen.add(p.repo);
    picks.push({ repo: p.repo, number: p.number });
  }
  const demo = [];
  for (const p of picks) {
    const r = publishEvidence(await fetchEvidence(async (path) => get(path), p.repo, p.number), now);
    if (r.ok) demo.push(r.evidence);
    else console.warn(`${p.repo}: withheld (${r.reason})`);
  }
  const out = { asOf: new Date(now).toISOString(), numbers, demo };
  if (!guard(out)) throw new Error("evidence.json would carry a field that never reaches the page");
  writeFileSync(store, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`evidence.json: ${demo.length} pull requests, ${numbers.merged} merged in ${DAYS} days across ${repos.length} public repos`);
}

if (process.argv.includes("--fetch")) await refresh();
const evidence = JSON.parse(readFileSync(store, "utf8"));

// The publisher, inlined for demo mode's "any public pull request": a page opened from disk can't
// import modules. logic.js gives only its NEVER guard; evidence.js is verbatim but for import and export.
const strip = (src) => src.replace(/^import .*$/gm, "").replace(/^export \{[^}]*\}.*$/gm, "").replace(/^export /gm, "");
const logic = readFileSync(new URL("src/logic.js", root), "utf8");
const neverBlock = logic.slice(logic.indexOf("export const NEVER"), logic.indexOf("function cleanAgentInfo"));
if (!neverBlock.includes("export function guard")) throw new Error("src/logic.js no longer has NEVER ... guard where build.mjs looks");
const lib = [
  "const Publisher = (() => {",
  `const AGENTS = ${JSON.stringify(AGENTS)};`,
  "const { guard } = (() => {",
  "// ---- src/logic.js, NEVER to guard, verbatim but for export",
  strip(neverBlock),
  "return { guard }; })();",
  "// ---- src/evidence.js, verbatim but for import and export",
  strip(readFileSync(new URL("src/evidence.js", root), "utf8")),
  "return { fetchEvidence, parsePull, publishEvidence };",
  "})();",
].join("\n");

// The live team view is the Day prototype as it is (docs/design/v3/day), in a frame. Its options
// normally come from its own address; in a srcdoc frame they come from the placeholder the page fills.
let day = readFileSync(new URL("../../v3/day/index.html", here), "utf8");
const n = day.split("location.hash.slice(1)").length - 1;
if (n !== 2) throw new Error(`the Day prototype reads location.hash ${n} times; build.mjs expects 2`);
day = day.replaceAll("location.hash.slice(1)", "DAY_OPTIONS");
day = day.replace("<script>", "<script>\nconst DAY_OPTIONS = \"__DAY_OPTIONS__\";");

const font = (file) => readFileSync(new URL(`public/fonts/${file}`, root)).toString("base64");
const faces = [["Manrope", 400, "manrope-latin-400-normal"], ["Manrope", 600, "manrope-latin-600-normal"], ["IBM Plex Mono", 400, "ibm-plex-mono-latin-400-normal"]]
  .map(([family, weight, file]) => `@font-face{font-family:"${family}";font-weight:${weight};font-style:normal;font-display:block;src:url(data:font/woff2;base64,${font(`${file}.woff2`)}) format("woff2")}`)
  .join("\n");

const page = new URL("index.html", here);
let html = readFileSync(page, "utf8");
const put = (name, body) => {
  const re = new RegExp(`(/\\* ${name} \\*/)[\\s\\S]*?(/\\* end ${name} \\*/)`);
  if (!re.test(html)) throw new Error(`index.html has no ${name} block`);
  html = html.replace(re, (_, a, b) => `${a}\n${body}\n${b}`);
};
const script = (v) => JSON.stringify(v).replaceAll("</", "<\\/").replaceAll("<!--", "<\\!--");
put("fonts", faces);
put("lib", lib);
put("evidence", `const EVIDENCE = ${script(evidence)};\nconst WALK = ${script(WALKTHROUGH)};`);
put("day", `const DAY_HTML = ${script(day)};`);
writeFileSync(page, html);
console.log(`index.html ${Math.round(html.length / 1024)} KiB`);
