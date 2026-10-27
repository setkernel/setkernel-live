// The "updates stopped" alert: when it fires, that it fires once, recovery, mute. Run: npm test
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { STALE_MS, delivered, duration, emptyWatch, tick } from "../src/watch.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 13, 14, 0);

// Runs one tick every `step` (a minute unless said otherwise) from `from` to `to` (inclusive),
// with updates arriving up to `lastUpdate(now)`. ok(type) says whether Buzz takes a message.
// Returns the posts and the state.
function run({ from, to, lastUpdate, ok = () => true, muted = () => false, watch = emptyWatch(), step = MIN }) {
  const posts = [];
  for (let now = from; now <= to; now += step) {
    const r = tick(watch, { lastIngest: lastUpdate(now), now, muted: muted(now) });
    watch = r.watch;
    if (r.send && ok(r.send.type, now)) {
      posts.push({ at: (now - T0) / MIN, ...r.send });
      watch = delivered(watch, r.send.type);
    }
  }
  return { posts, watch };
}

// Updates every minute, except none between minute `stop` and `resume`.
const outage = (stop, resume) => (now) => {
  const m = Math.floor((now - T0) / MIN);
  return T0 + (m >= stop && m < resume ? stop - 1 : m) * MIN;
};

test("fresh updates post nothing", () => {
  const { posts } = run({ from: T0, to: T0 + 60 * MIN, lastUpdate: (now) => now - 10_000 });
  assert.deepEqual(posts, []);
});

test("staleness: an alert only after more than 5 minutes without updates", () => {
  assert.equal(tick(emptyWatch(), { lastIngest: T0, now: T0 + STALE_MS, muted: false }).send, null);
  const { send, watch } = tick(emptyWatch(), { lastIngest: T0, now: T0 + STALE_MS + 1, muted: false });
  assert.equal(send.type, "alert");
  assert.match(send.text, /no updates for 5 min \(last at 2026-10-13 14:00 UTC\)/);
  assert.equal(watch.down, true);
});

test("nothing ever ingested is not an outage", () => {
  assert.equal(tick(emptyWatch(), { lastIngest: 0, now: T0, muted: false }).send, null);
});

test("one alert per outage, then one recovery with how long it lasted", () => {
  const { posts, watch } = run({ from: T0, to: T0 + 120 * MIN, lastUpdate: outage(10, 40) });
  assert.deepEqual(posts.map((p) => [p.at, p.type]), [[15, "alert"], [40, "recovery"]]);
  assert.match(posts[1].text, /getting updates again, after 31 min without \(2026-10-13 14:09 UTC to 2026-10-13 14:40 UTC\)/);
  assert.deepEqual(watch, emptyWatch());
});

test("two outages get two alerts and two recoveries", () => {
  const two = (now) => (now < T0 + 50 * MIN ? outage(10, 20)(now) : outage(60, 80)(now));
  const { posts } = run({ from: T0, to: T0 + 100 * MIN, lastUpdate: two });
  assert.deepEqual(posts.map((p) => [p.at, p.type]), [[15, "alert"], [20, "recovery"], [65, "alert"], [80, "recovery"]]);
});

test("a failed post is retried every minute until Buzz takes it, and only then", () => {
  const { posts } = run({ from: T0, to: T0 + 60 * MIN, lastUpdate: outage(10, 50), ok: (type, now) => now >= T0 + 30 * MIN });
  assert.deepEqual(posts.map((p) => [p.at, p.type]), [[30, "alert"], [50, "recovery"]]);
  assert.match(posts[0].text, /no updates for 21 min/); // the alert says how long it has been when it gets through
});

