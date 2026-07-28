-- Immutable non-fast-forward GitHub base facts and one durable human-action blocker.

CREATE TABLE IF NOT EXISTS github_base_conflicts (
  conflict_id             TEXT PRIMARY KEY,
  run_id                  TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  expected_run_version    INTEGER NOT NULL CHECK (expected_run_version >= 0),
  prior_plan_id           TEXT NOT NULL REFERENCES execution_plans(plan_id),
  prior_plan_version      INTEGER NOT NULL CHECK (prior_plan_version > 0),
  prior_plan_digest       TEXT NOT NULL CHECK (length(prior_plan_digest) = 71),
  repository              TEXT NOT NULL,
  base_branch             TEXT NOT NULL,
  before_sha              TEXT NOT NULL CHECK (length(before_sha) = 40),
  after_sha               TEXT NOT NULL CHECK (length(after_sha) = 40),
  relationship            TEXT NOT NULL CHECK (
    relationship IN ('behind', 'diverged', 'identical')
  ),
  ahead_by                INTEGER NOT NULL CHECK (ahead_by >= 0),
  behind_by               INTEGER NOT NULL CHECK (behind_by >= 0),
  merge_base_sha          TEXT NOT NULL CHECK (length(merge_base_sha) = 40),
  reference_digest        TEXT NOT NULL CHECK (length(reference_digest) = 71),
  comparison_digest       TEXT NOT NULL CHECK (length(comparison_digest) = 71),
  source_digest           TEXT NOT NULL CHECK (length(source_digest) = 71),
  blocker_reason          TEXT NOT NULL CHECK (blocker_reason = 'base_history_diverged'),
  needed_human_input      TEXT NOT NULL CHECK (needed_human_input = 'manual_rebase'),
  observed_at             TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  CHECK (before_sha <> after_sha),
  UNIQUE (run_id, expected_run_version),
  UNIQUE (run_id, before_sha, after_sha)
);

CREATE INDEX IF NOT EXISTS idx_github_base_conflicts_run
  ON github_base_conflicts(run_id, created_at);

CREATE TABLE IF NOT EXISTS base_conflict_approval_invalidations (
  approval_id     TEXT PRIMARY KEY REFERENCES approvals(approval_id) ON DELETE CASCADE,
  conflict_id     TEXT NOT NULL REFERENCES github_base_conflicts(conflict_id) ON DELETE CASCADE,
  reason          TEXT NOT NULL CHECK (reason = 'base_history_diverged'),
  invalidated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_base_conflict_approval_invalidations_conflict
  ON base_conflict_approval_invalidations(conflict_id, invalidated_at);

-- Every approval consumer uses this union so a base conflict revokes authority immediately.
CREATE VIEW IF NOT EXISTS invalidated_approvals AS
SELECT approval_id FROM approval_invalidations
UNION
SELECT approval_id FROM base_conflict_approval_invalidations;

CREATE TRIGGER IF NOT EXISTS trg_github_base_conflicts_immutable
BEFORE UPDATE ON github_base_conflicts
BEGIN
  SELECT RAISE(ABORT, 'github_base_conflict_is_immutable');
END;

