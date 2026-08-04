-- A commit Evidence row is immutable once linked to an attempt head, except for
-- the one control-plane-owned unverified -> verified promotion performed by the
-- Plan Item Evidence verifier. The generic verified-Evidence trigger freezes it
-- completely after that promotion.

DROP TRIGGER IF EXISTS trg_attempt_head_evidence_immutable;

CREATE TRIGGER trg_attempt_head_evidence_immutable
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
  OR (
    NEW.verification_status IS NOT OLD.verification_status
    AND NOT (
      OLD.verification_status = 'unverified'
      AND NEW.verification_status = 'verified'
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'attempt_head_evidence_is_immutable');
END;
