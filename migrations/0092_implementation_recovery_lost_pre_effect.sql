-- An implementation-repair recovery can itself be fenced after dispatch but
-- before a write credential or any repository/test effect exists. Preserve the
-- immutable implementation repair lineage while exposing one fresh approval
-- candidate for that exact lost replacement.

DROP VIEW repo_write_recovery_candidates_v4;

CREATE VIEW implementation_repair_replacement_lost_pre_effect_candidates AS
SELECT runs.run_id,
       runs.version AS run_version,
       plans.plan_id,
       plans.plan_version,
       plans.digest AS plan_digest,
       progress.item_id AS plan_item_id,
       progress.version AS progress_version,
       lost.attempt_id AS failed_attempt_id,
       prior_recovery.root_review_attempt_id,
       lost.head_sha AS source_head_sha,
       NULL AS blocker_id,
       'lost_pre_effect' AS source_kind
FROM runs
JOIN tasks ON tasks.task_id = runs.task_id
JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
JOIN plan_item_progress AS progress ON progress.plan_id = plans.plan_id
JOIN attempts AS lost ON lost.attempt_id = progress.active_attempt_id
JOIN review_approval_recoveries AS prior_recovery
  ON prior_recovery.replacement_attempt_id = lost.attempt_id
 AND prior_recovery.root_review_attempt_id = lost.recovered_from_attempt_id
 AND prior_recovery.source_kind = 'failed_dependency'
JOIN attempts AS repair
  ON repair.attempt_id = prior_recovery.failed_attempt_id
 AND repair.run_id = runs.run_id
 AND repair.plan_id = plans.plan_id
 AND repair.plan_version = plans.plan_version
 AND repair.plan_item_id = progress.item_id
 AND repair.mode = 'review_fix'
 AND repair.status = 'failed'
 AND repair.head_sha = lost.head_sha
JOIN outbox AS repair_dispatch
  ON repair_dispatch.run_id = runs.run_id
 AND repair_dispatch.kind = 'execution_dispatch'
 AND repair_dispatch.delivery_state = 'settled'
 AND repair_dispatch.payload_ref = 'd1://attempts/' || repair.attempt_id
JOIN attempt_failures AS prior_failure
  ON repair_dispatch.dedupe_key = 'execution-repair:' || prior_failure.failure_id
JOIN attempts AS prior
  ON prior.attempt_id = prior_recovery.root_review_attempt_id
 AND prior.attempt_id = prior_failure.attempt_id
 AND prior.run_id = runs.run_id
 AND prior.plan_id = plans.plan_id
 AND prior.plan_version = plans.plan_version
 AND prior.plan_item_id = progress.item_id
 AND prior.mode = 'implement'
 AND prior.status = 'failed'
 AND prior.head_sha = lost.head_sha
WHERE runs.state = 'blocked'
  AND runs.active_plan_version = plans.plan_version
  AND runs.active_plan_digest = plans.digest
  AND plans.status = 'active'
  AND plans.base_sha = runs.base_sha
  AND tasks.allow_repository_write = 1
  AND progress.status = 'in_progress'
  AND progress.active_attempt_id = lost.attempt_id
  AND progress.protected_path_gate_id IS NULL
  AND lost.mode = 'review_fix'
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
  AND lost.head_sha IS NOT NULL
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
    SELECT 1 FROM run_blockers
    WHERE run_blockers.run_id = runs.run_id
      AND run_blockers.resolved_at IS NULL
  )
  AND (
    NOT EXISTS (
      SELECT 1 FROM github_write_credentials
      WHERE github_write_credentials.attempt_id = lost.attempt_id
    )
    OR (
      SELECT COUNT(*) FROM github_write_credentials
      WHERE github_write_credentials.attempt_id = lost.attempt_id
    ) = 1
    AND EXISTS (
      SELECT 1 FROM github_write_credentials
      WHERE github_write_credentials.attempt_id = lost.attempt_id
        AND github_write_credentials.status IN ('revoked', 'expired')
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM attempt_failures
    WHERE attempt_failures.attempt_id = lost.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM attempt_head_updates
    WHERE attempt_head_updates.attempt_id = lost.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM verification_suites
    WHERE verification_suites.attempt_id = lost.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM evidence
    WHERE evidence.attempt_id = lost.attempt_id
      AND evidence.kind IN ('commit', 'test')
  )
  AND NOT EXISTS (
    SELECT 1 FROM review_approval_recovery_approvals
    WHERE review_approval_recovery_approvals.failed_attempt_id = lost.attempt_id
  );

CREATE VIEW repo_write_recovery_candidates_v4 AS
SELECT * FROM repo_write_recovery_candidates_v3
UNION ALL
SELECT * FROM implementation_repair_dependency_recovery_candidates
UNION ALL
SELECT * FROM implementation_repair_replacement_lost_pre_effect_candidates;
