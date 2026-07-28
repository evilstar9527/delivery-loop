import { z } from 'zod';

const QuerySchema = z.object({
  tenantKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/),
  eventId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/),
}).strict();

interface CountRow {
  deliveries: number;
  transport_receipts: number;
  ingress_outboxes: number;
  queue_message_identities: number;
  queue_observations: number;
  tasks: number;
  runs: number;
  workflow_create_outboxes: number;
}

interface DeliveryRow {
  delivery_id: string;
  event_type: string;
  event_digest: string;
  verification_mode: 'encrypted' | 'plaintext';
  received_at: string;
}

interface TransportReceiptRow {
  request_timestamp: string;
  request_digest: string;
  received_at: string;
}

interface IngressRow {
  outbox_id: string;
  delivery_id: string;
  event_type: string;
  event_digest: string;
  delivery_state: 'pending' | 'delivering' | 'enqueued' | 'queued' | 'settled' | 'dead_lettered';
  attempt_count: number;
  enqueued_at: string | null;
  queue_observed_at: string | null;
  task_id: string | null;
  run_id: string | null;
  task_digest: string | null;
  settled_at: string | null;
}

interface QueueObservationRow {
  queue_name: 'delivery-loop-feishu-ingress';
  queue_message_id_digest: string;
  delivery_attempt: number;
  message_timestamp: string;
  observed_at: string;
}

interface TaskRow {
  source_system: 'feishu' | 'meego';
  tenant_key: string;
  source_task_key: string;
  task_revision: string;
  task_digest: string;
  task_id: string;
  run_id: string;
  workflow_instance_id: string;
  run_state: string;
  workflow_create_outbox_id: string;
  workflow_create_state: 'pending' | 'delivering' | 'settled';
}

export interface FeishuIngressEvidenceProjection {
  schemaVersion: '1';
  tenantKey: string;
  eventId: string;
  counts: {
    deliveries: number;
    transportReceipts: number;
    ingressOutboxes: number;
    queueMessageIdentities: number;
    queueObservations: number;
    tasks: number;
    runs: number;
    workflowCreateOutboxes: number;
  };
  delivery: {
    deliveryId: string;
    eventType: string;
    eventDigest: string;
    verificationMode: 'encrypted' | 'plaintext';
    receivedAt: string;
  } | null;
  transportReceipts: Array<{
    requestTimestamp: string;
    requestDigest: string;
    receivedAt: string;
  }>;
  ingress: {
    outboxId: string;
    deliveryId: string;
    eventType: string;
    eventDigest: string;
    deliveryState: IngressRow['delivery_state'];
    relayAttemptCount: number;
    enqueuedAt: string | null;
    queueObservedAt: string | null;
    taskId: string | null;
    runId: string | null;
    taskDigest: string | null;
    settledAt: string | null;
  } | null;
  queueObservations: Array<{
    queueName: 'delivery-loop-feishu-ingress';
    queueMessageIdDigest: string;
    deliveryAttempt: number;
    messageTimestamp: string;
    observedAt: string;
  }>;
  task: {
    sourceSystem: 'feishu' | 'meego';
    tenantKey: string;
    sourceTaskKey: string;
    taskRevision: string;
    taskDigest: string;
    taskId: string;
    runId: string;
    workflowInstanceId: string;
    runState: string;
    workflowCreateOutboxId: string;
    workflowCreateState: 'pending' | 'delivering' | 'settled';
  } | null;
}

export class FeishuIngressEvidenceStoreError extends Error {
  constructor(readonly code: 'invalid_query' | 'projection_conflict') {
    super(`Feishu ingress evidence projection failed: ${code}`);
    this.name = 'FeishuIngressEvidenceStoreError';
  }
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Operations-only lineage projection. Queue IDs and request bodies never leave D1. */
export class FeishuIngressEvidenceStore {
  constructor(private readonly db: D1Database) {}

