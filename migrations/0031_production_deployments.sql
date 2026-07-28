-- Production release approval and deployment lineage. A high-risk approval is
-- trusted only when it is bound to the immutable GitHub merge and the exact
-- production Environment. Creating a GitHub Deployment is not success.

CREATE TABLE IF NOT EXISTS production_release_approval_bindings (
  approval_id       TEXT PRIMARY KEY REFERENCES identity_bound_approvals(approval_id) ON DELETE CASCADE,
  run_id            TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  task_revision     TEXT NOT NULL,
  plan_id           TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version      INTEGER NOT NULL CHECK (plan_version > 0),
  plan_digest       TEXT NOT NULL CHECK (length(plan_digest) = 71),
  merge_id          TEXT NOT NULL REFERENCES github_merges(merge_id),
  merge_sha         TEXT NOT NULL CHECK (length(merge_sha) = 40),
  environment       TEXT NOT NULL CHECK (environment = 'production'),
  created_at        TEXT NOT NULL,
  UNIQUE (run_id, merge_id, approval_id)
);

CREATE TABLE IF NOT EXISTS production_deployments (
  deployment_id          TEXT PRIMARY KEY,
  run_id                 TEXT NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE CASCADE,
  run_version            INTEGER NOT NULL CHECK (run_version >= 0),
  task_revision          TEXT NOT NULL,
  plan_id                TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version           INTEGER NOT NULL CHECK (plan_version > 0),
  plan_digest            TEXT NOT NULL CHECK (length(plan_digest) = 71),
  merge_id               TEXT NOT NULL UNIQUE REFERENCES github_merges(merge_id),
  merge_sha              TEXT NOT NULL CHECK (length(merge_sha) = 40),
  attempt_id             TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  approval_id            TEXT NOT NULL REFERENCES production_release_approval_bindings(approval_id),
  repository             TEXT NOT NULL,
  base_branch            TEXT NOT NULL,
  workflow_path          TEXT NOT NULL,
  environment            TEXT NOT NULL CHECK (environment = 'production'),
  oidc_audience          TEXT NOT NULL,
  role_ref               TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (
    status IN ('scheduled', 'created_unverified', 'in_progress', 'succeeded', 'failed')
  ),
  github_deployment_id   TEXT UNIQUE,
  external_url           TEXT,
  evidence_id            TEXT UNIQUE REFERENCES evidence(evidence_id),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS production_deployment_oidc_attestations (
  attestation_id    TEXT PRIMARY KEY,
  deployment_id    TEXT NOT NULL UNIQUE REFERENCES production_deployments(deployment_id) ON DELETE CASCADE,
  oidc_token_digest TEXT NOT NULL CHECK (length(oidc_token_digest) = 71),
  repository        TEXT NOT NULL,
  workflow_ref      TEXT NOT NULL,
  sha               TEXT NOT NULL CHECK (length(sha) = 40),
  github_run_id     TEXT NOT NULL,
  subject           TEXT NOT NULL,
  environment       TEXT NOT NULL CHECK (environment = 'production'),
  audience          TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

DROP VIEW trusted_effect_approvals;

CREATE VIEW trusted_effect_approvals AS
SELECT approvals.*
FROM approvals
WHERE approvals.effect NOT IN ('merge', 'production_deploy')
UNION ALL
SELECT approvals.*
FROM approvals
JOIN identity_bound_approvals AS bindings
  ON bindings.approval_id = approvals.approval_id
JOIN channel_identities AS approver_identity
  ON approver_identity.channel = bindings.approver_channel
 AND approver_identity.channel_user_id = bindings.approver_channel_user_id
 AND approver_identity.principal = bindings.approver_principal
JOIN channel_identities AS author_identity
  ON author_identity.channel = bindings.pull_request_author_channel
 AND author_identity.channel_user_id = bindings.pull_request_author_login
 AND author_identity.principal = bindings.pull_request_author_principal
JOIN identity_mappings
  ON identity_mappings.principal = bindings.approver_principal
WHERE approvals.effect = 'merge'
  AND bindings.separation_verified = 1
  AND bindings.approver_principal <> bindings.pull_request_author_principal
  AND json_valid(identity_mappings.roles)
  AND json_type(identity_mappings.roles) = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(identity_mappings.roles) WHERE value = 'human'
  )
  AND EXISTS (
    SELECT 1 FROM json_each(identity_mappings.roles)
    WHERE value = 'approve:' || approvals.effect
  )
UNION ALL
SELECT approvals.*
FROM approvals
JOIN identity_bound_approvals AS bindings
  ON bindings.approval_id = approvals.approval_id
JOIN production_release_approval_bindings AS releases
  ON releases.approval_id = approvals.approval_id
JOIN github_merges AS merges
  ON merges.merge_id = releases.merge_id
 AND merges.run_id = releases.run_id
 AND merges.plan_id = releases.plan_id
 AND merges.plan_version = releases.plan_version
 AND merges.plan_digest = releases.plan_digest
 AND merges.merge_sha = releases.merge_sha
JOIN channel_identities AS approver_identity
  ON approver_identity.channel = bindings.approver_channel
 AND approver_identity.channel_user_id = bindings.approver_channel_user_id
 AND approver_identity.principal = bindings.approver_principal
JOIN channel_identities AS author_identity
  ON author_identity.channel = bindings.pull_request_author_channel
 AND author_identity.channel_user_id = bindings.pull_request_author_login
 AND author_identity.principal = bindings.pull_request_author_principal
JOIN identity_mappings
  ON identity_mappings.principal = bindings.approver_principal
WHERE approvals.effect = 'production_deploy'
  AND approvals.run_id = releases.run_id
  AND approvals.task_revision = releases.task_revision
  AND approvals.plan_id = releases.plan_id
  AND approvals.plan_version = releases.plan_version
  AND approvals.plan_digest = releases.plan_digest
  AND releases.environment = 'production'
  AND bindings.separation_verified = 1
  AND bindings.approver_principal <> bindings.pull_request_author_principal
  AND json_valid(identity_mappings.roles)
  AND json_type(identity_mappings.roles) = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(identity_mappings.roles) WHERE value = 'human'
  )
  AND EXISTS (
    SELECT 1 FROM json_each(identity_mappings.roles)
    WHERE value = 'approve:production_deploy'
  );

