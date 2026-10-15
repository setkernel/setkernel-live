# Live v3 prototype: Day (option B)

Option B from setkernel/hq#177 ([decision document](https://github.com/setkernel/hq/blob/d87ee15212b8b2d21c027039d93ab9ac2790b314/docs/decisions/0005-discussion-a-better-designed-live-setkernel-com-op.md)),
built so it can be compared with Roster and the v2 control (setkernel-live#45). This is a prototype
on fixture data. It is not deployed, and nothing under `public/` or `src/` changes.

**To open it,** double-click `index.html`, or drag it into a browser. It is one self-contained file
with the fonts embedded, and it needs no server and no network. The dark strip at the top is the
prototype's switcher and is not part of the design. It has these controls:
- **Mood:** the four `headline()` moods (live, quiet, offline, waiting).
- **Day:** a busy day or a quiet day.
- **Layout:** page or wall.

Below 720 px wide, the page switches to the phone layout by itself.

| Live, 1440×900 | Quiet (quiet-day data), 1440×900 |
|---|---|
| ![live](day-live-1440x900.png) | ![quiet](day-quiet-1440x900.png) |

| Offline, 1440×900 | Waiting, 1440×900 |
|---|---|
| ![offline](day-offline-1440x900.png) | ![waiting](day-waiting-1440x900.png) |

| Scrubbed to 10:20 (keyboard), 1440×900 | Wall, live, 2560×1440 |
|---|---|
| ![scrub](day-scrub-1440x900.png) | ![wall](day-wall-live-2560x1440.png) |

| Phone, live, 375×812 | Phone, quiet day, 375×812 | Phone, live, full page |
|---|---|---|
| ![375 live](day-live-375x812.png) | ![375 quiet](day-quiet-375x812.png) | ![375 full](day-live-375-full.png) |

## The concept
The page has one sentence on top and one chart under it.
- **The sentence** answers the 10-second question, who is doing what right now. It is `headline()`
  from `words.js`, unchanged, with the "Latest" line under it.
- **The chart** is the last 24 hours, with one lane per engineer and time running left to right.
  The right edge is now, and the column past it says what each lane is doing at that moment.
  Scrubbing turns that column into "what each lane was doing at 10:20".

The chart is the client story: how a day of work actually flowed. The past runs into the present
along each lane.

There is no illustration. Every mark is an action, a count or a stage, and there is no glow,
gradient or card. Colour is never the only signal:
- each action has its own shape;
- the stages differ in line weight and dash;
- the one signal colour, red, always comes with a glyph (✕ for changes asked and CI failed).

**Type and grid.** The type is Manrope, with IBM Plex Mono for times; both are the repo's own OFL
fonts from `public/fonts/`, embedded.

| Element | Page | Wall |
|---|---|---|
| Headline | 34/42 | 62/74 |
| "Latest" line | 16 | 30 |
| Lane names | 16 bold | 44 |
| Labels | 13 | 26 |
| Axis | 11 mono | 22 |

On the page, the grid is a 48 px margin, then a 216 px name gutter, the plot (144 ten-minute
columns), and a 320 px "moment" column, with 24 px gaps.

## Regions and their data
Every field below is one that `cleanEvent` keeps. The page reads only `state.js`'s view and the
replay buffer.

| Region | What it shows | Source |
|---|---|---|
| Masthead, right | "About a minute behind · updated 6 s ago"; when offline, only "updated 47 min ago" | `freshness()` (`words.js`); the delay is hq `observability/wall/public.py` `DELAY = 60` |
| Headline and "Latest" | the sentence for the mood | `headline()`, `headlineForms()` and `fitHeadline()` (`words.js`), with `reviewers()` (`line.js`) for "reviewing Vega's pull request" |
| Name gutter | name, and today's tally | `tally()` on `byAgent` (`words.js`); Polaris's requests, merges and reviews in the same form |
| Lane, top: grey bars | Claude requests per 10 minutes, on one scale for all four lanes (the key gives the tallest) | `replay.pulses`, the per-minute rows, summed into 10-minute columns |
| Lane, middle: the track | the job's stage: hairline Started, line Building, heavy In review, red dashed Fixing | `replay.work` and the Claude pulses, run through `line.js`'s own `stepLines()`, from `seedLanes()` of the live lanes |
| Lane, track marks | each action: ○ started on an issue, ◆ opened a pull request, △ pushed fixes, ✓ approved, ✕ asked for changes, ● had a pull request merged, ⋯ posted in a design discussion, ■ wrote up a decision | `replay.work`, labelled with `deed()` |
| Lane, bottom: short bars | team chat posts per 10 minutes | `replay.pulses` |
| Polaris and its three Claudes | one Polaris row with Kochab, Pherkad and Yildun as sub-lines (hq#177 "Pole stars"); actions only: □ sent the team a request, ◇ commented, ◉ merged a pull request, plus their pull requests and reviews | `replay.work` |
| CI band | one shared band with no owner: a tick for passed, a red ✕ for failed | `state.ci` (CI runs are not in the replay; see Found) |
| Moment column | Now: the state in words (`doing()`), then the stage and since when (`column()`, `STAGE_NAME`). Scrubbed: that ten minutes' actions or counts, and the stage then | `words.js`, `line.js` |
| Hatching | where the page doesn't know: no word since the last report, older CI runs not kept, older actions not kept (above `REPLAY_WORK`), or nothing arrived yet | `lastIngest`, `state.ci` length, `replay.work` length |
| Key | only the marks that are on this day | `ACTION_TEXT` and `STAGE_NAME` |
| "The day as a table" | every action and CI run, newest first, with a glyph and the `deed()` words | the same data |

There are **no deploy marks** (hq#177). The helper column (subagents and skills) is in the data but
not drawn. Adding it would mean a third density row per lane, which I left out to keep the lane
readable.

## Phone (375)
- The lanes run down the page, with now at the top. Each lane is a column with the Claude bars,
  the stage track and the chat bars.
- The pole stars' names are set vertically, so each column has its full name.
- Above the chart, the moment column becomes a list: one line per row, with the tally. It
  answers the 10-second question before the chart, and it changes with scrubbing like the wide
  column does.

## Wall (2560×1440): what I chose and why
hq#177 gave Day no wall layout. My proposal is **the same view, set larger, in one fixed dark
theme**, with no second layout.
- **The type** is set for about 6 m (Lyra's target): names at 44 px, the headline at 62 px, the
  moment column at 32 px, and nothing smaller than 22 px.
- **The moment column is wider (760 px).** From across a room, the right edge carries the "now"
  answer, and the lanes show the day behind it.
- **The switcher, the keyboard hints and the table are hidden.** Nobody scrubs a wall.
- **The theme is dark and fixed.** A screen that is on all day should not change theme with the
  hour (hq#177, question 7), and a dark ground glares less in an office. There is no Day/Night
  toggle on the wall.

What I rejected:
- **A shorter window (12 hours) to make the marks bigger.** It would make the wall disagree with
  the page about "today".
- **Moving the moment column to the top as a Roster-like list.** That is option A; it is better
  judged on its own.

## Accessibility
- **Glyph and label on every mark.** Each mark has its own shape and carries a `<title>` with
  its label (for example "Orion opened a pull request in setkernel-live, 10:31"). The key, the
  scrub readout and the table give the same words.
- **Keyboard scrubbing.** The chart is a focusable `role="slider"`. The keys:
  - ← and → move ten minutes; ↑ and ↓ do on the phone.
  - Shift moves an hour; Page Up and Page Down move three hours.
  - Home and End go to the start and to now.
  - `[` and `]` jump to the previous or next ten minutes with an action, which matters on a
    quiet day.
  - Esc goes back to now.

  Each step updates `aria-valuetext` and a polite live region. Example: "11:40 to 11:50. Rigel:
  In review, no activity. Lyra: approved a teammate's pull request." Hovering and clicking scrub
  too.
- **Table fallback.** "The day as a table" lists every action and CI run, with a time, who, a
  glyph and the words.
- **Contrast.** Text uses ink tones that are at least 4.5:1 on the ground. The bars and rules
  that carry data are at least 3:1.

## The quiet day (the risk hq#177 names)
The quiet-day dataset is written by hand, and nothing is added to fill the lanes. It contains:
- one job: Polaris asks at 08:50, Orion picks it up at 09:12, CI fails, Orion pushes fixes, Lyra
  approves at 11:41, and Polaris merges at 14:02;
- Rigel's pull request from yesterday evening;
- nothing from Vega or the three Claudes.

On this data the design reads as a day with one finished job and one pull request that has
waited all day. The empty lanes show as empty, and the gutter says "nothing yet today"
(`tally()`'s own words).
- Rigel's heavy "In review since 19:20" bar spanning the whole day is the most useful thing on
  this screen: it shows work waiting on a reviewer.
- Lyra's lane is a single ✓ and 17 Claude requests.

## Open questions for Raghav
These are hq#177's recommendations as they show in the prototype, and what the build would need
to settle.

1. **Star names only, with no sky imagery** (hq#177, question 3). The names appear as lane
   names, and "the director" (`STAR_NOTE`) appears beside Polaris. There is no star, ring or
   constellation anywhere. Is the brand fine without the imagery?
2. **"About a minute behind" in place of "LIVE"** (question 4). This is the masthead's right
   side, in the live and quiet moods. Offline shows only "updated 47 min ago", and waiting shows
   nothing.
3. **"Today" is the Halifax day** (question 5). It shows in three places:
   - the "Today · 00:00 ADT" rule on the axis;
   - "Today's counts since 00:00 ADT" under the chart title;
   - every tally, because the fixtures pass the Halifax date as `applyBatch`'s day key.

   A visitor in London would see the rule at 04:00 BST, which publicly implies the team's
   timezone. In the real page this is a logic change (`state.js` resets at the UTC day), not
   only a renderer change.
4. **One fixed theme on the wall** (question 7). The wall layout is dark and has no toggle.
5. **Scrubbing limits** (hq#177, Orion and Rigel). The prototype bears out both of them:
   - Replay keeps no agent states, so scrubbing shows each lane's stage and its actions and
     counts, never "Working" or "Idle" for a past minute.
   - Stages come from `stepLines()` over the replay, seeded by `seedLanes()` from the live lanes.
     A job that started and ended before the 24-hour window, or one in a private repo whose
     review the page can't attribute, shows no stage. Fixing appears only when `laneAuthor()`
     can tell whose pull request the change request was on, which means public repos only.
   - Yildun's Claude requests are counted in its tally ("199 Claude") but have no lane density,
     because the replay keeps no column for them.
6. **CI history.** CI runs are not in the replay buffer. Only the 20 most recent (`CI_RECENT`)
   are kept, so on the busy day the band is hatched before 06:15 ("Older runs aren't
   kept"). Should the build add CI to the replay buffer? That would change its size budget
   (`test/state.test.mjs`).
7. **The 300-action cap.** At the demo's own speed (about 800 actions a day), `REPLAY_WORK = 300`
   keeps only the last 9 hours. Day would then hatch the morning ("Older actions aren't kept";
   the prototype handles this). The busy fixture is the demo slowed 4×, which makes 176 actions
   in 24 hours, in line with "a busy day is under 200". If real days run over 300, the cap needs
   raising for Day.
8. **Audience.** Day leads with the client story. hq#177 recommends the wall and the 10-second
   question first (question 2). Here the headline and the moment column carry that answer; does
   that go far enough?

## Fixtures
`build.mjs` builds them and writes them into `index.html`, together with the fonts, `words.js`
and `line.js`. A page opened from disk can't import ES modules, so the wording and stages are
inlined verbatim, with only `import` and `export` removed. The build:
1. runs every event through the real `cleanEvent` and fails unless it comes out unchanged, and
   checks agent states the same way through `cleanBatch`;
2. builds the state and the replay with the real `applyBatch` and `recordReplay`, in one-minute
   batches.

The fixture clock stops at Wednesday 14 October 2026, 16:40 ADT. The datasets:
- **Busy day:** `createDemo(17)` slowed 4×. Only the timestamps change.
- **Quiet day:** written by hand, as described above. Its live mood adds Vega picking up an issue
  at 16:31.
- **Quiet mood on the busy day:** the busy day with every engineer `IDLE`.
- **Offline:** each day's state as of 15:53.
- **Waiting:** an empty state.

```sh
node docs/design/v3/day/build.mjs                       # rebuild index.html from the fixtures
npm i --prefix "$TMPDIR/pw" playwright && npx --prefix "$TMPDIR/pw" playwright install chromium
PLAYWRIGHT_DIR="$TMPDIR/pw" node docs/design/v3/day/shoot.mjs   # retake every PNG, in Halifax time
```
`shoot.mjs` fails if the page throws or makes any request that isn't to `file:` or `data:`.

## Review rounds
**Round 1** (first shots):
- Tallies and the pole-star lines in the moment column were cut off ("948 Clau…", "had a pull
  request merged in a private proj…").
- The key ran to three rows and fell below the fold at 900 px.
- The moment column said "◎ Reviewing · In review" for Orion. That mixed his state (reviewing
  someone else's pull request) with his own job's stage, and it read as a contradiction.
- Waiting drew an empty grid that looked broken rather than designed.
- The wall overflowed: the CI band was cut, and there was no key.
- On the phone, the pole stars' columns read "P K P Y" (two Ps), and "Yesterday" ran into the
  marks.

**Changes after round 1:**
- The gutters are wider (216 and 320 px).
- The pole stars' moment lines use the action words without the place, which stays in the hover
  label and the table.
- The keyboard hint moved up beside the chart title, the vertical spacing is tighter, and the
  chat bars are lighter.
- The moment column now has two lines: first the state in `doing()`'s words ("◎ Reviewing a pull
  request in setkernel-live"), then, on the track's own baseline, the stage and since when ("In
  review since 15:22"). The stage label reads as the end of the track.
- Waiting hatches the whole day with "Nothing has arrived yet", the same visual language as
  offline, and hides the key.
- The wall's rows were re-proportioned so the whole view fits.
- The phone shows the pole stars' full names set vertically, and "Today" plus the time at
  midnight.

**Round 2:**
- The key still wrapped, with CI's two items orphaned on a third row.
- Scrubbed lines were cut ("Approved a teammate's pull request in a priva…").
- The scrub focus frame was a heavy 2 px blue box.
- The keyboard hint showed on the phone, which has no keyboard.
- On the wall, Polaris's tally touched Kochab's line, and the 06:00 and 18:00 labels were lost
  to a symmetric collision rule.
- Yildun's tally was cut.

**Changes after round 2:**
- CI passed and failed are one key item.
- Scrubbed lines use the action words.
- The focus frame is 1 px.
- The phone hides the keyboard hint, and its pole-star lines say `tally()`'s "nothing yet today"
  instead of a dash.
- The wall's Polaris row is taller.
- Axis labels avoid the midnight label differently on each side, and the sub-line tallies take
  the room left after the name.

**Round 3** checked the result:
- The Polaris row on the quiet day needed 6 px more, so that its tally clears Kochab.
- "21:00" sat against "Yesterday".

Both are fixed in the shots above.

**What I would still change:**
- On the busy day the marks crowd where a pull request opens and merges within minutes. At
  1440 px a mark is 11 px across and a ten-minute column is 5 px.
- The offline hatch for 47 minutes is too narrow to carry its label; the headline says it
  instead.
