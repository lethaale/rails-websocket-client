package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

const (
	defaultTimeout = 5 * time.Second
)

type SQLiteStore struct {
	db *sql.DB
}

func NewSQLiteStore(path string) (*SQLiteStore, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}

	// SQLite does not benefit from many concurrent writers; keep it simple.
	db.SetMaxOpenConns(1)

	return &SQLiteStore{db: db}, nil
}

func (s *SQLiteStore) Close() error {
	return s.db.Close()
}

func (s *SQLiteStore) SaveCodexData(ctx context.Context, arguments json.RawMessage) error {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	startTime := time.Now().UTC()
	jobID := uuid.New().String()

	argumentsPayload, err := json.Marshal(codexInsert{
		JobClass:            "InsertPriceJob",
		JobId:               jobID,
		ProviderJobId:       nil,
		QueueName:           "default",
		Priority:            nil,
		Arguments:           []json.RawMessage{arguments},
		Executions:          0,
		ExceptionExecutions: struct{}{},
		Locale:              "en",
		Timezone:            "UTC",
		EnqueuedAt:          startTime,
		ScheduledAt:         startTime,
	})
	if err != nil {
		return err
	}

	result, err := tx.ExecContext(ctx, `
INSERT INTO solid_queue_jobs (
	queue_name, class_name, arguments, priority, active_job_id, scheduled_at,
	finished_at, concurrency_key, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
`, "prices", "Codex::Subscriptions::ProcessPriceUpdateJob", string(argumentsPayload), 0, jobID, startTime, startTime, startTime)
	if err != nil {
		return err
	}

	jobRowID, err := result.LastInsertId()
	if err != nil {
		return fmt.Errorf("unable to fetch job id: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `
INSERT INTO solid_queue_ready_executions (job_id, queue_name, priority, created_at)
VALUES (?, ?, ?, ?)
`, jobRowID, "prices", 0, startTime); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("unable to commit transaction: %w", err)
	}

	return nil
}

type codexInsert struct {
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
