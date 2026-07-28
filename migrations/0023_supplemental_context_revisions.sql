-- Immutable supplemental context lineage. Full context remains in private R2.

CREATE TABLE IF NOT EXISTS supplemental_context_revisions (
  context_id             TEXT PRIMARY KEY,
  event_digest           TEXT NOT NULL UNIQUE CHECK (length(event_digest) = 71),
  prior_task_id           TEXT NOT NULL REFERENCES tasks(task_id),
  prior_task_revision     TEXT NOT NULL,
  new_task_id             TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
  new_task_revision       TEXT NOT NULL,
  new_task_digest         TEXT NOT NULL CHECK (length(new_task_digest) = 71),
  new_run_id              TEXT NOT NULL UNIQUE REFERENCES runs(run_id),
  context_ref             TEXT NOT NULL UNIQUE,
  context_digest          TEXT NOT NULL CHECK (length(context_digest) = 71),
  apply_to_current_run    INTEGER NOT NULL CHECK (apply_to_current_run IN (0, 1)),
  applied_run_id          TEXT REFERENCES runs(run_id),
  expected_run_version    INTEGER CHECK (
    expected_run_version IS NULL OR expected_run_version >= 0
  ),
  prior_plan_id           TEXT REFERENCES execution_plans(plan_id),
  prior_plan_version      INTEGER CHECK (
    prior_plan_version IS NULL OR prior_plan_version > 0
  ),
  prior_plan_digest       TEXT CHECK (
    prior_plan_digest IS NULL OR length(prior_plan_digest) = 71
  ),
  base_sha                TEXT CHECK (base_sha IS NULL OR length(base_sha) = 40),
  created_at              TEXT NOT NULL,
  UNIQUE (prior_task_id),
  CHECK (prior_task_id <> new_task_id),
  CHECK (prior_task_revision <> new_task_revision),
  CHECK (
    (apply_to_current_run = 0
      AND applied_run_id IS NULL
      AND expected_run_version IS NULL
      AND prior_plan_id IS NULL
      AND prior_plan_version IS NULL
      AND prior_plan_digest IS NULL
      AND base_sha IS NULL)
    OR
    (apply_to_current_run = 1
      AND applied_run_id IS NOT NULL
      AND expected_run_version IS NOT NULL
      AND prior_plan_id IS NOT NULL
      AND prior_plan_version IS NOT NULL
      AND prior_plan_digest IS NOT NULL
      AND base_sha IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_supplemental_context_applied_run
  ON supplemental_context_revisions(applied_run_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_supplemental_context_revision_immutable
BEFORE UPDATE ON supplemental_context_revisions
BEGIN
  SELECT RAISE(ABORT, 'supplemental_context_revision_is_immutable');
END;
