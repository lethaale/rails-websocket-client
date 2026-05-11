package store

import (
	"context"
	"encoding/json"
	"io"
	"time"
)

const defaultTimeout = 5 * time.Second

// Store writes Binance trade payloads as Solid Queue jobs into whichever
// database Rails happens to be reading from. Two implementations live here:
// SQLiteStore for the development setup (a local file shared with Rails) and
// PGStore for production on Fly (Supabase-managed Postgres).
type Store interface {
	io.Closer
	SaveBinanceData(ctx context.Context, arguments json.RawMessage) error
}

// The on-wire shape Active Job expects when it deserializes the `arguments`
// column of solid_queue_jobs. Match Active Job's serializer field-for-field.
type binanceMessage struct {
	JobClass            string            `json:"job_class"`
	JobId               string            `json:"job_id"`
	ProviderJobId       any               `json:"provider_job_id"`
	QueueName           string            `json:"queue_name"`
	Priority            any               `json:"priority"`
	Arguments           []json.RawMessage `json:"arguments"`
	Executions          int               `json:"executions"`
	ExceptionExecutions struct{}          `json:"exception_executions"`
	Locale              string            `json:"locale"`
	Timezone            string            `json:"timezone"`
	EnqueuedAt          time.Time         `json:"enqueued_at"`
	ScheduledAt         time.Time         `json:"scheduled_at"`
}
