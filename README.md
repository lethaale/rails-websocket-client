# Rails Websocket Client

Live-updating price board powered by Hotwire/Turbo Streams.

## Features

- Streams prices to a table; newest rows auto-scroll into view.
- Broadcasts on create/destroy; renders via `_price` partial.
- Client-side metrics: ingest latency (created_at - binance_time) and display latency (now - binance_time).

## Setup

1. Install deps: `bundle install`
2. Install foreman: `brew install foreman`
3. Set up DB: `bin/rails db:setup`
4. Run app: `bin/dev`

## Go websocket consumer (Binance -> SQLite)

The Go helper under `script/go-websockets` connects to Binance trades (`btcusdt@trade`) and writes two records per message into `solid_queue_jobs` and `solid_queue_ready_executions` tables in a local SQLite file.

Requirements: Go 1.25+ (or current Go toolchain) and network access to `wss://stream.binance.com`.

`bin/dev` already starts the listener alongside Rails (see `Procfile.dev`). First time only, fetch Go modules:

```bash
(cd script/go-websockets && go mod tidy)
```

To run it standalone (from the project root):

```bash
(cd script/go-websockets && DB_PATH=../../storage/development_queue.sqlite3 go run .)
```

`DB_PATH` is required — it must point at the Solid Queue SQLite file that Rails reads.
The path differs by Rails environment (see `config/database.yml`):

- development: `storage/development_queue.sqlite3`
- production:  `storage/production_queue.sqlite3`

Optional env vars:

- `WS_URL` – override the websocket stream URL (default: `wss://stream.binance.com:9443/ws/btcusdt@trade`)

## Usage

- Visit `/` to see the prices table.
- New prices appear live at the bottom; averages update automatically.

## Notes

- Stimulus controller `auto_scroll` handles auto-scroll and latency averages.
- Data attributes on rows carry binance/created epoch ms for precise calculations.
