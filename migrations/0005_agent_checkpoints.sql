-- AgentCheckpoint v1 keeps the semantic payload in R2 and a safe recovery projection in D1.

ALTER TABLE attempts ADD COLUMN head_branch TEXT;
ALTER TABLE attempts ADD COLUMN head_sha TEXT CHECK (head_sha IS NULL OR length(head_sha) = 40);

CREATE INDEX IF NOT EXISTS idx_attempts_plan_item
  ON attempts(run_id, plan_id, plan_version, plan_item_id, ordinal DESC);

CREATE INDEX IF NOT EXISTS idx_checkpoints_plan_item_recovery
  ON checkpoints(plan_id, plan_version, plan_item_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS checkpoints_require_v1_binding_insert
BEFORE INSERT ON checkpoints
WHEN NEW.plan_id IS NULL
  OR NEW.plan_version IS NULL
  OR NEW.plan_item_id IS NULL
  OR NEW.head_sha IS NULL
BEGIN
  SELECT RAISE(ABORT, 'checkpoint_v1_binding_required');
END;

CREATE TRIGGER IF NOT EXISTS checkpoints_require_v1_binding_update
BEFORE UPDATE ON checkpoints
WHEN NEW.plan_id IS NULL
  OR NEW.plan_version IS NULL
  OR NEW.plan_item_id IS NULL
  OR NEW.head_sha IS NULL
BEGIN
  SELECT RAISE(ABORT, 'checkpoint_v1_binding_required');
END;
