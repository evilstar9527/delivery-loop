-- Operations-only repair intent for a terminal or stuck Feishu card delivery.
-- The caller can bind only the current immutable snapshot; card/message/effect
-- payloads and free-form reasons have no storage column or authority surface.

CREATE TABLE IF NOT EXISTS feishu_delivery_card_refresh_requests (
  refresh_request_id       TEXT PRIMARY KEY,
  card_id                  TEXT NOT NULL
    REFERENCES feishu_delivery_cards(card_id) ON DELETE CASCADE,
  run_id                   TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  expected_presentation_id TEXT NOT NULL,
  expected_revision        INTEGER NOT NULL CHECK (expected_revision > 0),
  expected_digest          TEXT NOT NULL CHECK (
    length(expected_digest) = 71 AND substr(expected_digest, 1, 7) = 'sha256:' AND
    substr(expected_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  requested_by             TEXT NOT NULL CHECK (requested_by = 'service:operations'),
  requested_at             TEXT NOT NULL,
  UNIQUE (card_id, expected_presentation_id, expected_revision, expected_digest)
);

ALTER TABLE feishu_delivery_card_presentations
  ADD COLUMN refresh_request_id TEXT
  CHECK (refresh_request_id IS NULL OR length(refresh_request_id) BETWEEN 1 AND 200);

CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_card_refresh_presentation
  ON feishu_delivery_card_presentations(refresh_request_id)
  WHERE refresh_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_feishu_card_refresh_pending
  ON feishu_delivery_card_refresh_requests(card_id, expected_presentation_id, requested_at);

CREATE TRIGGER IF NOT EXISTS trg_feishu_card_refresh_request_bound_snapshot
BEFORE INSERT ON feishu_delivery_card_refresh_requests
WHEN NOT EXISTS (
  SELECT 1
  FROM feishu_delivery_cards AS cards
  JOIN feishu_delivery_card_presentations AS presentations
    ON presentations.presentation_id = NEW.expected_presentation_id
   AND presentations.card_id = cards.card_id
  WHERE cards.card_id = NEW.card_id AND cards.run_id = NEW.run_id
    AND presentations.run_id = NEW.run_id
    AND presentations.revision = NEW.expected_revision
    AND presentations.digest = NEW.expected_digest
)
BEGIN SELECT RAISE(ABORT, 'feishu_card_refresh_snapshot_is_invalid'); END;

CREATE TRIGGER IF NOT EXISTS trg_feishu_card_refresh_request_immutable
BEFORE UPDATE ON feishu_delivery_card_refresh_requests
BEGIN SELECT RAISE(ABORT, 'feishu_card_refresh_request_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_feishu_card_refresh_presentation_bound
BEFORE INSERT ON feishu_delivery_card_presentations
WHEN NEW.refresh_request_id IS NOT NULL AND (
  NEW.schema_version IS NOT '2' OR NEW.presentation_json IS NULL OR
  json_extract(NEW.presentation_json, '$.refreshRequestId') IS NOT NEW.refresh_request_id OR
  NOT EXISTS (
    SELECT 1 FROM feishu_delivery_card_refresh_requests AS requests
    WHERE requests.refresh_request_id = NEW.refresh_request_id
      AND requests.card_id = NEW.card_id AND requests.run_id = NEW.run_id
      AND NEW.revision > requests.expected_revision
  )
)
BEGIN SELECT RAISE(ABORT, 'feishu_card_refresh_presentation_is_invalid'); END;

CREATE TRIGGER IF NOT EXISTS trg_feishu_card_refresh_json_not_spoofed
BEFORE INSERT ON feishu_delivery_card_presentations
WHEN NEW.refresh_request_id IS NULL AND NEW.presentation_json IS NOT NULL
  AND json_type(NEW.presentation_json, '$.refreshRequestId') IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'feishu_card_refresh_presentation_is_invalid'); END;
