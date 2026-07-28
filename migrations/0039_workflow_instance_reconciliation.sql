-- Cloudflare Workflow status is orchestration fact, while D1 Run is business
-- truth. Persist only allowlisted status/digest and fenced repair intent; never
-- retain Workflow output, error name/message, stack, or platform response.

CREATE TABLE IF NOT EXISTS workflow_instance_reconciliation_state (
  run_id               TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  run_version          INTEGER NOT NULL CHECK (run_version >= 0),
  d1_state             TEXT NOT NULL,
  platform_status      TEXT NOT NULL CHECK (
    platform_status IN (
      'queued', 'running', 'paused', 'errored', 'terminated', 'complete',
      'waiting', 'waitingForPause', 'unknown'
    )
  ),
  fact_digest          TEXT NOT NULL CHECK (length(fact_digest) = 71),
  checked_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_instance_reconciliation_scan
  ON workflow_instance_reconciliation_state(checked_at, run_id);

CREATE TABLE IF NOT EXISTS workflow_instance_reconciliation_observations (
  observation_id       TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  run_version          INTEGER NOT NULL CHECK (run_version >= 0),
  d1_state             TEXT NOT NULL,
  platform_status      TEXT NOT NULL CHECK (
    platform_status IN (
      'queued', 'running', 'paused', 'errored', 'terminated', 'complete',
      'waiting', 'waitingForPause', 'unknown'
    )
  ),
  fact_digest          TEXT NOT NULL CHECK (length(fact_digest) = 71),
  action               TEXT NOT NULL CHECK (
    action IN ('restart_workflow', 'recreate_workflow', 'terminate_workflow')
  ),
  status               TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  repair_outbox_id     TEXT,
  observed_at          TEXT NOT NULL,
  repair_observed_at   TEXT,
  resolved_at          TEXT,
  resolution_code      TEXT CHECK (
    resolution_code IS NULL OR resolution_code IN (
      'workflow_active', 'workflow_inactive', 'run_advanced'
    )
  ),
  UNIQUE (run_id, run_version, platform_status, action),
  CHECK (
    (status = 'open' AND resolved_at IS NULL AND resolution_code IS NULL) OR
    (status = 'resolved' AND resolved_at IS NOT NULL AND resolution_code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_workflow_instance_reconciliation_open
  ON workflow_instance_reconciliation_observations(status, observed_at, run_id);

CREATE TRIGGER IF NOT EXISTS trg_workflow_instance_reconciliation_identity_immutable
BEFORE UPDATE OF
  observation_id, run_id, run_version, d1_state, platform_status,
  fact_digest, action, observed_at
ON workflow_instance_reconciliation_observations
BEGIN SELECT RAISE(ABORT, 'workflow_instance_reconciliation_identity_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_workflow_instance_reconciliation_transition_guard
BEFORE UPDATE OF status, resolved_at, resolution_code
ON workflow_instance_reconciliation_observations
WHEN NOT (
  OLD.status = NEW.status OR
  (OLD.status = 'open' AND NEW.status = 'resolved' AND
   NEW.resolved_at IS NOT NULL AND NEW.resolution_code IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'workflow_instance_reconciliation_transition_is_invalid'); END;
