# AGENTS.md

What anyone, person or coding agent, needs to know to work in **this** repository.
`CLAUDE.md` only points here. Org-wide rules (tracking work on the board, when to stop and ask,
secrets, branches and commits, the end-of-run report) come from setkernel's central agent setup
(https://github.com/setkernel/hq/blob/main/docs/repo-standard.md); don't repeat them here.

## What this repo is
The public page at https://live.setkernel.com: a Cloudflare Worker with static assets and one
Durable Object. sk-obs01 pushes filtered, delayed events to it; visitors watch over a WebSocket.
Public repo: everything here is visible to anyone.

## Commands
```sh
# install:  npm ci
# test:     npm test                 (node --test: allowlist, state, the Halifax day and replay buffer,
#                                    the line's columns, Access token check, GitHub receiver, page wording/
#                                    headline/demo/replay, Day's lanes/Now column/key/scrubbing/fitWall,
#                                    page hosts, fonts and contrast, the smoke check, the showcase's
#                                    publisher, and repo names against GitHub's public list, live)
# worker:   npm run test:worker      (vitest in workerd: the real Worker and Hub, see test/worker/)
# lint:     npm run check            (node --check on every script)
# validate: npm run validate         (check + test + test:worker + wrangler deploy --dry-run; what CI runs)
```

## Deploy
`.github/workflows/deploy.yml`, started by hand (workflow_dispatch) on `main`. It reads
`CLOUDFLARE_API_TOKEN` from Infisical (project `setkernel-live`, prod) through the OIDC identity
`setkernel-live-deploy`, which accepts only that workflow on `main`. The token itself is
`setkernel-live-deploy` in setkernel-cloudflare `stacks/services/api_tokens.tf`. Never deploy from
a laptop.

## Layout
- `src/worker.js`: routes (`/ws`, `/api/state`, `/api/replay`, `/ingest`, `/github/webhook`, `/github/queue`) and the `Hub` Durable Object.
- `src/logic.js`: the allowlist (pure, tested); re-exports the state from `public/lib/state.js`.
- `src/access.js`: checks the Cloudflare Access token on `/ingest` and `/github/queue` (pure, tested).
- `src/github.js`: the GitHub Actions webhook check, the fields it keeps, and the pull queue (pure, tested).
- `src/evidence.js`: the v4 showcase's publisher (setkernel-live#52), a public pull request's evidence and
  the team's numbers, as an allowlist (pure, tested). Only the v4 prototype uses it so far.
- `docs/design/v4/showcase/`: the v4 prototype (one `index.html`, its `build.mjs`, `shoot.mjs`,
  `evidence.json` and screenshots). Nothing in `public/` comes from it until Raghav picks a direction.
- `docs/design/v3/not-reporting/`: the prototype for setkernel-live#54 (an engineer whose VM stopped
  reporting). `build.mjs` bundles `public/app.js` with `src/`'s overrides into one `index.html`;
  `public/` is unchanged until Raghav picks an option.
- `public/`: the page, v3 "Day" (`index.html`, `app.js`, `style.css`, `early.js` for `?wall`
  before the first paint), its security headers (`_headers`), `favicon.svg`, `og.png` (the share
  preview, taken by `docs/design/v3/day/built/shoot.mjs`) and `fonts/`. The design is
  `docs/design/v3/day/` (the prototype and its README); `built/` holds the built page's shots.
