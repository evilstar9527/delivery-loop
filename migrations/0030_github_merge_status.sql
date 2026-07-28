-- A ready-to-merge decision and a GitHub merge are separate facts. This
-- migration records only externally observed merges; it creates no merge API
-- mutation or outbox.

CREATE TABLE IF NOT EXISTS github_merges (
  merge_id               TEXT PRIMARY KEY,
  run_id                 TEXT NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE CASCADE,
  run_version            INTEGER NOT NULL CHECK (run_version >= 0),
  decision_id            TEXT NOT NULL UNIQUE REFERENCES merge_gate_decisions(decision_id),
  publication_id         TEXT NOT NULL UNIQUE REFERENCES pull_request_publications(publication_id),
  plan_id                TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version           INTEGER NOT NULL CHECK (plan_version > 0),
  plan_digest            TEXT NOT NULL CHECK (length(plan_digest) = 71),
  repository             TEXT NOT NULL,
  github_pr_number       INTEGER NOT NULL CHECK (github_pr_number > 0),
  head_branch            TEXT NOT NULL,
  head_sha               TEXT NOT NULL CHECK (length(head_sha) = 40),
  base_branch            TEXT NOT NULL,
  base_sha               TEXT NOT NULL CHECK (length(base_sha) = 40),
  merge_sha              TEXT NOT NULL CHECK (length(merge_sha) = 40),
  merged_by_login        TEXT NOT NULL,
  merged_at              TEXT NOT NULL,
  external_updated_at    TEXT NOT NULL,
  deployment_disposition TEXT NOT NULL CHECK (
    deployment_disposition IN ('none', 'test', 'production')
  ),
  evidence_id            TEXT NOT NULL UNIQUE REFERENCES evidence(evidence_id),
  created_at             TEXT NOT NULL,
  UNIQUE (repository, github_pr_number),
  UNIQUE (repository, merge_sha)
);

CREATE TABLE IF NOT EXISTS github_merge_observations (
  observation_id      TEXT PRIMARY KEY,
  source_kind         TEXT NOT NULL CHECK (source_kind IN ('webhook', 'api')),
  fact_digest         TEXT NOT NULL CHECK (length(fact_digest) = 71),
  repository          TEXT NOT NULL,
  github_pr_number    INTEGER NOT NULL CHECK (github_pr_number > 0),
  merge_id            TEXT REFERENCES github_merges(merge_id),
  processing_state    TEXT NOT NULL CHECK (
    processing_state IN ('received', 'applied', 'ignored')
  ),
  ignore_reason       TEXT,
  external_updated_at TEXT NOT NULL,
  observed_at         TEXT NOT NULL,
  processed_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_github_merge_observations_pr
  ON github_merge_observations(repository, github_pr_number, external_updated_at);

CREATE TRIGGER IF NOT EXISTS trg_github_merges_immutable
BEFORE UPDATE ON github_merges
BEGIN SELECT RAISE(ABORT, 'github_merge_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_github_merge_observation_identity_immutable
BEFORE UPDATE OF
  observation_id, source_kind, fact_digest, repository, github_pr_number,
  external_updated_at, observed_at
ON github_merge_observations
BEGIN SELECT RAISE(ABORT, 'github_merge_observation_identity_is_immutable'); END;
