-- One bounded recovery for the exact 0086 replacement after proving the
-- diagnostic provider returns bounded plaintext and the source snapshot must
-- tokenize code-shaped candidates with the shared Git inventory budget.

CREATE TABLE IF NOT EXISTS initial_analysis_plaintext_source_recoveries (
  recovery_id              TEXT PRIMARY KEY,
  run_id                   TEXT NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE CASCADE,
  capacity_recovery_id     TEXT NOT NULL UNIQUE REFERENCES initial_analysis_source_snapshot_capacity_recoveries(recovery_id) ON DELETE CASCADE,
  blocker_id               TEXT NOT NULL UNIQUE REFERENCES run_blockers(blocker_id) ON DELETE CASCADE,
  failure_id               TEXT NOT NULL UNIQUE REFERENCES attempt_failures(failure_id) ON DELETE CASCADE,
  failed_attempt_id        TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  logs_trace_id            TEXT NOT NULL UNIQUE REFERENCES tool_call_traces(trace_id) ON DELETE CASCADE,
  request_trace_id         TEXT NOT NULL UNIQUE REFERENCES tool_call_traces(trace_id) ON DELETE CASCADE,
  replacement_attempt_id   TEXT NOT NULL UNIQUE,
  source_policy_version    INTEGER NOT NULL CHECK (source_policy_version = 3),
  created_at               TEXT NOT NULL,
  CHECK (failed_attempt_id <> replacement_attempt_id),
  CHECK (logs_trace_id <> request_trace_id)
);

CREATE TRIGGER IF NOT EXISTS trg_initial_analysis_plaintext_source_recoveries_immutable
BEFORE UPDATE ON initial_analysis_plaintext_source_recoveries
BEGIN
  SELECT RAISE(ABORT, 'initial_analysis_plaintext_source_recovery_is_immutable');
END;
