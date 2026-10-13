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
# test:     npm test                 (node --test: allowlist, state and replay buffer, Access token
#                                    check, page wording/demo/replay/layout, page hosts and contrast)
# lint:     npm run check            (node --check on every script)
# validate: npm run validate         (check + test + wrangler deploy --dry-run; what CI runs)
```

## Deploy
`.github/workflows/deploy.yml`, started by hand (workflow_dispatch) on `main`. It reads
`CLOUDFLARE_API_TOKEN` from Infisical (project `setkernel-live`, prod) through the OIDC identity
`setkernel-live-deploy`, which accepts only that workflow on `main`. The token itself is
`setkernel-live-deploy` in setkernel-cloudflare `stacks/services/api_tokens.tf`. Never deploy from
a laptop.

## Layout
- `src/worker.js`: routes (`/ws`, `/api/state`, `/api/replay`, `/ingest`) and the `Hub` Durable Object.
- `src/logic.js`: the allowlist (pure, tested); re-exports the state from `public/lib/state.js`.
- `src/access.js`: checks the Cloudflare Access token on `/ingest` (pure, tested).
- `public/`: the page (`index.html`, `app.js`, `style.css`), its security headers (`_headers`),
  `favicon.svg`, `og.png` (the share preview) and `fonts/`.
- `public/lib/`: ES modules for the page. `state.js` is the public state and the 24-hour replay
  buffer; the Durable Object and `?demo` both run it. `words.js` (wording, aria-live summary),
  `demo.js` (seeded sample data), `replay.js` (the replay show) and `layout.js` (the sky at any
  size) are pure and tested; `sky.js` draws the canvas.
- `test/`: `node --test` suites.

## Traps and don't-touch
- Anything added to what the page shows must be added to the allowlist on **both** sides
  (setkernel/hq `observability/wall/public.py` and `src/logic.js`) and to both test suites. Never
  show issue or PR titles or numbers, usernames, hostnames, private repo names or costs.
- `INGEST_AUD` in `wrangler.jsonc` is the audience tag of the "live ingest" Access app (not a
  secret). Empty means `/ingest` answers 503.
- `public/lib/state.js` is served to visitors (demo mode runs it) and bundled into the Worker.
  It must stay pure and hold nothing private. The replay buffer is capped so the stored value
  stays under 100 KiB (`test/state.test.mjs`); keep that test passing if you add a column.
- `?demo` data must pass `cleanEvent` unchanged (`test/page-logic.test.mjs`). If the allowlist
  changes, the demo changes with it.
- Text colours are checked for contrast in `test/page.test.mjs`; a new colour goes in its list.
- The page builds everything with `textContent`, never `innerHTML`; keep it that way. The CSP in
  `public/_headers` allows only same-origin scripts, styles and fonts; the fonts are self-hosted in
  `public/fonts/` (SIL OFL, licences beside them). Never add a third-party host.
- The Durable Object migration tag `v1` creates `Hub`; never edit an applied migration, add a new tag.
