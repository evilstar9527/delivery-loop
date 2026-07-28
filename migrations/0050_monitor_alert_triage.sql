-- Signed monitor alerts create metadata-only triage candidates. They never
-- create Task/Run/approval/outbox rows or carry policy/effect authority.

CREATE TABLE IF NOT EXISTS monitor_alert_receipts (
  receipt_id              TEXT PRIMARY KEY,
  lineage_id              TEXT NOT NULL UNIQUE,
  adapter                 TEXT NOT NULL CHECK (adapter = 'generic'),
  tenant_key              TEXT NOT NULL,
  external_event_id       TEXT NOT NULL,
  exact_snapshot_digest   TEXT NOT NULL CHECK (length(exact_snapshot_digest) = 71),
  snapshot_ref            TEXT NOT NULL,
  profile_digest          TEXT NOT NULL CHECK (length(profile_digest) = 71),
  fingerprint_digest      TEXT NOT NULL CHECK (length(fingerprint_digest) = 71),
  proposed_candidate_id   TEXT NOT NULL,
  repository              TEXT NOT NULL,
  alert_rule_id           TEXT NOT NULL,
  resource_digest         TEXT NOT NULL CHECK (length(resource_digest) = 71),
  environment             TEXT NOT NULL CHECK (environment IN ('none', 'test', 'production')),
  severity                TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  suppression_window_ms   INTEGER NOT NULL CHECK (
    suppression_window_ms BETWEEN 60000 AND 86400000
  ),
  occurred_at             TEXT NOT NULL,
  received_at             TEXT NOT NULL,
  proposed_expires_at     TEXT NOT NULL CHECK (proposed_expires_at > received_at),
  created_at              TEXT NOT NULL,
  UNIQUE (adapter, tenant_key, external_event_id)
);

CREATE TABLE IF NOT EXISTS monitor_alert_suppression_heads (
  fingerprint_digest      TEXT PRIMARY KEY CHECK (length(fingerprint_digest) = 71),
  candidate_id            TEXT NOT NULL,
  adapter                 TEXT NOT NULL CHECK (adapter = 'generic'),
  tenant_key              TEXT NOT NULL,
  profile_digest          TEXT NOT NULL CHECK (length(profile_digest) = 71),
  repository              TEXT NOT NULL,
  alert_rule_id           TEXT NOT NULL,
  resource_digest         TEXT NOT NULL CHECK (length(resource_digest) = 71),
  environment             TEXT NOT NULL CHECK (environment IN ('none', 'test', 'production')),
  severity                TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  suppression_window_ms   INTEGER NOT NULL CHECK (
    suppression_window_ms BETWEEN 60000 AND 86400000
  ),
  occurrence_count        INTEGER NOT NULL CHECK (occurrence_count > 0),
  first_seen_at           TEXT NOT NULL,
  last_seen_at            TEXT NOT NULL CHECK (last_seen_at >= first_seen_at),
  suppression_expires_at  TEXT NOT NULL CHECK (suppression_expires_at > first_seen_at),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE (adapter, tenant_key, fingerprint_digest)
);

CREATE TABLE IF NOT EXISTS monitor_alert_candidates (
  candidate_id            TEXT PRIMARY KEY,
  fingerprint_digest      TEXT NOT NULL CHECK (length(fingerprint_digest) = 71),
  adapter                 TEXT NOT NULL CHECK (adapter = 'generic'),
  tenant_key              TEXT NOT NULL,
  profile_digest          TEXT NOT NULL CHECK (length(profile_digest) = 71),
  repository              TEXT NOT NULL,
  alert_rule_id           TEXT NOT NULL,
  resource_digest         TEXT NOT NULL CHECK (length(resource_digest) = 71),
  environment             TEXT NOT NULL CHECK (environment IN ('none', 'test', 'production')),
  severity                TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  status                  TEXT NOT NULL CHECK (status = 'triaging'),
  suppression_window_ms   INTEGER NOT NULL CHECK (
    suppression_window_ms BETWEEN 60000 AND 86400000
  ),
  occurrence_count        INTEGER NOT NULL CHECK (occurrence_count > 0),
  first_seen_at           TEXT NOT NULL,
  last_seen_at            TEXT NOT NULL CHECK (last_seen_at >= first_seen_at),
  suppression_expires_at  TEXT NOT NULL CHECK (suppression_expires_at > first_seen_at),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE (fingerprint_digest, first_seen_at)
);

CREATE TABLE IF NOT EXISTS monitor_alert_lineage (
  lineage_id          TEXT PRIMARY KEY,
  candidate_id        TEXT NOT NULL REFERENCES monitor_alert_candidates(candidate_id),
  receipt_id          TEXT NOT NULL UNIQUE REFERENCES monitor_alert_receipts(receipt_id),
  occurrence_ordinal  INTEGER NOT NULL CHECK (occurrence_ordinal > 0),
  suppressed          INTEGER NOT NULL CHECK (suppressed IN (0, 1)),
  occurred_at         TEXT NOT NULL,
  received_at         TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  CHECK ((occurrence_ordinal = 1 AND suppressed = 0) OR
         (occurrence_ordinal > 1 AND suppressed = 1))
);

