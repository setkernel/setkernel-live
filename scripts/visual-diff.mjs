// The visual-diff check (setkernel-live#74). A pull request that touches the page gets it drawn
// twice on the same runner: as its base (the merge commit's first parent) and as its head (the
// merge commit), at 1440 x 900 and 375 x 812, on ?demo in Halifax time at a fixed clock, as
// docs/design/v3/day/built/shoot.mjs does. Each side's public/ is served with its own
// public/_headers. A pull request that touches no UI path draws nothing and passes.
//
//   git diff --no-renames --name-only HEAD^1 HEAD | node scripts/visual-diff.mjs plan
//       prints ui=true or ui=false
//   PLAYWRIGHT_DIR=<dir> node scripts/visual-diff.mjs render <base checkout> <head checkout> <out>
//       writes <out>/base/*.png, <out>/head/*.png and <out>/visual-diff.json, prints a summary
//
// Exit 1 from render: the head page threw, broke its CSP, asked for anything off its own origin
// or never drew. A visual change is not a failure: the shots are for the reviewers. A failure on
// the base side is only reported, since the base is already merged.
// Playwright isn't a dependency of this repo; .github/workflows/visual-diff.yml installs a pinned
// one outside it, as shoot.mjs's header says.

import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// What the page is built from: public/, except the private usage page, which this check never
// draws; and this check itself, so a change to it shows that it still draws.
const UI = [/^public\//, /^scripts\/visual-diff\.mjs$/, /^\.github\/workflows\/visual-diff\.yml$/];
const NOT_UI = [/^public\/usage\//];
export const isUiPath = (p) => UI.some((r) => r.test(p)) && !NOT_UI.some((r) => r.test(p));
export const uiChanged = (paths) => paths.some(isUiPath);

// [name, width, height, query]
export const SHOTS = [
  ["demo-1440x900", 1440, 900, "?demo"],
  ["demo-375x812", 375, 812, "?demo"],
];
export const NOW = Date.UTC(2026, 9, 14, 19, 40, 0); // 16:40 ADT, shoot.mjs's clock

const status = (s) =>
  s.head.errors.length ? `head failed: ${s.head.errors.join("; ")}`
  : s.base.errors.length ? `base failed: ${s.base.errors.join("; ")}`
  : s.changed ? "changed" : "same";

// The run's summary: one row per shot, base against head.
export function summary(shots) {
  const rows = shots.map((s) => `| ${s.name} | ${s.width} x ${s.height} | \`${s.query}\` | ${status(s)} |`);
  const changed = shots.filter((s) => s.changed).length;
  const failed = shots.filter((s) => s.head.errors.length).length;
  return [
    "### Visual diff",
    failed ? `The head failed to draw cleanly in ${failed} of ${shots.length} shots, so this check fails.`
      : changed ? `${changed} of ${shots.length} shots changed; both sides are in the run's \`visual-diff\` artifact.`
      : `No shot changed (${shots.length} drawn).`,
    "",
    "| Shot | Size | Page | Base to head |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

// A static server over one checkout's public/, with the headers its public/_headers sets for /*.
const TYPES = { html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml", woff2: "font/woff2", png: "image/png" };
async function serve(pub) {
  const headers = Object.fromEntries((await readFile(join(pub, "_headers"), "utf8")).split("\n")
    .filter((l) => /^\s+\S+:/.test(l)).map((l) => [l.trim().slice(0, l.trim().indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname.replace(/^\/$/, "/index.html");
    try {
      const body = await readFile(join(pub, path));
      res.writeHead(200, { ...headers, "Content-Type": TYPES[path.split(".").pop()] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  }).listen(0, "127.0.0.1");
  await new Promise((ok) => server.once("listening", ok));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

async function shoot(browser, origin, [, width, height, query], file) {
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width, height }, timezoneId: "America/Halifax", locale: "en-CA" });
  try {
    const p = await ctx.newPage();
    await p.clock.setFixedTime(NOW);
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("console", (m) => { if (m.type() === "error" || /Content Security Policy/.test(m.text())) errors.push(m.text()); });
    p.on("request", (r) => { if (!r.url().startsWith(origin)) errors.push(`network: ${r.url()}`); });
    await p.goto(`${origin}/${query}`);
    await p.waitForFunction(() => document.querySelector("#plot svg") && document.fonts.status === "loaded", null, { timeout: 15_000 });
    await p.waitForTimeout(300);
    await p.screenshot({ path: file });
    return { errors, png: await readFile(file) };
  } catch (e) {
    return { errors: [...errors, e.message.split("\n")[0]], png: null };
  } finally {
    await ctx.close();
  }
}

export async function render(baseDir, headDir, outDir) {
  const dir = process.env.PLAYWRIGHT_DIR;
  if (!dir) throw new Error("set PLAYWRIGHT_DIR to a folder with playwright installed");
  const { chromium } = createRequire(`${resolve(dir)}/`)("playwright");
  const sides = { base: baseDir, head: headDir };
  const shots = SHOTS.map(([name, width, height, query]) => ({ name, width, height, query }));
  const browser = await chromium.launch();
  try {
    for (const [side, root] of Object.entries(sides)) {
      await mkdir(join(outDir, side), { recursive: true });
      const server = await serve(join(root, "public"));
      try {
        for (const [i, shot] of SHOTS.entries())
          shots[i][side] = await shoot(browser, server.origin, shot, join(outDir, side, `${shot[0]}.png`));
      } finally {
        server.close();
      }
    }
  } finally {
    await browser.close();
  }
  for (const s of shots) s.changed = !!(s.base.png && s.head.png) && !s.base.png.equals(s.head.png);
  return shots.map(({ base, head, ...s }) => ({ ...s, base: { errors: base.errors }, head: { errors: head.errors } }));
}

// Not import.meta.main: that needs Node 24.2 (scripts/smoke.mjs says the same).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "plan" && !args.length) {
    console.log(`ui=${uiChanged(readFileSync(0, "utf8").split("\n").map((l) => l.trim()).filter(Boolean))}`);
  } else if (cmd === "render" && args.length === 3) {
    const shots = await render(...args);
    const pr = { number: Number(process.env.PR_NUMBER) || null, head: process.env.HEAD_SHA || null };
    await writeFile(join(args[2], "visual-diff.json"), `${JSON.stringify({ pr, shots }, null, 2)}\n`);
    console.log(summary(shots));
    if (shots.some((s) => s.head.errors.length)) process.exitCode = 1;
  } else {
    console.error("usage: visual-diff.mjs plan < paths | visual-diff.mjs render <base> <head> <out>");
    process.exitCode = 2;
  }
}
