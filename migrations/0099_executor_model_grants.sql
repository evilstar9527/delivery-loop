CREATE TABLE executor_model_grants (
  grant_id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL UNIQUE REFERENCES quota_model_reservations(reservation_id),
  execution_id TEXT NOT NULL REFERENCES attempt_execution_instances(execution_id),
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
  lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
  token_digest TEXT NOT NULL CHECK (length(token_digest) = 71),
  token_ciphertext TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (execution_id, reservation_id)
);

CREATE TRIGGER executor_model_grants_immutable
BEFORE UPDATE ON executor_model_grants
BEGIN SELECT RAISE(ABORT, 'executor model grant is immutable'); END;
