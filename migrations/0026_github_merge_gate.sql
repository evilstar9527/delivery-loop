-- Immutable GitHub merge eligibility observations and ready-to-merge decisions.
-- This migration intentionally creates no merge outbox: eligibility and merge are separate effects.

CREATE TABLE IF NOT EXISTS github_merge_gate_observations (
  observation_id          TEXT PRIMARY KEY,
  run_id                  TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  run_version             INTEGER NOT NULL CHECK (run_version >= 0),
  publication_id          TEXT NOT NULL REFERENCES pull_request_publications(publication_id) ON DELETE CASCADE,
  fact_digest             TEXT NOT NULL CHECK (length(fact_digest) = 71),
  repository              TEXT NOT NULL,
  github_pr_number        INTEGER NOT NULL CHECK (github_pr_number > 0),
  head_branch             TEXT NOT NULL,
  head_sha                TEXT NOT NULL CHECK (length(head_sha) = 40),
  base_branch             TEXT NOT NULL,
  base_sha                TEXT NOT NULL CHECK (length(base_sha) = 40),
  pull_request_base_sha   TEXT NOT NULL CHECK (length(pull_request_base_sha) = 40),
  pull_request_state      TEXT NOT NULL CHECK (pull_request_state IN ('open', 'closed')),
  is_draft                INTEGER NOT NULL CHECK (is_draft IN (0, 1)),
  mergeability            TEXT NOT NULL CHECK (mergeability IN ('mergeable', 'conflicting', 'unknown')),
  merge_state             TEXT NOT NULL CHECK (
    merge_state IN ('clean', 'blocked', 'behind', 'dirty', 'draft', 'has_hooks', 'unstable', 'unknown')
  ),
  review_decision         TEXT NOT NULL CHECK (
    review_decision IN ('approved', 'review_required', 'changes_requested')
  ),
  required_approval_count INTEGER NOT NULL CHECK (required_approval_count >= 0),
  approved_review_count   INTEGER NOT NULL CHECK (approved_review_count >= 0),
  required_check_count    INTEGER NOT NULL CHECK (required_check_count >= 0),
  passed_check_count      INTEGER NOT NULL CHECK (passed_check_count >= 0),
  pending_check_count     INTEGER NOT NULL CHECK (pending_check_count >= 0),
  failed_check_count      INTEGER NOT NULL CHECK (failed_check_count >= 0),
  missing_check_count     INTEGER NOT NULL CHECK (missing_check_count >= 0),
  policy_digest           TEXT NOT NULL CHECK (length(policy_digest) = 71),
  checks_digest           TEXT NOT NULL CHECK (length(checks_digest) = 71),
  reviews_digest          TEXT NOT NULL CHECK (length(reviews_digest) = 71),
  external_updated_at     TEXT NOT NULL,
  observed_at             TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  UNIQUE (publication_id, run_version, fact_digest),
  CHECK (
    required_check_count = passed_check_count + pending_check_count +
      failed_check_count + missing_check_count
  )
);

CREATE INDEX IF NOT EXISTS idx_github_merge_gate_observations_run
  ON github_merge_gate_observations(run_id, created_at);

CREATE TABLE IF NOT EXISTS github_merge_gate_required_checks (
  observation_id TEXT NOT NULL REFERENCES github_merge_gate_observations(observation_id) ON DELETE CASCADE,
  position       INTEGER NOT NULL CHECK (position >= 0 AND position < 100),
  context        TEXT NOT NULL,
  integration_id INTEGER CHECK (integration_id IS NULL OR integration_id > 0),
  state          TEXT NOT NULL CHECK (state IN ('missing', 'pending', 'passed', 'failed')),
  PRIMARY KEY (observation_id, position),
  UNIQUE (observation_id, context, integration_id)
);

CREATE TABLE IF NOT EXISTS merge_gate_evaluations (
  evaluation_id  TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  run_version    INTEGER NOT NULL CHECK (run_version >= 0),
  publication_id TEXT NOT NULL REFERENCES pull_request_publications(publication_id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES github_merge_gate_observations(observation_id) ON DELETE CASCADE,
  plan_id        TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version   INTEGER NOT NULL CHECK (plan_version > 0),
  plan_digest    TEXT NOT NULL CHECK (length(plan_digest) = 71),
  approval_id    TEXT REFERENCES approvals(approval_id),
  status         TEXT NOT NULL CHECK (status IN ('passed', 'rejected')),
  rejection_reason TEXT CHECK (
    rejection_reason IS NULL OR rejection_reason IN (
      'required_checks_incomplete', 'required_checks_failed',
      'review_insufficient', 'base_not_latest', 'head_not_latest',
      'approval_required', 'approval_identity_unresolved', 'self_approval_denied',
      'policy_unavailable', 'mergeability_unavailable'
    )
  ),
  created_at     TEXT NOT NULL,
  UNIQUE (run_id, run_version, observation_id, evaluation_id),
  CHECK (
    (status = 'passed' AND rejection_reason IS NULL AND approval_id IS NOT NULL) OR
    (status = 'rejected' AND rejection_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_merge_gate_evaluations_run
  ON merge_gate_evaluations(run_id, created_at);

CREATE TABLE IF NOT EXISTS merge_gate_decisions (
  decision_id    TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  run_version    INTEGER NOT NULL CHECK (run_version >= 0),
  publication_id TEXT NOT NULL REFERENCES pull_request_publications(publication_id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL UNIQUE REFERENCES github_merge_gate_observations(observation_id),
  evaluation_id  TEXT NOT NULL UNIQUE REFERENCES merge_gate_evaluations(evaluation_id),
  plan_id        TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version   INTEGER NOT NULL CHECK (plan_version > 0),
  plan_digest    TEXT NOT NULL CHECK (length(plan_digest) = 71),
  approval_id    TEXT NOT NULL REFERENCES approvals(approval_id),
  head_sha       TEXT NOT NULL CHECK (length(head_sha) = 40),
  base_sha       TEXT NOT NULL CHECK (length(base_sha) = 40),
  status         TEXT NOT NULL CHECK (status = 'passed'),
  created_at     TEXT NOT NULL,
  UNIQUE (run_id, run_version)
);

CREATE TRIGGER IF NOT EXISTS trg_github_merge_gate_observations_immutable
BEFORE UPDATE ON github_merge_gate_observations
BEGIN
  SELECT RAISE(ABORT, 'github_merge_gate_observation_is_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_github_merge_gate_checks_immutable
BEFORE UPDATE ON github_merge_gate_required_checks
BEGIN
  SELECT RAISE(ABORT, 'github_merge_gate_check_is_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_merge_gate_evaluations_immutable
BEFORE UPDATE ON merge_gate_evaluations
BEGIN
  SELECT RAISE(ABORT, 'merge_gate_evaluation_is_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_merge_gate_decisions_immutable
BEFORE UPDATE ON merge_gate_decisions
BEGIN
  SELECT RAISE(ABORT, 'merge_gate_decision_is_immutable');
END;
