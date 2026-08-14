-- A verification repair may fail before any repository effect when its
-- repo-write credential lease is stranded in an expired issuing state. Bind a
-- fresh approval to the current failed repair while preserving the prior
-- implementation head as the immutable recovery root.

CREATE VIEW implementation_repair_dependency_recovery_candidates AS
SELECT runs.run_id,
       runs.version AS run_version,
       plans.plan_id,
       plans.plan_version,
       plans.digest AS plan_digest,
       progress.item_id AS plan_item_id,
       progress.version AS progress_version,
       failed.attempt_id AS failed_attempt_id,
       prior.attempt_id AS root_review_attempt_id,
       failed.head_sha AS source_head_sha,
       blocker.blocker_id,
       'failed_dependency' AS source_kind
FROM runs
JOIN tasks ON tasks.task_id = runs.task_id
JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
JOIN plan_item_progress AS progress ON progress.plan_id = plans.plan_id
JOIN attempts AS failed ON failed.attempt_id = progress.active_attempt_id
JOIN attempt_failures AS failure ON failure.attempt_id = failed.attempt_id
JOIN run_blockers AS blocker
  ON blocker.run_id = runs.run_id
 AND blocker.retry_scope_digest = failure.retry_scope_digest
 AND blocker.fingerprint_digest = failure.fingerprint_digest
JOIN outbox AS repair_dispatch
  ON repair_dispatch.run_id = runs.run_id
 AND repair_dispatch.kind = 'execution_dispatch'
 AND repair_dispatch.delivery_state = 'settled'
 AND repair_dispatch.payload_ref = 'd1://attempts/' || failed.attempt_id
JOIN attempt_failures AS prior_failure
  ON repair_dispatch.dedupe_key = 'execution-repair:' || prior_failure.failure_id
JOIN attempts AS prior
  ON prior.attempt_id = prior_failure.attempt_id
 AND prior.run_id = runs.run_id
 AND prior.plan_id = plans.plan_id
 AND prior.plan_version = plans.plan_version
 AND prior.plan_item_id = progress.item_id
WHERE runs.state = 'blocked'
  AND runs.active_plan_version = plans.plan_version
  AND runs.active_plan_digest = plans.digest
  AND plans.status = 'active'
  AND plans.base_sha = runs.base_sha
  AND tasks.allow_repository_write = 1
  AND progress.status = 'blocked'
  AND progress.protected_path_gate_id IS NULL
  AND failed.mode = 'review_fix'
  AND failed.status = 'failed'
  AND failed.plan_id = plans.plan_id
  AND failed.plan_version = plans.plan_version
  AND failed.plan_item_id = progress.item_id
  AND failed.base_sha = runs.base_sha
  AND failed.head_sha IS NOT NULL
  AND failed.head_branch IS NULL
  AND failure.failure_class = 'tool_error'
  AND failure.failure_code = 'tool_unavailable'
  AND failure.failure_site = 'external_reconciliation'
  AND failure.needed_human_input = 'resolve_external_dependency'
  AND blocker.reason = 'external_dependency'
  AND blocker.needed_human_input = 'resolve_external_dependency'
  AND blocker.resolved_at IS NULL
  AND prior.mode = 'implement'
  AND prior.status = 'failed'
  AND prior.head_sha = failed.head_sha
  AND prior.head_branch IS NOT NULL
  AND prior_failure.failure_class = 'verification_error'
  AND prior_failure.failure_code = 'verification_nonzero_exit'
  AND prior_failure.failure_site = 'targeted_verification'
  AND EXISTS (
    SELECT 1 FROM plan_item_effects
    WHERE plan_item_effects.plan_id = plans.plan_id
      AND plan_item_effects.item_id = progress.item_id
      AND plan_item_effects.effect = 'repo_write'
  )
  AND EXISTS (
    SELECT 1 FROM outbox AS cancel
    WHERE cancel.run_id = runs.run_id
      AND cancel.kind = 'workflow_cancel'
      AND cancel.delivery_state = 'settled'
  )
  AND 1 = (
    SELECT COUNT(*) FROM github_write_credentials AS credential
    WHERE credential.attempt_id = failed.attempt_id
      AND credential.token_digest IS NULL
      AND credential.token_ciphertext IS NULL
      AND credential.token_iv IS NULL
      AND (
        credential.status = 'issuance_failed'
        OR (
          credential.status = 'issuing'
          AND credential.issue_lease_expires_at IS NOT NULL
          AND credential.issue_lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        )
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM attempt_head_updates WHERE attempt_head_updates.attempt_id = failed.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM verification_suites WHERE verification_suites.attempt_id = failed.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM evidence
    WHERE evidence.attempt_id = failed.attempt_id
      AND evidence.kind IN ('commit', 'test')
  )
  AND NOT EXISTS (
    SELECT 1 FROM review_approval_recovery_approvals
    WHERE review_approval_recovery_approvals.failed_attempt_id = failed.attempt_id
  );

CREATE VIEW repo_write_recovery_candidates_v4 AS
SELECT * FROM repo_write_recovery_candidates_v3
UNION ALL
SELECT * FROM implementation_repair_dependency_recovery_candidates;
