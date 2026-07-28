-- Head-bound GitHub review feedback and the same-PR review_fix Attempt lineage.
-- Review text is private R2 data; D1 stores only immutable references and digests.

CREATE TABLE IF NOT EXISTS github_review_webhook_deliveries (
  delivery_id        TEXT PRIMARY KEY,
  event_type         TEXT NOT NULL CHECK (event_type = 'pull_request_review'),
  payload_digest     TEXT NOT NULL CHECK (length(payload_digest) = 71),
  repository         TEXT NOT NULL,
  github_pr_number   INTEGER NOT NULL CHECK (github_pr_number > 0),
  github_review_id   TEXT NOT NULL,
  publication_id     TEXT REFERENCES pull_request_publications(publication_id),
  reviewed_head_sha  TEXT NOT NULL CHECK (length(reviewed_head_sha) = 40),
  processing_state   TEXT NOT NULL CHECK (
    processing_state IN ('received', 'applied', 'ignored')
  ),
  ignore_reason      TEXT,
  received_at        TEXT NOT NULL,
  processed_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_github_review_deliveries_review
  ON github_review_webhook_deliveries(repository, github_pr_number, github_review_id);

CREATE TABLE IF NOT EXISTS github_review_feedbacks (
  feedback_id         TEXT PRIMARY KEY,
  source_delivery_id  TEXT NOT NULL UNIQUE
    REFERENCES github_review_webhook_deliveries(delivery_id),
  github_review_id    TEXT NOT NULL UNIQUE,
  publication_id      TEXT NOT NULL REFERENCES pull_request_publications(publication_id),
  run_id              TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  expected_run_version INTEGER NOT NULL CHECK (expected_run_version >= 0),
  plan_id             TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version        INTEGER NOT NULL CHECK (plan_version > 0),
  plan_item_id        TEXT NOT NULL,
  prior_attempt_id    TEXT NOT NULL REFERENCES attempts(attempt_id),
  repository          TEXT NOT NULL,
  github_pr_number    INTEGER NOT NULL CHECK (github_pr_number > 0),
  source_head_sha     TEXT NOT NULL CHECK (length(source_head_sha) = 40),
  branch              TEXT NOT NULL,
  review_url          TEXT NOT NULL,
  submitted_at        TEXT NOT NULL,
  body_ref            TEXT NOT NULL,
  body_digest         TEXT NOT NULL CHECK (length(body_digest) = 71),
  payload_digest      TEXT NOT NULL CHECK (length(payload_digest) = 71),
  created_at          TEXT NOT NULL,
  FOREIGN KEY (plan_id, plan_item_id) REFERENCES plan_items(plan_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_github_review_feedbacks_run_item
  ON github_review_feedbacks(run_id, plan_id, plan_version, plan_item_id, created_at);

CREATE TABLE IF NOT EXISTS review_feedback_attempts (
  feedback_id        TEXT PRIMARY KEY
    REFERENCES github_review_feedbacks(feedback_id) ON DELETE CASCADE,
  review_attempt_id  TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  prior_attempt_id   TEXT NOT NULL REFERENCES attempts(attempt_id),
  branch             TEXT NOT NULL,
  source_head_sha    TEXT NOT NULL CHECK (length(source_head_sha) = 40),
  created_at         TEXT NOT NULL,
  CHECK (review_attempt_id <> prior_attempt_id)
);

CREATE INDEX IF NOT EXISTS idx_review_feedback_attempts_prior
  ON review_feedback_attempts(prior_attempt_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_github_review_feedbacks_immutable
BEFORE UPDATE ON github_review_feedbacks
BEGIN
  SELECT RAISE(ABORT, 'github_review_feedback_is_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_review_feedback_attempts_immutable
BEFORE UPDATE ON review_feedback_attempts
BEGIN
  SELECT RAISE(ABORT, 'review_feedback_attempt_lineage_is_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_github_review_feedback_cannot_be_deleted
BEFORE DELETE ON github_review_feedbacks
WHEN EXISTS (
  SELECT 1 FROM review_feedback_attempts
  WHERE feedback_id = OLD.feedback_id
)
BEGIN
  SELECT RAISE(ABORT, 'github_review_feedback_cannot_be_deleted');
END;
