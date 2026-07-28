-- Upgrade the existing four-section delivery card to a full, immutable Run
-- status presentation. Existing schema v1 rows/outbox remain renderable.

ALTER TABLE feishu_delivery_cards ADD COLUMN refresh_after TEXT;

ALTER TABLE feishu_delivery_card_presentations
  ADD COLUMN schema_version TEXT NOT NULL DEFAULT '1'
  CHECK (schema_version IN ('1', '2'));

ALTER TABLE feishu_delivery_card_presentations
  ADD COLUMN presentation_json TEXT
  CHECK (presentation_json IS NULL OR (
    json_valid(presentation_json) AND length(presentation_json) BETWEEN 2 AND 20000
  ));

CREATE INDEX IF NOT EXISTS idx_feishu_delivery_cards_refresh
  ON feishu_delivery_cards(refresh_after, run_id)
  WHERE refresh_after IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_feishu_card_v1_has_no_json
BEFORE INSERT ON feishu_delivery_card_presentations
WHEN NEW.schema_version = '1' AND NEW.presentation_json IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'feishu_card_v1_presentation_is_invalid'); END;

CREATE TRIGGER IF NOT EXISTS trg_feishu_card_v2_has_bound_json
BEFORE INSERT ON feishu_delivery_card_presentations
WHEN NEW.schema_version = '2' AND (
  NEW.presentation_json IS NULL OR NOT json_valid(NEW.presentation_json) OR
  json_extract(NEW.presentation_json, '$.schemaVersion') IS NOT '2' OR
  json_extract(NEW.presentation_json, '$.cardId') IS NOT NEW.card_id OR
  json_extract(NEW.presentation_json, '$.presentationId') IS NOT NEW.presentation_id OR
  json_extract(NEW.presentation_json, '$.runId') IS NOT NEW.run_id OR
  json_extract(NEW.presentation_json, '$.runVersion') IS NOT NEW.run_version
)
BEGIN SELECT RAISE(ABORT, 'feishu_card_v2_presentation_is_invalid'); END;
