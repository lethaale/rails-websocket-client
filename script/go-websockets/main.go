package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/lethale/rails-websocket-client/script/go-websockets/store"
)

const (
	defaultURL = "wss://stream.binance.com:9443/ws/btcusdt@trade"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	dbPath := envOrDefault("DB_PATH", defaultQueuePath())
	st, err := store.NewSQLiteStore(dbPath)
	if err != nil {
		log.Fatalf("failed to open sqlite store: %v", err)
	}
	defer st.Close()

	wsURL := envOrDefault("WS_URL", defaultURL)
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
			if websocket.CloseStatus(err) == websocket.StatusNormalClosure || ctx.Err() != nil {
				log.Printf("websocket closed: %v", err)
				return
			}

			log.Printf("read error: %v", err)
			time.Sleep(time.Second)
			continue
		}

		log.Printf("received message: %s", string(raw))

		if err := st.SaveBinanceData(context.Background(), raw); err != nil {
			log.Printf("store error: %v", err)
		}
	}
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}

	return fallback
}

// defaultQueuePath returns the queue database path relative to the repo root.
// When running from script/go-websockets, this resolves to ../../storage/development_queue.sqlite3.
func defaultQueuePath() string {
	wd, err := os.Getwd()
	if err != nil {
		return "queue.sqlite3"
	}

	candidate := filepath.Clean(filepath.Join(wd, "..", "..", "storage", "development_queue.sqlite3"))
	return candidate
}
