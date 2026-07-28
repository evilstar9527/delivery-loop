-- Cloudflare Queues is at-least-once. Persist an immutable, metadata-only
-- observation for each logical Queue message delivery attempt so a live
-- replay audit does not infer Queue identity from the ingress outbox alone.

CREATE TABLE IF NOT EXISTS feishu_ingress_queue_observations (
  observation_id          TEXT PRIMARY KEY,
  outbox_id               TEXT NOT NULL REFERENCES feishu_ingress_outbox(outbox_id),
  queue_name              TEXT NOT NULL CHECK (queue_name = 'delivery-loop-feishu-ingress'),
  queue_message_id_digest TEXT NOT NULL CHECK (length(queue_message_id_digest) = 71),
  delivery_attempt        INTEGER NOT NULL CHECK (delivery_attempt > 0 AND delivery_attempt <= 100),
  message_timestamp       TEXT NOT NULL,
  observed_at             TEXT NOT NULL CHECK (observed_at >= message_timestamp),
  created_at              TEXT NOT NULL,
  UNIQUE (queue_name, queue_message_id_digest, delivery_attempt)
);

CREATE INDEX IF NOT EXISTS idx_feishu_ingress_queue_observations_outbox
  ON feishu_ingress_queue_observations(outbox_id, delivery_attempt, observed_at);

CREATE TRIGGER IF NOT EXISTS trg_feishu_ingress_queue_observations_immutable
BEFORE UPDATE ON feishu_ingress_queue_observations
BEGIN SELECT RAISE(ABORT, 'feishu_ingress_queue_observation_is_immutable'); END;
