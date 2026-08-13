-- One bounded recovery after a newly issued Tipsy namespace credential is
-- verified against the exact SLS tool before being delivered to the adapter.

CREATE TABLE IF NOT EXISTS initial_analysis_tool_bridge_secret_value_recoveries (
  recovery_id               TEXT PRIMARY KEY,
  run_id                    TEXT NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE CASCADE,
  scope_recovery_id         TEXT NOT NULL UNIQUE REFERENCES initial_analysis_tool_bridge_scope_recoveries(recovery_id) ON DELETE CASCADE,
  blocker_id                TEXT NOT NULL UNIQUE REFERENCES run_blockers(blocker_id) ON DELETE CASCADE,
  failure_id                TEXT NOT NULL UNIQUE REFERENCES attempt_failures(failure_id) ON DELETE CASCADE,
  failed_attempt_id         TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  logs_trace_id             TEXT NOT NULL UNIQUE REFERENCES tool_call_traces(trace_id) ON DELETE CASCADE,
  replacement_attempt_id    TEXT NOT NULL UNIQUE,
  credential_policy_version INTEGER NOT NULL CHECK (credential_policy_version = 4),
  created_at                TEXT NOT NULL,
  CHECK (failed_attempt_id <> replacement_attempt_id)
);

CREATE TRIGGER IF NOT EXISTS trg_initial_analysis_tool_bridge_secret_value_recoveries_immutable
BEFORE UPDATE ON initial_analysis_tool_bridge_secret_value_recoveries
BEGIN
  SELECT RAISE(ABORT, 'initial_analysis_tool_bridge_secret_value_recovery_is_immutable');
END;
