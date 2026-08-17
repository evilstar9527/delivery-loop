CREATE TABLE executor_publisher_write_credentials (
  credential_id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL UNIQUE REFERENCES executor_patch_publications(publication_id),
  publisher_execution_id TEXT NOT NULL UNIQUE REFERENCES attempt_execution_instances(execution_id),
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
  approval_id TEXT NOT NULL REFERENCES approvals(approval_id),
  repository TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
  status TEXT NOT NULL CHECK (status IN ('issuing', 'active', 'revoked', 'expired')),
  issue_lease_token TEXT,
  issue_lease_expires_at TEXT,
  token_digest TEXT CHECK (token_digest IS NULL OR length(token_digest) = 71),
  token_ciphertext TEXT,
  token_iv TEXT,
  github_expires_at TEXT,
  authorization_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (
    (status = 'issuing' AND issue_lease_token IS NOT NULL
      AND issue_lease_expires_at IS NOT NULL AND token_digest IS NULL
      AND token_ciphertext IS NULL AND token_iv IS NULL
      AND github_expires_at IS NULL AND authorization_expires_at IS NULL
      AND revoked_at IS NULL)
    OR
    (status = 'active' AND issue_lease_token IS NULL
      AND issue_lease_expires_at IS NULL AND token_digest IS NOT NULL
      AND token_ciphertext IS NOT NULL AND token_iv IS NOT NULL
      AND github_expires_at IS NOT NULL AND authorization_expires_at IS NOT NULL
      AND revoked_at IS NULL)
    OR
    (status IN ('revoked', 'expired') AND issue_lease_token IS NULL
      AND issue_lease_expires_at IS NULL AND token_digest IS NOT NULL
      AND token_ciphertext IS NOT NULL AND token_iv IS NOT NULL
      AND github_expires_at IS NOT NULL AND authorization_expires_at IS NOT NULL
      AND revoked_at IS NOT NULL)
  )
);

CREATE TRIGGER executor_publisher_write_credentials_identity_immutable
BEFORE UPDATE OF credential_id, publication_id, publisher_execution_id,
                 attempt_id, approval_id, repository, target_branch,
                 lease_generation, created_at
ON executor_publisher_write_credentials
BEGIN
  SELECT RAISE(ABORT, 'executor publisher credential identity is immutable');
END;
