-- One bounded recovery for the verified Tool Bridge lineage that completed
-- logs + trace reads but was rejected by the stale 2,000-file source snapshot
-- ceiling. The replacement uses the existing 5,000-path inventory policy.

CREATE TABLE IF NOT EXISTS initial_analysis_source_snapshot_capacity_recoveries (
  recovery_id                   TEXT PRIMARY KEY,
  run_id                        TEXT NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE CASCADE,
  secret_value_recovery_id      TEXT NOT NULL UNIQUE REFERENCES initial_analysis_tool_bridge_secret_value_recoveries(recovery_id) ON DELETE CASCADE,
  blocker_id                    TEXT NOT NULL UNIQUE REFERENCES run_blockers(blocker_id) ON DELETE CASCADE,
  failure_id                    TEXT NOT NULL UNIQUE REFERENCES attempt_failures(failure_id) ON DELETE CASCADE,
  failed_attempt_id             TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  logs_trace_id                 TEXT NOT NULL UNIQUE REFERENCES tool_call_traces(trace_id) ON DELETE CASCADE,
  request_trace_id              TEXT NOT NULL UNIQUE REFERENCES tool_call_traces(trace_id) ON DELETE CASCADE,
  replacement_attempt_id        TEXT NOT NULL UNIQUE,
  inventory_policy_version      INTEGER NOT NULL CHECK (inventory_policy_version = 2),
  max_tracked_paths             INTEGER NOT NULL CHECK (max_tracked_paths = 5000),
  created_at                    TEXT NOT NULL,
  CHECK (failed_attempt_id <> replacement_attempt_id),
  CHECK (logs_trace_id <> request_trace_id)
);

CREATE TRIGGER IF NOT EXISTS trg_initial_analysis_source_snapshot_capacity_recoveries_immutable
BEFORE UPDATE ON initial_analysis_source_snapshot_capacity_recoveries
BEGIN
  SELECT RAISE(ABORT, 'initial_analysis_source_snapshot_capacity_recovery_is_immutable');
END;
