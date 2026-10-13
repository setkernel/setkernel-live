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
minute. Buzz runs in the office, so during a full office outage the alert can't get through; the
recovery message is then the first report, and says how long it lasted.

- **Mute** for planned maintenance: set `ALERTS_MUTED` to `"true"` in `wrangler.jsonc` and deploy;
  set it back to `"false"` afterwards. While muted nothing is posted, and an outage that ends
  inside the mute is never reported. One still going when the mute ends is reported then.
- **Identity:** the Worker posts as its own Buzz member, "live.setkernel.com watcher". Its key is the
  Worker secret `BUZZ_PRIVATE_KEY`, which the deploy workflow brings from Infisical (project
  `setkernel-live`, prod). It is never in this repo or in logs. The relay and the channel are
  plain vars in `wrangler.jsonc`.

### Owner: create the identity (once)

The deploy fails until `BUZZ_PRIVATE_KEY` is in Infisical, so do this before the next deploy. It
makes the key on sk-obs01, as for the Grafana alerts identity (setkernel/hq
`observability/README.md`), and runs from your Mac in an hq checkout. Only the public key is
ever printed.

1. Make the key in a private file on sk-obs01 (the script the agent identities use):
   ```sh
   ssh raghav@sk-obs01.int.setkernel.net 'SK_BUZZ_CONF=$HOME/.config/live-watch/buzz.env SK_BUZZ_CHANNEL=fc80475f-c5f0-42b7-870f-44785c189566 bash -s' < buzz/agent-identity.sh
   ```
   It prints `sk-obs01 <public key hex> buzz=ok`.
2. Make it a relay member:
   `ssh buzz@sk-buzz01.int.setkernel.net '~/hq/buzz/buzzctl add-member <public key hex>'`.
3. Name it and join #infra:
   ```sh
   ssh raghav@sk-obs01.int.setkernel.net 'set -a; . ~/.config/live-watch/buzz.env; set +a; ~/.local/bin/buzz users set-profile --name "live.setkernel.com watcher" >/dev/null; ~/.local/bin/buzz channels join --channel "$BUZZ_CHANNEL" >/dev/null && echo joined'
   ```
4. Copy the key to your clipboard without showing it, and paste it into the Infisical web UI as
   `BUZZ_PRIVATE_KEY` (project `setkernel-live`, environment prod, path `/`):
   ```sh
   ssh raghav@sk-obs01.int.setkernel.net "sed -n 's/^BUZZ_PRIVATE_KEY=//p' ~/.config/live-watch/buzz.env" | tr -d '\n' | pbcopy
   ```
   Then clear the clipboard (copy something else).
5. Delete the file, so Infisical holds the only copy:
   `ssh raghav@sk-obs01.int.setkernel.net 'shred -u ~/.config/live-watch/buzz.env'`.
6. Run the Deploy workflow. To check the whole path, stop sk-obs01's publisher for 6 minutes: an
   alert should arrive in #infra, and a recovery message within a minute of restarting it.

To silence it, use the mute. To retire the identity, remove its member on sk-buzz01
(`buzzctl remove-member <hex>`), delete the Infisical secret and take the cron out of
`wrangler.jsonc` in the same PR as the `secrets:` line of the deploy workflow.

Tracking: setkernel/hq#105.
