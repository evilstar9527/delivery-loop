-- Durable operational incidents for state-specific stuck detection. The rows
-- contain only fixed identifiers/enums/timestamps; task bodies and raw errors
-- are deliberately absent.

CREATE TABLE IF NOT EXISTS run_stuck_incidents (
  incident_id          TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  state_kind           TEXT NOT NULL CHECK (
    state_kind IN ('queued', 'running', 'awaiting_review', 'deploying')
  ),
  observed_run_state   TEXT NOT NULL CHECK (
    observed_run_state IN (
      'received', 'triaging', 'awaiting_approval', 'queued', 'planning',
      'executing', 'verifying', 'pull_request_open', 'awaiting_review',
      'ready_to_merge', 'merging', 'deploying', 'succeeded', 'blocked',
      'failed', 'cancelled'
    )
  ),
  run_version          INTEGER NOT NULL CHECK (run_version >= 0),
  attempt_id           TEXT REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  threshold_seconds    INTEGER NOT NULL CHECK (
    threshold_seconds BETWEEN 60 AND 604800
  ),
  action               TEXT NOT NULL CHECK (
    action IN (
      'requeue_workflow_create', 'fence_lost_attempt',
      'escalate_human_review', 'reconcile_external_deployment'
    )
  ),
  status               TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  detected_at          TEXT NOT NULL,
  recovery_requested_at TEXT NOT NULL,
  resolved_at          TEXT,
  resolution_code      TEXT CHECK (
    resolution_code IS NULL OR resolution_code IN ('attempt_fenced', 'run_progressed')
  ),
  CHECK (
    (state_kind = 'running' AND attempt_id IS NOT NULL) OR
    (state_kind <> 'running' AND attempt_id IS NULL)
  ),
  CHECK (
    (status = 'open' AND resolved_at IS NULL AND resolution_code IS NULL) OR
    (status = 'resolved' AND resolved_at IS NOT NULL AND resolution_code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_run_stuck_incidents_open
  ON run_stuck_incidents(status, detected_at, incident_id);

CREATE INDEX IF NOT EXISTS idx_run_stuck_incidents_run
  ON run_stuck_incidents(run_id, detected_at, incident_id);

CREATE INDEX IF NOT EXISTS idx_runs_stuck_scan
  ON runs(state, updated_at, run_id);

CREATE INDEX IF NOT EXISTS idx_attempts_stuck_scan
  ON attempts(status, heartbeat_at, updated_at, attempt_id)
  WHERE status IN ('starting', 'running') AND result_event_id IS NULL;

CREATE TRIGGER IF NOT EXISTS trg_run_stuck_incident_identity_immutable
BEFORE UPDATE ON run_stuck_incidents
FOR EACH ROW
WHEN NEW.incident_id <> OLD.incident_id
  OR NEW.run_id <> OLD.run_id
  OR NEW.state_kind <> OLD.state_kind
  OR NEW.observed_run_state <> OLD.observed_run_state
  OR NEW.run_version <> OLD.run_version
  OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.threshold_seconds <> OLD.threshold_seconds
  OR NEW.action <> OLD.action
  OR NEW.detected_at <> OLD.detected_at
  OR NEW.recovery_requested_at <> OLD.recovery_requested_at
BEGIN
  SELECT RAISE(ABORT, 'run stuck incident identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_run_stuck_incident_terminal_immutable
BEFORE UPDATE ON run_stuck_incidents
FOR EACH ROW
WHEN OLD.status = 'resolved' AND (
  NEW.status <> OLD.status
  OR NEW.resolved_at IS NOT OLD.resolved_at
  OR NEW.resolution_code IS NOT OLD.resolution_code
)
BEGIN
  SELECT RAISE(ABORT, 'resolved run stuck incident is immutable');
END;
