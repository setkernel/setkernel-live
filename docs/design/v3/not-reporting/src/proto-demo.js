// ?demo's busy day, with the scenario's engineers stopped (scenario.js). The live demo keeps
// going afterwards, and they stay stopped.
import { busyDay as realBusyDay } from "../../../../../public/lib/demo.js";
import { downBatch, downs } from "./scenario.js";
import { OPT, SCENARIO } from "./config.js";

export function busyDay(nowS, seed) {
  const list = downs(SCENARIO, nowS);
  const today = OPT === "today"; // main today: the stopped engineer arrives as IDLE
  const { batches, sim } = realBusyDay(nowS, seed);
  return {
    batches: batches.map((b) => downBatch(b, list, today)),
    sim: { advance: (toS) => downBatch({ at: toS, ...sim.advance(toS) }, list, today) },
  };
}
