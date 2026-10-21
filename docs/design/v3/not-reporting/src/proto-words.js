// The words for a not-reporting engineer (setkernel-live#54), over public/lib/words.js: the
// headline in each option, and the state's name. Pure.
import * as W from "../../../../../public/lib/words.js";
import { homeMidnight } from "../../../../../public/lib/state.js";
import { SILENT } from "./scenario.js";
import { OPT } from "./config.js";

export const isSilent = (info) => info?.state === SILENT;

// "14:05", "yesterday 21:40" or "Fri 16 Oct 04:10", by the Halifax day, as day.js says a stage's time.
export function whenDay(ts, nowS, tz) {
  const mid = homeMidnight(nowS);
  if (ts >= mid) return W.clock(ts, tz);
  if (ts >= homeMidnight(mid - 1)) return `yesterday ${W.clock(ts, tz)}`;
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: tz }).format(new Date(ts * 1000));
  return `${day} ${W.clock(ts, tz)}`;
}

// 155 min -> "2 h 35 min"; whole minutes, as the time it comes from.
export function age(s) {
  const m = Math.max(0, Math.floor(s / 60)), h = Math.floor(m / 60);
  if (h < 1) return `${m} min`;
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

// The state's words, for the shape's title in the Now column.
export function stateWords(info) {
  return isSilent(info) ? { glyph: "◌", state: "Not reporting", words: "not reporting", repo: "" } : W.stateWords(info);
}

const merge = (parts) => parts.reduce((out, p) => {
  if (typeof p === "string" && typeof out.at(-1) === "string") out[out.length - 1] += p;
  else out.push(p);
  return out;
}, []);

// "Orion hasn't reported since 14:05." (B), "Orion stopped reporting at 14:05." (C), "Orion is
// not reporting." (A); two names share one sentence, each with its own time.
function downSentence(down, agents, nowS, tz) {
  const t = (n) => (agents[n].lastRun ? whenDay(agents[n].lastRun, nowS, tz) : "");
  const join = (i) => (i ? (i === down.length - 1 ? " and " : ", ") : "");
  if (OPT === "a" || down.some((n) => !t(n))) return [...W.nameList(down), down.length > 1 ? " are not reporting." : " is not reporting."];
  const [verb, prep] = OPT === "c" ? [" stopped reporting at ", " at "] : [" hasn't reported since ", " since "];
  return [...down.flatMap((n, i) => [join(i), { name: n }, `${i ? prep : verb}${t(n)}`]), "."];
}

// The headline: the others as today, and the not-reporting engineers in their own sentence, after
// the others (A, B) or before them (C). The office being offline or not yet heard from says it all.
export function headline(args = {}) {
  const out = W.headline(args);
  const { agents = {}, seen = {}, names = [], targets = {}, now = Date.now(), timeZone } = args;
  const down = names.filter((n) => isSilent(agents[n]));
  if (OPT === "today" || !down.length || out.mood === "offline" || out.mood === "waiting") return out;
  const others = [...names].sort((a, b) => (seen[b] ?? 0) - (seen[a] ?? 0)).filter((n) => !down.includes(n));
  const said = downSentence(down, agents, Math.floor(now / 1000), timeZone);
  const forms = (others.length ? W.headlineForms(agents, others, targets) : [[]]).map((f) => {
    const own = W.plain(f) === "The engineers are between tasks." ? ["The other engineers are between tasks."] : f;
    return merge(OPT === "c" ? [...said, own.length ? " " : "", ...own] : [...own, own.length ? " " : "", ...said]);
  });
  return { ...out, forms };
}
