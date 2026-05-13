package main

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"sync/atomic"
	"time"
)

// priceFilter drops Binance messages that wouldn't change anything downstream:
// stale event times (E ≤ last) and unchanged prices for the same symbol. This
// is what keeps the Solid Queue table from being hammered with no-op INSERTs
// during quiet market periods, when BTCUSDT can fire 50+ trades/sec at the
// exact same dollar price.
type priceFilter struct {
	mu          sync.Mutex
	lastEventMs map[string]int64
	lastPrice   map[string]string

	forwarded     atomic.Uint64
	skippedStale  atomic.Uint64
	skippedSame   atomic.Uint64
	skippedParse  atomic.Uint64
}

func newPriceFilter() *priceFilter {
	return &priceFilter{
		lastEventMs: make(map[string]int64),
		lastPrice:   make(map[string]string),
	}
}

// shouldForward decides whether a raw trade message should be passed to the
// store. Returns false when the message is older than or equal to the last one
// we forwarded for that symbol, or when the price hasn't moved.
func (f *priceFilter) shouldForward(raw json.RawMessage) bool {
	var trade struct {
		// EventType ("e") is parsed only to keep Go's case-insensitive json
		// matching from binding it to EventMs ("E"). Binance ships both fields
		// in the same payload; without this, "trade" string would error into
		// the int64.
		EventType string `json:"e"`
		Symbol    string `json:"s"`
		EventMs   int64  `json:"E"`
		Price     string `json:"p"`
	}
	err := json.Unmarshal(raw, &trade)
	if err != nil || trade.Symbol == "" {
		if f.skippedParse.Add(1) == 1 {
			log.Printf("filter: first parse-skipped message: err=%v symbol=%q raw=%s", err, trade.Symbol, string(raw))
		}
		return false
	}

	f.mu.Lock()
	defer f.mu.Unlock()

	if trade.EventMs <= f.lastEventMs[trade.Symbol] {
		f.skippedStale.Add(1)
		return false
	}
	if trade.Price == f.lastPrice[trade.Symbol] {
		// Bump the event time so subsequent stale events still get caught even
		// when we're skipping same-price messages.
		f.lastEventMs[trade.Symbol] = trade.EventMs
		f.skippedSame.Add(1)
		return false
	}

	f.lastEventMs[trade.Symbol] = trade.EventMs
	f.lastPrice[trade.Symbol] = trade.Price
	if f.forwarded.Add(1) == 1 {
		log.Printf("filter: first message forwarded for %s at price %s (E=%d)", trade.Symbol, trade.Price, trade.EventMs)
	}
	return true
}

// logLoop emits a single line every 10 seconds summarizing what the filter has
// been doing. Frequent enough to confirm data is flowing during local dev,
// sparse enough to not flood Fly's log pipeline.
func (f *priceFilter) logLoop(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	var prev struct {
		forwarded, stale, same, parse uint64
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			fwd := f.forwarded.Load()
			stale := f.skippedStale.Load()
			same := f.skippedSame.Load()
			parse := f.skippedParse.Load()
			log.Printf("filter (last 10s): forwarded=%d skipped_same=%d skipped_stale=%d skipped_parse=%d",
				fwd-prev.forwarded, same-prev.same, stale-prev.stale, parse-prev.parse)
			prev.forwarded, prev.stale, prev.same, prev.parse = fwd, stale, same, parse
		}
	}
}
