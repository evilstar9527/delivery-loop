-- Token revocation evidence is reference-only and survives short-lived Runner loss.

CREATE TABLE IF NOT EXISTS attempt_revocations (
  revocation_id             TEXT PRIMARY KEY,
  run_id                    TEXT NOT NULL REFERENCES runs(run_id),
  attempt_id                TEXT NOT NULL REFERENCES attempts(attempt_id),
  reason                    TEXT NOT NULL CHECK (
    reason IN ('completed', 'cancelled', 'heartbeat_timeout')
  ),
  revoked_lease_generation  INTEGER NOT NULL CHECK (revoked_lease_generation >= 0),
  attempt_version           INTEGER NOT NULL CHECK (attempt_version >= 0),
  occurred_at               TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  UNIQUE (attempt_id, reason, revoked_lease_generation)
);

CREATE INDEX IF NOT EXISTS idx_attempt_revocations_run_time
  ON attempt_revocations(run_id, occurred_at);
