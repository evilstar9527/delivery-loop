-- A recovered review Action can still be fenced after a short-lived write
-- credential was issued but before any repository effect. Once that credential
-- is terminal, a fresh identity-bound approval may resume the immutable root
-- review lineage without reviving the lost Attempt or its credential.

ALTER TABLE review_approval_recovery_approvals
  ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'failed_dependency'
  CHECK (source_kind IN ('failed_dependency', 'lost_pre_effect'));

ALTER TABLE review_approval_recoveries
  ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'failed_dependency'
  CHECK (source_kind IN ('failed_dependency', 'lost_pre_effect'));

DROP VIEW review_approval_recovery_candidates;

CREATE VIEW review_approval_recovery_candidates AS
SELECT runs.run_id,
       runs.version AS run_version,
       plans.plan_id,
       plans.plan_version,
       plans.digest AS plan_digest,
       progress.item_id AS plan_item_id,
       progress.version AS progress_version,
       failed.attempt_id AS failed_attempt_id,
       COALESCE(failed.recovered_from_attempt_id, failed.attempt_id)
         AS root_review_attempt_id,
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
JOIN review_feedback_attempts AS review_lineage
  ON review_lineage.review_attempt_id =
     COALESCE(failed.recovered_from_attempt_id, failed.attempt_id)
JOIN github_review_feedbacks AS feedback
  ON feedback.feedback_id = review_lineage.feedback_id
 AND feedback.run_id = runs.run_id
 AND feedback.plan_id = plans.plan_id
 AND feedback.plan_version = plans.plan_version
 AND feedback.plan_item_id = progress.item_id
 AND feedback.source_head_sha = failed.head_sha
WHERE runs.state = 'blocked'
  AND runs.active_plan_version = plans.plan_version
  AND runs.active_plan_digest = plans.digest
  AND plans.status = 'blocked'
  AND plans.base_sha = runs.base_sha
  AND tasks.allow_repository_write = 1
  AND progress.status = 'blocked'
  AND progress.active_attempt_id = failed.attempt_id
  AND progress.protected_path_gate_id IS NULL
  AND failed.mode = 'review_fix'
  AND failed.status = 'failed'
  AND failed.plan_id = plans.plan_id
  AND failed.plan_version = plans.plan_version
  AND failed.plan_item_id = progress.item_id
  AND failed.base_sha = runs.base_sha
  AND failed.head_sha IS NOT NULL
  AND failure.failure_class = 'tool_error'
  AND failure.failure_code = 'tool_unavailable'
  AND failure.failure_site = 'external_reconciliation'
  AND failure.needed_human_input = 'resolve_external_dependency'
  AND blocker.reason = 'external_dependency'
  AND blocker.needed_human_input = 'resolve_external_dependency'
  AND blocker.resolved_at IS NULL
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
  AND NOT EXISTS (
    SELECT 1 FROM github_write_credentials
    WHERE github_write_credentials.attempt_id = failed.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM attempt_head_updates
    WHERE attempt_head_updates.attempt_id = failed.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM verification_suites
    WHERE verification_suites.attempt_id = failed.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM evidence
    WHERE evidence.attempt_id = failed.attempt_id
      AND evidence.kind IN ('commit', 'test')
  )
  AND NOT EXISTS (
    SELECT 1 FROM review_approval_recovery_approvals
    WHERE review_approval_recovery_approvals.failed_attempt_id = failed.attempt_id
  )

UNION ALL

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
JOIN review_feedback_attempts AS review_lineage
  ON review_lineage.review_attempt_id = prior_recovery.root_review_attempt_id
JOIN github_review_feedbacks AS feedback
  ON feedback.feedback_id = review_lineage.feedback_id
 AND feedback.run_id = runs.run_id
 AND feedback.plan_id = plans.plan_id
 AND feedback.plan_version = plans.plan_version
 AND feedback.plan_item_id = progress.item_id
 AND feedback.source_head_sha = lost.head_sha
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
  AND lost.github_status = 'completed'
  AND lost.github_conclusion IS NOT NULL
  AND lost.github_conclusion <> 'success'
  AND lost.plan_id = plans.plan_id
  AND lost.plan_version = plans.plan_version
  AND lost.plan_item_id = progress.item_id
  AND lost.base_sha = runs.base_sha
  AND lost.head_sha IS NOT NULL
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
    SELECT COUNT(*) FROM github_write_credentials
    WHERE github_write_credentials.attempt_id = lost.attempt_id
  ) = 1
  AND EXISTS (
    SELECT 1 FROM github_write_credentials
    WHERE github_write_credentials.attempt_id = lost.attempt_id
      AND github_write_credentials.status IN ('revoked', 'expired')
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
