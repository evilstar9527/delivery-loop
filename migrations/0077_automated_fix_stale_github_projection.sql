-- The Runner failure callback can terminally fence an automated review_fix
-- before the GitHub observation projector records the already-failed Action.
-- Failed Attempt + revoked credential + zero effects are the write fence; a
-- stale github_status must not make fresh human-approved recovery unreachable.

CREATE VIEW automated_fix_failed_pre_effect_recovery_candidates AS
SELECT runs.run_id,
       runs.version AS run_version,
       plans.plan_id,
       plans.plan_version,
       plans.digest AS plan_digest,
       progress.item_id AS plan_item_id,
       progress.version AS progress_version,
       failed.attempt_id AS failed_attempt_id,
       failed.attempt_id AS root_review_attempt_id,
       failed.head_sha AS source_head_sha,
       NULL AS blocker_id,
       'automated_fix_failed_pre_effect' AS source_kind
FROM runs
JOIN tasks ON tasks.task_id = runs.task_id
JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
JOIN plan_item_progress AS progress ON progress.plan_id = plans.plan_id
JOIN attempts AS failed ON failed.attempt_id = progress.active_attempt_id
JOIN attempt_failures AS failure ON failure.attempt_id = failed.attempt_id
JOIN automated_review_fix_attempts AS fixes
  ON fixes.fix_attempt_id = failed.attempt_id
JOIN automated_reviews AS review ON review.review_id = fixes.review_id
JOIN pull_request_publications AS publication
  ON publication.publication_id = review.publication_id
WHERE runs.state = 'executing'
  AND runs.active_plan_version = plans.plan_version
  AND runs.active_plan_digest = plans.digest
  AND plans.status = 'active'
  AND plans.base_sha = runs.base_sha
  AND tasks.allow_repository_write = 1
  AND progress.status = 'in_progress'
  AND progress.active_attempt_id = failed.attempt_id
  AND progress.protected_path_gate_id IS NULL
  AND failed.mode = 'review_fix'
  AND failed.status = 'failed'
  AND failed.recovered_from_attempt_id IS NULL
  AND failed.plan_id = plans.plan_id
  AND failed.plan_version = plans.plan_version
  AND failed.plan_item_id = progress.item_id
  AND failed.base_sha = runs.base_sha
  AND failed.repository = review.repository
  AND failed.head_sha = review.source_head_sha
  AND failed.head_branch IS NULL
  AND failure.failure_class = 'unknown'
  AND failure.failure_code = 'unknown_failure'
  AND failure.failure_site = 'external_reconciliation'
  AND failure.needed_human_input = 'manual_investigation'
  AND review.run_id = runs.run_id
  AND review.plan_id = plans.plan_id
  AND review.plan_version = plans.plan_version
  AND review.plan_item_id = progress.item_id
  AND review.status = 'changes_requested'
  AND review.result_ref IS NOT NULL
  AND review.result_digest IS NOT NULL
  AND review.feedback_body_digest IS NOT NULL
  AND fixes.source_head_sha = review.source_head_sha
  AND fixes.branch = review.branch
  AND publication.status = 'verified'
  AND publication.run_id = runs.run_id
  AND publication.repository = review.repository
  AND publication.github_pr_number = review.github_pr_number
  AND publication.base_branch = review.base_branch
  AND publication.head_branch = review.branch
  AND publication.head_sha = review.source_head_sha
  AND review.source_head_sha = (
    SELECT updates.head_sha
    FROM attempt_head_updates AS updates
    JOIN attempts AS head_attempt ON head_attempt.attempt_id = updates.attempt_id
    WHERE updates.run_id = runs.run_id
      AND updates.plan_id = plans.plan_id
      AND updates.branch = review.branch
    ORDER BY head_attempt.ordinal DESC, updates.created_at DESC LIMIT 1
  )
  AND EXISTS (
    SELECT 1 FROM plan_item_effects
    WHERE plan_item_effects.plan_id = plans.plan_id
      AND plan_item_effects.item_id = progress.item_id
      AND plan_item_effects.effect = 'repo_write'
  )
  AND NOT EXISTS (
    SELECT 1 FROM run_blockers
    WHERE run_blockers.run_id = runs.run_id
      AND run_blockers.resolved_at IS NULL
  )
  AND (
    SELECT COUNT(*) FROM github_write_credentials
    WHERE github_write_credentials.attempt_id = failed.attempt_id
  ) = 1
  AND EXISTS (
    SELECT 1 FROM github_write_credentials
    WHERE github_write_credentials.attempt_id = failed.attempt_id
      AND github_write_credentials.status IN ('revoked', 'expired')
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
    SELECT 1 FROM attempts AS replacement
    WHERE replacement.recovered_from_attempt_id = failed.attempt_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM review_approval_recovery_approvals
    WHERE review_approval_recovery_approvals.failed_attempt_id = failed.attempt_id
  );

CREATE VIEW review_approval_recovery_candidates_v2 AS
SELECT * FROM review_approval_recovery_candidates
UNION
SELECT * FROM automated_fix_failed_pre_effect_recovery_candidates;
