// No private repo name reaches the page or the v4 showcase (setkernel-live#52), checked against
// GitHub, live. Two checks:
// 1. An allowlist: every repo the page or the showcase can name (the demo data, the showcase's
//    evidence, every github.com/setkernel/... link in their markup) must be one of setkernel's
//    public repos, as the API lists them today. It needs no token and catches a private name that
//    nobody wrote down, or a repo made private since.
// 2. With SETKERNEL_REPO_TOKEN (a token that can list the org's private repos), each private name is
//    also looked for, as a word, in the same data and in the markup's text.
// With LIVE_REPO_CHECK=1 (ci.yml sets it) a failed request fails the test; elsewhere, including the
// deploy's re-gate, which has no token, a failed request skips it. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { busyDay, quietDay } from "../public/lib/demo.js";

const ORG = "setkernel";
const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const SHOWCASE = "docs/design/v4/showcase/";
const evidence = JSON.parse(read(`${SHOWCASE}evidence.json`));
// The markup a visitor reads: the page and the showcase prototype, without scripts, styles and comments.
const MARKUP = ["public/index.html", `${SHOWCASE}index.html`];
const text = (html) => html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");

async function repos(type, token) {
  const names = [];
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`https://api.github.com/orgs/${ORG}/repos?type=${type}&per_page=100&page=${page}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "setkernel-live-test", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`GitHub answered ${r.status} for the ${type} repo list`);
    const list = await r.json();
    for (const repo of list) if (type !== "public" || repo.private === false) names.push(repo.name);
    if (list.length < 100) break;
  }
  return names;
}

// Every `repo` value at any depth.
function repoFields(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => repoFields(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "repo" && typeof x === "string") out.add(x); else repoFields(x, out); }
  return out;
}
// ?demo's busy and quiet days (the busy day is createDemo's run, slowed)
const demoData = () => {
  const now = Date.UTC(2026, 9, 14, 19, 40) / 1000;
  return [busyDay(now).batches, quietDay(now).batches];
};
const links = (s) => [...s.matchAll(/github\.com\/setkernel\/([A-Za-z0-9._-]+)/g)].map((m) => m[1]);

let live = null;
async function publicRepos(t) {
  try {
    live ??= await repos("public", process.env.GITHUB_TOKEN);
    return live;
  } catch (err) {
    if (process.env.LIVE_REPO_CHECK === "1") throw err;
    t.skip(`no GitHub API here (${err.message}); ci.yml runs this`);
    return null;
  }
}

test("every repo the page or the showcase names is public, by GitHub's own list", async (t) => {
  const pub = await publicRepos(t);
  if (!pub) return;
  assert.ok(pub.includes("setkernel-live"), "the list is the org's public repos");
  const named = new Map();
  const add = (name, where) => named.set(name, [...(named.get(name) || []), where]);
  for (const r of repoFields(demoData())) add(r, "public/lib/demo.js");
  for (const r of repoFields(evidence)) add(r, `${SHOWCASE}evidence.json`);
  for (const r of links(JSON.stringify(evidence))) add(r, `${SHOWCASE}evidence.json`);
  for (const f of MARKUP) for (const r of links(text(read(f)))) add(r, f); // the showcase's data is evidence.json, above
  const served = [...readdirSync(new URL("public/", root)), ...readdirSync(new URL("public/lib/", root)).map((n) => `lib/${n}`)];
  for (const f of served.filter((n) => /\.(html|js|css|txt)$/.test(n)).map((n) => `public/${n}`)) for (const r of links(read(f))) add(r, f);
  assert.ok(named.has("setkernel-live"), "the sources were read");
  const notPublic = [...named].filter(([name]) => !pub.includes(name.replace(/\.git$/, "")));
  assert.deepEqual(notPublic, [], "these repo names are not on setkernel's public list");
});

test("no private repo name, as a word, in what the page or the showcase shows", async (t) => {
  const token = process.env.SETKERNEL_REPO_TOKEN;
  if (!token) { t.skip("SETKERNEL_REPO_TOKEN is not set, so only the public allowlist above runs"); return; }
  const priv = await repos("private", token);
  const shown = [JSON.stringify(evidence), JSON.stringify(demoData()), ...MARKUP.map((f) => text(read(f)))].join("\n");
  const found = priv.filter((name) => new RegExp(`(^|[^A-Za-z0-9._-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`, "i").test(shown));
  assert.equal(found.length, 0, `${found.length} private repo name(s) appear in the page or the showcase`); // never print them
});
