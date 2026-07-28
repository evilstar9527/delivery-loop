-- Durable failed-verification facts and Evidence-bound repair decisions.

CREATE TABLE IF NOT EXISTS attempt_failure_verification_facts (
  failure_id          TEXT PRIMARY KEY
    REFERENCES attempt_failures(failure_id) ON DELETE CASCADE,
  source_suite_id     TEXT NOT NULL REFERENCES verification_suites(suite_id),
  source_evidence_id  TEXT NOT NULL UNIQUE REFERENCES evidence(evidence_id),
  source_head_sha     TEXT NOT NULL CHECK (length(source_head_sha) = 40),
  failure_fact_digest TEXT NOT NULL CHECK (length(failure_fact_digest) = 71),
  created_at          TEXT NOT NULL,
  UNIQUE (failure_id, source_suite_id, source_evidence_id)
);

CREATE TABLE IF NOT EXISTS attempt_repairs (
  repair_id             TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  plan_id               TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version          INTEGER NOT NULL CHECK (plan_version > 0),
  plan_item_id          TEXT NOT NULL,
  failure_id            TEXT NOT NULL UNIQUE
    REFERENCES attempt_failures(failure_id) ON DELETE CASCADE,
  failed_attempt_id     TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  repair_attempt_id     TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  source_suite_id       TEXT NOT NULL REFERENCES verification_suites(suite_id),
  source_evidence_id    TEXT NOT NULL REFERENCES evidence(evidence_id),
  source_head_sha       TEXT NOT NULL CHECK (length(source_head_sha) = 40),
  failure_fact_digest   TEXT NOT NULL CHECK (length(failure_fact_digest) = 71),
  retry_scope_digest    TEXT NOT NULL CHECK (length(retry_scope_digest) = 71),
  fingerprint_digest    TEXT NOT NULL CHECK (length(fingerprint_digest) = 71),
  created_at            TEXT NOT NULL,
  CHECK (failed_attempt_id <> repair_attempt_id),
  FOREIGN KEY (plan_id, plan_item_id) REFERENCES plan_items(plan_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_attempt_repairs_run_item
  ON attempt_repairs(run_id, plan_id, plan_version, plan_item_id, created_at);

CREATE INDEX IF NOT EXISTS idx_attempt_repairs_failed_attempt
  ON attempt_repairs(failed_attempt_id);

CREATE TRIGGER IF NOT EXISTS trg_repair_failure_evidence_immutable
BEFORE UPDATE ON evidence
WHEN EXISTS (
  SELECT 1 FROM attempt_failure_verification_facts
  WHERE source_evidence_id = OLD.evidence_id
)
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
  OR NEW.artifact_digest IS NOT OLD.artifact_digest
  OR NEW.verification_status IS NOT OLD.verification_status
)
BEGIN
  SELECT RAISE(ABORT, 'repair_failure_evidence_is_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_repair_failure_command_immutable
BEFORE UPDATE ON verification_suite_commands
WHEN OLD.evidence_id IS NOT NULL
 AND EXISTS (
   SELECT 1 FROM attempt_failure_verification_facts
   WHERE source_evidence_id = OLD.evidence_id
 )
 AND (
   NEW.suite_id IS NOT OLD.suite_id
   OR NEW.position IS NOT OLD.position
   OR NEW.phase IS NOT OLD.phase
   OR NEW.command_ref IS NOT OLD.command_ref
   OR NEW.result_status IS NOT OLD.result_status
   OR NEW.evidence_id IS NOT OLD.evidence_id
 )
BEGIN
  SELECT RAISE(ABORT, 'repair_failure_command_is_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_repair_failure_suite_immutable
BEFORE UPDATE ON verification_suites
WHEN EXISTS (
  SELECT 1 FROM attempt_failure_verification_facts
  WHERE source_suite_id = OLD.suite_id
)
AND (
  NEW.run_id IS NOT OLD.run_id
  OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.plan_id IS NOT OLD.plan_id
  OR NEW.plan_version IS NOT OLD.plan_version
  OR NEW.plan_item_id IS NOT OLD.plan_item_id
  OR NEW.lease_generation IS NOT OLD.lease_generation
  OR NEW.head_sha IS NOT OLD.head_sha
  OR NEW.delivery_policy_digest IS NOT OLD.delivery_policy_digest
  OR NEW.targeted_command_count IS NOT OLD.targeted_command_count
  OR NEW.required_command_count IS NOT OLD.required_command_count
  OR NEW.status IS NOT OLD.status
)
BEGIN
  SELECT RAISE(ABORT, 'repair_failure_suite_is_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_repair_failure_command_cannot_be_deleted
BEFORE DELETE ON verification_suite_commands
WHEN OLD.evidence_id IS NOT NULL
 AND EXISTS (
   SELECT 1 FROM attempt_failure_verification_facts
   WHERE source_evidence_id = OLD.evidence_id
 )
BEGIN
  SELECT RAISE(ABORT, 'repair_failure_command_cannot_be_deleted');
END;
