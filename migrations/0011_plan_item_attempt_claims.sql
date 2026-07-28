-- Binds every initial Plan Item claim to the exact progress version it consumed.
-- Retries use a later progress version; concurrent replays of one claim converge.

ALTER TABLE attempts ADD COLUMN claimed_progress_version INTEGER CHECK (
  claimed_progress_version IS NULL OR claimed_progress_version > 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_one_plan_item_claim
  ON attempts(run_id, plan_id, plan_version, plan_item_id, claimed_progress_version)
  WHERE plan_id IS NOT NULL
    AND plan_version IS NOT NULL
    AND plan_item_id IS NOT NULL
    AND claimed_progress_version IS NOT NULL;

-- Investigation and verification are control-flow gates, not optional Agent advice.
-- Required items of every kind are also never skippable.
CREATE TRIGGER IF NOT EXISTS trg_plan_item_protected_skip_update
BEFORE UPDATE OF status ON plan_item_progress
WHEN NEW.status = 'skipped'
 AND EXISTS (
   SELECT 1 FROM plan_items
   WHERE plan_items.plan_id = NEW.plan_id
     AND plan_items.item_id = NEW.item_id
     AND (
       plan_items.required = 1
       OR plan_items.kind IN ('investigation', 'verification')
     )
 )
BEGIN
  SELECT RAISE(ABORT, 'protected_plan_item_cannot_be_skipped');
END;

CREATE TRIGGER IF NOT EXISTS trg_plan_item_protected_skip_insert
BEFORE INSERT ON plan_item_progress
WHEN NEW.status = 'skipped'
 AND EXISTS (
   SELECT 1 FROM plan_items
   WHERE plan_items.plan_id = NEW.plan_id
     AND plan_items.item_id = NEW.item_id
     AND (
       plan_items.required = 1
       OR plan_items.kind IN ('investigation', 'verification')
     )
 )
BEGIN
  SELECT RAISE(ABORT, 'protected_plan_item_cannot_be_skipped');
END;
