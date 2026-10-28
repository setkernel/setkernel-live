// The prototype's switches, from the address: ?opt= the option (a, b, c, or "today" for main's
// behaviour), ?down= the scenario (scenario.js). Under node (build.mjs) there is no address.
import { SCENARIOS } from "./scenario.js";

const q = typeof location === "undefined" ? new URLSearchParams() : new URLSearchParams(location.search);
export const OPTIONS = ["today", "a", "b", "c"];
export const OPT = OPTIONS.includes(q.get("opt")) ? q.get("opt") : "b";
export const SCENARIO = Object.hasOwn(SCENARIOS, q.get("down") ?? "") ? q.get("down") : "one";
