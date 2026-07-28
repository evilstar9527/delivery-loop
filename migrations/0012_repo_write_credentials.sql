-- Durable, encrypted projection for short-lived GitHub repo_write credentials.
-- Plaintext installation tokens never enter D1; ciphertext is retained only while revocation is possible.

CREATE TABLE IF NOT EXISTS github_write_credentials (
  credential_id             TEXT PRIMARY KEY,
  run_id                    TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  attempt_id                TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  plan_id                   TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version              INTEGER NOT NULL CHECK (plan_version > 0),
  plan_item_id              TEXT NOT NULL,
  approval_id               TEXT NOT NULL REFERENCES approvals(approval_id),
  repository                TEXT NOT NULL,
  lease_generation          INTEGER NOT NULL CHECK (lease_generation > 0),
  status                    TEXT NOT NULL CHECK (
    status IN (
      'issuing', 'active', 'issuance_failed', 'revocation_pending',
      'revoking', 'revoked', 'expired'
    )
  ),
  issue_lease_token         TEXT,
  issue_lease_expires_at    TEXT,
  token_digest              TEXT CHECK (token_digest IS NULL OR length(token_digest) = 71),
  token_ciphertext          TEXT,
  token_iv                  TEXT,
  github_expires_at         TEXT,
  authorization_expires_at  TEXT,
  revocation_lease_token    TEXT,
  revocation_lease_expires_at TEXT,
  revoked_at                TEXT,
  last_error_code           TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  UNIQUE (attempt_id, lease_generation),
  FOREIGN KEY (plan_id, plan_item_id) REFERENCES plan_items(plan_id, item_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_github_write_credentials_token_digest
  ON github_write_credentials(token_digest) WHERE token_digest IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_github_write_credentials_revocation
  ON github_write_credentials(status, authorization_expires_at, updated_at);
