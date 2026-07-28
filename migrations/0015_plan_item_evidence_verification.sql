-- A required Plan Item can pass only through an exact doneWhen/Evidence verification decision.

CREATE TABLE IF NOT EXISTS plan_item_verifications (
  verification_id       TEXT PRIMARY KEY,
  run_id                 TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  plan_id                TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version           INTEGER NOT NULL CHECK (plan_version > 0),
  plan_item_id           TEXT NOT NULL,
  attempt_id             TEXT NOT NULL REFERENCES attempts(attempt_id),
  head_sha               TEXT NOT NULL CHECK (length(head_sha) = 40),
  progress_version       INTEGER NOT NULL CHECK (progress_version >= 0),
  evidence_set_digest    TEXT NOT NULL CHECK (length(evidence_set_digest) = 71),
  status                 TEXT NOT NULL CHECK (status = 'passed'),
  created_at             TEXT NOT NULL,
  UNIQUE (plan_id, plan_item_id, head_sha, progress_version),
  FOREIGN KEY (plan_id, plan_item_id) REFERENCES plan_items(plan_id, item_id)
);

CREATE TABLE IF NOT EXISTS plan_item_done_when_evidence (
  verification_id    TEXT NOT NULL REFERENCES plan_item_verifications(verification_id) ON DELETE CASCADE,
  plan_id             TEXT NOT NULL,
  item_id             TEXT NOT NULL,
  done_when_position  INTEGER NOT NULL CHECK (done_when_position >= 0),
  evidence_position   INTEGER NOT NULL CHECK (evidence_position >= 0),
  evidence_id         TEXT NOT NULL REFERENCES evidence(evidence_id),
  PRIMARY KEY (verification_id, done_when_position, evidence_position),
  UNIQUE (verification_id, done_when_position, evidence_id),
  FOREIGN KEY (plan_id, item_id, done_when_position)
    REFERENCES plan_item_done_when(plan_id, item_id, position)
);

CREATE INDEX IF NOT EXISTS idx_done_when_evidence_lookup
  ON plan_item_done_when_evidence(plan_id, item_id, done_when_position);

CREATE TRIGGER IF NOT EXISTS trg_required_plan_item_pass_requires_evidence
BEFORE UPDATE OF status ON plan_item_progress
WHEN NEW.status = 'passed'
 AND OLD.status <> 'passed'
 AND EXISTS (
   SELECT 1 FROM plan_items
   WHERE plan_items.plan_id = NEW.plan_id
     AND plan_items.item_id = NEW.item_id
     AND plan_items.required = 1
 )
 AND (
   OLD.status <> 'in_progress'
   OR OLD.active_attempt_id IS NULL
   OR NOT EXISTS (
     SELECT 1
     FROM plan_item_verifications
     JOIN attempts ON attempts.attempt_id = plan_item_verifications.attempt_id
     WHERE plan_item_verifications.plan_id = NEW.plan_id
       AND plan_item_verifications.plan_item_id = NEW.item_id
       AND plan_item_verifications.attempt_id = OLD.active_attempt_id
       AND plan_item_verifications.progress_version = OLD.version
       AND plan_item_verifications.status = 'passed'
       AND attempts.head_sha = plan_item_verifications.head_sha
   )
   OR EXISTS (
     SELECT 1
     FROM plan_item_done_when
     WHERE plan_item_done_when.plan_id = NEW.plan_id
       AND plan_item_done_when.item_id = NEW.item_id
       AND NOT EXISTS (
         SELECT 1
         FROM plan_item_done_when_evidence
         JOIN evidence
           ON evidence.evidence_id = plan_item_done_when_evidence.evidence_id
         JOIN plan_item_verifications
           ON plan_item_verifications.verification_id = plan_item_done_when_evidence.verification_id
         WHERE plan_item_done_when_evidence.plan_id = NEW.plan_id
           AND plan_item_done_when_evidence.item_id = NEW.item_id
           AND plan_item_done_when_evidence.done_when_position = plan_item_done_when.position
           AND plan_item_verifications.attempt_id = OLD.active_attempt_id
           AND plan_item_verifications.progress_version = OLD.version
           AND evidence.run_id = plan_item_verifications.run_id
           AND evidence.plan_id = plan_item_verifications.plan_id
           AND evidence.plan_version = plan_item_verifications.plan_version
           AND evidence.plan_item_id = plan_item_verifications.plan_item_id
           AND evidence.sha = plan_item_verifications.head_sha
           AND evidence.status = 'passed'
           AND evidence.verification_status = 'verified'
       )
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'required_plan_item_requires_verified_evidence');
END;

CREATE TRIGGER IF NOT EXISTS trg_verified_evidence_immutable
BEFORE UPDATE ON evidence
WHEN OLD.verification_status = 'verified'
 AND (
   NEW.run_id IS NOT OLD.run_id
   OR NEW.attempt_id IS NOT OLD.attempt_id
   OR NEW.plan_id IS NOT OLD.plan_id
   OR NEW.plan_version IS NOT OLD.plan_version
   OR NEW.plan_item_id IS NOT OLD.plan_item_id
   OR NEW.kind IS NOT OLD.kind
   OR NEW.status IS NOT OLD.status
   OR NEW.command_ref IS NOT OLD.command_ref
   OR NEW.exit_code IS NOT OLD.exit_code
   OR NEW.duration_ms IS NOT OLD.duration_ms
   OR NEW.sha IS NOT OLD.sha
   OR NEW.external_url IS NOT OLD.external_url
   OR NEW.artifact_ref IS NOT OLD.artifact_ref
   OR NEW.artifact_digest IS NOT OLD.artifact_digest
   OR NEW.summary IS NOT OLD.summary
   OR NEW.verification_status IS NOT OLD.verification_status
 )
BEGIN
  SELECT RAISE(ABORT, 'verified_evidence_is_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_mapped_verified_evidence_cannot_be_deleted
BEFORE DELETE ON evidence
WHEN OLD.verification_status = 'verified'
 AND EXISTS (
   SELECT 1 FROM plan_item_done_when_evidence
   WHERE plan_item_done_when_evidence.evidence_id = OLD.evidence_id
 )
BEGIN
  SELECT RAISE(ABORT, 'mapped_verified_evidence_cannot_be_deleted');
END;
