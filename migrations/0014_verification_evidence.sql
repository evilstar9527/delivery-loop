-- Ordered targeted/required verification ledger and duration-bearing Evidence.

ALTER TABLE evidence ADD COLUMN duration_ms INTEGER CHECK (
  duration_ms IS NULL OR (duration_ms >= 0 AND duration_ms <= 3600000)
);

CREATE TABLE IF NOT EXISTS verification_suites (
  suite_id                 TEXT PRIMARY KEY,
  run_id                   TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  attempt_id               TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  plan_id                  TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version             INTEGER NOT NULL CHECK (plan_version > 0),
  plan_item_id             TEXT NOT NULL,
  lease_generation         INTEGER NOT NULL CHECK (lease_generation > 0),
  head_sha                 TEXT NOT NULL CHECK (length(head_sha) = 40),
  delivery_policy_digest   TEXT NOT NULL CHECK (length(delivery_policy_digest) = 71),
  targeted_command_count   INTEGER NOT NULL CHECK (targeted_command_count > 0),
  required_command_count   INTEGER NOT NULL CHECK (required_command_count > 0),
  status                   TEXT NOT NULL CHECK (status IN ('running', 'failed', 'completed')),
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  UNIQUE (attempt_id, lease_generation, head_sha, delivery_policy_digest),
  FOREIGN KEY (plan_id, plan_item_id) REFERENCES plan_items(plan_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_verification_suites_run_item
  ON verification_suites(run_id, plan_id, plan_item_id, created_at);

CREATE TABLE IF NOT EXISTS verification_suite_commands (
  suite_id       TEXT NOT NULL REFERENCES verification_suites(suite_id) ON DELETE CASCADE,
  position       INTEGER NOT NULL CHECK (position >= 0 AND position < 100),
  phase          TEXT NOT NULL CHECK (phase IN ('targeted', 'required_verify')),
  command_ref    TEXT NOT NULL,
  result_status  TEXT NOT NULL CHECK (result_status IN ('pending', 'passed', 'failed')),
  evidence_id    TEXT REFERENCES evidence(evidence_id),
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (suite_id, position),
  UNIQUE (suite_id, command_ref)
);
