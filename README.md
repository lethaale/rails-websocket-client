# Rails Websocket Client

Live-updating price board powered by Hotwire/Turbo Streams. Postgres everywhere, Rails 8 multi-database.

## Features

- Streams prices to a table; newest rows appear at the top.
- Broadcasts on create; renders via `_price` partial.
- Client-side metrics: latency percentiles, throughput, jitter, drop rate, Binance E−T gap.
- Side-by-side comparison: JS Direct vs Rails (Go → Solid Queue → Active Job → Turbo Stream).

## Setup

You need Postgres running locally (Postgres.app, Homebrew, Docker — any of them).

```bash
bundle install
brew install foreman                # if you don't already have it
bin/rails db:prepare                # creates four dev databases + test
bin/dev                             # web + css + jobs + Go listener
```

`bin/rails db:prepare` creates four databases (primary, queue, cable, cache) on your local Postgres — same names you see in `config/database.yml`. The Go listener writes to the `queue` database; Rails workers read from it.

## Go websocket consumer (Binance -> Postgres)

The Go helper under `script/go-websockets` connects to Binance trades (`btcusdt@trade`) and writes two records per message into `solid_queue_jobs` and `solid_queue_ready_executions` in Rails' queue database.

Requirements: Go 1.25+ and network access to `wss://stream.binance.com`.

`bin/dev` already starts the listener alongside Rails (see `Procfile.dev`). First time only, fetch Go modules:

```bash
(cd script/go-websockets && go mod tidy)
```

To run standalone (from the project root):

```bash
(cd script/go-websockets && \
  QUEUE_DATABASE_URL=postgres://localhost/rails_websocket_client_development_queue \
  go run .)
```

Env vars:

- `QUEUE_DATABASE_URL` (required) — Postgres URL for the Solid Queue database.
- `WS_URL` (optional) — override the WebSocket stream URL. Default: `wss://stream.binance.com:9443/ws/btcusdt@trade`.

## Deploying

See [DEPLOY.md](DEPLOY.md) for Fly.io (push-to-deploy from GitHub, recommended) and Kamal (one-VM-per-region, no domain required) flows.
