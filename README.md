# Rails Is The WebSocket Client

> Sub-second real-time updates from an external WebSocket feed to thousands of
> browsers, through Rails, with no long-lived event loops inside Puma.

This repo is the working proof for a pattern I landed on at Aura: when **Rails
is the *client*** of someone else's WebSocket (a market feed, a partner bus,
IoT telemetry, on-chain events), don't try to host the socket inside Puma.
Move the socket out to a tiny external listener, write Active Job rows
directly into Solid Queue from there, and let Rails do what it's good at —
pulling jobs, updating the DB, broadcasting via Hotwire.

Live demo: [Binance BTC/USDT trade stream](https://github.com/lethaale/rails-websocket-client),
~50–200 msg/sec, deployed side-by-side in Tokyo (`nrt`) and Frankfurt (`fra`)
on Fly.io. The full article is in [`article.md`](article.md).

---

## What this proves

- **A Rails app can be the consumer of a high-rate external WebSocket** and
  still deliver sub-second updates to the browser. Measured p95 end-to-end
  (Binance event time → row visible in the browser) stays under **200 ms** as
  long as the Fly region is geographically close to the upstream.
- **You don't need a single long-lived `EventMachine` or Faye-in-Puma loop.**
  Those are what made the early prototypes a Kamal deploy nightmare. A
  separate listener process talking to Solid Queue is dramatically simpler to
  reason about and to operate.
- **The cheapest way to survive a hot feed isn't a bigger machine** — it's
  filtering at the listener. Most BTCUSDT trades fire at the *same* dollar
  price as the previous one; skipping those before they hit Solid Queue takes
  Postgres queue inserts from ~100/sec to ~5/sec without losing any
  user-visible information.

---

## How it works

```
Binance  ──ws──>  Go listener  ──INSERT──>  solid_queue_jobs  (Postgres "queue" DB)
                       │
                       └── per-symbol filter: skip if E ≤ last OR price unchanged
                                                          │
                                                          ▼
                                  Solid Queue worker  →  InsertPriceJob
                                                          │
                                              broadcast_prepend_to "prices"
                                                          │
                                              Turbo Stream over Action Cable
                                                          │
                                                          ▼
                                                      Browser
```

Key choices:

- **One unified Docker image** ([`Dockerfile`](Dockerfile)) builds both the
  Rails app and the Go listener and copies the listener binary to
  `/usr/local/bin/listener`. Same image runs both processes.
- **One Machine per region**, started by [`bin/fly-start`](bin/fly-start) —
  runs `bin/rails db:prepare`, boots Rails, and only then launches the
  listener (so the queue tables exist before anything tries to insert).
- **Multi-database Rails 8** — `primary`, `queue`, `cable`, `cache` each get
  their own Postgres database on the same Fly Managed Postgres cluster, wired
  via `DATABASE_URL` / `QUEUE_DATABASE_URL` / `CABLE_DATABASE_URL` /
  `CACHE_DATABASE_URL`. See [`config/database.yml`](config/database.yml).
- **Go listener filter** ([`script/go-websockets/filter.go`](script/go-websockets/filter.go)) —
  per-symbol state of last event time and last price; drops stale events and
  no-price-change events before they reach Postgres. Logs forwarded/skipped
  counts every 10 seconds.
- **Stale-job guard in Rails** ([`app/jobs/insert_price_job.rb`](app/jobs/insert_price_job.rb)) —
  process-local registry so a backed-up worker fast-drops jobs older than the
  most recent it's already broadcast. Defense in depth with the Go filter.

---

## What you see in the UI

The page renders the **same feed through both paths side-by-side** so you can
read off the cost of going through Rails:

- **JS Direct** (left, emerald) — the browser opens its own WebSocket straight
  to Binance. The baseline.
- **Rails** (right, indigo) — Go listener → Solid Queue → Active Job → Turbo
  Stream broadcast → this tab.

Above the two columns:

- **Latency comparison panel** — per-percentile bars (p1/p50/p95/p99) of
  end-to-end latency, with the Rails-vs-Direct delta.
- **Price-match row** — green/red flag based on whether the two latest prices
  agree right now, the absolute delta between them, and the *millisecond-level*
  share of elapsed time the two paths disagreed.
- **Per-side stats panels** — mean / p1 / p50 / p95 / p99 latency, stddev,
  jitter, throughput, total messages, uptime, drop rate (inferred from gaps in
  Binance's trade ID sequence), and on the JS-Direct side the
  "same-price-as-previous" ratio that the Go filter on the Rails side
  exploits.
- **Per-side rolling charts** — every observed price plotted on a real-time
  x-axis since page load (no sliding window), so the two shapes can be
  compared directly even though JS Direct sees ~50× more points than Rails
  does after filtering.

### Measurement caveats — read this before trusting the numbers

The page has an amber disclaimer line for a reason:

1. **Clock skew.** Latency is `observedAt − Binance E`. Your laptop's NTP
   sync is rarely perfect, so the floor of the JS-Direct distribution
   (e.g. p1) is often negative — that's your local clock offset, not actual
   pre-cognition. The *deltas* between Rails and Direct are not affected
   because both use the same browser clock.
2. **Where the timestamp is captured differs.** JS Direct records
   `observedAt = Date.now()` in the browser's `ws.onmessage`. Rails records
   it server-side inside the job, *before* the Turbo Stream is even
   serialized. When both feeds share a tab, the browser main thread is busy
   rendering rows from both sides, which delays the JS Direct timestamp but
   not Rails'. Naive readings of the bars will show Rails *faster* than
   Direct on a local laptop — that's a measurement artifact, not a real
   win. In prod, the network and the Action Cable hop dominate and Rails
   loses fairly.

The talk version of this demo spends a slide on each of these, because they
are the two things every engineer who looks at the page asks about first.

---

## Run it locally

You need Postgres running (Postgres.app, Homebrew, Docker — any of them) and
Go 1.25+.

```bash
bundle install
brew install foreman                # if you don't already have it
bin/rails db:prepare                # creates four dev databases
(cd script/go-websockets && go mod tidy)
bin/dev                             # web + css + Solid Queue + Go listener
```

Then open `http://localhost:3000`. The region badge will say `local`.

Env vars used by the Go listener:

- `QUEUE_DATABASE_URL` (required) — Postgres URL for the Solid Queue database.
- `WS_URL` (optional) — override the upstream stream URL. Default:
  `wss://stream.binance.com:9443/ws/btcusdt@trade`.

---

## Deploying

Full step-by-step is in [DEPLOY.md](DEPLOY.md). Two options are documented:

- **Fly.io** (the one I run for the demo) — one Fly app per region, one Fly
  Managed Postgres cluster per region, push-to-deploy from GitHub. Recipe is
  the exact `flyctl` invocations I used; copy-paste blocks for Tokyo and
  Frankfurt, plus a teardown section.
- **Kamal + Vultr** — one $5 droplet per region, SQLite, no Postgres bill.
  Original prototype, kept for reference.

Cost on Fly with two regions: ~$86/month total (~$5/month per Machine,
~$38/month per MPG Basic cluster). Tear-down commands are in DEPLOY.md so
demos aren't accidentally left running.

---

## What's in the repo

- `app/` — Rails app: controllers, jobs, Stimulus controllers,
  Turbo Stream partial.
- `script/go-websockets/` — the listener. `main.go` (reconnect + ping loop),
  `filter.go` (per-symbol stale / same-price filter), `store/` (Postgres
  job inserter).
- `bin/fly-start` — launcher that boots Rails first, then the listener.
- `config/database.yml` — Rails 8 multi-DB config wiring four URL secrets.
- `Dockerfile` — multi-stage build for Rails + Go in one image.
- `DEPLOY.md` — the actual deploy recipe.
- `article.md` — long-form write-up of the pattern, with the reasoning and
  the dead-ends.

---

## Honest limitations

- The listener runs as a background process under `bin/fly-start`, not under
  a real supervisor. If the Go binary crashes mid-session, Rails keeps
  running but no new prices flow until you `fly machine restart`. For
  production-grade you'd add s6-overlay or a separate process group.
- Fly's natural model is one app many regions with anycast routing. This
  repo deliberately does *not* use that, because the demo needs distinct
  per-region URLs side-by-side. If you're not running a comparison demo,
  one app + many machines is simpler.
- The same-price filter assumes the UI cares about price changes, not trade
  volume. If you need every trade for accounting / VWAP / replay, turn it
  off and pay the queue cost.
