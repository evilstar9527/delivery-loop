-- Distinguish legacy GitHub OIDC exchanges from provider-neutral executor
-- identity exchanges while retaining the historical digest column.
ALTER TABLE attempt_tokens ADD COLUMN identity_kind TEXT NOT NULL DEFAULT 'github_oidc'
  CHECK (identity_kind IN ('github_oidc', 'executor'));
ALTER TABLE attempt_tokens ADD COLUMN execution_id TEXT
  REFERENCES attempt_execution_instances(execution_id);

CREATE UNIQUE INDEX attempt_tokens_execution_identity
ON attempt_tokens(execution_id)
WHERE execution_id IS NOT NULL;

CREATE TRIGGER attempt_tokens_executor_identity_binding
BEFORE INSERT ON attempt_tokens
WHEN NEW.identity_kind = 'executor'
AND (
  NEW.execution_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM attempt_execution_instances AS execution
    WHERE execution.execution_id = NEW.execution_id
      AND execution.attempt_id = NEW.attempt_id
      AND execution.lease_generation = NEW.lease_generation
      AND execution.status IN ('starting', 'running')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'executor grant identity mismatch');
END;

CREATE TRIGGER attempt_tokens_identity_immutable
BEFORE UPDATE OF identity_kind, execution_id ON attempt_tokens
BEGIN
  SELECT RAISE(ABORT, 'attempt token identity is immutable');
END;
