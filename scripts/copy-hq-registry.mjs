// Copies who works here from the hq registry (setkernel/hq registry/people.csv) into src/hq-registry.json
// (setkernel-live#96, setkernel/hq#1089), so the usage ingest's seats (src/usage.js) are no hand-written list.
// Handles only: this repo is public, so no logins, ids, names or emails. The same people the wall gives a lane
// (hq observability/wall/server.py's lanes()): each employee who isn't removed, in the file's order.
//
//   node scripts/copy-hq-registry.mjs --hq <hq checkout>          write the file
//   node scripts/copy-hq-registry.mjs --check --hq <hq checkout>  exit 1 when the committed file differs
//
// Exit 0: written, or no difference. 1: the registry can't be read or the file differs. 2: bad usage.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "hq-registry.json");
const HANDLE = /^[a-z][a-z0-9-]{0,31}$/; // hq registry/naming.md's handle; a row with anything else is left out

// The registry has no quoted fields; a quote is refused rather than half-parsed.
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new Error("empty csv");
  if (text.includes('"')) throw new Error("quoted csv fields are not supported");
  const head = lines[0].split(",");
  for (const h of ["handle", "kind", "status"]) if (!head.includes(h)) throw new Error(`no ${h} column`);
  return lines.slice(1).map((l) => {
    const cells = l.split(",");
    if (cells.length !== head.length) throw new Error(`row has ${cells.length} fields, header has ${head.length}`);
    return Object.fromEntries(head.map((h, i) => [h, cells[i].trim()]));
  });
}

// people.csv's text -> the canonical text of src/hq-registry.json.
export function render(peopleCsv) {
  const employees = [];
  for (const r of parseCsv(peopleCsv)) {
    if (r.kind === "employee" && r.status !== "removed" && HANDLE.test(r.handle) && !employees.includes(r.handle)) employees.push(r.handle);
  }
  return JSON.stringify({ employees }, null, 2) + "\n";
}

function main(argv) {
  const i = argv.indexOf("--hq");
  const hq = i >= 0 ? argv[i + 1] : undefined;
  if (!hq) {
    console.error("usage: copy-hq-registry.mjs [--check] --hq <hq checkout>");
    return 2;
  }
  let text;
  try {
    text = render(readFileSync(join(hq, "registry", "people.csv"), "utf8"));
  } catch (e) {
    console.error(`copy-hq-registry: ${e.message}`);
    return 1;
  }
  if (argv.includes("--check")) {
    let have = null;
    try { have = readFileSync(OUT, "utf8"); } catch { /* missing counts as differing */ }
    if (have === text) return 0;
    console.error("copy-hq-registry: src/hq-registry.json differs from the hq registry");
    return 1;
  }
  writeFileSync(OUT, text);
  return 0;
}

// Not import.meta.main: that needs Node 24.2 (scripts/smoke.mjs says the same).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
