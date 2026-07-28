import { z } from 'zod';

const QuerySchema = z.object({
  tenantKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/),
  eventId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/),
}).strict();

interface DeliveryRow {
  delivery_id: string;
  app_id: string;
  event_type: string;
  event_created_at: string;
  verification_mode: 'encrypted' | 'plaintext';
  request_timestamp: string | null;
  request_digest: string;
  event_digest: string;
  status: 'accepted';
  received_at: string;
}

interface IngressRow {
  outbox_id: string;
  delivery_id: string;
  event_type: string;
  event_digest: string;
  delivery_state: 'pending' | 'delivering' | 'enqueued' | 'queued' | 'settled' | 'dead_lettered';
  task_id: string | null;
  run_id: string | null;
  created_at: string;
}

interface CountRow {
  deliveries: number;
  nonces: number;
  ingress_outboxes: number;
  tasks: number;
  runs: number;
  outbox_effects: number;
}

export interface FeishuWebhookEvidenceProjection {
  schemaVersion: '1';
  tenantKey: string;
  eventId: string;
  counts: {
    deliveries: number;
    nonces: number;
    ingressOutboxes: number;
    tasks: number;
    runs: number;
    outboxEffects: number;
  };
  delivery: {
    deliveryId: string;
    appId: string;
    eventType: string;
    eventCreatedAt: string;
    verificationMode: 'encrypted' | 'plaintext';
    requestTimestamp: string | null;
    requestDigest: string;
    eventDigest: string;
    status: 'accepted';
    receivedAt: string;
  } | null;
  ingress: {
    outboxId: string;
    deliveryId: string;
    eventType: string;
    eventDigest: string;
    deliveryState: IngressRow['delivery_state'];
    taskId: string | null;
    runId: string | null;
    createdAt: string;
  } | null;
}

export class FeishuWebhookEvidenceStoreError extends Error {
  constructor(readonly code: 'invalid_query' | 'projection_conflict') {
    super(`Feishu webhook evidence projection failed: ${code}`);
    this.name = 'FeishuWebhookEvidenceStoreError';
  }
}

/** Operations-only metadata projection; it never returns raw/encrypted/decrypted request data. */
export class FeishuWebhookEvidenceStore {
  constructor(private readonly db: D1Database) {}

  async get(rawQuery: { tenantKey: string; eventId: string }): Promise<FeishuWebhookEvidenceProjection> {
    const parsed = QuerySchema.safeParse(rawQuery);
    if (!parsed.success) throw new FeishuWebhookEvidenceStoreError('invalid_query');
    const { tenantKey, eventId } = parsed.data;
    const results = await this.db.batch([
      this.db.prepare(
        `SELECT delivery_id, app_id, event_type, event_created_at, verification_mode,
                request_timestamp, request_digest, event_digest, status, received_at
         FROM feishu_webhook_deliveries WHERE tenant_key = ? AND event_id = ?`,
      ).bind(tenantKey, eventId),
      this.db.prepare(
        `SELECT outbox_id, delivery_id, event_type, event_digest, delivery_state,
                task_id, run_id, created_at
         FROM feishu_ingress_outbox WHERE tenant_key = ? AND event_id = ?`,
      ).bind(tenantKey, eventId),
      this.db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM feishu_webhook_deliveries
             WHERE tenant_key = ? AND event_id = ?) AS deliveries,
           (SELECT COUNT(*) FROM feishu_webhook_nonces
             WHERE tenant_key = ? AND event_id = ?) AS nonces,
           (SELECT COUNT(*) FROM feishu_ingress_outbox
             WHERE tenant_key = ? AND event_id = ?) AS ingress_outboxes,
           (SELECT COUNT(*) FROM tasks
             JOIN feishu_ingress_outbox AS ingress ON ingress.task_id = tasks.task_id
             WHERE ingress.tenant_key = ? AND ingress.event_id = ?) AS tasks,
           (SELECT COUNT(*) FROM runs
             JOIN feishu_ingress_outbox AS ingress ON ingress.run_id = runs.run_id
             WHERE ingress.tenant_key = ? AND ingress.event_id = ?) AS runs,
           (SELECT COUNT(*) FROM outbox
             JOIN feishu_ingress_outbox AS ingress ON ingress.run_id = outbox.run_id
             WHERE ingress.tenant_key = ? AND ingress.event_id = ?) AS outbox_effects`,
      ).bind(
        tenantKey, eventId,
        tenantKey, eventId,
        tenantKey, eventId,
        tenantKey, eventId,
        tenantKey, eventId,
        tenantKey, eventId,
      ),
    ]);
    const deliveryRows = (results[0]?.results ?? []) as unknown as DeliveryRow[];
    const ingressRows = (results[1]?.results ?? []) as unknown as IngressRow[];
    const counts = (results[2]?.results[0] ?? null) as unknown as CountRow | null;
    if (
      counts === null || deliveryRows.length > 1 || ingressRows.length > 1 ||
      counts.deliveries !== deliveryRows.length || counts.ingress_outboxes !== ingressRows.length ||
      ![
        counts.deliveries, counts.nonces, counts.ingress_outboxes,
        counts.tasks, counts.runs, counts.outbox_effects,
      ].every((count) => Number.isSafeInteger(count) && count >= 0)
    ) throw new FeishuWebhookEvidenceStoreError('projection_conflict');
    const delivery = deliveryRows[0];
    const ingress = ingressRows[0];
    return {
      schemaVersion: '1',
      tenantKey,
      eventId,
      counts: {
        deliveries: counts.deliveries,
        nonces: counts.nonces,
        ingressOutboxes: counts.ingress_outboxes,
        tasks: counts.tasks,
        runs: counts.runs,
        outboxEffects: counts.outbox_effects,
      },
      delivery: delivery === undefined
        ? null
        : {
          deliveryId: delivery.delivery_id,
          appId: delivery.app_id,
          eventType: delivery.event_type,
          eventCreatedAt: delivery.event_created_at,
          verificationMode: delivery.verification_mode,
          requestTimestamp: delivery.request_timestamp,
          requestDigest: delivery.request_digest,
          eventDigest: delivery.event_digest,
          status: delivery.status,
          receivedAt: delivery.received_at,
        },
      ingress: ingress === undefined
        ? null
        : {
          outboxId: ingress.outbox_id,
          deliveryId: ingress.delivery_id,
          eventType: ingress.event_type,
          eventDigest: ingress.event_digest,
          deliveryState: ingress.delivery_state,
          taskId: ingress.task_id,
          runId: ingress.run_id,
          createdAt: ingress.created_at,
        },
    };
  }
}
