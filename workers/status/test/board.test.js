import { test } from "node:test";
import assert from "node:assert/strict";
import { Board } from "../src/board.js";
import { fakeState } from "./fakes.js";

const T0 = Date.parse("2026-10-16T12:00:00Z");

function board(state = fakeState(), at = T0) {
  const b = new Board(state, {});
  b.clock = at;
  b.now = () => new Date(b.clock);
  return b;
}

const item = (ref, state, rev, extra = {}) => ({ item: { ref, kind: "issue", state, rev, seat: null, pr: null, updated_at: new Date(T0).toISOString(), ...extra } });
const seat = (login, seen, utilization = 0.5) => ({ seat: { login, active: true, updated_at: seen, windows: [{ name: "five_hour", utilization, resets_at: "2026-10-16T15:00:00Z", observed_at: seen }] } });

test("publish then snapshot: open items, and seats are neither written nor read", async () => {
  const b = board();
  const r = await b.publish({ items: [item("a/b#1", "queued", 1), item("a/b#2", "running", 3, { seat: "vega-setkernel" })], seats: [seat("vega-setkernel", "2026-10-16T11:00:00Z")] });
  assert.deepEqual(r, { ok: true, applied: 2, stale: 0, rejected: [] });
  const s = await b.snapshot();
  assert.deepEqual(s.items.map((i) => [i.ref, i.state, i.seat]), [["a/b#1", "queued", null], ["a/b#2", "running", "vega-setkernel"]]);
  assert.equal(s.seats, undefined);
  assert.deepEqual(b.sql.exec("SELECT name FROM sqlite_master WHERE name = 'seats'").toArray(), []);
  assert.deepEqual(s.events, []);
});

test("the rev fence: an older or repeated item view changes nothing", async () => {
  const b = board();
  await b.publish({ items: [item("a/b#1", "running", 3)] });
  const r = await b.publish({ items: [item("a/b#1", "queued", 1), item("a/b#1", "running", 3)] });
  assert.equal(r.applied, 0);
  assert.equal(r.stale, 2);
  assert.equal((await b.snapshot()).items[0].state, "running");
});

test("the session link written after the move to dispatched applies at the same rev, and stays", async () => {
  const b = board();
  const moved = item("a/b#1", "dispatched", 2, { seat: "vega-setkernel" });
  const fired = { ...moved, dispatch: { at: new Date(T0).toISOString(), seat: "vega-setkernel", rev: 2, outcome: "fired", session_url: "https://claude.ai/code/session_01abc" } };
  assert.equal((await b.publish({ items: [moved] })).applied, 1);
  assert.deepEqual(await b.publish({ items: [fired] }), { ok: true, applied: 1, stale: 0, rejected: [] });
  assert.equal((await b.snapshot()).items[0].session_url, "https://claude.ai/code/session_01abc");
  const r = await b.publish({ items: [moved, fired] }); // late or repeated: no change either way
  assert.equal(r.stale, 2);
  assert.equal((await b.snapshot()).items[0].session_url, "https://claude.ai/code/session_01abc");
  assert.deepEqual((await b.snapshot()).events, []);
});

test("another PR taking over at the same rev applies when newer, and a late replay doesn't undo it", async () => {
  const b = board();
  const at = (m) => new Date(T0 + m * 60_000).toISOString();
  const fired = { ...item("a/b#1", "pr_open", 4, { seat: "vega-setkernel", pr: 10, updated_at: at(0) }), dispatch: { at: at(0), seat: "vega-setkernel", rev: 4, outcome: "fired", session_url: "https://claude.ai/code/session_01abc" } };
  const first = item("a/b#1", "pr_open", 4, { seat: "vega-setkernel", pr: 10, updated_at: at(0) });
  const took = item("a/b#1", "pr_open", 4, { seat: "vega-setkernel", pr: 11, updated_at: at(30) });
  assert.equal((await b.publish({ items: [fired] })).applied, 1);
  assert.deepEqual(await b.publish({ items: [took] }), { ok: true, applied: 1, stale: 0, rejected: [] });
  let s = await b.snapshot();
  assert.deepEqual(s.items.map((i) => [i.ref, i.rev, i.pr, i.session_url]), [["a/b#1", 4, 11, "https://claude.ai/code/session_01abc"]]);
  const r = await b.publish({ items: [first, fired, took] }); // late or repeated: no change
  assert.equal(r.stale, 3);
  s = await b.snapshot();
  assert.deepEqual(s.items.map((i) => [i.pr, i.updated_at]), [[11, at(30)]]);
  assert.deepEqual(s.events, []);
});

