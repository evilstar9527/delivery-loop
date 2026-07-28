-- Metadata-only Feishu webhook receipts. Verification/decryption must complete
-- before insert; raw request/decrypted event/token/encrypt key have no columns.

CREATE TABLE IF NOT EXISTS feishu_webhook_nonces (
  nonce_id            TEXT PRIMARY KEY,
  tenant_key          TEXT NOT NULL,
  nonce_digest        TEXT NOT NULL CHECK (length(nonce_digest) = 71),
  event_id            TEXT NOT NULL,
  request_timestamp   TEXT NOT NULL,
  request_digest      TEXT NOT NULL CHECK (length(request_digest) = 71),
  received_at         TEXT NOT NULL,
  UNIQUE (tenant_key, nonce_digest)
);

CREATE TRIGGER IF NOT EXISTS trg_feishu_webhook_nonce_immutable
BEFORE UPDATE ON feishu_webhook_nonces
BEGIN SELECT RAISE(ABORT, 'feishu_webhook_nonce_is_immutable'); END;

CREATE TABLE IF NOT EXISTS feishu_webhook_deliveries (
  delivery_id         TEXT PRIMARY KEY,
  event_id            TEXT NOT NULL,
  tenant_key          TEXT NOT NULL,
  app_id              TEXT NOT NULL,
  event_type          TEXT NOT NULL,
  event_created_at    TEXT NOT NULL,
  verification_mode   TEXT NOT NULL CHECK (verification_mode IN ('encrypted', 'plaintext')),
  request_timestamp   TEXT,
  nonce_digest        TEXT CHECK (nonce_digest IS NULL OR length(nonce_digest) = 71),
  request_digest      TEXT NOT NULL CHECK (length(request_digest) = 71),
  event_digest        TEXT NOT NULL CHECK (length(event_digest) = 71),
  status              TEXT NOT NULL CHECK (status = 'accepted'),
  received_at         TEXT NOT NULL,
  UNIQUE (tenant_key, event_id)
);

CREATE INDEX IF NOT EXISTS idx_feishu_webhook_received
  ON feishu_webhook_deliveries(tenant_key, received_at, event_id);

CREATE TRIGGER IF NOT EXISTS trg_feishu_webhook_delivery_immutable
BEFORE UPDATE ON feishu_webhook_deliveries
BEGIN SELECT RAISE(ABORT, 'feishu_webhook_delivery_is_immutable'); END;
