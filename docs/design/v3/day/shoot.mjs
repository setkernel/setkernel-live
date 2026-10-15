// Takes the prototype's screenshots with Playwright's chromium, in Halifax time. Playwright isn't
// a dependency of this repo: install it anywhere outside it and point PLAYWRIGHT_DIR there.
//   npm i --prefix "$TMPDIR/pw" playwright && npx --prefix "$TMPDIR/pw" playwright install chromium
//   PLAYWRIGHT_DIR="$TMPDIR/pw" node docs/design/v3/day/shoot.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const dir = process.env.PLAYWRIGHT_DIR;
if (!dir) throw new Error("set PLAYWRIGHT_DIR to a folder with playwright installed");
const { chromium } = createRequire(`${dir}/`)("playwright");
const page = new URL("index.html", import.meta.url);
const out = (name) => fileURLToPath(new URL(name, import.meta.url));

const SHOTS = [
  ["day-live-1440x900.png", 1440, 900, "mood=live&data=busy"],
  ["day-quiet-1440x900.png", 1440, 900, "mood=quiet&data=quiet"],
  ["day-offline-1440x900.png", 1440, 900, "mood=offline&data=busy"],
  ["day-waiting-1440x900.png", 1440, 900, "mood=waiting&data=busy"],
  ["day-scrub-1440x900.png", 1440, 900, "mood=live&data=busy&scrub=106"],
  ["day-live-375x812.png", 375, 812, "mood=live&data=busy"],
  ["day-quiet-375x812.png", 375, 812, "mood=quiet&data=quiet"],
  ["day-live-375-full.png", 375, 812, "mood=live&data=busy", true],
  ["day-wall-live-2560x1440.png", 2560, 1440, "mood=live&data=busy&layout=wall"],
];
const only = process.argv.slice(2);
const browser = await chromium.launch();
for (const [name, width, height, hash, full] of SHOTS) {
  if (only.length && !only.some((o) => name.includes(o))) continue;
  const ctx = await browser.newContext({ viewport: { width, height }, timezoneId: "America/Halifax", locale: "en-CA", deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("request", (r) => { if (!r.url().startsWith("file:") && !r.url().startsWith("data:")) errors.push(`network: ${r.url()}`); });
  await p.goto(`${page.href}#${hash}&shot`);
  await p.waitForFunction(() => document.querySelector("#plot svg"));
  if (hash.includes("scrub")) await p.focus("#plot svg");
  await p.screenshot({ path: out(name), fullPage: !!full });
  if (errors.length) { console.error(name, errors); process.exitCode = 1; }
  console.log(name);
  await ctx.close();
}
await browser.close();