test("reaching merged or failed records one event; a retry records the next failure too", async () => {
  const b = board();
  await b.publish({ items: [item("a/b#1", "pr_open", 4, { pr: 9, seat: "vega-setkernel" })] });
  await b.publish({ items: [item("a/b#1", "merged", 5, { pr: 9, seat: "vega-setkernel" })] });
  await b.publish({ items: [item("a/b#1", "merged", 5, { pr: 9 })] }); // the same view again
  await b.publish({ items: [item("c/d#2", "failed", 2), item("c/d#2", "queued", 3), item("c/d#2", "failed", 4)] });
  const s = await b.snapshot();
  assert.deepEqual(s.events.map((e) => [e.ref, e.state, e.pr]), [["a/b#1", "merged", 9], ["c/d#2", "failed", null], ["c/d#2", "failed", null]]);
  assert.deepEqual(s.items, [], "ended items aren't open");
});

test("a day later, ended items and their events are pruned on the next publish", async () => {
  const b = board();
  await b.publish({ items: [item("a/b#1", "merged", 2), item("a/b#2", "queued", 1)] });
  b.clock = T0 + 25 * 3600_000;
  assert.equal((await b.snapshot()).events.length, 0, "the snapshot hides events past a day");
  await b.publish({ items: [item("a/b#3", "queued", 1, { updated_at: new Date(b.clock).toISOString() })] });
  const rows = b.sql.exec("SELECT ref FROM items ORDER BY ref").toArray().map((r) => r.ref);
  assert.deepEqual(rows, ["a/b#2", "a/b#3"], "an open item stays however old");
  assert.equal(b.sql.exec("SELECT count(*) AS n FROM events").toArray()[0].n, 0);
});

test("closed and new leave the board without an event, and are pruned a day later", async () => {
  const b = board();
  await b.publish({ items: [item("a/b#1", "queued", 1), item("a/b#2", "running", 2, { seat: "vega-setkernel" })] });
  await b.publish({ items: [item("a/b#1", "closed", 2), item("a/b#2", "new", 3)] });
  const s = await b.snapshot();
  assert.deepEqual(s.items, [], "neither is queued or running any more");
  assert.deepEqual(s.events, [], "only merged and failed are counted");
  b.clock = T0 + 25 * 3600_000;
  await b.publish({ items: [] });
  assert.equal(b.sql.exec("SELECT count(*) AS n FROM items").toArray()[0].n, 0);
});

test("a bad entry is rejected with its reason and the rest of the batch applies", async () => {
  const b = board();
  const r = await b.publish({ items: [item("bad ref", "queued", 1), item("a/b#1", "queued", 1)] });
  assert.equal(r.applied, 1);
  assert.deepEqual(r.rejected, [{ kind: "item", index: 0, error: "ref must be owner/repo#N" }]);
  assert.deepEqual(await b.publish("nope"), { ok: false, status: 400, error: "batch must be { items }" });
});

test("a failed write rolls the whole batch back", async () => {
  const state = fakeState();
  const b = board(state);
  state.db.exec("CREATE TRIGGER boom BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  await assert.rejects(b.publish({ items: [item("a/b#1", "queued", 1), item("a/b#2", "merged", 2)] }), /disk full/);
  assert.deepEqual((await b.snapshot()).items, []);
});

test("state survives the object being rebuilt on the same storage", async () => {
  const state = fakeState();
  await board(state).publish({ items: [item("a/b#1", "queued", 1)] });
  assert.equal((await board(state).snapshot()).items.length, 1);
});
