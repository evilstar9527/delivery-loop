-- One durable Feishu status card per Run. Presentations are immutable and
-- contain only the four safe delivery projections; no task/PR body, runner
-- output, upstream response, token, or free-form error is stored here.

CREATE TABLE IF NOT EXISTS feishu_delivery_cards (
  card_id                       TEXT PRIMARY KEY,
  run_id                        TEXT NOT NULL UNIQUE REFERENCES runs(run_id) ON DELETE CASCADE,
  task_id                       TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  tenant_key                    TEXT NOT NULL,
  chat_id                       TEXT NOT NULL CHECK (length(chat_id) BETWEEN 1 AND 200),
  latest_presentation_id        TEXT,
  latest_revision               INTEGER NOT NULL DEFAULT 0 CHECK (latest_revision >= 0),
  delivered_presentation_id     TEXT,
  delivered_revision            INTEGER NOT NULL DEFAULT 0 CHECK (delivered_revision >= 0),
  delivered_digest              TEXT CHECK (
    delivered_digest IS NULL OR length(delivered_digest) = 71
  ),
  active_message_id             TEXT,
  active_message_created_at     TEXT,
  source_observed_at            TEXT NOT NULL,
  created_at                    TEXT NOT NULL,
  updated_at                    TEXT NOT NULL,
  CHECK (delivered_revision <= latest_revision),
  CHECK (
    (delivered_presentation_id IS NULL AND delivered_revision = 0 AND
     delivered_digest IS NULL) OR
    (delivered_presentation_id IS NOT NULL AND delivered_revision > 0 AND
     delivered_digest IS NOT NULL)
  ),
  CHECK (
    (active_message_id IS NULL AND active_message_created_at IS NULL) OR
    (active_message_id IS NOT NULL AND active_message_created_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS feishu_delivery_card_presentations (
  presentation_id       TEXT PRIMARY KEY,
  card_id               TEXT NOT NULL REFERENCES feishu_delivery_cards(card_id) ON DELETE CASCADE,
  run_id                TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  run_version           INTEGER NOT NULL CHECK (run_version >= 0),
  revision              INTEGER NOT NULL CHECK (revision > 0),
  digest                TEXT NOT NULL CHECK (length(digest) = 71),
  pr_status             TEXT NOT NULL CHECK (
    pr_status IN ('not_started', 'publishing', 'open')
  ),
  pr_url                TEXT,
  merge_status          TEXT NOT NULL CHECK (
    merge_status IN ('waiting', 'ready', 'merged')
  ),
  merge_url             TEXT,
  test_deploy_status    TEXT NOT NULL CHECK (
    test_deploy_status IN (
      'not_started', 'scheduled', 'verifying', 'in_progress', 'succeeded', 'failed'
    )
  ),
  test_deploy_url       TEXT,
  production_deploy_status TEXT NOT NULL CHECK (
    production_deploy_status IN (
      'not_started', 'scheduled', 'verifying', 'in_progress', 'succeeded', 'failed'
    )
  ),
  production_deploy_url TEXT,
  created_at            TEXT NOT NULL,
  UNIQUE (card_id, revision),
  UNIQUE (card_id, digest)
);

CREATE INDEX IF NOT EXISTS idx_feishu_delivery_cards_source
  ON feishu_delivery_cards(source_observed_at, run_id);

CREATE TABLE IF NOT EXISTS feishu_delivery_card_deliveries (
  delivery_id       TEXT PRIMARY KEY,
  presentation_id   TEXT NOT NULL UNIQUE
    REFERENCES feishu_delivery_card_presentations(presentation_id) ON DELETE CASCADE,
  outbox_id          TEXT NOT NULL UNIQUE REFERENCES outbox(outbox_id) ON DELETE CASCADE,
  disposition       TEXT NOT NULL CHECK (
    disposition IN ('created', 'updated', 'rejected')
  ),
  message_id        TEXT,
  error_code        TEXT CHECK (
    error_code IS NULL OR error_code = 'feishu_request_rejected'
  ),
  delivered_at      TEXT NOT NULL,
  CHECK (
    (disposition IN ('created', 'updated') AND message_id IS NOT NULL AND
     error_code IS NULL) OR
    (disposition = 'rejected' AND message_id IS NULL AND
     error_code = 'feishu_request_rejected')
  )
);

CREATE TRIGGER IF NOT EXISTS trg_feishu_delivery_card_identity_immutable
BEFORE UPDATE OF run_id, task_id, tenant_key, chat_id, created_at
ON feishu_delivery_cards
BEGIN SELECT RAISE(ABORT, 'feishu_delivery_card_identity_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_feishu_delivery_card_revision_monotonic
BEFORE UPDATE OF latest_revision, delivered_revision ON feishu_delivery_cards
WHEN NEW.latest_revision < OLD.latest_revision OR
     NEW.delivered_revision < OLD.delivered_revision
BEGIN SELECT RAISE(ABORT, 'feishu_delivery_card_revision_cannot_regress'); END;

CREATE TRIGGER IF NOT EXISTS trg_feishu_delivery_card_presentation_immutable
BEFORE UPDATE ON feishu_delivery_card_presentations
BEGIN SELECT RAISE(ABORT, 'feishu_delivery_card_presentation_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_feishu_delivery_card_delivery_immutable
BEFORE UPDATE ON feishu_delivery_card_deliveries
BEGIN SELECT RAISE(ABORT, 'feishu_delivery_card_delivery_is_immutable'); END;
