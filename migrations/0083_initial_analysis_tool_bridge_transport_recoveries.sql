-- One bounded recovery after the Tool Bridge adapter transport switches from
-- the workerd-unsupported redirect=error mode to explicit manual redirects.

CREATE TABLE IF NOT EXISTS initial_analysis_tool_bridge_transport_recoveries (
  recovery_id             TEXT PRIMARY KEY,
  run_id                  TEXT NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE CASCADE,
  provider_recovery_id    TEXT NOT NULL UNIQUE REFERENCES initial_analysis_tool_bridge_recoveries(recovery_id) ON DELETE CASCADE,
  blocker_id              TEXT NOT NULL UNIQUE REFERENCES run_blockers(blocker_id) ON DELETE CASCADE,
  failure_id              TEXT NOT NULL UNIQUE REFERENCES attempt_failures(failure_id) ON DELETE CASCADE,
  failed_attempt_id       TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  logs_trace_id           TEXT NOT NULL UNIQUE REFERENCES tool_call_traces(trace_id) ON DELETE CASCADE,
  replacement_attempt_id  TEXT NOT NULL UNIQUE,
  transport_policy_version INTEGER NOT NULL CHECK (transport_policy_version = 2),
  created_at               TEXT NOT NULL,
  CHECK (failed_attempt_id <> replacement_attempt_id)
);

CREATE TRIGGER IF NOT EXISTS trg_initial_analysis_tool_bridge_transport_recoveries_immutable
BEFORE UPDATE ON initial_analysis_tool_bridge_transport_recoveries
BEGIN
  SELECT RAISE(ABORT, 'initial_analysis_tool_bridge_transport_recovery_is_immutable');
END;
