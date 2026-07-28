-- Test deployments use a dedicated GitHub Environment/OIDC identity and an
-- externally verified deployment_status fact. A create response is not success.

CREATE TABLE IF NOT EXISTS test_deployments (
  deployment_id              TEXT PRIMARY KEY,
  run_id                     TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  run_version                INTEGER NOT NULL CHECK (run_version >= 0),
  plan_id                    TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version               INTEGER NOT NULL CHECK (plan_version > 0),
  plan_digest                TEXT NOT NULL CHECK (length(plan_digest) = 71),
  plan_item_id               TEXT NOT NULL,
  attempt_id                 TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  approval_id                TEXT NOT NULL REFERENCES approvals(approval_id),
  repository                 TEXT NOT NULL,
  base_branch                TEXT NOT NULL,
  base_sha                   TEXT NOT NULL CHECK (length(base_sha) = 40),
  ref_sha                    TEXT NOT NULL CHECK (length(ref_sha) = 40),
  workflow_path              TEXT NOT NULL,
  environment                TEXT NOT NULL CHECK (environment = 'test'),
  oidc_audience              TEXT NOT NULL CHECK (oidc_audience = 'delivery-loop-test-deploy'),
  role_ref                   TEXT NOT NULL CHECK (role_ref LIKE 'test:%'),
  status                     TEXT NOT NULL CHECK (
    status IN ('scheduled', 'created_unverified', 'in_progress', 'succeeded', 'failed')
  ),
  github_deployment_id       TEXT UNIQUE,
  external_state             TEXT,
  external_url               TEXT,
  external_updated_at        TEXT,
  observation_version        INTEGER NOT NULL DEFAULT 0 CHECK (observation_version >= 0),
  evidence_id                TEXT UNIQUE REFERENCES evidence(evidence_id),
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  UNIQUE (run_id, plan_id, plan_item_id),
  FOREIGN KEY (plan_id, plan_item_id) REFERENCES plan_items(plan_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_test_deployments_status
  ON test_deployments(status, updated_at);

CREATE TABLE IF NOT EXISTS test_deployment_oidc_attestations (
  attestation_id    TEXT PRIMARY KEY,
  deployment_id    TEXT NOT NULL UNIQUE REFERENCES test_deployments(deployment_id) ON DELETE CASCADE,
  oidc_token_digest TEXT NOT NULL UNIQUE CHECK (length(oidc_token_digest) = 71),
  repository        TEXT NOT NULL,
  workflow_ref      TEXT NOT NULL,
  sha               TEXT NOT NULL CHECK (length(sha) = 40),
  github_run_id     TEXT NOT NULL,
  subject           TEXT NOT NULL,
  environment       TEXT NOT NULL CHECK (environment = 'test'),
  audience          TEXT NOT NULL CHECK (audience = 'delivery-loop-test-deploy'),
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS github_test_deployment_webhook_deliveries (
  delivery_id          TEXT PRIMARY KEY,
  event_type           TEXT NOT NULL CHECK (event_type = 'deployment_status'),
  payload_digest       TEXT NOT NULL CHECK (length(payload_digest) = 71),
  repository           TEXT NOT NULL,
  github_deployment_id TEXT NOT NULL,
  deployment_id        TEXT REFERENCES test_deployments(deployment_id),
  processing_state     TEXT NOT NULL CHECK (
    processing_state IN ('received', 'applied', 'ignored')
  ),
  ignore_reason        TEXT,
  external_updated_at  TEXT NOT NULL,
  received_at          TEXT NOT NULL,
  processed_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_github_test_deployment_deliveries
  ON github_test_deployment_webhook_deliveries(
    repository, github_deployment_id, external_updated_at
  );

CREATE TRIGGER IF NOT EXISTS trg_test_deployment_snapshot_immutable
BEFORE UPDATE OF
  run_id, run_version, plan_id, plan_version, plan_digest, plan_item_id,
  attempt_id, approval_id, repository, base_branch, base_sha, ref_sha,
  workflow_path, environment, oidc_audience, role_ref, created_at
ON test_deployments
BEGIN SELECT RAISE(ABORT, 'test_deployment_snapshot_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_test_deployment_status_monotonic
BEFORE UPDATE OF status ON test_deployments
WHEN NOT (
  OLD.status = NEW.status OR
  (OLD.status = 'scheduled' AND NEW.status IN (
    'created_unverified', 'in_progress', 'succeeded', 'failed'
  )) OR
  (OLD.status = 'created_unverified' AND NEW.status IN (
    'in_progress', 'succeeded', 'failed'
  )) OR
  (OLD.status = 'in_progress' AND NEW.status IN ('succeeded', 'failed'))
)
BEGIN SELECT RAISE(ABORT, 'test_deployment_status_cannot_regress'); END;

CREATE TRIGGER IF NOT EXISTS trg_test_deployment_oidc_attestation_immutable
BEFORE UPDATE ON test_deployment_oidc_attestations
BEGIN SELECT RAISE(ABORT, 'test_deployment_oidc_attestation_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_github_test_deployment_delivery_identity_immutable
BEFORE UPDATE OF
  delivery_id, event_type, payload_digest, repository, github_deployment_id,
  external_updated_at, received_at
ON github_test_deployment_webhook_deliveries
BEGIN SELECT RAISE(ABORT, 'github_test_deployment_delivery_identity_is_immutable'); END;
