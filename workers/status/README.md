# sk-status: the read model of the org

A page for Raghav, the internal wall and the showcase's publisher: sk-meter's guard flags and
the last 24 hours of merges and failures, on `ctl.setkernel.net/status` behind Access.

It moved here from a private repository on 2026-11-09 (setkernel/hq#1449, plan v6 F3). Its
history up to then is that repository's `status/` at commit `c1e3253`.

**It has never been deployed, and nothing deploys it from here.** Its only writer was the
control Worker, which publishes over a service binding (the `Feed` entrypoint) and is
being retired in hq#1449. Without it the board stays empty and the page shows only the guard.
Deploying it is Raghav's call ("The first deploy", below); until then this is code and tests
only, checked by `npm run validate`.

## How it works
- `src/board.js` `Board`: one SQLite Durable Object (`BOARD`, name `org`). Each writer publishes
  its own view here after it changes, and `/status` reads this one object.
  - An item applies only with a higher `rev` than the board holds. Reaching `merged` or `failed`
    adds one row to `events`; `closed` and `new` take an item off the board without one.
  - Each publish prunes ended items and events older than 24 hours. No alarms, no WebSockets.
- `src/model.js`: checks a published batch against the state list (`STATES`) and builds the two
  views. One bad entry is rejected with its index and reason; the rest of the batch applies.
- `src/index.js`: the routes, the Access check, the guard, and the `Feed` entrypoint.
- `src/access.js`: who may read (`STATUS_CLIENTS` scopes) and the Access token check.
- `src/html.js`: the phone page, no script. Manrope is self-hosted under `public/status/fonts/`
  with its licence; the last fallback is `sans-serif`.
- It imports one module from outside this folder: `../../meter/src/flags.js` (the guard).

## Routes
All on `ctl.setkernel.net`, behind an Access app for `ctl.setkernel.net/status` and
`ctl.setkernel.net/status/*` (not in setkernel-cloudflare tofu yet). The Worker routes are the
same two patterns.

| Route | Who | What |
|---|---|---|
| `GET /status` | a person | HTML when the browser asks for it, JSON otherwise |
| `GET /status/internal.json` | a person, or an `internal` service token | `{ generated_at, snapshot_at, guard, last_24h }` |
| `GET /status/public.json` | anyone let in, including a `public` token | `{ generated_at, last_24h: { merged, failed } }`, built field by field |
| `/status/fonts/*` | (static assets) | the two font files and `OFL-Manrope.txt` |

The Worker verifies `Cf-Access-Jwt-Assertion` itself (RS256, setkernel's team, audience
`STATUS_ACCESS_AUD`). A token with an `email` is a person and sees everything. A service token
gets in only if `STATUS_CLIENTS` lists its client id as `internal` or `public`; a `public` token
gets a 403 on anything but `/status/public.json`. With `STATUS_ACCESS_AUD` unset, every request
is a 401.

## The guard
`/status` reads sk-meter's flags at most once a minute per isolate. Under `guard:degrade`
snapshots are reused longer (person 60 s, service token 600 s; normally 15 s and 120 s). Under
`guard:refuse`, `/status/public.json` answers 503 with `retry-after`; people still see the page.

## What it costs
Estimated with two pollers at one a minute: about 176,000 Workers requests (1.8% of the
included 10M) and up to 190,000 Durable Object requests (19% of 1M at worst) a month
(https://developers.cloudflare.com/workers/platform/pricing/,
https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Commands
```sh
npm run test:status     # node --test, with cloudflare:workers resolved to test/cloudflare-workers.js
```

## The first deploy (Raghav, only if the page is wanted)
1. setkernel-cloudflare: the Access app for the two paths (allow Raghav; two service tokens for
   the wall and the publisher), `setkernel.net` in `deploy_tokens["setkernel-live"].zones`, and
   `workers_admin` for one deploy (Workers Editor can't create a Worker).
2. Infisical `sk-ctl-workers/prod`, folder `/sk-status`: `STATUS_ACCESS_AUD` and `STATUS_CLIENTS`
   from tofu outputs, and a Workers sync from that folder (never `/`) to the Worker `sk-status`.
3. A deploy job here, like `meter` in `.github/workflows/deploy.yml`.
4. Remove `workers_admin` again.
