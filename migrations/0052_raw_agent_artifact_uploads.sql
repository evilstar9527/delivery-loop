-- Recoverable producer intent for encrypted raw execution artifacts. Plaintext,
-- content digest, token, exception, R2 key and encryption key are not stored.

CREATE TABLE IF NOT EXISTS raw_agent_artifact_uploads (
  upload_id              TEXT PRIMARY KEY CHECK (length(upload_id) = 36),
  object_identity_digest TEXT NOT NULL UNIQUE CHECK (length(object_identity_digest) = 71),
  attempt_id             TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  category               TEXT NOT NULL CHECK (category IN ('raw_session', 'raw_transcript')),
  lease_generation       INTEGER NOT NULL CHECK (lease_generation > 0),
  upload_state           TEXT NOT NULL CHECK (upload_state IN ('pending', 'delivering', 'complete')),
  delivery_lease_token   TEXT,
  delivery_lease_expires_at TEXT,
  last_error_code        TEXT CHECK (
    last_error_code IS NULL OR last_error_code = 'storage_unavailable'
  ),
  created_at             TEXT NOT NULL,
  completed_at           TEXT,
  updated_at             TEXT NOT NULL,
  CHECK (
    (upload_state = 'pending' AND delivery_lease_token IS NULL AND
     delivery_lease_expires_at IS NULL AND completed_at IS NULL) OR
    (upload_state = 'delivering' AND delivery_lease_token IS NOT NULL AND
     delivery_lease_expires_at IS NOT NULL AND completed_at IS NULL) OR
    (upload_state = 'complete' AND delivery_lease_token IS NULL AND
     delivery_lease_expires_at IS NULL AND completed_at IS NOT NULL AND
     last_error_code IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_raw_agent_artifact_upload_pending
  ON raw_agent_artifact_uploads(upload_state, delivery_lease_expires_at, upload_id);

CREATE TRIGGER IF NOT EXISTS trg_raw_agent_artifact_upload_identity_immutable
BEFORE UPDATE OF upload_id, object_identity_digest, attempt_id, category,
  lease_generation, created_at
ON raw_agent_artifact_uploads
BEGIN SELECT RAISE(ABORT, 'raw_agent_artifact_upload_identity_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_raw_agent_artifact_upload_complete_bound
BEFORE UPDATE OF upload_state ON raw_agent_artifact_uploads
WHEN NEW.upload_state = 'complete' AND NOT EXISTS (
  SELECT 1 FROM raw_agent_artifacts
  WHERE raw_agent_artifacts.object_id = NEW.upload_id
    AND raw_agent_artifacts.object_identity_digest = NEW.object_identity_digest
    AND raw_agent_artifacts.category = NEW.category
    AND raw_agent_artifacts.deletion_state = 'active'
)
BEGIN SELECT RAISE(ABORT, 'raw_agent_artifact_upload_completion_is_invalid'); END;

CREATE TRIGGER IF NOT EXISTS trg_raw_agent_artifact_upload_completed_immutable
BEFORE UPDATE ON raw_agent_artifact_uploads
WHEN OLD.upload_state = 'complete'
BEGIN SELECT RAISE(ABORT, 'completed_raw_agent_artifact_upload_is_immutable'); END;