CREATE TRIGGER IF NOT EXISTS trg_production_release_approval_immutable
BEFORE UPDATE ON production_release_approval_bindings
BEGIN SELECT RAISE(ABORT, 'production_release_approval_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_production_deployment_identity_immutable
BEFORE UPDATE OF
  deployment_id, run_id, run_version, task_revision, plan_id, plan_version,
  plan_digest, merge_id, merge_sha, attempt_id, approval_id, repository,
  base_branch, workflow_path, environment, oidc_audience, role_ref, created_at
ON production_deployments
BEGIN SELECT RAISE(ABORT, 'production_deployment_identity_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_production_deployment_status_monotonic
BEFORE UPDATE OF status ON production_deployments
WHEN NOT (
  OLD.status = NEW.status OR
  (OLD.status = 'scheduled' AND NEW.status = 'created_unverified') OR
  (OLD.status = 'created_unverified' AND NEW.status IN ('in_progress', 'succeeded', 'failed')) OR
  (OLD.status = 'in_progress' AND NEW.status IN ('succeeded', 'failed'))
)
BEGIN SELECT RAISE(ABORT, 'production_deployment_status_cannot_regress'); END;

CREATE TRIGGER IF NOT EXISTS trg_production_deployment_oidc_immutable
BEFORE UPDATE ON production_deployment_oidc_attestations
BEGIN SELECT RAISE(ABORT, 'production_deployment_oidc_attestation_is_immutable'); END;
