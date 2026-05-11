package main

import (
	"context"
	"encoding/json"
	"errors"
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

	st, err := openStore()
	if err != nil {
		log.Fatalf("failed to open store: %v", err)
	}
	defer st.Close()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		log.Fatalf("failed to connect websocket: %v", err)
	}
	defer conn.Close(websocket.StatusGoingAway, "shutdown")

	log.Printf("connected to %s", wsURL)

	for {
		select {
		case <-ctx.Done():
			log.Println("context canceled, exiting")
			return
		default:
		}

		var raw json.RawMessage
		if err := wsjson.Read(ctx, conn, &raw); err != nil {
			if websocket.CloseStatus(err) >= 0 || errors.Is(err, context.Canceled) ||
				errors.Is(err, context.DeadlineExceeded) {
				log.Printf("websocket closed: %v", err)
				return
			}

			log.Printf("read error: %v", err)
			time.Sleep(time.Second)
			continue
		}

		log.Printf("received message: %s", string(raw))

		if err := st.SaveBinanceData(ctx, raw); err != nil {
			log.Printf("store error: %v", err)
		}
	}
}

// Picks the store implementation based on which env var is set:
//   - DATABASE_URL  → Postgres (production / Fly)
//   - DB_PATH       → SQLite   (development / Procfile.dev)
//
// DATABASE_URL wins if both are set.
func openStore() (store.Store, error) {
	if dsn := os.Getenv("DATABASE_URL"); dsn != "" {
		log.Printf("DATABASE_URL set, using Postgres store")
		return store.NewPGStore(dsn)
	}
	if path := os.Getenv("DB_PATH"); path != "" {
		log.Printf("DB_PATH=%s, using SQLite store", path)
		return store.NewSQLiteStore(path)
	}
	log.Fatalf("either DATABASE_URL or DB_PATH must be set")
	return nil, nil
}
