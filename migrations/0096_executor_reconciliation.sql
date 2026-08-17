CREATE TABLE executor_reconciliation_failures (
  execution_id TEXT NOT NULL REFERENCES attempt_execution_instances(execution_id),
  operation TEXT NOT NULL CHECK (operation IN ('observe', 'cancel')),
  consecutive_failures INTEGER NOT NULL CHECK (consecutive_failures > 0),
  first_failed_at TEXT NOT NULL,
  last_failed_at TEXT NOT NULL,
  next_retry_at TEXT NOT NULL,
  last_error_code TEXT NOT NULL CHECK (
    last_error_code IN ('provider_unavailable', 'projection_conflict')
  ),
  PRIMARY KEY(execution_id, operation)
);

CREATE TABLE executor_cancellations (
  cancellation_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE REFERENCES attempt_execution_instances(execution_id),
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
  lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
  reason TEXT NOT NULL CHECK (
    reason IN ('lease_expired', 'run_cancelled', 'superseded', 'policy_revoked')
  ),
  delivery_state TEXT NOT NULL CHECK (
    delivery_state IN ('pending', 'delivering', 'settled')
  ),
  outcome TEXT CHECK (outcome IN ('cancelled', 'already_terminal')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settled_at TEXT,
  CHECK ((delivery_state = 'settled') = (outcome IS NOT NULL AND settled_at IS NOT NULL))
);

CREATE TRIGGER executor_cancellations_identity_immutable
BEFORE UPDATE OF cancellation_id, execution_id, attempt_id, lease_generation, reason, created_at
ON executor_cancellations
BEGIN
  SELECT RAISE(ABORT, 'executor cancellation identity is immutable');
END;

CREATE TRIGGER executor_reconciliation_failures_no_raw_error
BEFORE INSERT ON executor_reconciliation_failures
WHEN NEW.last_error_code NOT IN ('provider_unavailable', 'projection_conflict')
BEGIN
  SELECT RAISE(ABORT, 'executor reconciliation error is unsafe');
END;
