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
