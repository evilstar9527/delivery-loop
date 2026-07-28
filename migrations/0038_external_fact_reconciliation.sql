-- Durable, reference-only observations for the two external-fact gaps closed
-- in Round 63. Raw GitHub/Feishu responses, message bodies and tokens are never
-- stored; projectors retain only canonical digests and allowlisted identity.

CREATE TABLE IF NOT EXISTS github_test_deployment_status_observations (
  observation_id       TEXT PRIMARY KEY,
  source_kind          TEXT NOT NULL CHECK (source_kind = 'api'),
  fact_digest          TEXT NOT NULL CHECK (length(fact_digest) = 71),
  repository           TEXT NOT NULL,
  github_deployment_id TEXT NOT NULL,
  deployment_id        TEXT REFERENCES test_deployments(deployment_id),
  processing_state     TEXT NOT NULL CHECK (
    processing_state IN ('received', 'applied', 'ignored')
  ),
  ignore_reason        TEXT,
  external_updated_at  TEXT NOT NULL,
  observed_at          TEXT NOT NULL,
  processed_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_github_test_deployment_status_observations
  ON github_test_deployment_status_observations(
    repository, github_deployment_id, external_updated_at
  );

CREATE TRIGGER IF NOT EXISTS trg_github_test_deployment_status_observation_immutable
BEFORE UPDATE OF
  observation_id, source_kind, fact_digest, repository, github_deployment_id,
  external_updated_at, observed_at
ON github_test_deployment_status_observations
BEGIN SELECT RAISE(ABORT, 'github_test_deployment_status_observation_is_immutable'); END;

CREATE TABLE IF NOT EXISTS feishu_delivery_card_observations (
  observation_id      TEXT PRIMARY KEY,
  source_kind         TEXT NOT NULL CHECK (source_kind = 'api'),
  fact_digest         TEXT NOT NULL CHECK (length(fact_digest) = 71),
  run_id              TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  card_id             TEXT NOT NULL REFERENCES feishu_delivery_cards(card_id) ON DELETE CASCADE,
  presentation_id     TEXT REFERENCES feishu_delivery_card_presentations(presentation_id),
  message_id          TEXT NOT NULL,
  processing_state    TEXT NOT NULL CHECK (
    processing_state IN ('received', 'applied', 'ignored')
  ),
  ignore_reason       TEXT CHECK (
    ignore_reason IS NULL OR ignore_reason IN (
      'binding_mismatch', 'content_mismatch', 'presentation_stale'
    )
  ),
  external_updated_at TEXT NOT NULL,
  observed_at         TEXT NOT NULL,
  processed_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_feishu_delivery_card_observations
  ON feishu_delivery_card_observations(
    run_id, message_id, external_updated_at
  );

CREATE TRIGGER IF NOT EXISTS trg_feishu_delivery_card_observation_immutable
BEFORE UPDATE OF
  observation_id, source_kind, fact_digest, run_id, card_id, message_id,
  external_updated_at, observed_at
ON feishu_delivery_card_observations
BEGIN SELECT RAISE(ABORT, 'feishu_delivery_card_observation_is_immutable'); END;
