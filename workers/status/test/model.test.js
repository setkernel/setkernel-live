import { test } from "node:test";
import assert from "node:assert/strict";
import { ENDED, LOGGED, STATES, checkBatch, internalView, itemRow, parseRef, publicView, sessionUrl } from "../src/model.js";
import { esc } from "../src/html.js";

const NOW = new Date("2026-10-16T12:00:00Z");
const OK = { alert: false, degrade: false, refuse: false, detail: {} };
const item = (ref, state, rev = 1, extra = {}, dispatch) => ({ item: { ref, kind: "issue", state, rev, seat: null, pr: null, updated_at: "2026-10-16T11:00:00Z", ...extra }, dispatch });

test("parseRef lower-cases and rejects what isn't owner/repo#N", () => {
  assert.deepEqual(parseRef("SetKernel/SK-demo#14"), { ref: "setkernel/sk-demo#14", repo: "setkernel/sk-demo", number: 14 });
  for (const bad of ["setkernel/sk-demo", "setkernel#1", "a/b/c#1", "a/b#0", "a/..#1", "-a/b#1", "a/b c#1", 7, null]) assert.equal(parseRef(bad), null, String(bad));
});

test("itemRow keeps a fired dispatch's claude.ai link only for the item's own seat", () => {
  const fired = { outcome: "fired", seat: "vega-setkernel", session_url: "https://claude.ai/code/session_01ab" };
  assert.equal(itemRow(item("a/b#1", "running", 3, { seat: "Vega-Setkernel" }, fired)).row.session_url, fired.session_url);
  assert.equal(itemRow(item("a/b#1", "running", 3, { seat: "lyra-setkernel" }, fired)).row.session_url, null);
  assert.equal(itemRow(item("a/b#1", "running", 3, { seat: "vega-setkernel" }, { ...fired, outcome: "failed" })).row.session_url, null);
  for (const url of ["javascript:alert(1)", "https://claude.ai.evil.example/x", "http://claude.ai/x", "https://claude.ai/\"><b>"]) {
    assert.equal(sessionUrl(url), null, url);
  }
});

test("itemRow rejects bad fields with a reason", () => {
  assert.match(itemRow(item("nope", "queued")).error, /ref/);
  assert.match(itemRow(item("a/b#1", "lost")).error, /state/);
  assert.match(itemRow(item("a/b#1", "queued", 0)).error, /rev/);
  assert.match(itemRow(item("a/b#1", "queued", 1, { seat: "not a login" })).error, /seat/);
  assert.match(itemRow(item("a/b#1", "queued", 1, { updated_at: "soon" })).error, /updated_at/);
  assert.match(itemRow({}).error, /no item/);
});

test("the ends the board logs and prunes are states the control Worker can reach", () => {
  for (const state of ENDED) assert.ok(STATES.includes(state), state);
  for (const state of LOGGED) assert.ok(ENDED.includes(state), state);
});

test("checkBatch drops bad entries with their index, keeps the rest and ignores seats", () => {
  const out = checkBatch({ items: [item("a/b#1", "queued"), item("bad", "queued")], seats: [{ seat: { login: "x", active: true, updated_at: NOW.toISOString() } }] });
  assert.equal(out.items.length, 1);
  assert.equal(out.seats, undefined);
  assert.deepEqual(out.rejected, [{ kind: "item", index: 1, error: "ref must be owner/repo#N" }]);
  assert.match(checkBatch([]).error, /batch/);
  assert.match(checkBatch({ items: Array(101).fill(item("a/b#1", "queued")) }).error, /at most/);
});

const SNAPSHOT = {
  items: [
    { ref: "acme-client/secret-app#3", repo: "acme-client/secret-app", number: 3, kind: "issue", state: "queued", rev: 1, seat: null, pr: null, session_url: null, updated_at: "2026-10-16T09:00:00Z" },
    { ref: "setkernel/sk-demo#14", repo: "setkernel/sk-demo", number: 14, kind: "issue", state: "queued", rev: 1, seat: null, pr: null, session_url: null, updated_at: "2026-10-16T10:00:00Z" },
    { ref: "setkernel/sk-demo#12", repo: "setkernel/sk-demo", number: 12, kind: "issue", state: "queued", rev: 1, seat: null, pr: null, session_url: null, updated_at: "2026-10-16T08:00:00Z" },
    { ref: "acme-client/secret-app#9", repo: "acme-client/secret-app", number: 9, kind: "issue", state: "pr_open", rev: 4, seat: "vega-setkernel", pr: 10, session_url: "https://claude.ai/code/session_01ab", updated_at: "2026-10-16T11:00:00Z" },
    { ref: "setkernel/hq#1", repo: "setkernel/hq", number: 1, kind: "issue", state: "running", rev: 3, seat: "realraghavgupta", pr: null, session_url: null, updated_at: "2026-10-16T10:30:00Z" },
  ],
  events: [
    { at: "2026-10-16T11:30:00Z", ref: "acme-client/secret-app#7", repo: "acme-client/secret-app", number: 7, kind: "issue", state: "merged", seat: "vega-setkernel", pr: 8 },
    { at: "2026-10-16T07:00:00Z", ref: "setkernel/hq#2", repo: "setkernel/hq", number: 2, kind: "issue", state: "failed", seat: "lyra-setkernel", pr: null },
    { at: "2026-10-15T11:00:00Z", ref: "setkernel/hq#3", repo: "setkernel/hq", number: 3, kind: "issue", state: "merged", seat: null, pr: null },
  ],
};

test("internalView: the guard and a day of events, with no queue, running or seats", () => {
  const v = internalView(SNAPSHOT, OK, NOW);
  assert.deepEqual(Object.keys(v), ["generated_at", "snapshot_at", "guard", "last_24h"]);
  assert.equal(v.last_24h.events[0].pr_url, "https://github.com/acme-client/secret-app/pull/8");
  assert.equal(v.last_24h.merged, 1);
  assert.equal(v.last_24h.failed, 1);
  assert.deepEqual(v.last_24h.events.map((e) => e.ref), ["acme-client/secret-app#7", "setkernel/hq#2"]);
  assert.equal(v.guard.level, "ok");
});

test("internalView names the guard's highest level, its metrics and reset", () => {
  const g = { alert: true, degrade: true, refuse: false, detail: { degrade: { since: "x", metrics: ["workers_cpu_ms"], until: "2026-11-13T00:00:00Z" } } };
  assert.deepEqual(internalView(SNAPSHOT, g, NOW).guard, { level: "degrade", alert: true, degrade: true, refuse: false, metrics: ["workers_cpu_ms"], until: "2026-11-13T00:00:00.000Z" });
  assert.equal(internalView(SNAPSHOT, { alert: true, degrade: true, refuse: false, error: "kv down" }, NOW).guard.unreadable, true);
});

test("publicView: counts only; no repo, ref, URL, login or usage", () => {
  const v = publicView(internalView(SNAPSHOT, OK, NOW));
  assert.deepEqual(v, { generated_at: NOW.toISOString(), last_24h: { merged: 1, failed: 1 } });
  const text = JSON.stringify(v).toLowerCase();
  for (const leak of ["acme", "secret-app", "sk-demo", "setkernel/", "http", "claude.ai", "raghav", "-setkernel", "five_hour", "headroom", "guard"]) {
    assert.ok(!text.includes(leak), `public view leaks ${leak}`);
  }
});

test("esc escapes everything HTML gives meaning to", () => {
  assert.equal(esc(`<a href="x" onclick='y'>&</a>`), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(esc(null), "");
});
