-- A repo-write repair can fail before any repository effect when the short-lived
-- credential broker is temporarily unavailable. Keep the original lost
-- implementation as the recovery lineage, but expose a fresh approval
-- candidate while the exact external-dependency blocker is still open.

DROP VIEW repo_write_recovery_candidates_v3;
DROP VIEW implementation_lost_pre_effect_recovery_candidates;

CREATE VIEW implementation_lost_pre_effect_recovery_candidates AS
SELECT runs.run_id,
       runs.version AS run_version,
       plans.plan_id,
       plans.plan_version,
       plans.digest AS plan_digest,
       progress.item_id AS plan_item_id,
       progress.version AS progress_version,
       lost.attempt_id AS failed_attempt_id,
       lost.attempt_id AS root_review_attempt_id,
       runs.base_sha AS source_head_sha,
       blocker.blocker_id AS blocker_id,
       'implement_lost_pre_effect' AS source_kind
FROM runs
JOIN tasks ON tasks.task_id = runs.task_id
JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
JOIN plan_item_progress AS progress ON progress.plan_id = plans.plan_id
JOIN attempts AS lost ON lost.attempt_id = progress.active_attempt_id
LEFT JOIN run_blockers AS blocker
  ON blocker.run_id = runs.run_id
 AND blocker.resolved_at IS NULL
 AND blocker.reason = 'external_dependency'
LEFT JOIN attempts AS dependency_attempt
  ON dependency_attempt.run_id = runs.run_id
 AND dependency_attempt.mode = 'review_fix'
 AND dependency_attempt.status = 'failed'
LEFT JOIN attempt_failures AS dependency_failure
  ON dependency_failure.attempt_id = dependency_attempt.attempt_id
 AND dependency_failure.failure_class = 'tool_error'
 AND dependency_failure.failure_code = 'tool_unavailable'
 AND dependency_failure.failure_site = 'external_reconciliation'
 AND dependency_failure.needed_human_input = 'resolve_external_dependency'
WHERE runs.state = 'blocked'
  AND runs.active_plan_version = plans.plan_version
  AND runs.active_plan_digest = plans.digest
  AND plans.status = 'active'
  AND plans.base_sha = runs.base_sha
  AND tasks.allow_repository_write = 1
  AND progress.status = 'in_progress'
  AND progress.active_attempt_id = lost.attempt_id
  AND progress.protected_path_gate_id IS NULL
  AND lost.mode = 'implement'
  AND lost.status = 'lost'
  AND lost.result_event_id IS NULL
  AND lost.github_status = 'completed'
  AND lost.github_conclusion IS NOT NULL
  AND lost.github_conclusion <> 'success'
  AND lost.plan_id = plans.plan_id
  AND lost.plan_version = plans.plan_version
  AND lost.plan_item_id = progress.item_id
  AND lost.base_sha = runs.base_sha
  AND lost.repository = tasks.target_repository
  AND lost.workflow_ref IS NOT NULL
  AND lost.head_branch IS NULL
  AND lost.head_sha IS NULL
  AND EXISTS (
    SELECT 1 FROM plan_item_effects
    WHERE plan_item_effects.plan_id = plans.plan_id
      AND plan_item_effects.item_id = progress.item_id
      AND plan_item_effects.effect = 'repo_write'
  )
  AND (
    NOT EXISTS (
      SELECT 1 FROM run_blockers
      WHERE run_blockers.run_id = runs.run_id
        AND run_blockers.resolved_at IS NULL
    )
    OR (
      blocker.blocker_id IS NOT NULL
      AND dependency_attempt.attempt_id IS NOT NULL
      AND dependency_failure.failure_id IS NOT NULL
    )
  )
  AND EXISTS (
    SELECT 1 FROM run_stuck_incidents AS incident
    WHERE incident.run_id = runs.run_id
      AND incident.attempt_id = lost.attempt_id
      AND incident.state_kind = 'running'
      AND incident.observed_run_state = 'executing'
      AND incident.run_version + 1 = runs.version
      AND incident.action = 'fence_lost_attempt'
      AND incident.status = 'resolved'
      AND incident.resolution_code = 'attempt_fenced'
  )
  AND EXISTS (
    SELECT 1 FROM outbox AS cancel
    WHERE cancel.run_id = runs.run_id
      AND cancel.kind = 'workflow_cancel'
      AND cancel.delivery_state = 'settled'
  )
  AND NOT EXISTS (
    SELECT 1 FROM github_write_credentials
    WHERE github_write_credentials.attempt_id = lost.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM attempt_failures WHERE attempt_failures.attempt_id = lost.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM attempt_head_updates WHERE attempt_head_updates.attempt_id = lost.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM verification_suites WHERE verification_suites.attempt_id = lost.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM evidence WHERE evidence.attempt_id = lost.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM checkpoints WHERE checkpoints.attempt_id = lost.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM attempts AS replacement
    WHERE replacement.recovered_from_attempt_id = lost.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM implementation_pre_effect_recovery_approvals AS recovery
    WHERE recovery.failed_attempt_id = lost.attempt_id
  );

CREATE VIEW repo_write_recovery_candidates_v3 AS
SELECT * FROM review_approval_recovery_candidates_v2
UNION ALL
SELECT * FROM implementation_lost_pre_effect_recovery_candidates;
