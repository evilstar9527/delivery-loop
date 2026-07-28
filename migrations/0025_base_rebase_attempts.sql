-- Durable lineage for replaying a verified unpublished bot head after a base-only Plan revision.

DROP VIEW IF EXISTS invalidated_approvals;

CREATE TABLE IF NOT EXISTS base_rebase_attempts (
  rebase_id             TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  revision_id           TEXT NOT NULL REFERENCES plan_revisions(revision_id) ON DELETE CASCADE,
  source_plan_id        TEXT NOT NULL REFERENCES execution_plans(plan_id),
  source_plan_version   INTEGER NOT NULL CHECK (source_plan_version > 0),
  target_plan_id        TEXT NOT NULL REFERENCES execution_plans(plan_id),
  target_plan_version   INTEGER NOT NULL CHECK (target_plan_version > 0),
  plan_item_id          TEXT NOT NULL,
  source_attempt_id     TEXT NOT NULL REFERENCES attempts(attempt_id),
  rebase_attempt_id     TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  old_base_sha          TEXT NOT NULL CHECK (length(old_base_sha) = 40),
  new_base_sha          TEXT NOT NULL CHECK (length(new_base_sha) = 40),
  source_branch         TEXT NOT NULL,
  source_head_sha       TEXT NOT NULL CHECK (length(source_head_sha) = 40),
  target_branch         TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('scheduled', 'passed', 'blocked')),
  result_head_sha       TEXT CHECK (result_head_sha IS NULL OR length(result_head_sha) = 40),
  verification_suite_id TEXT REFERENCES verification_suites(suite_id),
  blocker_reason        TEXT CHECK (
    blocker_reason IS NULL OR blocker_reason = 'base_rebase_content_conflict'
  ),
  created_at            TEXT NOT NULL,
  completed_at          TEXT,
  updated_at            TEXT NOT NULL,
  UNIQUE (revision_id, plan_item_id),
  CHECK (old_base_sha <> new_base_sha),
  CHECK (source_branch <> target_branch),
  CHECK (
    (status = 'scheduled'
      AND result_head_sha IS NULL
      AND verification_suite_id IS NULL
      AND blocker_reason IS NULL
      AND completed_at IS NULL)
    OR
    (status = 'passed'
      AND result_head_sha IS NOT NULL
      AND verification_suite_id IS NOT NULL
      AND blocker_reason IS NULL
      AND completed_at IS NOT NULL)
    OR
    (status = 'blocked'
      AND result_head_sha IS NULL
      AND verification_suite_id IS NULL
      AND blocker_reason = 'base_rebase_content_conflict'
      AND completed_at IS NOT NULL)
  ),
  FOREIGN KEY (source_plan_id, plan_item_id) REFERENCES plan_items(plan_id, item_id),
  FOREIGN KEY (target_plan_id, plan_item_id) REFERENCES plan_items(plan_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_base_rebase_attempts_run_status
  ON base_rebase_attempts(run_id, status, created_at);

CREATE TABLE IF NOT EXISTS base_rebase_approval_invalidations (
  approval_id     TEXT PRIMARY KEY REFERENCES approvals(approval_id) ON DELETE CASCADE,
  rebase_id       TEXT NOT NULL REFERENCES base_rebase_attempts(rebase_id) ON DELETE CASCADE,
  reason          TEXT NOT NULL CHECK (reason = 'base_rebase_content_conflict'),
  invalidated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_base_rebase_approval_invalidations_rebase
  ON base_rebase_approval_invalidations(rebase_id, invalidated_at);

CREATE VIEW invalidated_approvals AS
SELECT approval_id FROM approval_invalidations
UNION
SELECT approval_id FROM base_conflict_approval_invalidations
UNION
SELECT approval_id FROM base_rebase_approval_invalidations;

CREATE TRIGGER IF NOT EXISTS trg_base_rebase_attempt_snapshot_immutable
BEFORE UPDATE OF
  run_id, revision_id, source_plan_id, source_plan_version,
  target_plan_id, target_plan_version, plan_item_id,
  source_attempt_id, rebase_attempt_id, old_base_sha, new_base_sha,
  source_branch, source_head_sha, target_branch, created_at
ON base_rebase_attempts
BEGIN
  SELECT RAISE(ABORT, 'base_rebase_attempt_snapshot_is_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_base_rebase_attempt_status_monotonic
BEFORE UPDATE OF status ON base_rebase_attempts
WHEN NOT (
  OLD.status = NEW.status OR
  (OLD.status = 'scheduled' AND NEW.status IN ('passed', 'blocked'))
)
BEGIN
  SELECT RAISE(ABORT, 'base_rebase_attempt_status_cannot_regress');
END;
