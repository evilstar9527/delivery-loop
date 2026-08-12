-- A terminal automated review_fix that produced no repository/test effect can
-- be replaced once, but only after a fresh identity-bound repo_write approval.
-- Keep this source distinct from human-review dependency/lost recoveries.

DROP VIEW review_approval_recovery_candidates;
DROP TRIGGER trg_execution_plan_status_monotonic;
DROP TRIGGER trg_review_approval_recovery_approvals_immutable;
DROP TRIGGER trg_review_approval_recoveries_immutable;
DROP INDEX idx_review_approval_recovery_candidates;

ALTER TABLE review_approval_recovery_approvals
  RENAME TO review_approval_recovery_approvals_0076_old;
ALTER TABLE review_approval_recoveries
  RENAME TO review_approval_recoveries_0076_old;

CREATE TABLE review_approval_recovery_approvals (
  recovery_approval_id   TEXT PRIMARY KEY,
  run_id                 TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  plan_id                TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version           INTEGER NOT NULL CHECK (plan_version > 0),
  plan_item_id           TEXT NOT NULL,
  failed_attempt_id      TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  root_review_attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  approval_id            TEXT NOT NULL UNIQUE REFERENCES approvals(approval_id),
  created_at             TEXT NOT NULL,
  source_kind            TEXT NOT NULL DEFAULT 'failed_dependency' CHECK (
    source_kind IN (
      'failed_dependency', 'lost_pre_effect', 'automated_fix_failed_pre_effect'
    )
  ),
  FOREIGN KEY (plan_id, plan_item_id) REFERENCES plan_items(plan_id, item_id)
);

CREATE TABLE review_approval_recoveries (
  recovery_id            TEXT PRIMARY KEY,
  recovery_approval_id   TEXT NOT NULL UNIQUE
    REFERENCES review_approval_recovery_approvals(recovery_approval_id) ON DELETE CASCADE,
  run_id                 TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  plan_id                TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version           INTEGER NOT NULL CHECK (plan_version > 0),
  plan_item_id           TEXT NOT NULL,
  failed_attempt_id      TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  root_review_attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  approval_id            TEXT NOT NULL UNIQUE REFERENCES approvals(approval_id),
  replacement_attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  created_at             TEXT NOT NULL,
  source_kind            TEXT NOT NULL DEFAULT 'failed_dependency' CHECK (
    source_kind IN (
      'failed_dependency', 'lost_pre_effect', 'automated_fix_failed_pre_effect'
    )
  ),
  FOREIGN KEY (plan_id, plan_item_id) REFERENCES plan_items(plan_id, item_id),
  CHECK (failed_attempt_id <> replacement_attempt_id),
  CHECK (root_review_attempt_id <> replacement_attempt_id)
);

INSERT INTO review_approval_recovery_approvals
SELECT * FROM review_approval_recovery_approvals_0076_old;

INSERT INTO review_approval_recoveries
SELECT * FROM review_approval_recoveries_0076_old;

DROP TABLE review_approval_recoveries_0076_old;
DROP TABLE review_approval_recovery_approvals_0076_old;

CREATE INDEX idx_review_approval_recovery_candidates
  ON review_approval_recovery_approvals(run_id, created_at);

CREATE TRIGGER trg_review_approval_recovery_approvals_immutable
BEFORE UPDATE ON review_approval_recovery_approvals
BEGIN
  SELECT RAISE(ABORT, 'review_approval_recovery_approval_is_immutable');
END;

CREATE TRIGGER trg_review_approval_recoveries_immutable
BEFORE UPDATE ON review_approval_recoveries
BEGIN
  SELECT RAISE(ABORT, 'review_approval_recovery_is_immutable');
END;

CREATE TRIGGER trg_execution_plan_status_monotonic
BEFORE UPDATE OF status ON execution_plans
WHEN NOT (
  OLD.status = NEW.status OR
  (OLD.status = 'proposed' AND NEW.status IN ('validated', 'superseded')) OR
  (OLD.status = 'validated' AND NEW.status IN ('approved', 'active', 'superseded')) OR
  (OLD.status = 'approved' AND NEW.status IN ('active', 'superseded', 'blocked')) OR
  (OLD.status = 'active' AND NEW.status IN ('superseded', 'completed', 'blocked')) OR
  (
    OLD.status = 'blocked' AND NEW.status = 'active' AND EXISTS (
      SELECT 1 FROM review_approval_recovery_approvals AS recovery
      WHERE recovery.plan_id = OLD.plan_id
        AND NOT EXISTS (
          SELECT 1 FROM review_approval_recoveries
          WHERE review_approval_recoveries.recovery_approval_id =
                recovery.recovery_approval_id
        )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_status_cannot_regress');
END;

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
  )

UNION ALL

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
  AND failed.plan_id = plans.plan_id
  AND failed.plan_version = plans.plan_version
  AND failed.plan_item_id = progress.item_id
  AND failed.base_sha = runs.base_sha
  AND failed.repository = review.repository
  AND failed.head_sha = review.source_head_sha
  AND failed.head_branch IS NULL
  AND failed.github_status = 'completed'
  AND failed.github_conclusion IS NOT NULL
  AND failed.github_conclusion <> 'success'
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
