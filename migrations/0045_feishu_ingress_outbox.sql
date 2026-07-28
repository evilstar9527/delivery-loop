-- Durable Feishu ingress handoff. Platform event identity and Task revision
-- identity are deliberately separate: one event owns one ingress outbox, while
-- multiple events may settle against the same Task/Run revision.

CREATE TABLE IF NOT EXISTS feishu_ingress_outbox (
  outbox_id            TEXT PRIMARY KEY,
  delivery_id          TEXT NOT NULL UNIQUE REFERENCES feishu_webhook_deliveries(delivery_id),
  tenant_key           TEXT NOT NULL,
  event_id             TEXT NOT NULL,
  event_type           TEXT NOT NULL,
  event_digest         TEXT NOT NULL CHECK (length(event_digest) = 71),
  delivery_state       TEXT NOT NULL CHECK (
    delivery_state IN ('pending', 'delivering', 'enqueued', 'queued', 'settled', 'dead_lettered')
  ),
  lease_id             TEXT,
  lease_expires_at     TEXT,
  attempt_count        INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  enqueued_at          TEXT,
  queue_observed_at    TEXT,
  task_id              TEXT REFERENCES tasks(task_id),
  run_id               TEXT REFERENCES runs(run_id),
  task_digest          TEXT CHECK (task_digest IS NULL OR length(task_digest) = 71),
  task_payload_ref     TEXT,
  settled_at           TEXT,
  dead_lettered_at     TEXT,
  last_failure_code    TEXT CHECK (
    last_failure_code IS NULL OR last_failure_code IN ('queue_unavailable', 'queue_dead_lettered')
  ),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (tenant_key, event_id),
  CHECK (
    (delivery_state = 'pending' AND lease_id IS NULL AND lease_expires_at IS NULL
      AND enqueued_at IS NULL AND queue_observed_at IS NULL AND settled_at IS NULL
      AND dead_lettered_at IS NULL AND task_id IS NULL AND run_id IS NULL
      AND task_digest IS NULL AND task_payload_ref IS NULL)
    OR
    (delivery_state = 'delivering' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL
      AND queue_observed_at IS NULL AND settled_at IS NULL AND dead_lettered_at IS NULL
      AND task_id IS NULL AND run_id IS NULL AND task_digest IS NULL AND task_payload_ref IS NULL)
    OR
    (delivery_state = 'enqueued' AND lease_id IS NULL AND lease_expires_at IS NULL
      AND enqueued_at IS NOT NULL AND queue_observed_at IS NULL AND settled_at IS NULL
      AND dead_lettered_at IS NULL AND task_id IS NULL AND run_id IS NULL
      AND task_digest IS NULL AND task_payload_ref IS NULL)
    OR
    (delivery_state = 'queued' AND lease_id IS NULL AND lease_expires_at IS NULL
      AND enqueued_at IS NOT NULL AND queue_observed_at IS NOT NULL AND settled_at IS NULL
      AND dead_lettered_at IS NULL AND task_id IS NULL AND run_id IS NULL
      AND task_digest IS NULL AND task_payload_ref IS NULL)
    OR
    (delivery_state = 'settled' AND lease_id IS NULL AND lease_expires_at IS NULL
      AND enqueued_at IS NOT NULL AND queue_observed_at IS NOT NULL AND settled_at IS NOT NULL
      AND dead_lettered_at IS NULL AND task_id IS NOT NULL AND run_id IS NOT NULL
      AND task_digest IS NOT NULL AND task_payload_ref IS NOT NULL)
    OR
    (delivery_state = 'dead_lettered' AND lease_id IS NULL AND lease_expires_at IS NULL
      AND settled_at IS NULL AND dead_lettered_at IS NOT NULL
      AND task_id IS NULL AND run_id IS NULL AND task_digest IS NULL AND task_payload_ref IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_feishu_ingress_relay
  ON feishu_ingress_outbox(delivery_state, lease_expires_at, created_at, outbox_id);

CREATE INDEX IF NOT EXISTS idx_feishu_ingress_normalize
  ON feishu_ingress_outbox(delivery_state, queue_observed_at, outbox_id);

CREATE TRIGGER IF NOT EXISTS trg_feishu_ingress_identity_immutable
BEFORE UPDATE OF
  outbox_id, delivery_id, tenant_key, event_id, event_type, event_digest, created_at
ON feishu_ingress_outbox
BEGIN SELECT RAISE(ABORT, 'feishu_ingress_identity_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_feishu_ingress_terminal_immutable
BEFORE UPDATE ON feishu_ingress_outbox
WHEN OLD.delivery_state IN ('settled', 'dead_lettered')
BEGIN SELECT RAISE(ABORT, 'feishu_ingress_terminal_is_immutable'); END;
