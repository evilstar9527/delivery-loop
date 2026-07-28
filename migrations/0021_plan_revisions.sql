-- Durable immutable ExecutionPlan replacement and explicit old-approval invalidation.

CREATE TABLE IF NOT EXISTS plan_revision_source_facts (
  source_ref          TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  expected_run_version INTEGER NOT NULL CHECK (expected_run_version >= 0),
  prior_plan_id       TEXT NOT NULL REFERENCES execution_plans(plan_id),
  prior_plan_version  INTEGER NOT NULL CHECK (prior_plan_version > 0),
  prior_plan_digest   TEXT NOT NULL CHECK (length(prior_plan_digest) = 71),
  source_kind         TEXT NOT NULL CHECK (
    source_kind IN ('review_feedback', 'supplemental_context', 'base_update')
  ),
  source_digest       TEXT NOT NULL CHECK (length(source_digest) = 71),
  requested_base_sha  TEXT NOT NULL CHECK (length(requested_base_sha) = 40),
  observed_at         TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  UNIQUE (run_id, prior_plan_id, source_kind, source_digest)
);

CREATE TABLE IF NOT EXISTS plan_revisions (
  revision_id               TEXT PRIMARY KEY,
  run_id                    TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  expected_run_version      INTEGER NOT NULL CHECK (expected_run_version >= 0),
  prior_plan_id             TEXT NOT NULL REFERENCES execution_plans(plan_id),
  prior_plan_version        INTEGER NOT NULL CHECK (prior_plan_version > 0),
  prior_plan_digest         TEXT NOT NULL CHECK (length(prior_plan_digest) = 71),
  prior_base_sha            TEXT NOT NULL CHECK (length(prior_base_sha) = 40),
  source_kind               TEXT NOT NULL CHECK (
    source_kind IN ('review_feedback', 'supplemental_context', 'base_update')
  ),
  source_ref                TEXT NOT NULL REFERENCES plan_revision_source_facts(source_ref),
  source_digest             TEXT NOT NULL CHECK (length(source_digest) = 71),
  requested_base_sha        TEXT NOT NULL CHECK (length(requested_base_sha) = 40),
  analysis_attempt_id       TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id),
  new_plan_id               TEXT UNIQUE REFERENCES execution_plans(plan_id),
  new_plan_version          INTEGER CHECK (new_plan_version IS NULL OR new_plan_version > 0),
  new_plan_digest           TEXT CHECK (
    new_plan_digest IS NULL OR length(new_plan_digest) = 71
  ),
  body_changed              INTEGER CHECK (body_changed IS NULL OR body_changed IN (0, 1)),
  base_changed              INTEGER CHECK (base_changed IS NULL OR base_changed IN (0, 1)),
  effects_changed           INTEGER CHECK (effects_changed IS NULL OR effects_changed IN (0, 1)),
  status                    TEXT NOT NULL CHECK (status IN ('analyzing', 'activated', 'rejected')),
  created_at                TEXT NOT NULL,
  activated_at              TEXT,
  updated_at                TEXT NOT NULL,
  UNIQUE (run_id, prior_plan_id, source_kind, source_ref, source_digest)
);

CREATE INDEX IF NOT EXISTS idx_plan_revisions_run_status
  ON plan_revisions(run_id, status, created_at);

CREATE TABLE IF NOT EXISTS approval_invalidations (
  approval_id     TEXT PRIMARY KEY REFERENCES approvals(approval_id) ON DELETE CASCADE,
  revision_id     TEXT NOT NULL REFERENCES plan_revisions(revision_id) ON DELETE CASCADE,
  reason          TEXT NOT NULL CHECK (reason = 'plan_revision_started'),
  invalidated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approval_invalidations_revision
  ON approval_invalidations(revision_id, invalidated_at);

CREATE TRIGGER IF NOT EXISTS trg_execution_plan_body_immutable
BEFORE UPDATE OF
  run_id, plan_version, task_revision, base_sha, digest,
  created_by_attempt_id, objective, created_at
ON execution_plans
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_body_is_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_execution_plan_status_monotonic
BEFORE UPDATE OF status ON execution_plans
WHEN NOT (
  OLD.status = NEW.status OR
  (OLD.status = 'proposed' AND NEW.status IN ('validated', 'superseded')) OR
  (OLD.status = 'validated' AND NEW.status IN ('approved', 'active', 'superseded')) OR
  (OLD.status = 'approved' AND NEW.status IN ('active', 'superseded', 'blocked')) OR
  (OLD.status = 'active' AND NEW.status IN ('superseded', 'completed', 'blocked'))
)
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_status_cannot_regress');
END;

CREATE TRIGGER IF NOT EXISTS trg_execution_plan_assumptions_immutable
BEFORE UPDATE ON execution_plan_assumptions
BEGIN SELECT RAISE(ABORT, 'execution_plan_assumption_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_execution_plan_evidence_refs_immutable
BEFORE UPDATE ON execution_plan_evidence_refs
BEGIN SELECT RAISE(ABORT, 'execution_plan_evidence_ref_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_plan_items_immutable
BEFORE UPDATE ON plan_items
BEGIN SELECT RAISE(ABORT, 'plan_item_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_plan_item_acceptance_criteria_immutable
BEFORE UPDATE ON plan_item_acceptance_criteria
BEGIN SELECT RAISE(ABORT, 'plan_item_acceptance_criterion_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_plan_item_done_when_immutable
BEFORE UPDATE ON plan_item_done_when
BEGIN SELECT RAISE(ABORT, 'plan_item_done_when_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_plan_item_dependencies_immutable
BEFORE UPDATE ON plan_item_dependencies
BEGIN SELECT RAISE(ABORT, 'plan_item_dependency_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_plan_item_effects_immutable
BEFORE UPDATE ON plan_item_effects
BEGIN SELECT RAISE(ABORT, 'plan_item_effect_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_plan_item_command_refs_immutable
BEFORE UPDATE ON plan_item_command_refs
BEGIN SELECT RAISE(ABORT, 'plan_item_command_ref_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_plan_item_evidence_kinds_immutable
BEFORE UPDATE ON plan_item_evidence_kinds
BEGIN SELECT RAISE(ABORT, 'plan_item_evidence_kind_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_plan_item_external_facts_immutable
BEFORE UPDATE ON plan_item_external_facts
BEGIN SELECT RAISE(ABORT, 'plan_item_external_fact_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_plan_revision_snapshot_immutable
BEFORE UPDATE OF
  run_id, expected_run_version, prior_plan_id, prior_plan_version,
  prior_plan_digest, prior_base_sha, source_kind, source_ref, source_digest,
  requested_base_sha, analysis_attempt_id, created_at
ON plan_revisions
BEGIN
  SELECT RAISE(ABORT, 'plan_revision_snapshot_is_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_plan_revision_source_fact_immutable
BEFORE UPDATE ON plan_revision_source_facts
BEGIN
  SELECT RAISE(ABORT, 'plan_revision_source_fact_is_immutable');
END;
