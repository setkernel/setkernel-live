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
  of work, a dot per Claude request and per team-chat post, a short list of GitHub actions, and a
  repo's name only when the repo is public. No code, conversations, titles, numbers, usernames,
  hostnames or customer data.
- `/ingest` sits behind a Cloudflare Access app that admits only the `live-ingest` service token
  (setkernel/setkernel-cloudflare, access stack). The Worker checks the Access token again.

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

## When updates stop

A Cron Trigger asks the Durable Object once a minute when the last batch arrived. After more than
5 minutes without one, the Worker posts to Buzz #infra; when batches come back, it posts once more
with how long they were gone. One alert per outage. A post Buzz doesn't take is tried again every
minute (so, rarely, a post that timed out after Buzz stored it appears twice). Buzz runs in the
office, so during a full office outage the alert can't get through; the recovery message is then
the first report, and says how long it lasted.

- **Mute** for planned maintenance: set `ALERTS_MUTED` to `"true"` in `wrangler.jsonc` and deploy;
  set it back to `"false"` afterwards. While muted no alert is posted, and an outage that ends
  inside the mute is never reported. One still going when the mute ends is alerted then. The
  recovery for an alert posted before the mute still goes out.
- **Identity:** the Worker posts as its own Buzz member, "live.setkernel.com watcher". Its key is the
  Worker secret `BUZZ_PRIVATE_KEY`, which the deploy workflow brings from Infisical (project
  `setkernel-live`, prod). It is never in this repo or in logs. The relay and the channel are
  plain vars in `wrangler.jsonc`.

### Owner: create the identity (once)

The deploy fails until `BUZZ_PRIVATE_KEY` is in Infisical, so do this before the next deploy. It
is the same procedure as the Grafana alerts identity in setkernel/hq `observability/README.md`;
the private details (hosts, logins) are there, not in this public repo. Only the public key is
ever printed.

1. On sk-obs01, make the key in a new private file with hq's `buzz/agent-identity.sh`, with
   `SK_BUZZ_CONF` set to that file and `SK_BUZZ_CHANNEL` to the #infra channel id from
   `wrangler.jsonc`. It prints only the public key (hex).
2. Make that public key a relay member (`buzzctl add-member <hex>`, hq `buzz/README.md`).
3. With that file's variables loaded (`set -a; . <file>; set +a`), name the identity
   (`buzz users set-profile --name "live.setkernel.com watcher"`) and join #infra
   (`buzz channels join --channel "$BUZZ_CHANNEL"`).
4. Put the key in Infisical as `BUZZ_PRIVATE_KEY` (project `setkernel-live`, environment prod,
   path `/`) without showing it: pipe the value straight to your clipboard
   (`sed -n 's/^BUZZ_PRIVATE_KEY=//p' <file> | tr -d '\n' | pbcopy`, over SSH if need be), paste
   it into the Infisical web UI, then copy something else.
5. `shred -u <file>`, so Infisical holds the only copy.
6. Run the Deploy workflow. To check the whole path, stop sk-obs01's publisher for 6 minutes: an
   alert should arrive in #infra, and a recovery message within a minute of restarting it.

To retire the identity: remove its relay member, delete the Infisical secret, and in one PR take
the cron out of `wrangler.jsonc` and `BUZZ_PRIVATE_KEY` out of the deploy workflow.

Tracking: setkernel/hq#105.
