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

type SQLiteStore struct {
	db *sql.DB
}

var _ Store = (*SQLiteStore)(nil)

func NewSQLiteStore(path string) (*SQLiteStore, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}

	// SQLite does not benefit from many concurrent writers; keep it simple.
	db.SetMaxOpenConns(1)

	// Rails opens the same file (queue/cable/cache). Wait up to 5s when the
	// writer lock is held instead of erroring with SQLITE_BUSY immediately.
	// WAL is already on (Rails 8 default); set it idempotently so we don't
	// depend on which process opened the file first.
	for _, pragma := range []string{
		"PRAGMA journal_mode = WAL",
		"PRAGMA busy_timeout = 5000",
		"PRAGMA synchronous = NORMAL",
	} {
		if _, err := db.Exec(pragma); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("%s: %w", pragma, err)
		}
	}

	return &SQLiteStore{
		db: db,
	}, nil
}

func (s *SQLiteStore) Close() error {
	return s.db.Close()
}

func (s *SQLiteStore) SaveBinanceData(ctx context.Context, arguments json.RawMessage) error {
	ctx, cancel := context.WithTimeout(ctx, defaultTimeout)
	defer cancel()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	startTime := time.Now().UTC()
	jobID := uuid.New().String()

	argumentsPayload, err := json.Marshal(binanceMessage{
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

	var jobRowID int64
	if err := tx.QueryRowContext(ctx, `
INSERT INTO solid_queue_jobs (
	queue_name, class_name, arguments, priority, active_job_id, scheduled_at, finished_at, concurrency_key,
    created_at, updated_at
) VALUES (
    @queueName, @className, @arguments, @priority, @jobID, @currentDateTime, NULL, NULL,
    @currentDateTime, @currentDateTime
)
RETURNING id`,
		sql.Named("queueName", "default"),
		sql.Named("className", "InsertPriceJob"),
		sql.Named("arguments", string(argumentsPayload)),
		sql.Named("priority", 0),
		sql.Named("jobID", jobID),
		sql.Named("currentDateTime", startTime),
	).Scan(&jobRowID); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, `
INSERT INTO solid_queue_ready_executions (job_id, queue_name, priority, created_at)
VALUES (@jobRowID, @queueName, @priority, @currentDateTime)`,
		sql.Named("jobRowID", jobRowID),
		sql.Named("queueName", "default"),
		sql.Named("priority", 0),
		sql.Named("currentDateTime", startTime),
	); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("unable to commit transaction: %w", err)
	}

	return nil
}
