// Takes the not-reporting prototype's screenshots with Playwright's chromium, in Halifax time, at
// the Day prototype's clock (Wednesday 14 October 2026, 16:40 ADT). Playwright isn't a dependency
// of this repo: install it anywhere outside it and point PLAYWRIGHT_DIR there.
//   npm i --prefix "$TMPDIR/pw" playwright && npx --prefix "$TMPDIR/pw" playwright install chromium
//   PLAYWRIGHT_DIR="$TMPDIR/pw" node docs/design/v3/not-reporting/shoot.mjs [name filter]
// It fails on a page error, a request that isn't to file: or data:, horizontal scroll, or a wall
// canvas that doesn't fit the window.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const dir = process.env.PLAYWRIGHT_DIR;
if (!dir) throw new Error("set PLAYWRIGHT_DIR to a folder with playwright installed");
const { chromium } = createRequire(`${dir}/`)("playwright");
const page = new URL("index.html", import.meta.url);
const out = (name) => fileURLToPath(new URL(name, import.meta.url));
const NOW = Date.UTC(2026, 9, 14, 19, 40, 0);

// [file, width, height, query, extra]: per option, the desktop and the phone in light and dark,
// the phone's whole chart, the wall, and the 12-hour case; main today as the control.
const SHOTS = [
  ["today-1440x900.png", 1440, 900, "opt=today&down=one"],
  ["today-375x812.png", 375, 812, "opt=today&down=one"],
];
for (const o of ["a", "b", "c"]) {
  SHOTS.push(
    [`${o}-1440x900.png`, 1440, 900, `opt=${o}&down=one`],
    [`${o}-1440x900-dark.png`, 1440, 900, `opt=${o}&down=one&theme=dark`],
    [`${o}-375x812.png`, 375, 812, `opt=${o}&down=one`],
    [`${o}-375x812-dark.png`, 375, 812, `opt=${o}&down=one&theme=dark`],
    [`${o}-375-full.png`, 375, 812, `opt=${o}&down=one`, "full"],
    [`${o}-wall-1920x1080.png`, 1920, 1080, `opt=${o}&down=one&wall`],
    [`${o}-12h-1440x900.png`, 1440, 900, `opt=${o}&down=two`],
  );
}
// B scrubbed with the keyboard to 15:20, inside the outage (from the 16:30 column, 7 steps back)
SHOTS.push(["b-scrub-1440x900.png", 1440, 900, "opt=b&down=one", "scrub"]);

const only = process.argv.slice(2);
const browser = await chromium.launch();
for (const [name, width, height, query, extra] of SHOTS) {
  if (only.length && !only.some((o) => name.includes(o))) continue;
  const ctx = await browser.newContext({ viewport: { width, height }, timezoneId: "America/Halifax", locale: "en-CA", deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.clock.setFixedTime(NOW);
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  p.on("request", (r) => { if (!r.url().startsWith("file:") && !r.url().startsWith("data:")) errors.push(`network: ${r.url()}`); });
  await p.goto(`${page.href}?demo&${query}&shot`);
  await p.waitForFunction(() => document.querySelector("#plot svg") && document.fonts.status === "loaded");
  await p.waitForTimeout(300);
  if (extra === "scrub") {
    await p.focus("#plot svg");
    for (let i = 0; i < 7; i++) await p.keyboard.press("ArrowLeft");
  }
  const fit = await p.evaluate(() => {
    const d = document.getElementById("day"), r = d.getBoundingClientRect();
    return { sh: d.scrollHeight, sw: d.scrollWidth, r: [r.left, r.top, r.right, r.bottom], w: innerWidth, h: innerHeight, page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight] };
  });
  if (fit.page[0] > fit.w) errors.push(`horizontal scroll: ${fit.page[0]} > ${fit.w}`);
  if (query.includes("wall")) {
    const ok = fit.sh <= 810 && fit.sw <= 1440 && fit.r[0] >= -0.5 && fit.r[1] >= -0.5 && fit.r[2] <= fit.w + 0.5 && fit.r[3] <= fit.h + 0.5 && fit.page[1] <= fit.h;
    if (!ok) errors.push(`wall does not fit: ${JSON.stringify(fit)}`);
  }
  await p.screenshot({ path: out(name), fullPage: extra === "full" });
  if (errors.length) { console.error(name, errors); process.exitCode = 1; }
  console.log(name);
  await ctx.close();
}
await browser.close();
