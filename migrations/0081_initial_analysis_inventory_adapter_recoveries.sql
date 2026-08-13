-- One bounded compatibility recovery after the Agent adapter adopts inventory policy v2.

CREATE TABLE IF NOT EXISTS initial_analysis_inventory_adapter_recoveries (
  recovery_id            TEXT PRIMARY KEY,
  run_id                 TEXT NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE CASCADE,
  capacity_recovery_id   TEXT NOT NULL UNIQUE REFERENCES initial_analysis_capacity_recoveries(recovery_id) ON DELETE CASCADE,
  blocker_id             TEXT NOT NULL UNIQUE REFERENCES run_blockers(blocker_id) ON DELETE CASCADE,
  failure_id             TEXT NOT NULL UNIQUE REFERENCES attempt_failures(failure_id) ON DELETE CASCADE,
  failed_attempt_id      TEXT NOT NULL UNIQUE REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  replacement_attempt_id TEXT NOT NULL UNIQUE,
  inventory_policy_version INTEGER NOT NULL CHECK (inventory_policy_version = 2),
  max_prompt_path_bytes  INTEGER NOT NULL CHECK (max_prompt_path_bytes = 524288),
  created_at             TEXT NOT NULL,
  CHECK (failed_attempt_id <> replacement_attempt_id)
);

CREATE TRIGGER IF NOT EXISTS trg_initial_analysis_inventory_adapter_recoveries_immutable
BEFORE UPDATE ON initial_analysis_inventory_adapter_recoveries
BEGIN
  SELECT RAISE(ABORT, 'initial_analysis_inventory_adapter_recovery_is_immutable');
END;
