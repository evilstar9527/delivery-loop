-- Immutable, publication-scanned Draft PR body snapshots. External PR facts arrive later.

CREATE TABLE IF NOT EXISTS pull_request_drafts (
  draft_id          TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  run_version       INTEGER NOT NULL CHECK (run_version >= 0),
  task_id           TEXT NOT NULL REFERENCES tasks(task_id),
  task_revision     TEXT NOT NULL,
  task_digest       TEXT NOT NULL CHECK (length(task_digest) = 71),
  plan_id           TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version      INTEGER NOT NULL CHECK (plan_version > 0),
  plan_digest       TEXT NOT NULL CHECK (length(plan_digest) = 71),
  attempt_id        TEXT NOT NULL REFERENCES attempts(attempt_id),
  head_update_id    TEXT NOT NULL UNIQUE REFERENCES attempt_head_updates(update_id),
  head_sha          TEXT NOT NULL CHECK (length(head_sha) = 40),
  branch            TEXT NOT NULL,
  body              TEXT NOT NULL CHECK (length(body) > 0 AND length(body) <= 65536),
  body_digest       TEXT NOT NULL CHECK (length(body_digest) = 71),
  status            TEXT NOT NULL CHECK (status = 'prepared'),
  created_at        TEXT NOT NULL,
  UNIQUE (run_id, plan_id, plan_version, head_sha),
  UNIQUE (run_id, body_digest)
);

CREATE TABLE IF NOT EXISTS pull_request_draft_criteria (
  draft_id            TEXT NOT NULL REFERENCES pull_request_drafts(draft_id) ON DELETE CASCADE,
  criterion_index     INTEGER NOT NULL CHECK (criterion_index >= 0),
  criterion_digest    TEXT NOT NULL CHECK (length(criterion_digest) = 71),
  status              TEXT NOT NULL CHECK (status = 'passed'),
  evidence_ids_digest TEXT NOT NULL CHECK (length(evidence_ids_digest) = 71),
  PRIMARY KEY (draft_id, criterion_index)
);

CREATE TABLE IF NOT EXISTS pull_request_draft_evidence (
  draft_id    TEXT NOT NULL REFERENCES pull_request_drafts(draft_id) ON DELETE CASCADE,
  position    INTEGER NOT NULL CHECK (position >= 0 AND position < 100),
  evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
  PRIMARY KEY (draft_id, position),
  UNIQUE (draft_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS pull_request_draft_unfinished_items (
  draft_id TEXT NOT NULL REFERENCES pull_request_drafts(draft_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0 AND position < 200),
  item_id  TEXT NOT NULL,
  status   TEXT NOT NULL CHECK (
    status IN ('pending', 'ready', 'in_progress', 'failed', 'blocked', 'skipped')
  ),
  PRIMARY KEY (draft_id, position),
  UNIQUE (draft_id, item_id)
);

CREATE TRIGGER IF NOT EXISTS trg_pull_request_drafts_immutable
BEFORE UPDATE ON pull_request_drafts
BEGIN
  SELECT RAISE(ABORT, 'pull_request_draft_is_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_pull_request_draft_criteria_immutable
BEFORE UPDATE ON pull_request_draft_criteria
BEGIN
  SELECT RAISE(ABORT, 'pull_request_draft_criterion_is_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_pull_request_draft_evidence_immutable
BEFORE UPDATE ON pull_request_draft_evidence
BEGIN
  SELECT RAISE(ABORT, 'pull_request_draft_evidence_is_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_pull_request_draft_unfinished_immutable
BEFORE UPDATE ON pull_request_draft_unfinished_items
BEGIN
  SELECT RAISE(ABORT, 'pull_request_draft_unfinished_item_is_immutable');
END;
