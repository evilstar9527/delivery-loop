-- Immutable bot-commit head transition used by the execution Runner before verification.

CREATE TABLE IF NOT EXISTS attempt_head_updates (
  update_id         TEXT PRIMARY KEY,
  evidence_id       TEXT NOT NULL UNIQUE REFERENCES evidence(evidence_id),
  run_id            TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  attempt_id        TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  plan_id           TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version      INTEGER NOT NULL CHECK (plan_version > 0),
  plan_item_id      TEXT NOT NULL,
  lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
  parent_sha        TEXT NOT NULL CHECK (length(parent_sha) = 40),
  head_sha          TEXT NOT NULL CHECK (length(head_sha) = 40),
  branch            TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  UNIQUE (attempt_id, lease_generation),
  CHECK (parent_sha <> head_sha),
  FOREIGN KEY (plan_id, plan_item_id) REFERENCES plan_items(plan_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_attempt_head_updates_run_item
  ON attempt_head_updates(run_id, plan_id, plan_item_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_attempt_head_updates_immutable
BEFORE UPDATE ON attempt_head_updates
BEGIN
  SELECT RAISE(ABORT, 'attempt_head_update_is_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_attempt_head_evidence_immutable
BEFORE UPDATE ON evidence
WHEN EXISTS (
  SELECT 1 FROM attempt_head_updates
  WHERE evidence_id = OLD.evidence_id
)
AND (
  NEW.run_id IS NOT OLD.run_id
  OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.plan_id IS NOT OLD.plan_id
  OR NEW.plan_version IS NOT OLD.plan_version
  OR NEW.plan_item_id IS NOT OLD.plan_item_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.status IS NOT OLD.status
  OR NEW.sha IS NOT OLD.sha
  OR NEW.verification_status IS NOT OLD.verification_status
)
BEGIN
  SELECT RAISE(ABORT, 'attempt_head_evidence_is_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_attempt_head_evidence_cannot_be_deleted
BEFORE DELETE ON evidence
WHEN EXISTS (
  SELECT 1 FROM attempt_head_updates
  WHERE evidence_id = OLD.evidence_id
)
BEGIN
  SELECT RAISE(ABORT, 'attempt_head_evidence_cannot_be_deleted');
END;
