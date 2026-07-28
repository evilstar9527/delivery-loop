-- Production deployment final state is an external GitHub fact. Webhook and
-- read-only API reconciliation share one observation ledger/projector.

ALTER TABLE production_deployments ADD COLUMN external_state TEXT;
ALTER TABLE production_deployments ADD COLUMN external_updated_at TEXT;
ALTER TABLE production_deployments
  ADD COLUMN observation_version INTEGER NOT NULL DEFAULT 0
  CHECK (observation_version >= 0);

CREATE INDEX IF NOT EXISTS idx_production_deployments_status
  ON production_deployments(status, updated_at);

CREATE TABLE IF NOT EXISTS production_deployment_status_observations (
  observation_id       TEXT PRIMARY KEY,
  source_kind          TEXT NOT NULL CHECK (source_kind IN ('webhook', 'api')),
  fact_digest          TEXT NOT NULL CHECK (length(fact_digest) = 71),
  repository           TEXT NOT NULL,
  github_deployment_id TEXT NOT NULL,
  deployment_id        TEXT REFERENCES production_deployments(deployment_id),
  processing_state     TEXT NOT NULL CHECK (
    processing_state IN ('received', 'applied', 'ignored')
  ),
  ignore_reason        TEXT,
  external_updated_at  TEXT NOT NULL,
  observed_at          TEXT NOT NULL,
  processed_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_production_deployment_status_observations
  ON production_deployment_status_observations(
    repository, github_deployment_id, external_updated_at
  );

CREATE TRIGGER IF NOT EXISTS trg_production_deployment_status_observation_identity_immutable
BEFORE UPDATE OF
  observation_id, source_kind, fact_digest, repository, github_deployment_id,
  external_updated_at, observed_at
ON production_deployment_status_observations
BEGIN SELECT RAISE(ABORT, 'production_deployment_status_observation_is_immutable'); END;
