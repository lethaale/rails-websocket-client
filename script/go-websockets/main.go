package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"os/signal"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/lethale/rails-websocket-client/script/go-websockets/store"
)

const (
	_defaultURL = "wss://stream.binance.com:9443/ws/btcusdt@trade"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	wsURL := os.Getenv("WS_URL")
	if wsURL == "" {
		wsURL = _defaultURL
	}

	// The listener writes Active Job rows for InsertPriceJob into Solid Queue's
	// tables, which live in Rails' "queue" database. Point QUEUE_DATABASE_URL
	// at that database (in dev: rails_websocket_client_development_queue; in
	// prod: the per-region queue Postgres URL provisioned for Fly).
	queueDB := os.Getenv("QUEUE_DATABASE_URL")
	if queueDB == "" {
		log.Fatalf("Environment variable QUEUE_DATABASE_URL not set")
	}

	st, err := store.NewPGStore(queueDB)
	if err != nil {
		log.Fatalf("failed to open postgres store: %v", err)
	}
	defer st.Close()

	// Binance drops connections after ~24h, and Fly/intermediate proxies can
	// drop sooner. Reconnect with exponential backoff capped at 30s; reset the
	// backoff after a session that lasted more than a minute (so a one-off
	// disconnect doesn't poison the next retry).
	backoff := time.Second
	for {
		if ctx.Err() != nil {
			log.Println("context canceled, exiting")
			return
		}

		started := time.Now()
		err := runSession(ctx, wsURL, st)
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		log.Printf("session ended after %s: %v; reconnecting in %s", time.Since(started).Round(time.Second), err, backoff)

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}

		backoff *= 2
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}

// runSession dials the stream, reads messages until the connection fails, and
// returns the terminating error. A 3-minute keepalive ping detects half-open
// TCP connections that would otherwise hang Read indefinitely.
func runSession(ctx context.Context, wsURL string, st *store.PGStore) error {
	sessionCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	conn, _, err := websocket.Dial(sessionCtx, wsURL, nil)
	if err != nil {
		return err
	}
	defer conn.Close(websocket.StatusGoingAway, "shutdown")

	log.Printf("connected to %s", wsURL)

	go func() {
		ticker := time.NewTicker(3 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-sessionCtx.Done():
				return
			case <-ticker.C:
				pingCtx, pingCancel := context.WithTimeout(sessionCtx, 10*time.Second)
				if err := conn.Ping(pingCtx); err != nil {
					pingCancel()
					log.Printf("ping failed: %v", err)
					cancel()
					return
				}
				pingCancel()
			}
		}
	}()

	for {
		var raw json.RawMessage
		if err := wsjson.Read(sessionCtx, conn, &raw); err != nil {
			return err
		}

		if err := st.SaveBinanceData(sessionCtx, raw); err != nil {
			log.Printf("store error: %v", err)
		}
	}
}
