-- Automatic rollback is a separate test-only effect. It requires an exact,
-- commit-bound repository contract and a verified deployment/acceptance failure.

CREATE TABLE IF NOT EXISTS test_rollback_contract_observations (
  observation_id      TEXT PRIMARY KEY,
  source_kind         TEXT NOT NULL CHECK (
    source_kind IN ('deployment_failure', 'acceptance_failure')
  ),
  source_id           TEXT NOT NULL,
  source_evidence_id  TEXT NOT NULL REFERENCES evidence(evidence_id),
  repository          TEXT NOT NULL,
  ref_sha             TEXT NOT NULL CHECK (length(ref_sha) = 40),
  disposition         TEXT NOT NULL CHECK (
    disposition IN ('declared', 'not_declared', 'policy_missing', 'policy_invalid')
  ),
  policy_digest       TEXT CHECK (policy_digest IS NULL OR length(policy_digest) = 71),
  contract_digest     TEXT CHECK (contract_digest IS NULL OR length(contract_digest) = 71),
  workflow_path       TEXT,
  environment         TEXT CHECK (environment IS NULL OR environment = 'test'),
  oidc_audience       TEXT,
  role_ref            TEXT,
  observed_at         TEXT NOT NULL,
  UNIQUE (source_kind, source_id),
  CHECK (
    (disposition = 'declared' AND policy_digest IS NOT NULL AND
     contract_digest IS NOT NULL AND
     workflow_path = '.github/workflows/delivery-test-rollback.yml' AND
     environment = 'test' AND oidc_audience = 'delivery-loop-test-rollback' AND
     role_ref LIKE 'test:%') OR
    (disposition <> 'declared' AND contract_digest IS NULL AND
     workflow_path IS NULL AND environment IS NULL AND
     oidc_audience IS NULL AND role_ref IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS test_rollbacks (
  rollback_id             TEXT PRIMARY KEY,
  source_kind             TEXT NOT NULL CHECK (
    source_kind IN ('deployment_failure', 'acceptance_failure')
  ),
  source_id               TEXT NOT NULL,
  source_evidence_id      TEXT NOT NULL REFERENCES evidence(evidence_id),
  failed_attempt_id       TEXT NOT NULL REFERENCES attempts(attempt_id),
  deployment_id           TEXT NOT NULL REFERENCES test_deployments(deployment_id),
  approval_id             TEXT NOT NULL REFERENCES approvals(approval_id),
  contract_observation_id TEXT NOT NULL UNIQUE
    REFERENCES test_rollback_contract_observations(observation_id),
  run_id                  TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  run_version             INTEGER NOT NULL CHECK (run_version >= 0),
  plan_id                 TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version            INTEGER NOT NULL CHECK (plan_version > 0),
  plan_digest             TEXT NOT NULL CHECK (length(plan_digest) = 71),
  plan_item_id            TEXT NOT NULL,
  attempt_id              TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  repository              TEXT NOT NULL,
  base_branch             TEXT NOT NULL,
  base_sha                TEXT NOT NULL CHECK (length(base_sha) = 40),
  ref_sha                 TEXT NOT NULL CHECK (length(ref_sha) = 40),
  policy_digest           TEXT NOT NULL CHECK (length(policy_digest) = 71),
  contract_digest         TEXT NOT NULL CHECK (length(contract_digest) = 71),
  workflow_path           TEXT NOT NULL CHECK (
    workflow_path = '.github/workflows/delivery-test-rollback.yml'
  ),
  environment             TEXT NOT NULL CHECK (environment = 'test'),
  oidc_audience           TEXT NOT NULL CHECK (
    oidc_audience = 'delivery-loop-test-rollback'
  ),
  role_ref                TEXT NOT NULL CHECK (role_ref LIKE 'test:%'),
  status                  TEXT NOT NULL CHECK (
    status IN ('scheduled', 'dispatched', 'running', 'succeeded', 'failed')
  ),
  github_run_id           TEXT UNIQUE,
  runner_result_digest    TEXT UNIQUE CHECK (
    runner_result_digest IS NULL OR length(runner_result_digest) = 71
  ),
  runner_status           TEXT CHECK (runner_status IS NULL OR runner_status IN ('passed', 'failed')),
  runner_exit_code        INTEGER CHECK (
    runner_exit_code IS NULL OR (runner_exit_code >= 0 AND runner_exit_code <= 255)
  ),
  runner_duration_ms      INTEGER CHECK (
    runner_duration_ms IS NULL OR
    (runner_duration_ms >= 0 AND runner_duration_ms <= 3600000)
  ),
  external_state          TEXT,
  external_conclusion     TEXT,
  external_updated_at     TEXT,
  observation_version     INTEGER NOT NULL DEFAULT 0 CHECK (observation_version >= 0),
  evidence_id             TEXT UNIQUE REFERENCES evidence(evidence_id),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE (source_kind, source_id),
  FOREIGN KEY (plan_id, plan_item_id) REFERENCES plan_items(plan_id, item_id),
  CHECK (
    (runner_result_digest IS NULL AND runner_status IS NULL AND
     runner_exit_code IS NULL AND runner_duration_ms IS NULL) OR
    (runner_result_digest IS NOT NULL AND runner_status IS NOT NULL AND
     runner_exit_code IS NOT NULL AND runner_duration_ms IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_test_rollbacks_status
  ON test_rollbacks(status, updated_at);

CREATE TABLE IF NOT EXISTS test_rollback_oidc_attestations (
  attestation_id    TEXT PRIMARY KEY,
  rollback_id       TEXT NOT NULL UNIQUE REFERENCES test_rollbacks(rollback_id) ON DELETE CASCADE,
  oidc_token_digest TEXT NOT NULL UNIQUE CHECK (length(oidc_token_digest) = 71),
  repository        TEXT NOT NULL,
  workflow_ref      TEXT NOT NULL,
  sha               TEXT NOT NULL CHECK (length(sha) = 40),
  github_run_id     TEXT NOT NULL,
  subject           TEXT NOT NULL,
  environment       TEXT NOT NULL CHECK (environment = 'test'),
  audience          TEXT NOT NULL CHECK (audience = 'delivery-loop-test-rollback'),
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS github_test_rollback_observations (
  observation_id       TEXT PRIMARY KEY,
  source_kind          TEXT NOT NULL CHECK (source_kind IN ('webhook', 'api')),
  fact_digest          TEXT NOT NULL CHECK (length(fact_digest) = 71),
  repository           TEXT NOT NULL,
  github_run_id        TEXT NOT NULL,
  rollback_id          TEXT REFERENCES test_rollbacks(rollback_id),
  processing_state     TEXT NOT NULL CHECK (
    processing_state IN ('received', 'applied', 'ignored')
  ),
  ignore_reason        TEXT,
  external_updated_at  TEXT NOT NULL,
  observed_at          TEXT NOT NULL,
  processed_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_github_test_rollback_observations
  ON github_test_rollback_observations(
    repository, github_run_id, external_updated_at
  );

CREATE TRIGGER IF NOT EXISTS trg_test_rollback_contract_observation_immutable
BEFORE UPDATE ON test_rollback_contract_observations
BEGIN SELECT RAISE(ABORT, 'test_rollback_contract_observation_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_test_rollback_snapshot_immutable
BEFORE UPDATE OF
  source_kind, source_id, source_evidence_id, failed_attempt_id, deployment_id,
  approval_id, contract_observation_id, run_id, run_version, plan_id,
  plan_version, plan_digest, plan_item_id, attempt_id, repository, base_branch,
  base_sha, ref_sha, policy_digest, contract_digest, workflow_path, environment,
  oidc_audience, role_ref, created_at
ON test_rollbacks
BEGIN SELECT RAISE(ABORT, 'test_rollback_snapshot_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_test_rollback_status_monotonic
BEFORE UPDATE OF status ON test_rollbacks
WHEN NOT (
  OLD.status = NEW.status OR
  (OLD.status = 'scheduled' AND NEW.status IN ('dispatched', 'running', 'failed')) OR
  (OLD.status = 'dispatched' AND NEW.status IN ('running', 'succeeded', 'failed')) OR
  (OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed'))
)
BEGIN SELECT RAISE(ABORT, 'test_rollback_status_cannot_regress'); END;

CREATE TRIGGER IF NOT EXISTS trg_test_rollback_github_run_immutable
BEFORE UPDATE OF github_run_id ON test_rollbacks
WHEN OLD.github_run_id IS NOT NULL AND NEW.github_run_id IS NOT OLD.github_run_id
BEGIN SELECT RAISE(ABORT, 'test_rollback_github_run_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_test_rollback_runner_result_immutable
BEFORE UPDATE OF
  runner_result_digest, runner_status, runner_exit_code, runner_duration_ms
ON test_rollbacks
WHEN OLD.runner_result_digest IS NOT NULL AND (
  NEW.runner_result_digest IS NOT OLD.runner_result_digest OR
  NEW.runner_status IS NOT OLD.runner_status OR
  NEW.runner_exit_code IS NOT OLD.runner_exit_code OR
  NEW.runner_duration_ms IS NOT OLD.runner_duration_ms
)
BEGIN SELECT RAISE(ABORT, 'test_rollback_runner_result_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_test_rollback_oidc_immutable
BEFORE UPDATE ON test_rollback_oidc_attestations
BEGIN SELECT RAISE(ABORT, 'test_rollback_oidc_attestation_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_test_rollback_observation_identity_immutable
BEFORE UPDATE OF
  observation_id, source_kind, fact_digest, repository, github_run_id,
  external_updated_at, observed_at
ON github_test_rollback_observations
BEGIN SELECT RAISE(ABORT, 'test_rollback_observation_identity_is_immutable'); END;

