-- Signed GitHub workflow_run deliveries are external facts, not Runner self-report.
-- Keep their ordering/version separate from Attempt fencing version so reconciliation
-- cannot invalidate an otherwise healthy heartbeat lease.

ALTER TABLE attempts ADD COLUMN github_external_updated_at TEXT;
ALTER TABLE attempts ADD COLUMN github_observation_version INTEGER NOT NULL DEFAULT 0
  CHECK (github_observation_version >= 0);

CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  delivery_id         TEXT PRIMARY KEY,
  event_type          TEXT NOT NULL CHECK (event_type = 'workflow_run'),
  payload_digest      TEXT NOT NULL CHECK (length(payload_digest) = 71),
  repository          TEXT NOT NULL,
  github_run_id       TEXT NOT NULL,
  attempt_id          TEXT,
  processing_state    TEXT NOT NULL CHECK (
    processing_state IN ('received', 'applied', 'ignored')
  ),
  ignore_reason       TEXT,
  external_updated_at TEXT NOT NULL,
  received_at         TEXT NOT NULL,
  processed_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_github_deliveries_run
  ON github_webhook_deliveries(repository, github_run_id, external_updated_at);
