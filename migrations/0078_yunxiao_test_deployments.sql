-- Selects the external provider for test deployment effects. Existing rows stay
-- GitHub-backed; Yunxiao rows use pipeline/run identifiers and are reconciled
-- through Tool Bridge.
ALTER TABLE test_deployments ADD COLUMN provider TEXT NOT NULL DEFAULT 'github_actions'
  CHECK (provider IN ('github_actions', 'yunxiao_pipeline'));
ALTER TABLE test_deployments ADD COLUMN provider_pipeline_id TEXT;
ALTER TABLE test_deployments ADD COLUMN provider_repository_url TEXT;
ALTER TABLE test_deployments ADD COLUMN provider_source_ref TEXT;
ALTER TABLE test_deployments ADD COLUMN provider_run_id TEXT;

CREATE INDEX IF NOT EXISTS idx_test_deployments_provider_status
  ON test_deployments(provider, status, updated_at);

DROP TRIGGER IF EXISTS trg_test_deployment_snapshot_immutable;
CREATE TRIGGER trg_test_deployment_snapshot_immutable
BEFORE UPDATE OF
  run_id, run_version, plan_id, plan_version, plan_digest, plan_item_id,
  attempt_id, approval_id, repository, base_branch, base_sha, ref_sha,
  workflow_path, environment, oidc_audience, role_ref, provider,
  provider_pipeline_id, provider_repository_url, provider_source_ref, created_at
ON test_deployments
BEGIN SELECT RAISE(ABORT, 'test_deployment_snapshot_is_immutable'); END;
