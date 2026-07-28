-- Read-only correlation views over authoritative D1 facts. Views avoid write
-- fan-out and cannot perturb producer meta.changes/idempotency semantics.

CREATE INDEX IF NOT EXISTS idx_attempts_github_run_correlation
  ON attempts(github_run_id) WHERE github_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pull_requests_number_correlation
  ON pull_request_publications(repository, github_pr_number)
  WHERE github_pr_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_test_deployments_github_correlation
  ON test_deployments(repository, github_deployment_id)
  WHERE github_deployment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_production_deployments_github_correlation
  ON production_deployments(repository, github_deployment_id)
  WHERE github_deployment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_test_acceptances_github_correlation
  ON test_acceptances(github_run_id) WHERE github_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_test_rollbacks_github_correlation
  ON test_rollbacks(github_run_id) WHERE github_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_test_deployment_oidc_github_correlation
  ON test_deployment_oidc_attestations(github_run_id);

CREATE INDEX IF NOT EXISTS idx_production_deployment_oidc_github_correlation
  ON production_deployment_oidc_attestations(github_run_id);

-- Split views stay below workerd SQLite's compound-select term limit.
CREATE VIEW IF NOT EXISTS correlation_links_identity AS
SELECT 'task' AS identifier_kind, '' AS identifier_scope,
       runs.task_id AS identifier_value, runs.run_id AS correlation_id,
       runs.task_id, 'run' AS source_kind, runs.run_id AS source_id,
       runs.created_at AS linked_at
FROM runs
UNION ALL
SELECT 'run', '', runs.run_id, runs.run_id, runs.task_id,
       'run', runs.run_id, runs.created_at
FROM runs
UNION ALL
SELECT 'attempt', '', attempts.attempt_id, attempts.run_id, runs.task_id,
       'attempt', attempts.attempt_id, attempts.created_at
FROM attempts JOIN runs ON runs.run_id = attempts.run_id
UNION ALL
SELECT 'github_run', '', attempts.github_run_id, attempts.run_id, runs.task_id,
       'attempt', attempts.attempt_id, attempts.updated_at
FROM attempts JOIN runs ON runs.run_id = attempts.run_id
WHERE attempts.github_run_id IS NOT NULL;

CREATE VIEW IF NOT EXISTS correlation_links_trace_pr AS
SELECT 'trace' AS identifier_kind, '' AS identifier_scope,
       traces.trace_id AS identifier_value, traces.run_id AS correlation_id,
       runs.task_id, 'tool_trace' AS source_kind, traces.trace_id AS source_id,
       traces.occurred_at AS linked_at
FROM tool_call_traces AS traces JOIN runs ON runs.run_id = traces.run_id
UNION ALL
SELECT 'github_pr', publications.repository, CAST(publications.github_pr_number AS TEXT),
       publications.run_id, runs.task_id, 'pull_request', publications.publication_id,
       publications.updated_at
FROM pull_request_publications AS publications JOIN runs ON runs.run_id = publications.run_id
WHERE publications.github_pr_number IS NOT NULL;

CREATE VIEW IF NOT EXISTS correlation_links_deployments AS
SELECT 'test_deployment' AS identifier_kind, '' AS identifier_scope,
       deployments.deployment_id AS identifier_value,
       deployments.run_id AS correlation_id, runs.task_id,
       'test_deployment' AS source_kind, deployments.deployment_id AS source_id,
       deployments.created_at AS linked_at
FROM test_deployments AS deployments JOIN runs ON runs.run_id = deployments.run_id
UNION ALL
SELECT 'github_deployment', deployments.repository, deployments.github_deployment_id,
       deployments.run_id, runs.task_id, 'test_deployment', deployments.deployment_id,
       deployments.updated_at
FROM test_deployments AS deployments JOIN runs ON runs.run_id = deployments.run_id
WHERE deployments.github_deployment_id IS NOT NULL
UNION ALL
SELECT 'production_deployment', '', deployments.deployment_id, deployments.run_id,
       runs.task_id, 'production_deployment', deployments.deployment_id, deployments.created_at
FROM production_deployments AS deployments JOIN runs ON runs.run_id = deployments.run_id
UNION ALL
SELECT 'github_deployment', deployments.repository, deployments.github_deployment_id,
       deployments.run_id, runs.task_id, 'production_deployment', deployments.deployment_id,
       deployments.updated_at
FROM production_deployments AS deployments JOIN runs ON runs.run_id = deployments.run_id
WHERE deployments.github_deployment_id IS NOT NULL;

CREATE VIEW IF NOT EXISTS correlation_links_workflow_runs AS
SELECT 'test_acceptance' AS identifier_kind, '' AS identifier_scope,
       acceptances.acceptance_id AS identifier_value,
       acceptances.run_id AS correlation_id, runs.task_id,
       'test_acceptance' AS source_kind, acceptances.acceptance_id AS source_id,
       acceptances.created_at AS linked_at
FROM test_acceptances AS acceptances JOIN runs ON runs.run_id = acceptances.run_id
UNION ALL
SELECT 'github_run', '', acceptances.github_run_id, acceptances.run_id,
       runs.task_id, 'test_acceptance', acceptances.acceptance_id, acceptances.updated_at
FROM test_acceptances AS acceptances JOIN runs ON runs.run_id = acceptances.run_id
WHERE acceptances.github_run_id IS NOT NULL
UNION ALL
SELECT 'test_rollback', '', rollbacks.rollback_id, rollbacks.run_id,
       runs.task_id, 'test_rollback', rollbacks.rollback_id, rollbacks.created_at
FROM test_rollbacks AS rollbacks JOIN runs ON runs.run_id = rollbacks.run_id
UNION ALL
SELECT 'github_run', '', rollbacks.github_run_id, rollbacks.run_id,
       runs.task_id, 'test_rollback', rollbacks.rollback_id, rollbacks.updated_at
FROM test_rollbacks AS rollbacks JOIN runs ON runs.run_id = rollbacks.run_id
WHERE rollbacks.github_run_id IS NOT NULL;

CREATE VIEW IF NOT EXISTS correlation_links_deployment_runs AS
SELECT 'github_run' AS identifier_kind, '' AS identifier_scope,
       attestations.github_run_id AS identifier_value,
       deployments.run_id AS correlation_id, runs.task_id,
       'test_deployment_oidc' AS source_kind, attestations.attestation_id AS source_id,
       attestations.created_at AS linked_at
FROM test_deployment_oidc_attestations AS attestations
JOIN test_deployments AS deployments ON deployments.deployment_id = attestations.deployment_id
JOIN runs ON runs.run_id = deployments.run_id
UNION ALL
SELECT 'github_run', '', attestations.github_run_id, deployments.run_id,
       runs.task_id, 'production_deployment_oidc', attestations.attestation_id,
       attestations.created_at
FROM production_deployment_oidc_attestations AS attestations
JOIN production_deployments AS deployments
  ON deployments.deployment_id = attestations.deployment_id
JOIN runs ON runs.run_id = deployments.run_id;
