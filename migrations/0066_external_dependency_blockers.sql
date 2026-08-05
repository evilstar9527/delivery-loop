-- A credential or other trusted external reconciliation dependency is not a
-- useful model retry. Preserve the first bounded failure and block immediately.
CREATE TABLE run_blockers_next (
  blocker_id                    TEXT PRIMARY KEY,
  run_id                        TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  reason                        TEXT NOT NULL CHECK (
    reason IN ('repeated_fingerprint', 'attempt_limit', 'external_dependency')
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

INSERT INTO run_blockers_next (
  blocker_id, run_id, reason, retry_scope_digest, fingerprint_digest,
  attempt_count, consecutive_fingerprint_count, needed_human_input,
  created_at, resolved_at, resolution_code
)
SELECT blocker_id, run_id, reason, retry_scope_digest, fingerprint_digest,
       attempt_count, consecutive_fingerprint_count, needed_human_input,
       created_at, resolved_at, resolution_code
FROM run_blockers;

DROP INDEX idx_run_blockers_one_active;
DROP TABLE run_blockers;
ALTER TABLE run_blockers_next RENAME TO run_blockers;

CREATE UNIQUE INDEX idx_run_blockers_one_active
  ON run_blockers(run_id) WHERE resolved_at IS NULL;
