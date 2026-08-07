-- A review_fix that failed before any repository effect because its repo-write
-- approval expired may be reopened only by a fresh identity-bound approval.
-- Keep the approval request and the resulting replacement lineage immutable.

CREATE TABLE IF NOT EXISTS review_approval_recovery_approvals (
  recovery_approval_id   TEXT PRIMARY KEY,
  run_id                 TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  plan_id                TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version           INTEGER NOT NULL CHECK (plan_version > 0),
  plan_item_id           TEXT NOT NULL,
  failed_attempt_id      TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  root_review_attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  approval_id            TEXT NOT NULL UNIQUE REFERENCES approvals(approval_id),
  created_at             TEXT NOT NULL,
  FOREIGN KEY (plan_id, plan_item_id) REFERENCES plan_items(plan_id, item_id)
);

CREATE TABLE IF NOT EXISTS review_approval_recoveries (
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
  FOREIGN KEY (plan_id, plan_item_id) REFERENCES plan_items(plan_id, item_id),
  CHECK (failed_attempt_id <> replacement_attempt_id),
  CHECK (root_review_attempt_id <> replacement_attempt_id)
);

CREATE INDEX IF NOT EXISTS idx_review_approval_recovery_candidates
  ON review_approval_recovery_approvals(run_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_review_approval_recovery_approvals_immutable
BEFORE UPDATE ON review_approval_recovery_approvals
BEGIN
  SELECT RAISE(ABORT, 'review_approval_recovery_approval_is_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_review_approval_recoveries_immutable
BEFORE UPDATE ON review_approval_recoveries
BEGIN
  SELECT RAISE(ABORT, 'review_approval_recovery_is_immutable');
END;

DROP TRIGGER trg_execution_plan_status_monotonic;

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

CREATE VIEW IF NOT EXISTS review_approval_recovery_candidates AS
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
       blocker.blocker_id
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
  );
