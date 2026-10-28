// The Now column, the scrub readout and the key for a not-reporting engineer (setkernel-live#54),
// over public/lib/day.js. Pure.
import * as DAY from "../../../../../public/lib/day.js";
import { ENGINEERS } from "../../../../../public/lib/state.js";
import { ciWhere, ciWord, clock, sentence } from "../../../../../public/lib/words.js";
import { age, isSilent, whenDay } from "./proto-words.js";
import { OPT } from "./config.js";

// The engineers not reporting: [{ name, lastRun }], lastRun null when the time isn't known.
export const downIn = (D) => (OPT === "today" || !D.s.lastIngest ? [] : ENGINEERS.filter((n) => isSilent(D.s.agents?.[n])).map((n) => ({ name: n, lastRun: D.s.agents[n].lastRun ?? null })));

// Now: "Not reporting", then when it last ran. Scrubbed (B, C): the ten minutes after the last
// run say "Not reporting" too (only for the outage going on now: the replay keeps no states).
export function moment(D, row, i, tz) {
  const lines = DAY.moment(D, row, i, tz);
  const down = row.kind === "eng" && downIn(D).find((d) => d.name === row.id);
  if (!down) return lines;
  const { lastRun } = down;
  if (i == null) {
    const when = lastRun ? whenDay(lastRun, D.nowS, tz) : "";
    const ago = lastRun ? age((D.lastS ?? D.nowS) - lastRun) : ""; // as of the last word, as the column's heading
    const detail = !lastRun ? "" : OPT === "a" ? `Last ran ${when}` : OPT === "b" ? `Last ran ${when} · ${ago} ago` : `Since ${when} · ${ago}`;
    const out = ["Not reporting", detail];
    out.idle = OPT === "a";
    out.state = "SILENT";
    out.down = true;
    return out;
  }
  if (OPT !== "a" && lastRun && DAY.binTime(D, i) >= lastRun) return ["Not reporting", lines[1]];
  return lines;
}

// day.js's readout, with this moment.
export function readout(D, i, tz) {
  if (i == null) return "Back to now.";
  const parts = [`${clock(DAY.binTime(D, i), tz)} to ${clock(DAY.binTime(D, i) + DAY.BIN, tz)}.`];
  if (!D.s.lastIngest) return `${parts[0]} Nothing has arrived yet.`;
  for (const n of ENGINEERS) {
    const [what, st] = moment(D, { id: n, kind: "eng" }, i, tz);
    if (what !== "No activity" || st) parts.push(`${n}: ${[st, what.charAt(0).toLowerCase() + what.slice(1)].filter(Boolean).join(", ")}.`);
  }
  for (const w of DAY.inBin(D, D.work, i).filter((w) => !ENGINEERS.includes(w.agent))) parts.push(sentence(w));
  for (const c of DAY.inBin(D, D.ci, i)) parts.push(`CI ${ciWord(c)} in ${ciWhere(c)}.`);
  if (parts.length === 1) parts.push("Nothing happened.");
  return parts.join(" ");
}

// The key: B and C hatch the lane, so the hatch gets an entry.
export function keyItems(D) {
  const out = DAY.keyItems(D);
  if (OPT !== "a" && downIn(D).length) out.push({ kind: `silent-${OPT}`, words: "Not reporting" });
  return out;
}
