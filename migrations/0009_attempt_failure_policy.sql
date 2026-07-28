-- Structured failure ledger and card-safe blocker projection. No raw message/stack columns.
CREATE TABLE IF NOT EXISTS attempt_failures (
  failure_id                    TEXT PRIMARY KEY,
  run_id                        TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  attempt_id                    TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  attempt_ordinal               INTEGER NOT NULL CHECK (attempt_ordinal > 0),
  event_id                      TEXT NOT NULL,
  sequence                      INTEGER NOT NULL CHECK (sequence > 0),
  retry_scope_digest            TEXT NOT NULL CHECK (length(retry_scope_digest) = 71),
  fingerprint_digest            TEXT NOT NULL CHECK (length(fingerprint_digest) = 71),
  failure_class                 TEXT NOT NULL CHECK (
    failure_class IN (
      'invalid_output', 'tool_error', 'command_error', 'verification_error',
      'policy_denied', 'external_error', 'timeout', 'unknown'
    )
  ),
  failure_code                  TEXT NOT NULL CHECK (
    failure_code IN (
      'invalid_agent_output', 'tool_unavailable', 'tool_policy_denied',
      'command_nonzero_exit', 'verification_nonzero_exit', 'workspace_changed',
      'external_fact_conflict', 'lease_timeout', 'unknown_failure'
    )
  ),
  failure_site                  TEXT NOT NULL CHECK (
    failure_site IN (
      'agent_output', 'repo_snapshot', 'tool_repo_read', 'tool_logs_search',
      'tool_trace_get', 'tool_database_diagnose', 'tool_k8s_diagnose',
      'policy_inspect', 'policy_diagnose', 'targeted_verification',
      'full_verification', 'external_reconciliation'
    )
  ),
  needed_human_input            TEXT NOT NULL CHECK (
    needed_human_input IN (
      'clarify_requirement', 'provide_reproduction', 'grant_context_access',
      'resolve_external_dependency', 'approve_policy_change', 'manual_investigation'
    )
  ),
  scope_attempt_count           INTEGER NOT NULL CHECK (scope_attempt_count > 0),
  consecutive_fingerprint_count INTEGER NOT NULL CHECK (consecutive_fingerprint_count > 0),
  revoked_lease_generation      INTEGER NOT NULL CHECK (revoked_lease_generation > 0),
  occurred_at                   TEXT NOT NULL,
  created_at                    TEXT NOT NULL,
  UNIQUE (run_id, event_id),
  UNIQUE (attempt_id),
  UNIQUE (run_id, retry_scope_digest, attempt_ordinal)
);

CREATE INDEX IF NOT EXISTS idx_attempt_failures_scope_ordinal
  ON attempt_failures(run_id, retry_scope_digest, attempt_ordinal DESC);

CREATE TABLE IF NOT EXISTS attempt_failure_paths (
  failure_id TEXT NOT NULL REFERENCES attempt_failures(failure_id) ON DELETE CASCADE,
  position   INTEGER NOT NULL CHECK (position >= 0),
  path_code  TEXT NOT NULL CHECK (
    path_code IN (
      'repository_inspection', 'log_query', 'trace_query', 'database_diagnostic',
      'k8s_diagnostic', 'plan_revision', 'code_change', 'targeted_test',
      'full_verification', 'external_reconciliation'
    )
  ),
  PRIMARY KEY (failure_id, position),
  UNIQUE (failure_id, path_code)
);

CREATE TABLE IF NOT EXISTS run_blockers (
  blocker_id                    TEXT PRIMARY KEY,
  run_id                        TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  reason                        TEXT NOT NULL CHECK (
    reason IN ('repeated_fingerprint', 'attempt_limit')
  ),
  retry_scope_digest            TEXT NOT NULL CHECK (length(retry_scope_digest) = 71),
  fingerprint_digest            TEXT NOT NULL CHECK (length(fingerprint_digest) = 71),
  attempt_count                 INTEGER NOT NULL CHECK (attempt_count > 0),
  consecutive_fingerprint_count INTEGER NOT NULL CHECK (consecutive_fingerprint_count > 0),
  needed_human_input            TEXT NOT NULL CHECK (
    needed_human_input IN (
      'clarify_requirement', 'provide_reproduction', 'grant_context_access',
      'resolve_external_dependency', 'approve_policy_change', 'manual_investigation'
    )
  ),
  created_at                    TEXT NOT NULL,
  resolved_at                   TEXT,
  resolution_code               TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_blockers_one_active
  ON run_blockers(run_id) WHERE resolved_at IS NULL;
