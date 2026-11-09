# sk-meter: the Cloudflare billing guard

Cloudflare's budget alerts email a day late and don't cap usage, and overage on Workers Paid
bills automatically. sk-meter keeps setkernel inside the $5 plan. Every hour (cron `7 * * * *`)
it reads the account's usage through the GraphQL Analytics API, totals each metric over its
window, compares it with the plan's included allowance and sets three KV flags.

| Share of any allowance | KV key | What happens |
|---|---|---|
| 50% | `guard:alert` | an alert to Raghav |
| 80% | `guard:degrade` | readers run with `DEGRADED` (`src/flags.js`) |
| 95% | `guard:refuse` | readers refuse non-essential requests until the window resets |

Cloudflare's own $10 budget alert stays on as the backstop.

It moved here from a private repository on 2026-11-09 (setkernel/hq#1449, plan v6 F3). Its
history up to then is that repository's `meter/` at commit `c1e3253`. Not moved, and retired
with that repository: the Workers Logs `readings` tool and the `baseline` and live `drill`
workflows (each read Infisical through an identity bound to a workflow there).

## Files
- `allowances.json`: the included allowance for each metric, its window (`month` from the
  billing day, `day` from 00:00 UTC for Workers AI, `gauge` for storage), and the pricing page
  it came from. Change it only from those pages.
- `src/usage.js`: the GraphQL queries, one per dataset.
- `src/meter.js`: shares, levels, flags, the pro-rated projection, the alert text. Pure.
- `src/flags.js`: the contract for every reader: `readGuard(env.GUARD)`,
  `refusal(guard, { essential })` and `DEGRADED`.
- `src/index.js`: the hourly run. `src/notify.js`: the alert webhook.
- `tools/baseline.mjs`: a read-only report of current usage, also the schema check.
- `tools/drill.mjs`: the offline drill (below).

## How it decides
- Each metric's total is recomputed from the start of its window every hour, so a missed run
  loses nothing.
- A flag is on while any metric is at or past its threshold, and lists those metrics and when
  the last of them resets (`until`; `null` when storage holds it, because only deleting data
  brings that down).
- A query that fails keeps the metric's last value from the same window, so an outage of the
  analytics API never lowers a flag; the failure is in the alert.
- Pro-rated: once 10% of a window has passed, a metric on pace to pass its allowance before the
  reset is named in the alert. Flags act on actual use, not the projection.
- A reader that can't reach KV treats it as degrade, not refuse.
- The Workers and Durable Object queries also group by `scriptName` in the same query, so a
  metric projected to reach 50% names its top script in the alert (`topScripts` in the report).
- An alert goes out when the flags, errors, on-pace list or Workers AI gateways change, and is
  retried each hour until delivered.

## What it costs
Its own use of the plan (https://developers.cloudflare.com/workers/platform/pricing/), a month:

| Metric | sk-meter's use | Included | Share |
|---|---|---|---|
| Workers requests (cron runs) | 720 | 10,000,000 | 0.01% |
| Workers CPU time | estimate: a few ms a run, well under 36,000 ms | 30,000,000 ms | <0.2% |
| KV reads | 1,440 (report + drill each run) | 10,000,000 | 0.01% |
| KV writes | 720 (report) + a few on flag changes | 1,000,000 | <0.1% |
| GraphQL Analytics subrequests | ~11 a run; up to ~44 when every dataset needs its 3 retries | not billed | |

## Commands
```sh
npm run test:meter        # the tests (node --test); npm run validate runs them too
node workers/meter/tools/drill.mjs   # the offline drill: in-memory KV, fake analytics API, nothing leaves the machine
CF_ACCOUNT_ID=… CF_ANALYTICS_TOKEN=… BILLING_DAY=13 node workers/meter/tools/baseline.mjs   # live, read-only
```

## Deploy
Only from CI: the `meter` job in `.github/workflows/deploy.yml`, on every push to `main` and by
hand, after the same `check` job as the page. It reads the repo's deploy token (Infisical
project `setkernel-live`, identity `setkernel-live-deploy`: Workers Editor on the account, which
deploys an existing Worker and binds an existing KV namespace). sk-meter has no route, so the
job checks the live deployment itself: the version serving all traffic must be this run's
(`deploy <sha>`). If not, it rolls back to the version that was live before, and the job fails,
so `report` opens an issue. Nothing sets vars or secrets on deploy (`keep_vars = true`).

### The Worker's settings
All in Infisical `sk-ctl-workers/prod`, reaching the Worker through the Infisical -> Cloudflare
Workers secret sync (target Worker `sk-meter`). The sync is by Worker name, so the move changed
nothing there.

| Key | Value |
|---|---|
| `BILLING_DAY` | `13` (cycle starts on the 13th; required, 1-28) |
| `CF_ACCOUNT_ID` | the account to meter |
| `CF_ANALYTICS_TOKEN` | `sk-meter-analytics-read`: Account Analytics Read, nothing else (setkernel-cloudflare tofu) |
| `ALERT_WEBHOOK_URL` | `https://alerts.setkernel.net/meter` (https only; anything else is refused) |
| `ALERT_WEBHOOK_TOKEN` | bearer the receiver checks |
| `ALERT_ACCESS_CLIENT_ID`, `ALERT_ACCESS_CLIENT_SECRET` | the `sk-meter-alerts` Access service token |

The KV namespace `sk-meter` (`f79ca12aeb9347f9851f5dfd53313f39`) is tofu-owned in
setkernel-cloudflare: this repo binds it and never creates or deletes it.

## The baseline
`tools/baseline.mjs` introspects the GraphQL schema for every dataset, field and filter key in
`src/usage.js`, then reads the current usage the way the hourly run does, and prints both. Any
"Can't read" line fails it. A dataset still answering "try again later" after three retries is
an "Unknown" line: its metric shows as `?` and the run passes. It writes nothing and prints no
secret.

## The drill
Proves the degrade end to end without extra spend: `meter:drill` in the namespace lowers one
metric's allowance below what is already used, until its `expiresAt`. A drill can only lower an
allowance. `tools/drill.mjs` runs the steps offline and fails if any step doesn't see what it
should.
