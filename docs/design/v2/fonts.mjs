// Writes the page's self-hosted fonts (public/fonts/, Google Fonts under the OFL, licences beside
// them) into reference.html as data URLs, so the mockup opens from disk with no server and loads
// nothing from another host. The faces are the ones public/style.css declares. Run from the repo
// root after the fonts change:
//   node docs/design/v2/fonts.mjs
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../../../", import.meta.url);
const css = readFileSync(new URL("public/style.css", root), "utf8");
const faces = [...css.matchAll(/@font-face\s*{[^}]*}/g)].map(([face]) => {
  const url = face.match(/url\("(\/fonts\/[^"]+\.woff2)"\)/)[1];
  const data = readFileSync(new URL(`public${url}`, root)).toString("base64");
  return face.replace(/\s+/g, " ").replace("@font-face {", "@font-face{").replace(/: /g, ":").replace(/; /g, ";").replace("{ ", "{").replace(" }", "}")
    .replace(`url("${url}")`, `url(data:font/woff2;base64,${data})`);
});

const page = new URL("reference.html", import.meta.url);
const html = readFileSync(page, "utf8");
const re = /(\/\* fonts \*\/)[\s\S]*?(\/\* end fonts \*\/)/;
if (!re.test(html)) throw new Error("reference.html has no fonts block");
writeFileSync(page, html.replace(re, (_, a, b) => `${a}\n${faces.join("\n")}\n${b}`));
console.log(`${faces.length} faces; reference.html ${Math.round(readFileSync(page).length / 1024)} KiB`);
