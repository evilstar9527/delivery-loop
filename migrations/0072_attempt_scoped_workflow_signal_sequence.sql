-- Completion sequence is monotonic within one Attempt, not across the whole Run.
-- A Run may contain the initial analysis plus later Plan-revision analysis Attempts,
-- and each of those independently emits sequence 1.

CREATE TABLE workflow_signals_attempt_scoped (
  signal_id            TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL REFERENCES runs(run_id),
  event_id             TEXT NOT NULL,
  workflow_event_type  TEXT NOT NULL,
  signal_type          TEXT NOT NULL CHECK (signal_type = 'attempt_completed'),
  attempt_id           TEXT NOT NULL,
  sequence             INTEGER NOT NULL CHECK (sequence > 0),
  payload_ref          TEXT NOT NULL,
  digest               TEXT NOT NULL CHECK (length(digest) = 71),
  occurred_at          TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  UNIQUE (run_id, event_id),
  UNIQUE (run_id, attempt_id, sequence)
);

INSERT INTO workflow_signals_attempt_scoped (
  signal_id, run_id, event_id, workflow_event_type, signal_type,
  attempt_id, sequence, payload_ref, digest, occurred_at, created_at
)
SELECT signal_id, run_id, event_id, workflow_event_type, signal_type,
       attempt_id, sequence, payload_ref, digest, occurred_at, created_at
FROM workflow_signals;

DROP TABLE workflow_signals;
ALTER TABLE workflow_signals_attempt_scoped RENAME TO workflow_signals;
