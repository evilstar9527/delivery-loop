-- Immutable, reference-only history for retryable Feishu delivery failures.
-- The live outbox keeps only its current state; this table preserves the
-- bounded attempt/error facts needed to audit rate-limit, timeout and token
-- refresh recovery without storing response bodies or credentials.

CREATE TABLE IF NOT EXISTS feishu_delivery_card_retry_observations (
  observation_id  TEXT PRIMARY KEY,
  outbox_id       TEXT NOT NULL REFERENCES outbox(outbox_id) ON DELETE CASCADE,
  run_id          TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  presentation_id TEXT NOT NULL
    REFERENCES feishu_delivery_card_presentations(presentation_id) ON DELETE CASCADE,
  attempt_count   INTEGER NOT NULL CHECK (attempt_count > 0),
  error_code      TEXT NOT NULL CHECK (
    error_code IN (
      'feishu_rate_limited', 'feishu_api_timeout', 'feishu_token_invalid',
      'feishu_api_unavailable', 'feishu_token_unavailable', 'feishu_unavailable'
    )
  ),
  observed_at     TEXT NOT NULL,
  UNIQUE (outbox_id, attempt_count)
);

CREATE INDEX IF NOT EXISTS idx_feishu_card_retry_observations
  ON feishu_delivery_card_retry_observations(run_id, observed_at, observation_id);

CREATE TRIGGER IF NOT EXISTS trg_feishu_card_retry_observation_immutable
BEFORE UPDATE ON feishu_delivery_card_retry_observations
BEGIN SELECT RAISE(ABORT, 'feishu_card_retry_observation_is_immutable'); END;