- `public/lib/`: ES modules for the page. `state.js` is the public state, the Halifax day
  (`homeDay`, `homeMidnight`) and the 24-hour replay buffer; the Durable Object and `?demo` both
  run it. `line.js` derives each engineer's stage (state.js keeps the lanes). `words.js` (wording,
  the headline, aria-live summary), `day.js` (the lanes, stages, marks, Now column, key, table and
  scrubbing, from the view and the replay), `layout.js` (the grid, the page's modes and `fitWall`),
  `demo.js` (seeded sample data and the busy and quiet days) and `replay.js` (the replay plan) are
  pure and tested; `chart.js` draws the SVG.
- `scripts/smoke.mjs`: the post-deploy smoke check (no dependencies); waits for `/api/state`'s
  `version` (the `VERSION` var, set at deploy) to be the deployed commit, then checks each route.
- `test/`: `node --test` suites for the pure modules and the page (`day.test.mjs` for Day).
- `test/worker/`: vitest suites run in workerd by `@cloudflare/vitest-plugin` (`vitest.config.mjs`
  reads `wrangler.jsonc`). They fake Access's certs with a throwaway key and drive every route
  end to end.

## Traps and don't-touch
- Anything added to what the page shows must be added to the allowlist on **both** sides
  (setkernel/hq `observability/wall/public.py` and `src/logic.js`) and to both test suites. Never
  show issue or PR titles or numbers, usernames, hostnames, private repo names or costs.
- `/github/webhook` is public; the HMAC check is its only gate. Never store or log the payload,
  and never widen what `cleanWebhook` keeps without the same review as the page allowlist.
- `QUEUE_AUD` works like `INGEST_AUD` below, for the "live queue" Access app. `GITHUB_WEBHOOK_SECRET`
  is a Worker secret set by the deploy workflow from Infisical; never put it in `vars`.
- `INGEST_AUD` in `wrangler.jsonc` is the audience tag of the "live ingest" Access app (not a
  secret). Empty means `/ingest` answers 503.
- `public/lib/state.js` is served to visitors (demo mode runs it) and bundled into the Worker.
  It must stay pure and hold nothing private. The replay buffer is capped so the stored value
  stays under 128 KiB even at its worst (`test/state.test.mjs`); keep that test passing if you add a column.
- "Today" is the Halifax day: the Worker passes `homeDay()` as `applyBatch`'s day key, so the counts
  reset at midnight in Halifax (AST or ADT), and the page shows that midnight on the visitor's clock.
- `?demo` data (and `?demo=quiet|offline|waiting`) must pass `cleanEvent` unchanged
  (`test/page-logic.test.mjs`). If the allowlist changes, the demo changes with it. The demo names
  only a real public repo.
- Text colours are checked for contrast in `test/page.test.mjs`, on the page (`:root`) and on the
  wall (`html.wall`, one fixed dark theme); a new colour goes in its list and needs a value in both.
  Nothing on the page is under 12 px. The page stores nothing (no `localStorage`).
- Every SVG colour is a class in `style.css` (`f-*`, `s-*`, `st-*`), never a `style` attribute or a
  `var()` in script: the CSP allows no inline style. A wall's size comes only from `fitWall`
  scaling the 1440 x 810 canvas; never lay the wall out at the screen's own size.
- The page builds everything with `textContent`, never `innerHTML`; keep it that way. The CSP in
  `public/_headers` allows only same-origin scripts, styles and fonts; the fonts are self-hosted in
  `public/fonts/` (SIL OFL, licences beside them). Never add a third-party host.
- The Durable Object migration tag `v1` creates `Hub`; never edit an applied migration, add a new tag.
- `test/private-repos.test.mjs` asks the GitHub API for setkernel's public repos. With `LIVE_REPO_CHECK=1`
  (set only in `ci.yml`) a failed request fails it; elsewhere, including the deploy's re-gate (no
  token), it skips. A repo the page names that isn't on that list fails it.
  `evidence.json` is regenerated by `build.mjs --fetch` and goes through `publishEvidence`; never edit it by hand.
- vitest stays on 4.1.x for now: with vitest 5.0.4, `@cloudflare/vitest-plugin` 1.4.0 fails every
  suite ("no such file or directory, readAll …/.vitest-cache/…").
- In worker tests, read every response body. An unread body keeps the request open, and
  `evictDurableObject` then waits for it until the test times out.
