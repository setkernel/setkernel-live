// Builds the not-reporting prototype (setkernel-live#54) into one index.html that opens from disk:
// the built page (public/) with its own app.js, bundled by esbuild (wrangler's, already in
// node_modules), where four of public/lib's modules get this prototype's overrides from src/. The
// fonts are embedded. Nothing under public/ changes. Run from the repo root:
//   node docs/design/v3/not-reporting/build.mjs
// First it checks the scenarios' data: every event must pass the real cleanEvent unchanged, every
// state but the new one the real cleanBatch, and the new one the proposed check (src/scenario.js).
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deepStrictEqual } from "node:assert";
import { build } from "esbuild";
import { cleanBatch, cleanEvent } from "../../../../src/logic.js";
import { view } from "../../../../public/lib/state.js";
import { busyDay, runDay } from "../../../../public/lib/demo.js";
import { SCENARIOS, SILENT, cleanSilent, downBatch, downs } from "./src/scenario.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const pub = (p) => fileURLToPath(new URL(`../../../../public/${p}`, import.meta.url));
const NOW = Date.UTC(2026, 9, 14, 19, 40, 0) / 1000; // the Day prototype's clock: 16:40 ADT

// ---- the data
for (const scenario of Object.keys(SCENARIOS)) {
  const list = downs(scenario, NOW);
  const batches = busyDay(NOW).batches.map((b) => downBatch(b, list));
  for (const b of batches) {
    for (const e of b.events) deepStrictEqual(cleanEvent(e), e, `not clean: ${JSON.stringify(e)}`);
    const silent = Object.entries(b.agents).filter(([, v]) => v.state === SILENT);
    for (const [, v] of silent) deepStrictEqual(cleanSilent(v, b.at), v, `SILENT not clean: ${JSON.stringify(v)}`);
    const rest = Object.fromEntries(Object.entries(b.agents).filter(([, v]) => v.state !== SILENT));
    deepStrictEqual(cleanBatch({ events: [], agents: rest }).agents, rest, "agent states must pass the allowlist unchanged");
  }
  // state.js carries the new state, and its time, through to the page as it is
  const { state, replay } = runDay(batches);
  const agents = view(state, replay, NOW * 1000).agents;
  for (const { name, from } of list) deepStrictEqual(agents[name], { state: SILENT, lastRun: from }, `${scenario}: ${name}`);
  console.log(`${scenario}: ${batches.length} batches clean; ${list.map((d) => `${d.name} SILENT since ${new Date(d.from * 1000).toISOString().slice(11, 16)} UTC`).join(", ") || "nobody down"}`);
}

// ---- the page: public/app.js, with src/proto-<name>.js over public/lib/<name>.js
const OVERRIDE = ["words", "day", "chart", "demo"];
const exportsOf = async (name) => Object.keys(await import(`./src/proto-${name}.js`));
const names = Object.fromEntries(await Promise.all(OVERRIDE.map(async (n) => [n, await exportsOf(n)])));
const libDir = dirname(pub("lib/state.js"));
const plugin = {
  name: "proto",
  setup(b) {
    // the page's own imports: "/lib/x.js" (app.js) and "./x.js" (inside public/lib)
    b.onResolve({ filter: /^(\/lib\/|\.\/)[\w-]+\.js$/ }, (a) => {
      if (!a.importer.startsWith(dirname(pub("app.js")))) return undefined;
      const file = a.path.startsWith("/lib/") ? pub(a.path.slice(1)) : fileURLToPath(new URL(a.path, `file://${a.importer}`));
      const name = basename(file, ".js");
      if (dirname(file) === libDir && OVERRIDE.includes(name)) return { path: name, namespace: "proto" };
      return { path: file };
    });
    // public/lib/<name>.js as it is, but for the names src/proto-<name>.js gives
    b.onLoad({ filter: /.*/, namespace: "proto" }, (a) => ({
      contents: `export * from ${JSON.stringify(pub(`lib/${a.path}.js`))};\nexport { ${names[a.path].join(", ")} } from ${JSON.stringify(here(`src/proto-${a.path}.js`))};\n`,
      resolveDir: here("src"),
      loader: "js",
    }));
  },
};
const out = await build({ entryPoints: [pub("app.js")], bundle: true, format: "iife", target: "es2022", write: false, plugins: [plugin], legalComments: "none", charset: "utf8" });
const js = out.outputFiles[0].text;

const font = (file) => `url(data:font/woff2;base64,${readFileSync(pub(`fonts/${file}`)).toString("base64")})`;
const css = readFileSync(pub("style.css"), "utf8").replace(/url\("\/fonts\/([\w.-]+)"\)/g, (_, f) => font(f)) + readFileSync(here("src/proto.css"), "utf8");
const inline = (s) => s.replace(/<\/(script|style)/gi, "<\\/$1");

// The prototype's symbols: the not-reporting state's shape (a dotted ring), C's red hatch, and the
// key's swatches for B and C.
const defs = [
  `<symbol id="s-SILENT" viewBox="-6 -6 12 12"><circle r="4.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="1.65 1.65"/></symbol>`,
  `<pattern id="hatch-sig" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="hatch-ground" width="6" height="6"/><path class="hatch-sig-line" d="M0 0V6" stroke-width="1.2"/></pattern>`,
  `<symbol id="m-silent-b" viewBox="-6 -6 12 12"><rect x="-5.5" y="-4.5" width="11" height="9" class="f-hatch s-hatch-edge"/></symbol>`,
  `<symbol id="m-silent-c" viewBox="-6 -6 12 12"><rect x="-5.5" y="-4.5" width="11" height="9" class="f-hatch-sig s-hatch-edge"/></symbol>`,
].join("\n      ");

let html = readFileSync(pub("index.html"), "utf8");
const swap = (from, to) => {
  if (!html.includes(from)) throw new Error(`public/index.html has no ${from}`);
  html = html.replace(from, () => to);
};
html = html.replace(/\n\s*<link rel="(preload|icon)"[^>]*>/g, "");
swap(`<link rel="stylesheet" href="/style.css">`, `<style>\n${inline(css)}</style>`);
swap(`<script src="/early.js"></script>`, `<script>\n${inline(readFileSync(here("src/head.js"), "utf8"))}</script>`);
swap(`<title>`, `<title>Prototype (setkernel-live#54) · `);
swap(`</defs>`, `  ${defs}\n    </defs>`);
swap(`<script type="module" src="/app.js"></script>`, `<script>\n${inline(js)}</script>\n  <script>\n${inline(readFileSync(here("src/bar.js"), "utf8"))}</script>`);
if (/(src|href)="\//.test(html.replace(/href="\/"/g, ""))) throw new Error("index.html still loads something from the server");
writeFileSync(here("index.html"), `<!-- Built by build.mjs from public/ and src/ (setkernel-live#54): a prototype, not the page. -->\n${html}`);
console.log(`index.html ${Math.round(html.length / 1024)} KiB`);