  async get(rawQuery: { tenantKey: string; eventId: string }): Promise<FeishuIngressEvidenceProjection> {
    const parsed = QuerySchema.safeParse(rawQuery);
    if (!parsed.success) throw new FeishuIngressEvidenceStoreError('invalid_query');
    const { tenantKey, eventId } = parsed.data;
    const results = await this.db.batch([
      this.db.prepare(
        `SELECT delivery_id, event_type, event_digest, verification_mode, received_at
         FROM feishu_webhook_deliveries WHERE tenant_key = ? AND event_id = ?`,
      ).bind(tenantKey, eventId),
      this.db.prepare(
        `SELECT request_timestamp, request_digest, received_at
         FROM feishu_webhook_nonces WHERE tenant_key = ? AND event_id = ?
         ORDER BY request_timestamp, received_at, nonce_id`,
      ).bind(tenantKey, eventId),
      this.db.prepare(
        `SELECT outbox_id, delivery_id, event_type, event_digest, delivery_state,
                attempt_count, enqueued_at, queue_observed_at, task_id, run_id,
                task_digest, settled_at
         FROM feishu_ingress_outbox WHERE tenant_key = ? AND event_id = ?`,
      ).bind(tenantKey, eventId),
      this.db.prepare(
        `SELECT observation.queue_name, observation.queue_message_id_digest,
                observation.delivery_attempt, observation.message_timestamp,
                observation.observed_at
         FROM feishu_ingress_queue_observations AS observation
         JOIN feishu_ingress_outbox AS ingress ON ingress.outbox_id = observation.outbox_id
         WHERE ingress.tenant_key = ? AND ingress.event_id = ?
         ORDER BY observation.delivery_attempt, observation.observed_at, observation.observation_id`,
      ).bind(tenantKey, eventId),
      this.db.prepare(
        `SELECT task.source_system, task.tenant_key, task.source_task_key,
                task.task_revision, task.task_digest, task.task_id,
                run.run_id, run.workflow_instance_id, run.state AS run_state,
                effect.outbox_id AS workflow_create_outbox_id,
                effect.delivery_state AS workflow_create_state
         FROM feishu_ingress_outbox AS ingress
         JOIN tasks AS task ON task.task_id = ingress.task_id
         JOIN runs AS run ON run.run_id = ingress.run_id
         JOIN outbox AS effect ON effect.run_id = run.run_id AND effect.kind = 'workflow_create'
         WHERE ingress.tenant_key = ? AND ingress.event_id = ?`,
      ).bind(tenantKey, eventId),
      this.db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM feishu_webhook_deliveries
             WHERE tenant_key = ? AND event_id = ?) AS deliveries,
           (SELECT COUNT(*) FROM feishu_webhook_nonces
             WHERE tenant_key = ? AND event_id = ?) AS transport_receipts,
           (SELECT COUNT(*) FROM feishu_ingress_outbox
             WHERE tenant_key = ? AND event_id = ?) AS ingress_outboxes,
           (SELECT COUNT(DISTINCT observation.queue_message_id_digest)
              FROM feishu_ingress_queue_observations AS observation
              JOIN feishu_ingress_outbox AS ingress ON ingress.outbox_id = observation.outbox_id
             WHERE ingress.tenant_key = ? AND ingress.event_id = ?) AS queue_message_identities,
           (SELECT COUNT(*) FROM feishu_ingress_queue_observations AS observation
              JOIN feishu_ingress_outbox AS ingress ON ingress.outbox_id = observation.outbox_id
             WHERE ingress.tenant_key = ? AND ingress.event_id = ?) AS queue_observations,
           (SELECT COUNT(*) FROM tasks AS task
              JOIN feishu_ingress_outbox AS ingress ON ingress.task_id = task.task_id
             WHERE ingress.tenant_key = ? AND ingress.event_id = ?) AS tasks,
           (SELECT COUNT(*) FROM runs AS run
              JOIN feishu_ingress_outbox AS ingress ON ingress.run_id = run.run_id
             WHERE ingress.tenant_key = ? AND ingress.event_id = ?) AS runs,
           (SELECT COUNT(*) FROM outbox AS effect
              JOIN feishu_ingress_outbox AS ingress ON ingress.run_id = effect.run_id
             WHERE ingress.tenant_key = ? AND ingress.event_id = ?
               AND effect.kind = 'workflow_create') AS workflow_create_outboxes`,
      ).bind(
        tenantKey, eventId,
        tenantKey, eventId,
        tenantKey, eventId,
        tenantKey, eventId,
        tenantKey, eventId,
        tenantKey, eventId,
        tenantKey, eventId,
        tenantKey, eventId,
      ),
    ]);
    const deliveryRows = (results[0]?.results ?? []) as unknown as DeliveryRow[];
    const receiptRows = (results[1]?.results ?? []) as unknown as TransportReceiptRow[];
    const ingressRows = (results[2]?.results ?? []) as unknown as IngressRow[];
    const observationRows = (results[3]?.results ?? []) as unknown as QueueObservationRow[];
    const taskRows = (results[4]?.results ?? []) as unknown as TaskRow[];
    const counts = (results[5]?.results[0] ?? null) as unknown as CountRow | null;
    if (
      counts === null || deliveryRows.length > 1 || ingressRows.length > 1 || taskRows.length > 1 ||
      counts.deliveries !== deliveryRows.length ||
      counts.transport_receipts !== receiptRows.length ||
      counts.ingress_outboxes !== ingressRows.length ||
      counts.queue_observations !== observationRows.length ||
      !Object.values(counts).every(validCount)
    ) throw new FeishuIngressEvidenceStoreError('projection_conflict');
    const delivery = deliveryRows[0];
    const ingress = ingressRows[0];
    const task = taskRows[0];
    return {
      schemaVersion: '1',
      tenantKey,
      eventId,
      counts: {
        deliveries: counts.deliveries,
        transportReceipts: counts.transport_receipts,
        ingressOutboxes: counts.ingress_outboxes,
        queueMessageIdentities: counts.queue_message_identities,
        queueObservations: counts.queue_observations,
        tasks: counts.tasks,
        runs: counts.runs,
        workflowCreateOutboxes: counts.workflow_create_outboxes,
      },
      delivery: delivery === undefined ? null : {
        deliveryId: delivery.delivery_id,
        eventType: delivery.event_type,
        eventDigest: delivery.event_digest,
        verificationMode: delivery.verification_mode,
        receivedAt: delivery.received_at,
      },
      transportReceipts: receiptRows.map((receipt) => ({
        requestTimestamp: receipt.request_timestamp,
        requestDigest: receipt.request_digest,
        receivedAt: receipt.received_at,
      })),
      ingress: ingress === undefined ? null : {
        outboxId: ingress.outbox_id,
        deliveryId: ingress.delivery_id,
        eventType: ingress.event_type,
        eventDigest: ingress.event_digest,
        deliveryState: ingress.delivery_state,
        relayAttemptCount: ingress.attempt_count,
        enqueuedAt: ingress.enqueued_at,
        queueObservedAt: ingress.queue_observed_at,
        taskId: ingress.task_id,
        runId: ingress.run_id,
        taskDigest: ingress.task_digest,
        settledAt: ingress.settled_at,
      },
      queueObservations: observationRows.map((observation) => ({
        queueName: observation.queue_name,
        queueMessageIdDigest: observation.queue_message_id_digest,
        deliveryAttempt: observation.delivery_attempt,
        messageTimestamp: observation.message_timestamp,
        observedAt: observation.observed_at,
      })),
      task: task === undefined ? null : {
        sourceSystem: task.source_system,
        tenantKey: task.tenant_key,
        sourceTaskKey: task.source_task_key,
        taskRevision: task.task_revision,
        taskDigest: task.task_digest,
        taskId: task.task_id,
        runId: task.run_id,
        workflowInstanceId: task.workflow_instance_id,
        runState: task.run_state,
        workflowCreateOutboxId: task.workflow_create_outbox_id,
        workflowCreateState: task.workflow_create_state,
      },
    };
  }
}
