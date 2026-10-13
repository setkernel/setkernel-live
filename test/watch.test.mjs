// The "updates stopped" alert: when it fires, that it fires once, recovery, mute. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { STALE_MS, delivered, duration, emptyWatch, tick } from "../src/watch.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 13, 14, 0);

// Runs one tick per minute from `from` to `to` (inclusive), with updates arriving up to
// `lastUpdate(now)`. ok(type) says whether Buzz takes a message. Returns the posts and the state.
function run({ from, to, lastUpdate, ok = () => true, muted = () => false, watch = emptyWatch() }) {
  const posts = [];
  for (let now = from; now <= to; now += MIN) {
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
  assert.match(posts[0].text, /had none for 2 h 6 min .*couldn't be reached to say so while it lasted/);
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

test("muted: a recovery due when the mute starts is dropped, not posted later", () => {
  const { posts } = run({ from: T0, to: T0 + 60 * MIN, lastUpdate: outage(10, 20), ok: (type) => type === "alert" ? true : false, muted: (now) => now >= T0 + 22 * MIN && now < T0 + 30 * MIN });
  assert.deepEqual(posts.map((p) => [p.at, p.type]), [[15, "alert"]]);
});

test("durations read naturally", () => {
  assert.equal(duration(20_000), "1 min");
  assert.equal(duration(59 * MIN), "59 min");
  assert.equal(duration(60 * MIN), "1 h");
  assert.equal(duration(125 * MIN), "2 h 5 min");
  assert.equal(duration(50 * 60 * MIN), "2 d 2 h");
});
