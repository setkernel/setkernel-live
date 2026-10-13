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

Tracking: setkernel/hq#105.
