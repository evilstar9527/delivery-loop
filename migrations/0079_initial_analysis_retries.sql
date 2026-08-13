-- Immutable lineage for bounded retries of the root analysis before any Plan exists.

CREATE TABLE IF NOT EXISTS initial_analysis_retries (
  retry_id          TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  failure_id        TEXT NOT NULL UNIQUE REFERENCES attempt_failures(failure_id) ON DELETE CASCADE,
  failed_attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  retry_attempt_id  TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  retry_sequence    INTEGER NOT NULL CHECK (retry_sequence > 0),
  created_at        TEXT NOT NULL,
  UNIQUE (run_id, retry_sequence),
  CHECK (failed_attempt_id <> retry_attempt_id)
);

CREATE INDEX IF NOT EXISTS idx_initial_analysis_retries_current
  ON initial_analysis_retries(run_id, retry_sequence DESC);

CREATE TRIGGER IF NOT EXISTS trg_initial_analysis_retries_immutable
BEFORE UPDATE ON initial_analysis_retries
BEGIN
  SELECT RAISE(ABORT, 'initial_analysis_retry_is_immutable');
END;
