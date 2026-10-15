// Takes the v4 prototype's screenshots with Playwright's chromium, in Halifax time. Playwright isn't
// a dependency of this repo: install it anywhere outside it and point PLAYWRIGHT_DIR there.
//   npm i --prefix "$TMPDIR/pw" playwright && npx --prefix "$TMPDIR/pw" playwright install chromium
//   PLAYWRIGHT_DIR="$TMPDIR/pw" node docs/design/v4/showcase/shoot.mjs [name filter...]
// It fails if the page throws, makes any request that isn't to file: or data:, scrolls sideways,
// or sets text under 12 px.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const dir = process.env.PLAYWRIGHT_DIR;
if (!dir) throw new Error("set PLAYWRIGHT_DIR to a folder with playwright installed");
const { chromium } = createRequire(`${dir}/`)("playwright");
const page = new URL("index.html", import.meta.url);
// SHOTS_DIR puts them elsewhere, for a review round that shouldn't touch the committed ones
const out = (name) => (process.env.SHOTS_DIR ? `${process.env.SHOTS_DIR}/${name}` : fileURLToPath(new URL(name, import.meta.url)));

// [file, width, height, hash, what]: what is "full" (the whole page), an element id, or the viewport
const SHOTS = [
  ["page-1440x900.png", 1440, 900, ""],
  ["page-1440-full.png", 1440, 900, "", "full"],
  ["page-375x812.png", 375, 812, ""],
  ["page-375-full.png", 375, 812, "", "full"],
  ["page-2560x1440.png", 2560, 1440, ""],
  ["page-2560-full.png", 2560, 1440, "", "full"],
  ["live-1440.png", 1440, 900, "", "live"],
  ["live-1024.png", 1024, 768, "", "live"],
  ["live-375.png", 375, 812, "", "live"],
  ...[1, 2, 3, 4, 5, 6, 7].map((s) => [`step-${s}-1440.png`, 1440, 900, `step=${s}`, "how"]),
  ["step-5-375.png", 375, 812, "step=5", "how"],
  ["step-4-2560.png", 2560, 1440, "step=4", "how"],
  ["numbers-1440.png", 1440, 900, "", "numbers"],
  ["brief-1440.png", 1440, 900, "", "brief"],
  ["demo-1440x900.png", 1440, 900, "view=demo&step=1"],
  ["demo-step5-1440x900.png", 1440, 900, "view=demo&step=5"],
  ["demo-other-repo-1440x900.png", 1440, 900, "view=demo&step=4&pick=2"],
  ["demo-2560x1440.png", 2560, 1440, "view=demo&step=4"],
  ["demo-375x812.png", 375, 812, "view=demo&step=5"],
];
const only = process.argv.slice(2);
const browser = await chromium.launch();
for (const [name, width, height, hash, what] of SHOTS) {
  if (only.length && !only.some((o) => name.includes(o))) continue;
  const ctx = await browser.newContext({ viewport: { width, height }, timezoneId: "America/Halifax", locale: "en-CA", deviceScaleFactor: 1, reducedMotion: "reduce" });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("request", (r) => { if (!r.url().startsWith("file:") && !r.url().startsWith("data:") && r.url() !== "about:srcdoc") errors.push(`network: ${r.url()}`); });
  await p.goto(`${page.href}#${hash}${hash ? "&" : ""}shot`);
  await p.waitForFunction(() => document.getElementById("dayframe").contentDocument?.querySelector("#plot svg"));
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(300);
  const check = await p.evaluate(() => {
    const small = [];
    for (const e of document.querySelectorAll("body *")) {
      if (!e.childNodes.length || ![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      if (e.closest("[hidden], .proto, .sr") || !e.getClientRects().length) continue;
      const px = parseFloat(getComputedStyle(e).fontSize);
      if (px < 12) small.push(`${e.tagName}.${e.className}: ${px}px`);
    }
    return { wide: document.documentElement.scrollWidth > innerWidth, small: small.slice(0, 5) };
  });
  if (check.wide) errors.push("the page scrolls sideways");
  if (check.small.length) errors.push(`text under 12 px: ${check.small.join("; ")}`);
  if (what && what !== "full") await p.locator(`#${what}`).screenshot({ path: out(name) });
  else await p.screenshot({ path: out(name), fullPage: what === "full" });
  if (errors.length) { console.error(name, errors); process.exitCode = 1; }
  console.log(name);
  await ctx.close();
}
await browser.close();
