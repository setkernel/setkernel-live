// Pure logic for the "updates stopped" alert (setkernel-live#9): a Cron Trigger calls tick() once
// a minute with the Durable Object's lastIngest, and posts what it returns to Buzz #infra. No
// Workers APIs here, so it runs under `node --test`.
//
// One alert per outage and one recovery message. A post that fails is tried again on the next
// tick until Buzz takes it. Buzz runs in the office, so during a full office outage the alert
// can't get through; then the recovery message is the first report, and says how long it lasted.
// While muted (planned maintenance) nothing is posted, and recoveries are dropped, not queued.

export const STALE_MS = 5 * 60_000;
const MAX_RECOVERIES = 10;

export function emptyWatch() {
  // down: updates have stopped; since: the last update before they did; alerted: Buzz took the
  // alert for this outage; recoveries: ended outages whose recovery message hasn't been posted yet.
  return { down: false, since: 0, alerted: false, recoveries: [] };
}

// One tick -> { watch, send }. send is { type: "alert" | "recovery", text } or null; after Buzz
// takes it, record that with delivered().
export function tick(watch, { lastIngest, now, muted, staleMs = STALE_MS }) {
  const w = { ...emptyWatch(), ...watch };
  w.recoveries = [...w.recoveries];
  // lastIngest 0: nothing has ever arrived (a new deploy before sk-obs01 pushes), so no outage.
  const stale = lastIngest > 0 && now - lastIngest > staleMs;
  if (w.down && !stale) {
    w.recoveries.push({ since: w.since, until: lastIngest, alerted: w.alerted });
    w.recoveries = w.recoveries.slice(-MAX_RECOVERIES);
    Object.assign(w, { down: false, since: 0, alerted: false });
  } else if (!w.down && stale) {
    Object.assign(w, { down: true, since: lastIngest, alerted: false });
  }
  if (muted) {
    w.recoveries = [];
    return { watch: w, send: null };
  }
  if (w.recoveries.length) return { watch: w, send: { type: "recovery", text: recoveryText(w.recoveries[0]) } };
  if (w.down && !w.alerted) return { watch: w, send: { type: "alert", text: alertText(w.since, now) } };
  return { watch: w, send: null };
}

// Buzz took the message tick() returned.
export function delivered(watch, type) {
  if (type === "alert") return { ...watch, alerted: true };
  if (type === "recovery") return { ...watch, recoveries: watch.recoveries.slice(1) };
  return watch;
}

export function duration(ms) {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`;
}

const utc = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export function alertText(since, now) {
  return (
    `🔴 live.setkernel.com has had no updates for ${duration(now - since)} (last at ${utc(since)}). ` +
    "sk-obs01 or its publisher may be down. A message follows when updates resume."
  );
}

export function recoveryText({ since, until, alerted }) {
  const span = duration(until - since);
  const range = `(${utc(since)} to ${utc(until)})`;
  if (alerted) return `✅ live.setkernel.com is getting updates again, after ${span} without ${range}.`;
  return (
    `✅ live.setkernel.com is getting updates again. It had none for ${span} ${range}, and Buzz couldn't ` +
    "be reached to say so while it lasted, which usually means the office was down."
  );
}