CREATE INDEX IF NOT EXISTS idx_monitor_alert_candidates_triage
  ON monitor_alert_candidates(status, first_seen_at, candidate_id);

CREATE TRIGGER IF NOT EXISTS trg_monitor_alert_receipt_immutable
BEFORE UPDATE ON monitor_alert_receipts
BEGIN SELECT RAISE(ABORT, 'monitor_alert_receipt_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_monitor_alert_lineage_immutable
BEFORE UPDATE ON monitor_alert_lineage
BEGIN SELECT RAISE(ABORT, 'monitor_alert_lineage_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_monitor_alert_fingerprint_collision
BEFORE INSERT ON monitor_alert_receipts
WHEN EXISTS (
  SELECT 1 FROM monitor_alert_suppression_heads AS heads
  WHERE heads.fingerprint_digest = NEW.fingerprint_digest
    AND (
      heads.adapter != NEW.adapter OR heads.tenant_key != NEW.tenant_key OR
      heads.profile_digest != NEW.profile_digest OR heads.repository != NEW.repository OR
      heads.alert_rule_id != NEW.alert_rule_id OR
      heads.resource_digest != NEW.resource_digest OR
      heads.environment != NEW.environment OR heads.severity != NEW.severity OR
      heads.suppression_window_ms != NEW.suppression_window_ms
    )
)
BEGIN SELECT RAISE(ABORT, 'monitor_alert_fingerprint_conflicts'); END;

CREATE TRIGGER IF NOT EXISTS trg_monitor_alert_head_update_shape
BEFORE UPDATE ON monitor_alert_suppression_heads
WHEN OLD.fingerprint_digest != NEW.fingerprint_digest OR
     OLD.adapter != NEW.adapter OR OLD.tenant_key != NEW.tenant_key OR
     OLD.profile_digest != NEW.profile_digest OR OLD.repository != NEW.repository OR
     OLD.alert_rule_id != NEW.alert_rule_id OR
     OLD.resource_digest != NEW.resource_digest OR
     OLD.environment != NEW.environment OR OLD.severity != NEW.severity OR
     OLD.suppression_window_ms != NEW.suppression_window_ms OR
     NOT (
       (
         NEW.candidate_id = OLD.candidate_id AND
         NEW.occurrence_count = OLD.occurrence_count + 1 AND
         NEW.first_seen_at = OLD.first_seen_at AND
         NEW.last_seen_at >= OLD.last_seen_at AND
         NEW.last_seen_at <= OLD.suppression_expires_at AND
         NEW.suppression_expires_at = OLD.suppression_expires_at AND
         NEW.created_at = OLD.created_at AND NEW.updated_at >= OLD.updated_at
       ) OR (
         NEW.candidate_id != OLD.candidate_id AND NEW.occurrence_count = 1 AND
         NEW.first_seen_at > OLD.suppression_expires_at AND
         NEW.last_seen_at = NEW.first_seen_at AND
         NEW.suppression_expires_at > NEW.first_seen_at AND
         NEW.created_at = NEW.first_seen_at AND NEW.updated_at = NEW.first_seen_at
       )
     )
BEGIN SELECT RAISE(ABORT, 'monitor_alert_head_update_is_invalid'); END;

CREATE TRIGGER IF NOT EXISTS trg_monitor_alert_candidate_update_shape
BEFORE UPDATE ON monitor_alert_candidates
WHEN OLD.candidate_id != NEW.candidate_id OR
     OLD.fingerprint_digest != NEW.fingerprint_digest OR
     OLD.adapter != NEW.adapter OR OLD.tenant_key != NEW.tenant_key OR
     OLD.profile_digest != NEW.profile_digest OR OLD.repository != NEW.repository OR
     OLD.alert_rule_id != NEW.alert_rule_id OR
     OLD.resource_digest != NEW.resource_digest OR
     OLD.environment != NEW.environment OR OLD.severity != NEW.severity OR
     OLD.status != NEW.status OR OLD.suppression_window_ms != NEW.suppression_window_ms OR
     NEW.occurrence_count != OLD.occurrence_count + 1 OR
     NEW.first_seen_at != OLD.first_seen_at OR
     NEW.last_seen_at < OLD.last_seen_at OR
     NEW.last_seen_at > OLD.suppression_expires_at OR
     NEW.suppression_expires_at != OLD.suppression_expires_at OR
     NEW.created_at != OLD.created_at OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'monitor_alert_candidate_update_is_invalid'); END;

-- The receipt/head/candidate/lineage projection is an explicit D1 batch in
-- MonitorAlertIngressStore. Cloudflare D1's remote /query migration path does
-- not accept a trigger body containing multiple statements.
