-- Polling repairs missed workflow_run webhooks. Observations keep only a canonical
-- fact digest and normalized bindings, never the GitHub response body or token.

CREATE TABLE IF NOT EXISTS github_api_observations (
  observation_id      TEXT PRIMARY KEY,
  fact_digest         TEXT NOT NULL CHECK (length(fact_digest) = 71),
  repository          TEXT NOT NULL,
  github_run_id       TEXT NOT NULL,
  attempt_id          TEXT,
  processing_state    TEXT NOT NULL CHECK (
    processing_state IN ('received', 'applied', 'ignored')
  ),
  ignore_reason       TEXT,
  external_updated_at TEXT NOT NULL,
  observed_at         TEXT NOT NULL,
  processed_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_github_api_observations_run
  ON github_api_observations(repository, github_run_id, external_updated_at);
