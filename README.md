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

## Usage

- Visit `/` to see the prices table.
- New prices appear live at the bottom; averages update automatically.

## Notes

- Stimulus controller `auto_scroll` handles auto-scroll and latency averages.
- Data attributes on rows carry binance/created epoch ms for precise calculations.
