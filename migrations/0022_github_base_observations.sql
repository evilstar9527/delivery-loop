-- GitHub API-observed fast-forward base changes that can start immutable Plan revision.

CREATE TABLE IF NOT EXISTS github_base_observations (
  observation_id        TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  expected_run_version  INTEGER NOT NULL CHECK (expected_run_version >= 0),
  prior_plan_id         TEXT NOT NULL REFERENCES execution_plans(plan_id),
  prior_plan_version    INTEGER NOT NULL CHECK (prior_plan_version > 0),
  prior_plan_digest     TEXT NOT NULL CHECK (length(prior_plan_digest) = 71),
  repository            TEXT NOT NULL,
  base_branch           TEXT NOT NULL,
  before_sha            TEXT NOT NULL CHECK (length(before_sha) = 40),
  after_sha             TEXT NOT NULL CHECK (length(after_sha) = 40),
  relationship          TEXT NOT NULL CHECK (relationship = 'ahead'),
  ahead_by              INTEGER NOT NULL CHECK (ahead_by > 0),
  reference_digest      TEXT NOT NULL CHECK (length(reference_digest) = 71),
  comparison_digest     TEXT NOT NULL CHECK (length(comparison_digest) = 71),
  source_digest         TEXT NOT NULL CHECK (length(source_digest) = 71),
  observed_at           TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  CHECK (before_sha <> after_sha),
  UNIQUE (run_id, expected_run_version),
  UNIQUE (run_id, before_sha, after_sha)
);

CREATE INDEX IF NOT EXISTS idx_github_base_observations_run
  ON github_base_observations(run_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_github_base_observations_immutable
BEFORE UPDATE ON github_base_observations
BEGIN
  SELECT RAISE(ABORT, 'github_base_observation_is_immutable');
END;
