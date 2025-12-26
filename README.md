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

Requirements: Go 1.21+ (or current Go toolchain) and network access to `wss://stream.binance.com`.

Setup & run:

```bash
cd script/go-websockets
# First time: fetch modules
go mod tidy
# Run (defaults: DB_PATH=queue.sqlite3, WS_URL=wss://stream.binance.com:9443/ws/btcusdt@trade)
go run .
```

Optional env vars:

- `DB_PATH` – path to the SQLite file (will be created if missing)
- `WS_URL` – override the websocket stream URL

## Usage

- Visit `/` to see the prices table.
- New prices appear live at the bottom; averages update automatically.

## Notes

- Stimulus controller `auto_scroll` handles auto-scroll and latency averages.
- Data attributes on rows carry binance/created epoch ms for precise calculations.
