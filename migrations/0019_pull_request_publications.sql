-- Durable Draft PR publication intents and externally verified GitHub facts.
-- The create response is only a candidate; signed webhook/API observation closes the fact.

CREATE TABLE IF NOT EXISTS pull_request_publications (
  publication_id             TEXT PRIMARY KEY,
  run_id                     TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  run_version                INTEGER NOT NULL CHECK (run_version >= 0),
  draft_id                   TEXT NOT NULL UNIQUE REFERENCES pull_request_drafts(draft_id),
  approval_id                TEXT NOT NULL REFERENCES approvals(approval_id),
  repository                 TEXT NOT NULL,
  base_branch                TEXT NOT NULL,
  head_branch                TEXT NOT NULL,
  head_sha                   TEXT NOT NULL CHECK (length(head_sha) = 40),
  title                      TEXT NOT NULL CHECK (length(title) > 0 AND length(title) <= 256),
  body_digest                TEXT NOT NULL CHECK (length(body_digest) = 71),
  status                     TEXT NOT NULL CHECK (
    status IN ('pending', 'created_unverified', 'verified')
  ),
  github_pr_number           INTEGER CHECK (github_pr_number IS NULL OR github_pr_number > 0),
  github_pr_url              TEXT,
  github_external_updated_at TEXT,
  github_observation_version INTEGER NOT NULL DEFAULT 0 CHECK (github_observation_version >= 0),
  evidence_id                TEXT UNIQUE REFERENCES evidence(evidence_id),
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  UNIQUE (repository, head_branch)
);

CREATE INDEX IF NOT EXISTS idx_pull_request_publications_reconcile
  ON pull_request_publications(status, updated_at)
  WHERE status <> 'verified';

CREATE TABLE IF NOT EXISTS github_pull_request_webhook_deliveries (
  delivery_id         TEXT PRIMARY KEY,
  event_type          TEXT NOT NULL CHECK (event_type = 'pull_request'),
  payload_digest      TEXT NOT NULL CHECK (length(payload_digest) = 71),
  repository          TEXT NOT NULL,
  github_pr_number    INTEGER NOT NULL CHECK (github_pr_number > 0),
  publication_id      TEXT REFERENCES pull_request_publications(publication_id),
  processing_state    TEXT NOT NULL CHECK (
    processing_state IN ('received', 'applied', 'ignored')
  ),
  ignore_reason       TEXT,
  external_updated_at TEXT NOT NULL,
  received_at         TEXT NOT NULL,
  processed_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_github_pr_deliveries_number
  ON github_pull_request_webhook_deliveries(repository, github_pr_number, external_updated_at);

CREATE TABLE IF NOT EXISTS github_pull_request_api_observations (
  observation_id      TEXT PRIMARY KEY,
  fact_digest         TEXT NOT NULL CHECK (length(fact_digest) = 71),
  repository          TEXT NOT NULL,
  github_pr_number    INTEGER NOT NULL CHECK (github_pr_number > 0),
  publication_id      TEXT REFERENCES pull_request_publications(publication_id),
  processing_state    TEXT NOT NULL CHECK (
    processing_state IN ('received', 'applied', 'ignored')
  ),
  ignore_reason       TEXT,
  external_updated_at TEXT NOT NULL,
  observed_at         TEXT NOT NULL,
  processed_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_github_pr_api_observations_number
  ON github_pull_request_api_observations(repository, github_pr_number, external_updated_at);

CREATE TRIGGER IF NOT EXISTS trg_pull_request_publication_snapshot_immutable
BEFORE UPDATE OF
  run_id, run_version, draft_id, approval_id, repository, base_branch,
  head_branch, head_sha, title, body_digest, created_at
ON pull_request_publications
BEGIN
  SELECT RAISE(ABORT, 'pull_request_publication_snapshot_is_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_pull_request_publication_status_monotonic
BEFORE UPDATE OF status ON pull_request_publications
WHEN NOT (
  OLD.status = NEW.status OR
  (OLD.status = 'pending' AND NEW.status IN ('created_unverified', 'verified')) OR
  (OLD.status = 'created_unverified' AND NEW.status = 'verified')
)
BEGIN
  SELECT RAISE(ABORT, 'pull_request_publication_status_cannot_regress');
END;
