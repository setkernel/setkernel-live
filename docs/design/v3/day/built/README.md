# Day, built: screenshots of the page

These are the built page (`public/`) on `?demo`, taken by `shoot.mjs` in this folder at the
prototype's clock (Wednesday 14 October 2026, 16:40 ADT) and in Halifax time, so each one can be
laid beside the prototype's shot of the same name in [`..`](..).

```sh
npm i --prefix "$TMPDIR/pw" playwright && npx --prefix "$TMPDIR/pw" playwright install chromium
PLAYWRIGHT_DIR="$TMPDIR/pw" node docs/design/v3/day/built/shoot.mjs          # every shot, and public/og.png
PLAYWRIGHT_DIR="$TMPDIR/pw" node docs/design/v3/day/built/shoot.mjs wall     # only names containing "wall"
```

`shoot.mjs` serves `public/` itself with the headers from `public/_headers`, so it fails on a CSP
violation, a page error, a request to another host, horizontal scroll, or a wall canvas that
doesn't fit the window.

| Shot | Address | What it shows |
|---|---|---|
| `day-live-1440x900.png` | `?demo` | the busy day, live |
| `day-live-api-1440x900.png` | `/` | the same day through `/api/state`, `/api/replay` and `/ws` (answered by `shoot.mjs`), so the masthead reads "About a minute behind · updated 6 s ago" |
| `day-quiet-1440x900.png` | `?demo=quiet` | the quiet day, everyone idle |
| `day-offline-1440x900.png` | `?demo=offline` | the busy day as it stood at 15:53 |
| `day-waiting-1440x900.png` | `?demo=waiting` | nothing has arrived |
| `day-scrub-1440x900.png` | `?demo` | scrubbed to 10:20 with the keyboard |
| `day-live-375x812.png`, `day-live-375-full.png`, `day-quiet-375x812.png` | `?demo`, `?demo=quiet` | the phone |
| `day-live-1024x768.png` | `?demo` | a width the prototype didn't draw: the Now list above the chart |
| `day-wall-*.png` | `?demo&wall` | the wall at 2560×1440, 1920×1080, 1440×810, a quiet day, and a 1280×1024 window |
| `day-down-*.png`, `day-wall-down-1920x1080.png` | `?demo=down` | Orion's VM stopped at 14:05 (setkernel-live#54, option C of [`../../not-reporting`](../../not-reporting/README.md)): the page, scrubbed to 15:20, the phone and the wall |

## Where the built page differs from the prototype, on purpose
- **The masthead on `?demo`** says "Demo: sample data, not the real office · live page" where the
  prototype says "About a minute behind · updated 6 s ago": the demo isn't the office.
  `day-live-api-1440x900.png` shows the live masthead.
- **The key's ✕ and CI-failed bar are red**, as on the chart. In the prototype the key drew them in
  ink, because `.legend svg` outranked the red class (the bug its round 2 fixed for the chart's marks).
- **The waiting line** says "Nothing has arrived yet. This page fills in by itself." The prototype
  kept v2's "Replay the last 24 hours, or watch the demo.", and Day has no replay button.
- **Widths from 720 to 1231 px**, which the prototype didn't draw, put the Now list above the chart
  (as on the phone) and run the lanes across, because the Now column needs its 376 px.
- **The chart's columns end on a ten-minute boundary**, so a scrubbed column reads "10:20–10:30"
  whatever the clock; the now line sits inside the last column.
- **The quiet mood on the busy day** isn't offered: `?demo=quiet` is the hand-written quiet day,
  as in the prototype's quiet shots.
