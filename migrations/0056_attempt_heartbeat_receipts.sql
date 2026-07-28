-- A latest heartbeat_at value cannot prove cadence. Keep one immutable, reference-only
-- receipt per successful Runner heartbeat without persisting either rotated token digest.

CREATE TABLE IF NOT EXISTS attempt_heartbeat_receipts (
  heartbeat_id             TEXT PRIMARY KEY,
  run_id                   TEXT NOT NULL REFERENCES runs(run_id),
  attempt_id               TEXT NOT NULL REFERENCES attempts(attempt_id),
  lease_generation         INTEGER NOT NULL CHECK (lease_generation > 0),
  previous_attempt_version INTEGER NOT NULL CHECK (previous_attempt_version >= 0),
  attempt_version          INTEGER NOT NULL CHECK (
    attempt_version = previous_attempt_version + 1
  ),
  previous_heartbeat_at    TEXT NOT NULL,
  heartbeat_at             TEXT NOT NULL CHECK (heartbeat_at > previous_heartbeat_at),
  lease_expires_at         TEXT NOT NULL CHECK (lease_expires_at > heartbeat_at),
  created_at               TEXT NOT NULL,
  UNIQUE (attempt_id, attempt_version)
);

CREATE INDEX IF NOT EXISTS idx_attempt_heartbeat_receipts_run
  ON attempt_heartbeat_receipts(run_id, attempt_id, attempt_version);

CREATE TRIGGER IF NOT EXISTS trg_attempt_heartbeat_receipts_immutable
BEFORE UPDATE ON attempt_heartbeat_receipts
BEGIN SELECT RAISE(ABORT, 'attempt_heartbeat_receipt_is_immutable'); END;
