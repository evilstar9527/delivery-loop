-- Raw Agent session/transcript retention. Raw ciphertext has a dedicated R2
-- bucket and an explicit D1 registry; cleanup never enumerates or accepts keys
-- from the Task, checkpoint, Evidence, or backup stores.

CREATE TABLE IF NOT EXISTS raw_agent_artifacts (
  object_id               TEXT PRIMARY KEY CHECK (length(object_id) = 36),
  object_identity_digest  TEXT NOT NULL UNIQUE CHECK (length(object_identity_digest) = 71),
  category                TEXT NOT NULL CHECK (category IN ('raw_session', 'raw_transcript')),
  ciphertext_digest       TEXT NOT NULL CHECK (length(ciphertext_digest) = 71),
  size_bytes              INTEGER NOT NULL CHECK (size_bytes >= 0),
  r2_etag                 TEXT NOT NULL CHECK (length(r2_etag) > 0),
  policy_version          TEXT NOT NULL DEFAULT 'security-v1-raw-30d'
    CHECK (policy_version = 'security-v1-raw-30d'),
  created_at              TEXT NOT NULL,
  expires_at              TEXT NOT NULL,
  deletion_state          TEXT NOT NULL CHECK (
    deletion_state IN ('active', 'deleting', 'retry', 'deleted')
  ),
  delete_claim_id         TEXT,
  delete_claim_expires_at TEXT,
  deleted_at              TEXT,
  retry_count             INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  last_failure_code       TEXT CHECK (
    last_failure_code IS NULL OR last_failure_code IN (
      'metadata_conflict', 'policy_conflict', 'storage_unavailable',
      'verification_failed'
    )
  ),
  updated_at              TEXT NOT NULL,
  CHECK (
    (deletion_state = 'deleting' AND delete_claim_id IS NOT NULL AND delete_claim_expires_at IS NOT NULL AND deleted_at IS NULL)
    OR
    (deletion_state IN ('active', 'retry') AND delete_claim_id IS NULL AND delete_claim_expires_at IS NULL AND deleted_at IS NULL)
    OR
    (deletion_state = 'deleted' AND delete_claim_id IS NULL AND delete_claim_expires_at IS NULL AND deleted_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_raw_agent_artifacts_due
  ON raw_agent_artifacts(deletion_state, expires_at, object_id);

CREATE TRIGGER IF NOT EXISTS trg_raw_agent_artifact_identity_immutable
BEFORE UPDATE OF
  object_id, object_identity_digest, category, ciphertext_digest, size_bytes,
  r2_etag, policy_version, created_at, expires_at
ON raw_agent_artifacts
BEGIN SELECT RAISE(ABORT, 'raw_agent_artifact_identity_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_raw_agent_artifact_deleted_immutable
BEFORE UPDATE ON raw_agent_artifacts
WHEN OLD.deletion_state = 'deleted'
BEGIN SELECT RAISE(ABORT, 'deleted_raw_agent_artifact_is_immutable'); END;

CREATE TABLE IF NOT EXISTS data_retention_cursor (
  cursor_name      TEXT PRIMARY KEY CHECK (cursor_name = 'raw_agent_artifacts'),
  last_expires_at  TEXT,
  last_object_id   TEXT,
  updated_at       TEXT NOT NULL,
  CHECK (
    (last_expires_at IS NULL AND last_object_id IS NULL)
    OR (last_expires_at IS NOT NULL AND last_object_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS data_retention_scans (
  scan_id             TEXT PRIMARY KEY,
  mode                TEXT NOT NULL CHECK (mode IN ('dry_run', 'execute')),
  source              TEXT NOT NULL CHECK (source IN ('scheduled', 'operations')),
  policy_version      TEXT NOT NULL CHECK (policy_version = 'security-v1-raw-30d'),
  status              TEXT NOT NULL CHECK (status IN ('running', 'completed')),
  batch_limit         INTEGER NOT NULL CHECK (batch_limit > 0 AND batch_limit <= 100),
  candidate_count     INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  claimed_count       INTEGER NOT NULL DEFAULT 0 CHECK (claimed_count >= 0),
  deleted_count       INTEGER NOT NULL DEFAULT 0 CHECK (deleted_count >= 0),
  already_absent_count INTEGER NOT NULL DEFAULT 0 CHECK (already_absent_count >= 0),
  failed_count        INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  raw_session_count   INTEGER NOT NULL DEFAULT 0 CHECK (raw_session_count >= 0),
  raw_transcript_count INTEGER NOT NULL DEFAULT 0 CHECK (raw_transcript_count >= 0),
  started_at          TEXT NOT NULL,
  completed_at        TEXT
);

CREATE TRIGGER IF NOT EXISTS trg_data_retention_scan_identity_immutable
BEFORE UPDATE OF scan_id, mode, source, policy_version, batch_limit, started_at
ON data_retention_scans
BEGIN SELECT RAISE(ABORT, 'data_retention_scan_identity_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_data_retention_scan_completed_immutable
BEFORE UPDATE ON data_retention_scans
WHEN OLD.status = 'completed'
BEGIN SELECT RAISE(ABORT, 'completed_data_retention_scan_is_immutable'); END;

CREATE TABLE IF NOT EXISTS data_retention_deletion_audit (
  audit_id               TEXT PRIMARY KEY,
  scan_id                TEXT NOT NULL REFERENCES data_retention_scans(scan_id),
  object_identity_digest TEXT NOT NULL CHECK (length(object_identity_digest) = 71),
  category               TEXT NOT NULL CHECK (category IN ('raw_session', 'raw_transcript')),
  policy_version         TEXT NOT NULL CHECK (policy_version = 'security-v1-raw-30d'),
  expires_at             TEXT NOT NULL,
  attempt_ordinal        INTEGER NOT NULL CHECK (attempt_ordinal > 0),
  result                 TEXT NOT NULL CHECK (result IN ('deleted', 'already_absent', 'failed')),
  failure_code           TEXT CHECK (
    (result IN ('deleted', 'already_absent') AND failure_code IS NULL)
    OR
    (result = 'failed' AND failure_code IN (
      'metadata_conflict', 'policy_conflict', 'storage_unavailable',
      'verification_failed'
    ))
  ),
  created_at             TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_data_retention_one_completion
  ON data_retention_deletion_audit(object_identity_digest)
  WHERE result IN ('deleted', 'already_absent');

CREATE INDEX IF NOT EXISTS idx_data_retention_audit_scan
  ON data_retention_deletion_audit(scan_id, created_at, audit_id);

CREATE TRIGGER IF NOT EXISTS trg_data_retention_deletion_audit_immutable
BEFORE UPDATE ON data_retention_deletion_audit
BEGIN SELECT RAISE(ABORT, 'data_retention_deletion_audit_is_immutable'); END;
