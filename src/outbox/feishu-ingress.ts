import { canonicalSha256 } from '../domain/digest.js';

export const FEISHU_INGRESS_QUEUE_NAME = 'delivery-loop-feishu-ingress';
export const FEISHU_INGRESS_DEAD_LETTER_QUEUE_NAME = 'delivery-loop-feishu-ingress-dlq';

export interface FeishuIngressQueueMessage {
  outboxId: string;
}

export interface FeishuIngressRelayOptions {
  now?: () => Date;
  generateLeaseId?: () => string;
  leaseMs?: number;
}

interface RelayRow {
  outbox_id: string;
}

/** D1-fenced relay for the dedicated Feishu ingress Queue. */
export class FeishuIngressRelay {
  private readonly now: () => Date;
  private readonly generateLeaseId: () => string;
  private readonly leaseMs: number;

  constructor(
    private readonly db: D1Database,
    private readonly queue: Queue<FeishuIngressQueueMessage>,
    options: FeishuIngressRelayOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.generateLeaseId = options.generateLeaseId ?? (() => crypto.randomUUID());
    this.leaseMs = options.leaseMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1_000 || this.leaseMs > 3_600_000) {
      throw new Error('Feishu ingress relay lease is invalid');
    }
  }

  async relay(limit = 25): Promise<number> {
    const now = this.now();
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const { results } = await this.db.prepare(
      `SELECT outbox_id FROM feishu_ingress_outbox
       WHERE delivery_state = 'pending'
          OR (delivery_state = 'delivering' AND lease_expires_at <= ?)
       ORDER BY created_at, outbox_id LIMIT ?`,
    ).bind(now.toISOString(), boundedLimit).all<RelayRow>();
    let delivered = 0;
    for (const row of results) {
      if (await this.deliver(row.outbox_id, now)) delivered += 1;
    }
    return delivered;
  }

  private async deliver(outboxId: string, now: Date): Promise<boolean> {
    const leaseId = this.generateLeaseId();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseMs).toISOString();
    const claim = await this.db.prepare(
      `UPDATE feishu_ingress_outbox
       SET delivery_state = 'delivering', lease_id = ?, lease_expires_at = ?,
           attempt_count = attempt_count + 1, last_failure_code = NULL, updated_at = ?
       WHERE outbox_id = ? AND (
         delivery_state = 'pending'
         OR (delivery_state = 'delivering' AND lease_expires_at <= ?)
       )`,
    ).bind(leaseId, leaseExpiresAt, nowIso, outboxId, nowIso).run();
    if (claim.meta.changes !== 1) return false;
    try {
      await this.queue.send({ outboxId });
    } catch {
      await this.db.prepare(
        `UPDATE feishu_ingress_outbox
         SET delivery_state = 'pending', lease_id = NULL, lease_expires_at = NULL,
             last_failure_code = 'queue_unavailable', updated_at = ?
         WHERE outbox_id = ? AND delivery_state = 'delivering' AND lease_id = ?`,
      ).bind(nowIso, outboxId, leaseId).run();
      return false;
    }
    const enqueued = await this.db.prepare(
      `UPDATE feishu_ingress_outbox
       SET delivery_state = 'enqueued', lease_id = NULL, lease_expires_at = NULL,
           enqueued_at = ?, updated_at = ?
       WHERE outbox_id = ? AND delivery_state = 'delivering' AND lease_id = ?`,
    ).bind(nowIso, nowIso, outboxId, leaseId).run();
    if (enqueued.meta.changes === 1) return true;
    const raced = await this.db.prepare(
      `SELECT delivery_state FROM feishu_ingress_outbox WHERE outbox_id = ?`,
    ).bind(outboxId).first<{ delivery_state: string }>();
    return raced?.delivery_state === 'queued' || raced?.delivery_state === 'settled';
  }
}