test("an office outage (Buzz unreachable the whole time) is reported on recovery", () => {
  const { posts } = run({ from: T0, to: T0 + 300 * MIN, lastUpdate: outage(10, 135), ok: (type, now) => now >= T0 + 135 * MIN });
  assert.deepEqual(posts.map((p) => [p.at, p.type]), [[135, "recovery"]]);
  assert.match(posts[0].text, /had none for 2 h 6 min .*didn't get through to Buzz while it lasted/);
});

test("a recovery that fails is retried", () => {
  const { posts } = run({ from: T0, to: T0 + 60 * MIN, lastUpdate: outage(10, 20), ok: (type, now) => type === "alert" || now >= T0 + 25 * MIN });
  assert.deepEqual(posts.map((p) => [p.at, p.type]), [[15, "alert"], [25, "recovery"]]);
});

test("muted: an outage inside the mute posts nothing at all", () => {
  const { posts, watch } = run({ from: T0, to: T0 + 60 * MIN, lastUpdate: outage(10, 30), muted: (now) => now < T0 + 40 * MIN });
  assert.deepEqual(posts, []);
  assert.deepEqual(watch, emptyWatch());
});

test("muted: an outage still going when the mute ends is alerted then", () => {
  const { posts } = run({ from: T0, to: T0 + 60 * MIN, lastUpdate: outage(10, 50), muted: (now) => now < T0 + 30 * MIN });
  assert.deepEqual(posts.map((p) => [p.at, p.type]), [[30, "alert"], [50, "recovery"]]);
});

test("muted: the recovery for an alert already posted still goes out", () => {
  const { posts } = run({ from: T0, to: T0 + 60 * MIN, lastUpdate: outage(10, 30), muted: (now) => now >= T0 + 20 * MIN && now < T0 + 40 * MIN });
  assert.deepEqual(posts.map((p) => [p.at, p.type]), [[15, "alert"], [30, "recovery"]]);
});

test("muted: a recovery for an alert that never got through is dropped, not posted later", () => {
  const { posts, watch } = run({ from: T0, to: T0 + 60 * MIN, lastUpdate: outage(10, 20), ok: () => false, muted: (now) => now >= T0 + 20 * MIN && now < T0 + 30 * MIN });
  assert.deepEqual(posts, []);
  assert.deepEqual(watch, emptyWatch());
});

// The cron runs every 5 minutes (wrangler.jsonc, README "When updates stop"); STALE_MS stays 5.
const CRON_STEP = 5 * MIN;

test("wrangler.jsonc schedules the check every 5 minutes, as the README says", () => {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(config, /"crons": \["\*\/5 \* \* \* \*"\]/);
  assert.doesNotMatch(config, /"\* \* \* \* \*"/);
});

test("every 5 minutes: the alert comes 5 to 10 minutes after the last update, whatever the tick's phase", () => {
  // Updates stop after minute 9 (outage(10, ...)); the cron's ticks start `phase` minutes into the hour.
  for (let phase = 0; phase < 5; phase++) {
    const { posts } = run({ from: T0 + phase * MIN, to: T0 + 60 * MIN, step: CRON_STEP, lastUpdate: outage(10, 100) });
    const alerts = posts.filter((p) => p.type === "alert");
    assert.equal(alerts.length, 1);
    const age = alerts[0].at - 9; // minutes since the last update
    assert.ok(age > 5 && age <= 10, `phase ${phase}: alert ${age} min after the last update`);
  }
});

test("every 5 minutes: a tick exactly 5 minutes after the last update is silent, the next one alerts", () => {
  // The last update is at minute 9. Ticks at 4, 9, 14, 19: minute 14 is exactly 5 minutes (silent, the
  // test is strictly more than), so the alert comes at 19, 10 minutes after the last update.
  const { posts } = run({ from: T0 + 4 * MIN, to: T0 + 30 * MIN, step: CRON_STEP, lastUpdate: outage(10, 100) });
  assert.deepEqual(posts.map((p) => [p.at, p.type]), [[19, "alert"]]);
  assert.match(posts[0].text, /no updates for 10 min/);
});

test("every 5 minutes: the recovery comes within 5 minutes of updates resuming", () => {
  for (let phase = 0; phase < 5; phase++) {
    const { posts, watch } = run({ from: T0 + phase * MIN, to: T0 + 60 * MIN, step: CRON_STEP, lastUpdate: outage(10, 32) });
    assert.deepEqual(posts.map((p) => p.type), ["alert", "recovery"]);
    const wait = posts[1].at - 32; // minutes from the first update back to the recovery
    assert.ok(wait >= 0 && wait < 5, `phase ${phase}: recovery ${wait} min after updates resumed`);
    assert.deepEqual(watch, emptyWatch());
  }
});

test("every 5 minutes: a recovery's end time and length can read up to 5 minutes long", () => {
  // Updates resume at minute 31; the tick at 35 records the last update it sees, minute 35.
  const { posts } = run({ from: T0, to: T0 + 60 * MIN, step: CRON_STEP, lastUpdate: outage(10, 31) });
  assert.deepEqual(posts.map((p) => [p.at, p.type]), [[15, "alert"], [35, "recovery"]]);
  assert.match(posts[1].text, /after 26 min without \(2026-10-13 14:09 UTC to 2026-10-13 14:35 UTC\)/); // 22 min actually
});

test("every 5 minutes: a gap under 10 minutes between ticks can pass with no alert and no recovery", () => {
  // Updates at minute 10, then none until 18: the ticks at 15 (5 min old, not stale) and 20 (fresh).
  const gap = (now) => {
    const m = (now - T0) / MIN;
    return m >= 10 && m < 18 ? T0 + 10 * MIN : now;
  };
  const { posts, watch } = run({ from: T0, to: T0 + 60 * MIN, step: CRON_STEP, lastUpdate: gap });
  assert.deepEqual(posts, []);
  assert.deepEqual(watch, emptyWatch());
});

test("every 5 minutes: a failed post is retried on the next tick, 5 minutes later", () => {
  // Buzz refuses the alert at the first tick that wants to post it (minute 15) and takes it at 20.
  const attempts = [];
  const { posts } = run({
    from: T0,
    to: T0 + 40 * MIN,
    step: CRON_STEP,
    lastUpdate: outage(10, 100),
    ok: (type, now) => {
      attempts.push((now - T0) / MIN);
      return now >= T0 + 20 * MIN;
    },
  });
  assert.deepEqual(attempts, [15, 20]);
  assert.deepEqual(posts.map((p) => [p.at, p.type]), [[20, "alert"]]);
  assert.match(posts[0].text, /no updates for 11 min/);
});

test("durations read naturally", () => {
  assert.equal(duration(20_000), "1 min");
  assert.equal(duration(59 * MIN), "59 min");
  assert.equal(duration(60 * MIN), "1 h");
  assert.equal(duration(125 * MIN), "2 h 5 min");
  assert.equal(duration(50 * 60 * MIN), "2 d 2 h");
});
