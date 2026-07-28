-- A distinct attempt-scoped tool credential. The raw bearer is returned once and never stored.
ALTER TABLE attempt_tokens ADD COLUMN tool_token_digest TEXT CHECK (
  tool_token_digest IS NULL OR (
    length(tool_token_digest) = 71 AND tool_token_digest <> token_digest
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attempt_tokens_tool_digest
  ON attempt_tokens(tool_token_digest) WHERE tool_token_digest IS NOT NULL;
