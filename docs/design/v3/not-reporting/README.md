# Day prototype: an engineer whose VM stopped reporting

The prototype for box 1 of setkernel-live#54. Today the page can't tell a stopped VM from an idle
one: sk-obs01 sends IDLE for both, so the engineer reads "Idle". Below are three options for how
Day shows an engineer whose sk-agent has stopped, and when it last ran. This is a prototype on
the busy demo day. Nothing under `public/` or `src/` changes until Raghav picks an option and says
whether this new fact may leave sk-obs01.

**To open it,** double-click `index.html`. It is one file, with the fonts embedded, and it needs
no server and no network. It is the built page (`public/`) on `?demo`'s busy day, with this
prototype's code over four of its modules (see "How it's built"). The dark strip at the bottom
is the prototype's switcher, not part of the design. It switches:
- **Option:** main today (the control), A, B or C.
- **Down:** Orion stopped 2 h 35 min ago; Vega and Orion stopped about 12 hours ago (the
  2026-10-16 case, setkernel/hq#246); or nobody.
- **Theme:** light, or dark. The page has one light theme. "Dark" is the wall's fixed palette on
  the page's layout, shown because Raghav asked for both. It is not a proposal for a dark page.
- **Layout:** page or wall.

The screenshots are at the Day prototype's clock (Wednesday 14 October 2026, 16:40 ADT). Orion's
last run ended at 14:05.

## Today (main): Orion reads "Idle"

| 1440×900 | 375×812 |
|---|---|
| ![today](today-1440x900.png) | ![today phone](today-375x812.png) |

## The three options at a glance

| | A · Words | B · Hatched lane (recommended) | C · Flagged |
|---|---|---|---|
| Headline | "… Orion is not reporting." after the others, with no time | "… Orion hasn't reported since 14:05." after the others | "Orion stopped reporting at 14:05." first, then the others |
| Now column | "Not reporting" in light type (like Idle), with a dotted ring; "Last ran 14:05" | "Not reporting" in regular type, the second ink, with the dotted ring; "Last ran 14:05 · 2 h 35 min ago" | "Not reporting" in the signal red, with a red ring; "Since 14:05 · 2 h 35 min" |
| Lane | the faint track stops at 14:05 with an end cap and "Last ran 14:05" | the same, and the lane is hatched from 14:05 to now, the page's existing "we don't know" pattern | the same, but the hatch and the end cap are red |
| Key | nothing new | "Not reporting" with the hatch | "Not reporting" with the red hatch |
| Scrubbing | as today | the ten-minute columns after the last run say "Not reporting" | as B |

In all three:
- The other engineers are shown exactly as today.
- When the whole office is offline, the headline says only "No word from the office since …",
  as today. The Now column, headed "Last word, …", shows each engineer as they were at the last
  word, a stopped one included. The lane's hatch ends where the office's begins.
- A GitHub event about the stopped engineer's work still shows on their lane. An example is
  Polaris merging their pull request; see Vega's lane in the 12-hour shots.

### A · Words

| 1440×900 | 1440×900, dark |
|---|---|
| ![A](a-1440x900.png) | ![A dark](a-1440x900-dark.png) |

| 375×812 | 375×812, dark | 375, the whole page |
|---|---|---|
| ![A phone](a-375x812.png) | ![A phone dark](a-375x812-dark.png) | ![A phone full](a-375-full.png) |

| Wall, 1920×1080 | Vega and Orion, 12 hours, 1440×900 |
|---|---|
| ![A wall](a-wall-1920x1080.png) | ![A 12h](a-12h-1440x900.png) |

### B · Hatched lane (recommended)

| 1440×900 | 1440×900, dark |
|---|---|
| ![B](b-1440x900.png) | ![B dark](b-1440x900-dark.png) |

| 375×812 | 375×812, dark | 375, the whole page |
|---|---|---|
| ![B phone](b-375x812.png) | ![B phone dark](b-375x812-dark.png) | ![B phone full](b-375-full.png) |

| Wall, 1920×1080 | Vega and Orion, 12 hours, 1440×900 | Scrubbed to 15:20 (keyboard) |
|---|---|---|
| ![B wall](b-wall-1920x1080.png) | ![B 12h](b-12h-1440x900.png) | ![B scrub](b-scrub-1440x900.png) |

### C · Flagged

| 1440×900 | 1440×900, dark |
|---|---|
| ![C](c-1440x900.png) | ![C dark](c-1440x900-dark.png) |

| 375×812 | 375×812, dark | 375, the whole page |
|---|---|---|
| ![C phone](c-375x812.png) | ![C phone dark](c-375x812-dark.png) | ![C phone full](c-375-full.png) |

| Wall, 1920×1080 | Vega and Orion, 12 hours, 1440×900 |
|---|---|
| ![C wall](c-wall-1920x1080.png) | ![C 12h](c-12h-1440x900.png) |

## Why B
- **It uses the page's own language.** The hatch already means "the page doesn't know what
  happened here": "No word since …", "Older runs aren't kept". A stopped VM is that, for one lane.
- **It says when, where a visitor looks first.** The time appears in the headline as well as in
  the Now column.
- **A is too easy to miss.** Its light "Not reporting" looks like "Idle", which is the problem
  this issue is about.
- **C reads as an incident banner** on the only public demo. Red on Day already means review
  feedback and failed CI runs, so a red lane would compete with them. C also makes `--signal` a
  text colour. It measures 5.50:1 on the page's `--surface` and 5.99:1 on the wall's, so it passes
  AA. It does not reach the 7:1 that `test/page.test.mjs` asks of `--ink` and `--ink-2`.

## The data this assumes (for the build, once Raghav says yes)
- **A new engineer state, `SILENT`**, with an optional `lastRun`: when the last run ended, in
  seconds, on a whole minute. `src/scenario.js` has the proposed check (`cleanSilent`):
  - A `lastRun` that isn't a whole minute, is in the future, or is older than 7 days is dropped.
  - The state stays; the page then says "Not reporting" with no time.
  - The name is a proposal. The issue rules out `OFFLINE`, because "offline" means the whole office.
- **`state.js` needs no change.** `applyBatch` keeps the batch's agents as they are, and
  `view()` passes them through. `build.mjs` checks that `lastRun` reaches the page unchanged.
  `scripts/smoke.mjs`'s `STATE_KEYS` stays, because agents are nested.
- **sk-obs01 (setkernel/hq, a separate PR):**
  - It sends `SILENT` when no run has ended in 15 minutes and none is in progress, or when the
    watch has stopped writing.
  - `lastRun` comes from `sk_agent_last_run_end_seconds`, rounded down to the minute.
  - If Prometheus or a series is missing, it sends what it sends today and never `SILENT`.
  - For the first 15 minutes after a stop, the engineer still reads as today.
- **The new public fact:** for one engineer, that its agent hasn't run since a minute-rounded
  time. There are no hostnames and no metric values.

## Open questions for Raghav
1. **Which option**: A, B or C?
2. **May this fact leave sk-obs01?** It tells the public, per engineer, when an agent stopped
   running.
3. **The state's name**: is `SILENT` fine? The page only ever shows the words "Not reporting".
4. **Old times.** A time from yesterday reads "yesterday 21:40", and an older one "Fri 16 Oct
   04:10", as Day already writes a stage's time. Should an outage longer than 24 hours say
   more than that? The hatch then covers the whole lane.
5. **Past outages.** The replay keeps no agent states. When the VM comes back, its hatch goes,
   and the outage shows only as a gap in the lane's activity. Keeping it would need a replay
   column, which counts against the 128 KiB budget. I suggest leaving it out.
6. **`?demo` with one engineer down.** The issue asks for it, and the comment says to build
   nothing under `public/` this round. Here it is the switcher's "Down" choice, made from
   `?demo`'s busy day. In the build it would be `?demo=down`.

## How it's built
`build.mjs` bundles `public/app.js` into `index.html` with esbuild. That is wrangler's copy,
already in `node_modules`. Four of `public/lib`'s modules get this prototype's code over them:

| Module | Overrides |
|---|---|
| `src/proto-words.js` | the headline and the state's name |
| `src/proto-day.js` | the Now column's words, the scrub readout and the key |
| `src/proto-chart.js` | draws the lane and marks the Now column's words for `src/proto.css` |
| `src/proto-demo.js` | stops the scenario's engineers in `?demo`'s busy day |

`src/scenario.js` holds the data. It is the same busy day with the stopped engineer's events
removed after the stop, and the state turned `SILENT` 15 minutes later.

Before building, `build.mjs` checks the data:
- every event passes the real `cleanEvent` unchanged;
- every other state passes the real `cleanBatch`;
- `SILENT` passes the proposed `cleanSilent`.

```sh
npm ci
node docs/design/v3/not-reporting/build.mjs                       # check the data, rebuild index.html
npm i --prefix "$TMPDIR/pw" playwright && npx --prefix "$TMPDIR/pw" playwright install chromium
PLAYWRIGHT_DIR="$TMPDIR/pw" node docs/design/v3/not-reporting/shoot.mjs   # retake every PNG
```
`shoot.mjs` fails in any of these cases:
- the page throws;
- the page requests anything that isn't `file:` or `data:`;
- the page scrolls sideways;
- the wall's canvas doesn't fit the window.
