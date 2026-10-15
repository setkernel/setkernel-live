// Screenshots for setkernel-live#44, with Playwright's Chromium. Playwright isn't a dependency of
// this repo; point PLAYWRIGHT at an installed copy (for example the one `npx playwright` fetched):
//   PLAYWRIGHT=$(dirname $(find ~/.npm/_npx -path '*node_modules/playwright/package.json' | head -1)) \
//     node docs/design/v3/roster/shoot.mjs [roster|v2]
// roster: index.html from disk, every size the issue asks for.
// v2:     today's page on ?demo, served from public/ by a throwaway local server, at the same sizes.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../../..");
const { chromium } = await import(process.env.PLAYWRIGHT ? pathToFileURL(join(process.env.PLAYWRIGHT, "index.mjs")).href : "playwright");
const which = process.argv[2] ?? "roster";

const ROSTER = [
  ["1440x900-live", 1440, 900, "mood=live&data=busy&layout=page"],
  ["1440x900-quiet", 1440, 900, "mood=quiet&data=busy&layout=page"],
  ["1440x900-offline", 1440, 900, "mood=offline&data=busy&layout=page"],
  ["1440x900-waiting", 1440, 900, "mood=waiting&data=busy&layout=page"],
  ["1440x900-quiet-day", 1440, 900, "mood=quiet&data=quiet&layout=page"],
  ["375x812-live", 375, 812, "mood=live&data=busy&layout=page"],
  ["375x812-quiet", 375, 812, "mood=quiet&data=quiet&layout=page"],
  ["2560x1440-wall-live", 2560, 1440, "mood=live&data=busy&layout=wall"],
  ["2560x1440-wall-quiet-day", 2560, 1440, "mood=quiet&data=quiet&layout=wall"],
];
const V2 = [
  ["1440x900-live", 1440, 900, "?demo"],
  ["375x812-live", 375, 812, "?demo"],
  ["2560x1440-wall-live", 2560, 1440, "?demo&wall"],
];

const browser = await chromium.launch();
try {
  if (which === "roster") {
    const url = pathToFileURL(join(HERE, "index.html")).href;
    for (const [name, width, height, hash] of ROSTER) {
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
      await page.goto(`${url}#${hash}&still&clean`);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(HERE, `${name}.png`) });
      await page.close();
      console.log(name);
    }
  } else {
    // a static server for public/, so the page's absolute module paths (/lib/…) resolve
    const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
    const pub = join(ROOT, "public");
    const server = createServer(async (req, res) => {
      const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
      try {
        const body = await readFile(join(pub, path.endsWith("/") ? `${path}index.html` : path));
        res.writeHead(200, { "content-type": TYPES[extname(path) || ".html"] ?? "application/octet-stream" }).end(body);
      } catch {
        res.writeHead(404).end();
      }
    }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}/`;
    const out = join(HERE, "../v2-control");
    for (const [name, width, height, query] of V2) {
      // Night, the theme v2 opens in by default on a dark-mode system and always on the wall
      const page = await browser.newPage({ viewport: { width, height }, colorScheme: "dark" });
      await page.goto(`${base}${query}`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(6000); // let the demo run a few batches
      await page.screenshot({ path: join(out, `${name}.png`) });
      await page.close();
      console.log(`v2 ${name}`);
    }
    server.close();
  }
} finally {
  await browser.close();
}
