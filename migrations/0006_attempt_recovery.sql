-- Links a replacement Attempt to the lost Attempt and exact checkpoint it resumes.

ALTER TABLE attempts ADD COLUMN recovered_from_attempt_id TEXT REFERENCES attempts(attempt_id);
ALTER TABLE attempts ADD COLUMN recovery_checkpoint_id TEXT REFERENCES checkpoints(checkpoint_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_one_recovery_per_lost_attempt
  ON attempts(recovered_from_attempt_id, recovery_checkpoint_id)
  WHERE recovered_from_attempt_id IS NOT NULL AND recovery_checkpoint_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_attempts_recovery_item
  ON attempts(run_id, plan_id, plan_version, plan_item_id, ordinal DESC)
  WHERE recovery_checkpoint_id IS NOT NULL;
