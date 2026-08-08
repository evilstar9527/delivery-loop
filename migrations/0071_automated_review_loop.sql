-- Head-bound automated review attempts are read-only analysis attempts. Their
-- immutable lineage is separate from GitHub human review deliveries; only a
-- verified blocking result may open one existing-branch review_fix attempt.

CREATE TABLE automated_reviews (
  review_id               TEXT PRIMARY KEY,
  run_id                  TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  publication_id          TEXT NOT NULL REFERENCES pull_request_publications(publication_id),
  plan_id                 TEXT NOT NULL REFERENCES execution_plans(plan_id),
  plan_version            INTEGER NOT NULL CHECK (plan_version > 0),
  plan_item_id            TEXT NOT NULL,
  prior_attempt_id        TEXT NOT NULL REFERENCES attempts(attempt_id),
  review_attempt_id       TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id),
  repository              TEXT NOT NULL,
  github_pr_number        INTEGER NOT NULL CHECK (github_pr_number > 0),
  base_branch             TEXT NOT NULL,
  branch                  TEXT NOT NULL,
  source_head_sha         TEXT NOT NULL CHECK (length(source_head_sha) = 40),
  iteration               INTEGER NOT NULL CHECK (iteration BETWEEN 1 AND 3),
  status                  TEXT NOT NULL CHECK (
    status IN ('pending', 'approved', 'changes_requested', 'blocked')
  ),
  result_ref              TEXT,
  result_digest           TEXT CHECK (result_digest IS NULL OR length(result_digest) = 71),
  feedback_body_digest    TEXT CHECK (
    feedback_body_digest IS NULL OR length(feedback_body_digest) = 71
  ),
  blocking_finding_count  INTEGER CHECK (
    blocking_finding_count IS NULL OR blocking_finding_count BETWEEN 0 AND 20
  ),
  minor_finding_count     INTEGER CHECK (
    minor_finding_count IS NULL OR minor_finding_count BETWEEN 0 AND 20
  ),
  completed_at            TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE (publication_id, source_head_sha),
  UNIQUE (run_id, plan_id, iteration),
  FOREIGN KEY (plan_id, plan_item_id) REFERENCES plan_items(plan_id, item_id),
  CHECK (
    (status = 'pending' AND result_ref IS NULL AND result_digest IS NULL
      AND feedback_body_digest IS NULL AND blocking_finding_count IS NULL
      AND minor_finding_count IS NULL AND completed_at IS NULL)
    OR
    (status <> 'pending' AND result_ref IS NOT NULL AND result_digest IS NOT NULL
      AND feedback_body_digest IS NOT NULL AND blocking_finding_count IS NOT NULL
      AND minor_finding_count IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX idx_automated_reviews_run_status
  ON automated_reviews(run_id, status, iteration);

CREATE TABLE automated_review_fix_attempts (
  review_id          TEXT PRIMARY KEY REFERENCES automated_reviews(review_id),
  fix_attempt_id     TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id),
  prior_attempt_id   TEXT NOT NULL REFERENCES attempts(attempt_id),
  branch             TEXT NOT NULL,
  source_head_sha    TEXT NOT NULL CHECK (length(source_head_sha) = 40),
  created_at         TEXT NOT NULL
);

CREATE TRIGGER trg_automated_review_identity_immutable
BEFORE UPDATE OF run_id, publication_id, plan_id, plan_version, plan_item_id,
  prior_attempt_id, review_attempt_id, repository, github_pr_number,
  base_branch, branch, source_head_sha, iteration
ON automated_reviews
BEGIN
  SELECT RAISE(ABORT, 'automated_review_identity_is_immutable');
END;

CREATE TRIGGER trg_automated_review_result_immutable
BEFORE UPDATE OF result_ref, result_digest, feedback_body_digest,
  blocking_finding_count, minor_finding_count, completed_at
ON automated_reviews
WHEN OLD.result_digest IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'automated_review_result_is_immutable');
END;

CREATE TRIGGER trg_automated_review_status_monotonic
BEFORE UPDATE OF status ON automated_reviews
WHEN NOT (
  OLD.status = NEW.status OR
  (OLD.status = 'pending' AND NEW.status IN ('approved', 'changes_requested', 'blocked'))
)
BEGIN
  SELECT RAISE(ABORT, 'automated_review_status_cannot_regress');
END;

CREATE TRIGGER trg_automated_review_fix_attempt_immutable
BEFORE UPDATE ON automated_review_fix_attempts
BEGIN
  SELECT RAISE(ABORT, 'automated_review_fix_attempt_is_immutable');
END;
