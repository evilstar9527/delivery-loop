-- Immutable reason/source watermark for every new Feishu card presentation.
-- It proves that a scheduled approval-expiry refresh happened without another
-- business projection changing. No card body, principal, nonce, token, raw
-- log, artifact reference, or upstream response is stored here.

CREATE TABLE IF NOT EXISTS feishu_delivery_card_presentation_lineages (
  lineage_id                TEXT PRIMARY KEY,
  presentation_id           TEXT NOT NULL UNIQUE
    REFERENCES feishu_delivery_card_presentations(presentation_id) ON DELETE CASCADE,
  card_id                   TEXT NOT NULL
    REFERENCES feishu_delivery_cards(card_id) ON DELETE CASCADE,
  run_id                    TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  prior_presentation_id     TEXT
    REFERENCES feishu_delivery_card_presentations(presentation_id) ON DELETE CASCADE,
  trigger_reason            TEXT NOT NULL CHECK (
    trigger_reason IN ('initial', 'source_change', 'approval_expiry', 'manual_refresh')
  ),
  prior_source_observed_at  TEXT,
  source_observed_at        TEXT NOT NULL,
  trigger_refresh_at        TEXT,
  next_refresh_at           TEXT,
  projected_at              TEXT NOT NULL,
  CHECK (
    (trigger_reason = 'initial' AND prior_presentation_id IS NULL AND
     prior_source_observed_at IS NULL AND trigger_refresh_at IS NULL) OR
    (trigger_reason <> 'initial' AND prior_presentation_id IS NOT NULL AND
     prior_source_observed_at IS NOT NULL)
  ),
  CHECK (
    (trigger_reason = 'approval_expiry' AND trigger_refresh_at IS NOT NULL AND
     prior_source_observed_at = source_observed_at AND
     trigger_refresh_at <= projected_at) OR
    (trigger_reason <> 'approval_expiry' AND trigger_refresh_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_feishu_card_presentation_lineage_run
  ON feishu_delivery_card_presentation_lineages(run_id, projected_at, lineage_id);

CREATE TRIGGER IF NOT EXISTS trg_feishu_card_presentation_lineage_bound
BEFORE INSERT ON feishu_delivery_card_presentation_lineages
WHEN NOT EXISTS (
  SELECT 1 FROM feishu_delivery_card_presentations AS current
  WHERE current.presentation_id = NEW.presentation_id
    AND current.card_id = NEW.card_id AND current.run_id = NEW.run_id
) OR (
  NEW.prior_presentation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM feishu_delivery_card_presentations AS prior
    JOIN feishu_delivery_card_presentations AS current
      ON current.presentation_id = NEW.presentation_id
    WHERE prior.presentation_id = NEW.prior_presentation_id
      AND prior.card_id = NEW.card_id AND prior.run_id = NEW.run_id
      AND prior.revision < current.revision
  )
)
BEGIN SELECT RAISE(ABORT, 'feishu_card_presentation_lineage_is_invalid'); END;

CREATE TRIGGER IF NOT EXISTS trg_feishu_card_presentation_lineage_immutable
BEFORE UPDATE ON feishu_delivery_card_presentation_lineages
BEGIN SELECT RAISE(ABORT, 'feishu_card_presentation_lineage_is_immutable'); END;
