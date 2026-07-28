-- Digest-only binding from successful read-only tool calls to a sanitized
-- root-cause Evidence record. Raw locators, logs, traces, database rows and
-- tool results intentionally have no columns in this ledger.

CREATE TABLE IF NOT EXISTS diagnostic_evidence_bindings (
  evidence_id        TEXT PRIMARY KEY REFERENCES evidence(evidence_id) ON DELETE CASCADE,
  run_id             TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  attempt_id         TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  locator_kinds_json TEXT NOT NULL,
  locator_digest     TEXT NOT NULL CHECK (length(locator_digest) = 71),
  root_cause_digest  TEXT NOT NULL CHECK (length(root_cause_digest) = 71),
  evidence_digest    TEXT NOT NULL CHECK (length(evidence_digest) = 71),
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS diagnostic_evidence_trace_sources (
  evidence_id TEXT NOT NULL
    REFERENCES diagnostic_evidence_bindings(evidence_id) ON DELETE CASCADE,
  position    INTEGER NOT NULL CHECK (position >= 0 AND position < 50),
  trace_id    TEXT NOT NULL REFERENCES tool_call_traces(trace_id) ON DELETE RESTRICT,
  PRIMARY KEY (evidence_id, position),
  UNIQUE (evidence_id, trace_id)
);

CREATE INDEX IF NOT EXISTS idx_diagnostic_evidence_run
  ON diagnostic_evidence_bindings(run_id, attempt_id, created_at, evidence_id);

CREATE TRIGGER IF NOT EXISTS trg_diagnostic_evidence_binding_valid
BEFORE INSERT ON diagnostic_evidence_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM evidence
  WHERE evidence.evidence_id = NEW.evidence_id
    AND evidence.run_id = NEW.run_id
    AND evidence.attempt_id = NEW.attempt_id
    AND evidence.plan_id IS NULL AND evidence.plan_version IS NULL
    AND evidence.plan_item_id IS NULL
    AND evidence.kind = 'diagnostic' AND evidence.status = 'passed'
    AND evidence.verification_status = 'verified'
    AND evidence.artifact_digest = NEW.evidence_digest
)
BEGIN SELECT RAISE(ABORT, 'diagnostic_evidence_binding_is_invalid'); END;

CREATE TRIGGER IF NOT EXISTS trg_diagnostic_evidence_source_valid
BEFORE INSERT ON diagnostic_evidence_trace_sources
WHEN NOT EXISTS (
  SELECT 1
  FROM diagnostic_evidence_bindings AS binding
  JOIN tool_call_traces AS trace ON trace.trace_id = NEW.trace_id
  WHERE binding.evidence_id = NEW.evidence_id
    AND trace.run_id = binding.run_id AND trace.attempt_id = binding.attempt_id
    AND trace.tool_path IN ('logs/search', 'traces/get')
    AND trace.effect = 'read' AND trace.result_category = 'success'
)
BEGIN SELECT RAISE(ABORT, 'diagnostic_evidence_source_is_invalid'); END;

CREATE TRIGGER IF NOT EXISTS trg_diagnostic_evidence_binding_immutable
BEFORE UPDATE ON diagnostic_evidence_bindings
BEGIN SELECT RAISE(ABORT, 'diagnostic_evidence_binding_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_diagnostic_evidence_source_immutable
BEFORE UPDATE ON diagnostic_evidence_trace_sources
BEGIN SELECT RAISE(ABORT, 'diagnostic_evidence_source_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_tool_call_trace_immutable
BEFORE UPDATE ON tool_call_traces
BEGIN SELECT RAISE(ABORT, 'tool_call_trace_is_immutable'); END;
