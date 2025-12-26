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

	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		log.Fatalf("Environment variable DB_PATH not set")
	}

	st, err := store.NewSQLiteStore(dbPath)
	if err != nil {
		log.Fatalf("failed to open sqlite store: %v", err)
	}
	defer st.Close()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		log.Fatalf("failed to connect websocket: %v", err)
	}
	defer conn.Close(websocket.StatusGoingAway, "shutdown")

	log.Printf("connected to %s; writing jobs into %s", wsURL, dbPath)

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
