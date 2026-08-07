-- Immutable lineage for bounded analysis retries while a Plan revision remains analyzing.

CREATE TABLE IF NOT EXISTS plan_revision_analysis_retries (
  retry_id          TEXT PRIMARY KEY,
  revision_id       TEXT NOT NULL REFERENCES plan_revisions(revision_id) ON DELETE CASCADE,
  failure_id        TEXT NOT NULL UNIQUE REFERENCES attempt_failures(failure_id) ON DELETE CASCADE,
  failed_attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  retry_attempt_id  TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  retry_sequence    INTEGER NOT NULL CHECK (retry_sequence > 0),
  created_at        TEXT NOT NULL,
  UNIQUE (revision_id, retry_sequence),
  CHECK (failed_attempt_id <> retry_attempt_id)
);

CREATE INDEX IF NOT EXISTS idx_plan_revision_analysis_retries_current
  ON plan_revision_analysis_retries(revision_id, retry_sequence DESC);

CREATE TRIGGER IF NOT EXISTS trg_plan_revision_analysis_retries_immutable
BEFORE UPDATE ON plan_revision_analysis_retries
BEGIN
  SELECT RAISE(ABORT, 'plan_revision_analysis_retry_is_immutable');
END;