async function observeQueueDelivery(
  db: D1Database,
  outboxId: string,
  queueMessageId: string,
  deliveryAttempt: number,
  messageTimestamp: Date,
  now: Date,
): Promise<'observed' | 'existing' | 'missing'> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(outboxId) ||
    queueMessageId.length < 1 || queueMessageId.length > 1_024 ||
    !Number.isSafeInteger(deliveryAttempt) || deliveryAttempt < 1 || deliveryAttempt > 100 ||
    !Number.isFinite(messageTimestamp.getTime())
  ) return 'missing';
  const nowIso = now.toISOString();
  const messageTimestampIso = messageTimestamp.toISOString();
  const queueMessageIdDigest = await canonicalSha256(queueMessageId);
  const observationId = `feishu_queue_observation_${(
    await canonicalSha256({
      queueName: FEISHU_INGRESS_QUEUE_NAME,
      queueMessageIdDigest,
      deliveryAttempt,
    })
  ).slice('sha256:'.length, 47)}`;
  const results = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO feishu_ingress_queue_observations (
         observation_id, outbox_id, queue_name, queue_message_id_digest,
         delivery_attempt, message_timestamp, observed_at, created_at
       )
       SELECT ?, outbox_id, ?, ?, ?, ?, ?, ?
       FROM feishu_ingress_outbox WHERE outbox_id = ?`,
    ).bind(
      observationId,
      FEISHU_INGRESS_QUEUE_NAME,
      queueMessageIdDigest,
      deliveryAttempt,
      messageTimestampIso,
      nowIso,
      nowIso,
      outboxId,
    ),
    db.prepare(
      `UPDATE feishu_ingress_outbox
       SET delivery_state = 'queued', lease_id = NULL, lease_expires_at = NULL,
           enqueued_at = COALESCE(enqueued_at, ?), queue_observed_at = ?, updated_at = ?
       WHERE outbox_id = ?
         AND delivery_state IN ('pending', 'delivering', 'enqueued')
         AND EXISTS (
           SELECT 1 FROM feishu_ingress_queue_observations AS observation
           WHERE observation.outbox_id = ? AND observation.queue_name = ?
             AND observation.queue_message_id_digest = ?
             AND observation.delivery_attempt = ?
         )`,
    ).bind(
      messageTimestampIso,
      nowIso,
      nowIso,
      outboxId,
      outboxId,
      FEISHU_INGRESS_QUEUE_NAME,
      queueMessageIdDigest,
      deliveryAttempt,
    ),
    db.prepare(
      `SELECT ingress.delivery_state,
              (SELECT COUNT(*) FROM feishu_ingress_queue_observations AS observation
                WHERE observation.outbox_id = ingress.outbox_id
                  AND observation.queue_name = ?
                  AND observation.queue_message_id_digest = ?
                  AND observation.delivery_attempt = ?) AS observation_count
       FROM feishu_ingress_outbox AS ingress WHERE ingress.outbox_id = ?`,
    ).bind(
      FEISHU_INGRESS_QUEUE_NAME,
      queueMessageIdDigest,
      deliveryAttempt,
      outboxId,
    ),
  ]);
  const updated = results[1]?.meta.changes === 1;
  const row = (results[2]?.results[0] ?? null) as {
    delivery_state: string;
    observation_count: number;
  } | null;
  if (row === null) return 'missing';
  if (
    row.observation_count !== 1 ||
    (row.delivery_state !== 'queued' && row.delivery_state !== 'settled')
  ) throw new Error('Feishu ingress Queue observation did not commit');
  return updated ? 'observed' : 'existing';
}

export async function consumeFeishuIngressBatch(
  batch: MessageBatch<FeishuIngressQueueMessage>,
  db: D1Database,
  now = new Date(),
): Promise<void> {
  for (const message of batch.messages) {
    if (
      typeof message.body !== 'object' || message.body === null ||
      typeof message.body.outboxId !== 'string' || typeof message.id !== 'string' ||
      !(message.timestamp instanceof Date) || !Number.isSafeInteger(message.attempts)
    ) {
      message.ack();
      continue;
    }
    try {
      await observeQueueDelivery(
        db,
        message.body.outboxId,
        message.id,
        message.attempts,
        message.timestamp,
        now,
      );
      message.ack();
    } catch {
      message.retry();
    }
  }
}

export async function consumeFeishuIngressDeadLetterBatch(
  batch: MessageBatch<FeishuIngressQueueMessage>,
  db: D1Database,
  now = new Date(),
): Promise<void> {
  const nowIso = now.toISOString();
  for (const message of batch.messages) {
    if (
      typeof message.body !== 'object' || message.body === null ||
      typeof message.body.outboxId !== 'string'
    ) {
      message.ack();
      continue;
    }
    try {
      await db.prepare(
        `UPDATE feishu_ingress_outbox
         SET delivery_state = 'dead_lettered', lease_id = NULL, lease_expires_at = NULL,
             dead_lettered_at = ?, last_failure_code = 'queue_dead_lettered', updated_at = ?
         WHERE outbox_id = ? AND delivery_state NOT IN ('settled', 'dead_lettered')`,
      ).bind(nowIso, nowIso, message.body.outboxId).run();
      message.ack();
    } catch {
      message.retry();
    }
  }
}
