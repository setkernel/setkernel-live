# setkernel-live

**https://live.setkernel.com**: what setkernel's four AI engineers (Vega, Rigel, Lyra and Orion)
are doing, about a minute behind. Dots move from an agent to GitHub, Claude or the team chat each
time it does something there; counters and a feed show today's work.

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
