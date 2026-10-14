# setkernel-live

**https://live.setkernel.com**: what setkernel's four AI engineers (Vega, Rigel, Lyra and Orion)
are doing, about a minute behind, drawn as a night sky. Each agent is a star whose glow follows its
work; each Claude request, GitHub action or team-chat post is a pulse of light from the star to
where the work went, and a review draws a line between two stars. Under the sky: today in a few
numbers, the last 24 hours, and the recent-work stream.

- `?demo`: sample data (labelled as such), so the page can be shown any time.
- `?wall`, or the Wall mode button: a layout for a big screen.
- Replay: the last hour in a minute, or the last 24 hours in two, from a capped buffer of
  already-allowlisted events in the Durable Object (`GET /api/replay?h=1|24`).

## How it works

```
sk-obs01 (office)                       Cloudflare                              visitors
wall service ── filtered events ──▶  /ingest (Access: service token only) ──▶  Durable Object ──▶ /ws
                 every 5 s,                                                    holds the picture,
                 60 s late                                                     fans out batches
```

- The office never accepts connections from the internet. sk-obs01 pushes; the page only reads.
  If the pushes stop, the page says the office is offline.
- What may appear is an allowlist, checked twice: on sk-obs01 (setkernel/hq
  `observability/wall/public.py`) and again here (`src/logic.js`). Agents by first name, the kind
  of work, a dot per Claude request and per team-chat post, a short list of GitHub actions, CI
  results (pass or fail; a private repo's run is just "a private project"), and a repo's name only
  when the repo is public. No code, conversations, titles, numbers, usernames, hostnames, branches,
  commit messages, run links or customer data.
- `/ingest` sits behind a Cloudflare Access app that admits only the `live-ingest` service token
  (setkernel/setkernel-cloudflare, access stack). The Worker checks the Access token again.

## Deploy

The Deploy workflow (`.github/workflows/deploy.yml`) runs `npm run validate` and deploys. Never
deploy from a laptop. `/api/state` carries `version`, the `VERSION` var from `wrangler.jsonc`:
`dev` unless the deploy sets the commit with `wrangler deploy --var VERSION:<commit>`.

`node scripts/smoke.mjs --expect <commit>` first polls `/api/state` until its `version` is that
commit. The field comes from the Durable Object's own code, and for a few minutes after a deploy
the object can still run the previous version, so the check waits up to 10 minutes. Then it checks
each route once: `/` 200, `/api/state` 200 with every key the page uses, `/api/replay?h=1` 200,
`GET /github/webhook` 405 (POST only) and `GET /github/queue` 401 (Access answers first). It prints
status codes, key names and the version, never a response body, and exits 1 on failure (2 on bad
arguments).

### Reading a failed smoke

Read the output from the top:

- `FAIL the Durable Object still serves version X`: the new code never reached the object in
  10 minutes. `version unknown` means `/api/state` never answered with a version at all; the
  `waiting:` lines show its status (404 or 5xx is old code or a crash). `version dev` means the
  deploy didn't set `VERSION`.
- `FAIL GET /api/state: 200, missing keys: …`: the page's data changed shape; `view()` in
  `public/lib/state.js` and `STATE_KEYS` in `scripts/smoke.mjs` must agree (the worker tests check).
- `FAIL GET /…: 404, want 200` and the like: that route is broken in the new code. `0 (TimeoutError)`
  means no answer within 15 s.
- `GET /github/queue: 403, want 401` or a 302: Access no longer sits in front of the queue; check
  the "live queue" Access app (setkernel-cloudflare) before anything else.

### Rolling back by hand

In the Cloudflare dashboard: Workers & Pages, `setkernel-live`, Deployments, pick the last good
version and "Rollback". The Durable Object again takes a few minutes to follow; check with
`node scripts/smoke.mjs --expect <that version's commit>`. Then revert the bad change in a PR.
Cloudflare won't roll back across a Durable Object migration: if the bad deploy added one, fix
forward.

## GitHub Actions results

```
GitHub (org webhook) ── workflow_run, deployment_status ──▶  /github/webhook  ──▶  queue in the
                                                                                  Durable Object
sk-obs01 ◀── pulls ── /github/queue?since=<cursor> (Access: live-queue service token only) ◀──┘
```

The office still accepts no connections: GitHub calls the Worker, and sk-obs01 pulls from it.

- `POST /github/webhook` is public, because GitHub calls it. The Worker caps the body at 512 KB,
  checks `X-Hub-Signature-256` against `GITHUB_WEBHOOK_SECRET`, ignores repeated
  `X-GitHub-Delivery` ids, and accepts only completed `workflow_run` and finished
  (`success`, `failure`, `error`) `deployment_status` events. Every other event is ignored.
- Each run or deployment is one queued event; a re-run replaces it. Only the repo name, whether
  the repo is private (anything unclear counts as private), the workflow name, the conclusion and
  the time are kept. Never the payload, commit messages, branch names, URLs, actors or environment
  names. The queue keeps the latest 500 events.
- `GET /github/queue?since=<cursor>` returns `{ events, cursor, more, gap }`: up to 200 events
  after the cursor, oldest first, each with its own `cursor`. Send the returned `cursor` next
  time. `more` means pull again now; `gap` means events after your cursor were dropped by the cap.
  It sits behind its own Access app (setkernel-cloudflare#54) and the Worker checks the token
  again against `QUEUE_AUD`. Until `QUEUE_AUD` is set it answers 503.
- This queue doesn't reach the public page by itself. What the page may show of it is decided on
  sk-obs01 and in `src/logic.js` (setkernel/hq#123, setkernel-live#14).

### Deploys

For a few minutes after a deploy, the new Worker can reach a Durable Object still running the old
code, which doesn't know the newer routes and answers 404. The Worker retries those calls for
about 7.5 s (inside GitHub's 10 s delivery timeout), and answers 503 if the old code is still
there, so sk-obs01's puller tries again and GitHub's delivery log shows a server error.
GitHub never retries a failed delivery on its own: after a deploy, check the webhook's recent
deliveries (github.com/organizations/setkernel/settings/hooks) and redeliver any that failed.

### Owner steps

1. Generate a webhook secret (for example `openssl rand -hex 32`) and store it in Infisical,
   project `setkernel-live`, environment `prod`, as `GITHUB_WEBHOOK_SECRET`. Do this before the
   next deploy: the deploy fails while it is missing.
2. Run the Deploy workflow on `main`. It sets the secret on the Worker; until then
   `/github/webhook` answers 503.
3. Create the org webhook (github.com/organizations/setkernel/settings/hooks): payload URL
   `https://live.setkernel.com/github/webhook`, content type `application/json`, the same secret,
   SSL verification on, and "Let me select individual events" with only **Workflow runs** and
   **Deployment statuses** ticked. GitHub's ping should get `200 pong`.
4. After setkernel-cloudflare#54 is applied, put its audience tag in `QUEUE_AUD` in
   `wrangler.jsonc` (a PR) and deploy again.

Tracking: setkernel/hq#105.
