package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	_ "github.com/jackc/pgx/v5/stdlib"
)

type PGStore struct {
	db *sql.DB
}

var _ Store = (*PGStore)(nil)

func NewPGStore(dsn string) (*PGStore, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}

	return &PGStore{db: db}, nil
}

func (s *PGStore) Close() error {
	return s.db.Close()
}

func (s *PGStore) SaveBinanceData(ctx context.Context, arguments json.RawMessage) error {
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
    queue_name, class_name, arguments, priority, active_job_id,
    scheduled_at, finished_at, concurrency_key, created_at, updated_at
) VALUES (
    $1, $2, $3, $4, $5, $6, NULL, NULL, $6, $6
)
RETURNING id`,
		"default",
		"InsertPriceJob",
		string(argumentsPayload),
		0,
		jobID,
		startTime,
	).Scan(&jobRowID); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, `
INSERT INTO solid_queue_ready_executions (job_id, queue_name, priority, created_at)
VALUES ($1, $2, $3, $4)`,
		jobRowID,
		"default",
		0,
		startTime,
	); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("unable to commit transaction: %w", err)
	}

	return nil
}
