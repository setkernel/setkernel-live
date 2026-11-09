# AGENTS.md

What anyone, person or coding agent, needs to know to work in **this** repository.
`CLAUDE.md` only points here. Org-wide rules (tracking work on the board, when to stop and ask,
secrets, branches and commits, the end-of-run report) come from setkernel's central agent setup
(https://github.com/setkernel/hq/blob/main/docs/repo-standard.md); don't repeat them here.

## What this repo is
The public page at https://live.setkernel.com: a Cloudflare Worker with static assets and one
Durable Object. sk-obs01 pushes filtered, delayed events to it; visitors watch over a WebSocket.
It also holds `workers/meter`, sk-meter, the Cloudflare billing guard (an hourly cron, no route;
`workers/meter/README.md`), moved here on 2026-11-09 (setkernel/hq#1449).
Public repo: everything here is visible to anyone.

## Commands
```sh
# install:  npm ci
# test:     npm test                 (node --test: allowlist, state, the Halifax day and replay buffer,
#                                    the line's columns, Access token check, GitHub receiver, page wording/
#                                    headline/demo/replay, Day's lanes/Now column/key/scrubbing/fitWall,
#                                    Buzz alert, page hosts, fonts and contrast, the smoke check, the showcase's
#                                    publisher, the workflow runner guard, the visual-diff check's plan and workflow,
#                                    its poster (the artifact, the pull request, the shots branch, the comment),
#                                    and repo names against GitHub's public list, live)
# worker:   npm run test:worker      (vitest in workerd: the real Worker and Hub, see test/worker/)
# meter:    npm run test:meter       (node --test: sk-meter's guard, usage queries, alert, baseline)
# lint:     npm run check            (node --check on every script)
# validate: npm run validate         (check + test + test:worker + test:meter + a wrangler deploy --dry-run
#                                    of each Worker; what CI runs)
```

## Deploy
`.github/workflows/deploy.yml`, runs on every push to `main` (docs-only ones too) and by hand
(workflow_dispatch). It is setkernel/hq's deploy contract template (`templates/repo/.github/workflows/deploy.yml`
at 6e8fdbd) and must keep passing hq `tools/check-deploy-contract.py --repo setkernel-live`: a failed
smoke rolls back to the version live before, smokes that, and opens an `agent-ready` issue (`owner` too
if the rollback or its smoke fails). Where it differs from the template, the header says why (`npm run
validate`, the identity and folder, `VERSION` and the Worker secrets in the deploy's one version). It
reads `CLOUDFLARE_API_TOKEN`, `GITHUB_WEBHOOK_SECRET` and `BUZZ_PRIVATE_KEY` from Infisical (project
`setkernel-live`, prod, `/`) through the OIDC identity `setkernel-live-deploy`, which accepts only that
workflow file on `main` (its binding is the file, not a job); only the `deploy`, `rollback` and
`meter` jobs ask for it. The token itself is
`setkernel-live-deploy` in setkernel-cloudflare `stacks/services/api_tokens.tf`. Never deploy from
a laptop.
The same workflow's `meter` job deploys sk-meter (`workers/meter/wrangler.toml`) with that token,
checks that its version serves all traffic and rolls it back in the job if not. A failed rollback,
or nothing live to roll back to, gives the issue `owner` too.

## Layout
- `src/worker.js`: routes (`/ws`, `/api/state`, `/api/replay`, `/ingest`, `/ingest/usage`, `/ingest/limits`, `/usage/data`, `/usage/`, `/github/webhook`, `/github/queue`) and the `Hub` and `Usage` Durable Objects.
- `src/logic.js`: the allowlist (pure, tested); re-exports the state from `public/lib/state.js`.
- `src/access.js`: checks the Cloudflare Access token on `/ingest` and `/github/queue` (pure, tested).
- `src/github.js`: the GitHub Actions webhook check, the fields it keeps, and the pull queue (pure, tested).
- `src/usage.js`: what `/ingest/usage` and `/ingest/limits` accept (`cleanUsage`, `cleanLimits`) and how
  `/usage/data` sums usage per Halifax day (pure, tested); the `Usage` Durable Object (SQLite, migration `v2`;
  `seat_limits` is created in code) is in `src/worker.js`. Private: never route it to the Hub. Its seats are
  the employees in `src/hq-registry.json`, plus polaris, codex and other.
- `scripts/copy-hq-registry.mjs`: writes `src/hq-registry.json` from setkernel/hq `registry/people.csv`
  (setkernel-live#96): each employee who isn't removed, handles only (`--check` compares).
- `src/watch.js`: when to post "updates stopped" and "updates resumed" to Buzz (pure, tested).
- `src/buzz.js`: signs and posts a Buzz message as the Worker's own identity (tested).
- `src/evidence.js`: the v4 showcase's publisher (setkernel-live#52), a public pull request's evidence and
  the team's numbers, as an allowlist (pure, tested). Only the v4 prototype uses it so far.
- `docs/design/v4/showcase/`: the v4 prototype (one `index.html`, its `build.mjs`, `shoot.mjs`,
  `evidence.json` and screenshots). Nothing in `public/` comes from it until Raghav picks a direction.
- `docs/design/v3/not-reporting/`: the prototype for setkernel-live#54 (an engineer whose VM stopped
  reporting). `build.mjs` bundles `public/app.js` with `src/`'s overrides into one `index.html`.
  Raghav picked option C; `public/` builds it (`SILENT`, `?demo=down`), and the prototype stays as it was.
- `public/`: the page, v3 "Day" (`index.html`, `app.js`, `style.css`, `early.js` for `?wall`
  before the first paint), its security headers (`_headers`), `favicon.svg`, `og.png` (the share
  preview, taken by `docs/design/v3/day/built/shoot.mjs`) and `fonts/`. The design is
  `docs/design/v3/day/` (the prototype and its README); `built/` holds the built page's shots.
- `public/usage/`: the private usage page's files (setkernel-live#71), served by the Worker only with
  a `USAGE_AUD` token (`run_worker_first` in `wrangler.jsonc`, pinned by `test/usage-page.test.mjs`).
  `table.js` (a month's totals, rows, cells, the box's text and each seat's trend) and `limits.js` (the
  5-hour and weekly windows: alert, limit, stale, not reported, Codex) are pure and tested; `page.js`
  draws them, tested against a stand-in document. `usage.css` carries its own palette (contrast checked
  in that test) and loads only `public/usage/fonts/`. `docs/design/usage/shoot.mjs` takes its shots.
  Never move them out of `/usage`.
- `public/lib/`: ES modules for the page. `state.js` is the public state, the Halifax day
  (`homeDay`, `homeMidnight`) and the 24-hour replay buffer; the Durable Object and `?demo` both
  run it. `line.js` derives each engineer's stage (state.js keeps the lanes). `words.js` (wording,
  the headline, aria-live summary), `day.js` (the lanes, stages, marks, Now column, key, table and
  scrubbing, from the view and the replay), `layout.js` (the grid, the page's modes and `fitWall`),
  `demo.js` (seeded sample data and the busy and quiet days) and `replay.js` (the replay plan) are
  pure and tested; `chart.js` draws the SVG.
- `scripts/smoke.mjs`: the post-deploy smoke check (no dependencies); waits for `/api/state`'s
  `version` (the `VERSION` var, set at deploy) to be the deployed commit, then checks each route.
- `scripts/visual-diff.mjs` and `.github/workflows/visual-diff.yml`: the visual-diff check (setkernel-live#74).
  On every pull request that touches `public/` (not `public/usage/`), it draws `?demo` from the base and
  from the head at 1440x900 and 375x812, on one runner with a pinned Playwright, and keeps the shots
  as the run's `visual-diff` artifact. It fails only when the head page errs. It always runs, and
  passes with no UI change, so it can be a required check: never give it a `paths:` filter or a job `if:`.
- `scripts/visual-diff-post.mjs` and `.github/workflows/visual-diff-comment.yml`: its poster. A
  `workflow_run` after "Visual diff", from main, with the only write token a pull request's run can
  reach: it commits the shots to the orphan branch `visual-diff-shots` (`pr-<n>/<head sha>/`) and keeps
  one comment marked `<!-- sk-visual head=<sha> -->`. The artifact is untrusted (a fork's pull request
  can change the workflow that made it): never check out or run the pull request's code there, never
  put text from the artifact in the comment, and never write any ref but `visual-diff-shots`.
  The poster reads only the files main's `SHOTS` (in `scripts/visual-diff.mjs`) names, so a pull request
  that changes `SHOTS` gets no comment ("unexpected file in the artifact") until it merges.
- `workers/meter/`: sk-meter, its own Worker (`wrangler.toml`, not `wrangler.jsonc`): `src/` the hourly
  run and the guard flags, `allowances.json`, `tools/` the baseline and the offline drill, `test/` its
  `node --test` suites. Its settings come from the Infisical -> Workers sync (`keep_vars = true`).
- `test/`: `node --test` suites for the pure modules and the page (`day.test.mjs` for Day).
- `test/worker/`: vitest suites run in workerd by `@cloudflare/vitest-plugin` (`vitest.config.mjs`
  reads `wrangler.jsonc`). They fake Access's certs with a throwaway key and drive every route
  end to end.

## Traps and don't-touch
- A workflow that a pull request starts must run on a GitHub-hosted runner (`ubuntu-latest`), never
  `setkernel-linux`: this repo is public and a fork's PR runs its code. `test/workflows.test.mjs` enforces it.
- Anything added to what the page shows must be added to the allowlist on **both** sides
  (setkernel/hq `observability/wall/public.py` and `src/logic.js`) and to both test suites. Never
  show issue or PR titles or numbers, usernames, hostnames, private repo names or costs.
- `/github/webhook` is public; the HMAC check is its only gate. Never store or log the payload,
  and never widen what `cleanWebhook` keeps without the same review as the page allowlist.
- `QUEUE_AUD` works like `INGEST_AUD` below, for the "live queue" Access app. `GITHUB_WEBHOOK_SECRET`
  is a Worker secret set by the deploy workflow from Infisical; never put it in `vars`.
- `USAGE_AUD` is the same for the "live usage" Access app in front of `/usage` (output `live_usage_aud`;
  setkernel-cloudflare#119); `/usage/data` is open behind it. That app sends a visitor with no login a
  302 to `setkernel.cloudflareaccess.com`, which the smoke check accepts for that route only. Empty
  would make `/usage/data` answer 503.
- `INGEST_AUD` in `wrangler.jsonc` is the audience tag of the "live ingest" Access app (not a
  secret). Empty means `/ingest` answers 503.
- `public/lib/state.js` is served to visitors (demo mode runs it) and bundled into the Worker.
  It must stay pure and hold nothing private. The replay buffer is capped so the stored value
  stays under 128 KiB even at its worst (`test/state.test.mjs`); keep that test passing if you add a column.
- "Today" is the Halifax day: the Worker passes `homeDay()` as `applyBatch`'s day key, so the counts
  reset at midnight in Halifax (AST or ADT), and the page shows that midnight on the visitor's clock.
- `?demo` data (and `?demo=quiet|offline|down|waiting`) must pass `cleanEvent` unchanged
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
- Fonts follow setkernel/hq `docs/repo-standard.md` ("Fonts"): every stack is a self-hosted face,
  then one generic family (`"Manrope", sans-serif`, `"IBM Plex Mono", monospace`), never a named
  system font. The design mockups embed the files from `public/fonts/` (`docs/design/v2/fonts.mjs`,
  `docs/design/v3/day/build.mjs`); `test/page.test.mjs` checks all of it.
- `public/og.png` (the share preview) is taken by `docs/design/v3/day/built/shoot.mjs` (the `?demo`
  page at 1440x756, scaled to 1200x630; last regenerated in #49). That script renders through the
  host's system fonts, with no TTF files and no pinned `FONTCONFIG_FILE`, so glyphs outside the
  Latin subset (`●`, `○`, `→`) depend on the machine. Pin both when `og.png` is next regenerated.
- `BUZZ_PRIVATE_KEY` is a Worker secret from Infisical (README, "When updates stop"); never put it
  in `wrangler.jsonc`, a log line or an error message.
- The Durable Object migration tag `v1` creates `Hub`; never edit an applied migration, add a new tag.
- `test/private-repos.test.mjs` asks the GitHub API for setkernel's public repos. With `LIVE_REPO_CHECK=1`
  (set only in `ci.yml`) a failed request fails it; elsewhere, including the deploy's re-gate (no
  token), it skips. A repo the page names that isn't on that list fails it.
  `evidence.json` is regenerated by `build.mjs --fetch` and goes through `publishEvidence`; never edit it by hand.
- `src/hq-registry.json` is written only by `scripts/copy-hq-registry.mjs`; never edit it by hand, and never
  copy more than handles into it (no logins, ids, names or emails: this repo is public).
- vitest stays on 4.1.x for now: with vitest 5.0.4, `@cloudflare/vitest-plugin` 1.4.0 fails every
  suite ("no such file or directory, readAll …/.vitest-cache/…").
- In worker tests, read every response body. An unread body keeps the request open, and
  `evictDurableObject` then waits for it until the test times out.
