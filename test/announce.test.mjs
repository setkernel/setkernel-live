// What the aria-live region says, and how often. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { ANNOUNCE_EVERY_MS, createAnnouncer, sentence, summarise } from "../public/announce.js";

const gh = (agent, action, repo) => ({ t: "msg", kind: "github", agent, action, ...(repo ? { repo } : {}) });

test("one GitHub event reads as a sentence", () => {
  assert.equal(sentence(gh("Vega", "opened_pr", "lafka-plugin")), "Vega opened a pull request in lafka-plugin.");
  assert.equal(sentence(gh("Rigel", "approved")), "Rigel approved a teammate's pull request.");
  assert.equal(sentence(gh("Lyra", "something_new")), "Lyra did something.");
});

test("a summary skips Claude and chat, keeps the last three and counts the rest", () => {
  assert.equal(summarise([{ t: "msg", kind: "claude", agent: "Vega" }, { t: "msg", kind: "chat", agent: "Orion" }, { t: "agent", agent: "Vega", state: "IDLE" }]), "");
  assert.equal(summarise([]), "");
  const five = [gh("Vega", "picked_up"), gh("Vega", "opened_pr"), gh("Rigel", "approved"), gh("Lyra", "pushed"), gh("Orion", "decision_pr")];
  assert.equal(summarise(five),
    "2 more updates. Rigel approved a teammate's pull request. Lyra pushed fixes to a pull request. Orion wrote up a decision.");
  assert.equal(summarise(five.slice(0, 4)).split(". ")[0], "1 more update");
});

test("the announcer speaks at most once every 30 s and batches what waits", () => {
  let clock = 0;
  const said = [], timers = [];
  const a = createAnnouncer({ say: (t) => said.push(t), now: () => clock, setTimer: (fn, ms) => timers.push({ fn, at: clock + ms }) });

  a.add([{ t: "msg", kind: "claude", agent: "Vega" }]); // nothing worth saying, nothing scheduled
  assert.deepEqual(said, []);
  assert.equal(timers.length, 0);

  a.add([gh("Vega", "opened_pr", "lafka-plugin")]); // first news: straight away
  assert.deepEqual(said, ["Vega opened a pull request in lafka-plugin."]);

  clock = 5_000;
  a.add([gh("Rigel", "approved")]);
  clock = 10_000;
  a.add([gh("Lyra", "picked_up")]);
  assert.equal(said.length, 1);
  assert.equal(timers.length, 1, "one timer for the whole window");
  assert.equal(timers[0].at, ANNOUNCE_EVERY_MS);

  clock = timers[0].at;
  timers[0].fn();
  assert.deepEqual(said.at(-1), "Rigel approved a teammate's pull request. Lyra started on an issue.");

  clock += ANNOUNCE_EVERY_MS; // a full window later: straight away again
  a.add([gh("Orion", "pushed")]);
  assert.equal(said.length, 3);
  assert.equal(timers.length, 1);
});
