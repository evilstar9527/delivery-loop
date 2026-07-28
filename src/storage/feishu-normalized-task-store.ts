import { z } from 'zod';
import {
  TaskEnvelopeSchema,
  taskRevisionDigest,
  taskRevisionIds,
  type TaskEnvelope,
} from '../domain/task.js';
import { SecretScanner } from '../security/redaction.js';
import {
  ImmutableR2ObjectConflictError,
  putImmutableJsonObject,
} from './immutable-r2-object.js';
import {
  TaskIntakeStore,
  TaskRevisionConflictError,
} from './task-intake-store.js';

const InputSchema = z.object({
  ingressOutboxId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/),
  task: TaskEnvelopeSchema,
  now: z.date(),
}).strict();

export interface FeishuNormalizedTaskInput {
  ingressOutboxId: string;
  task: TaskEnvelope;
  now: Date;
}

export interface FeishuNormalizedTaskResult {
  ingressOutboxId: string;
  taskId: string;
  runId: string;
  disposition: 'linked' | 'duplicate';
}

export class FeishuNormalizedTaskError extends Error {
  constructor(readonly code:
    | 'not_found'
    | 'not_ready'
    | 'binding_mismatch'
    | 'secret_detected'
    | 'revision_conflict'
    | 'storage_unavailable'
    | 'state_conflict') {
    super(`Feishu normalized Task rejected: ${code}`);
    this.name = 'FeishuNormalizedTaskError';
  }
}

interface IngressRow {
  outbox_id: string;
  delivery_state: string;
  tenant_key: string;
  event_id: string;
  event_digest: string;
  queue_observed_at: string | null;
  task_id: string | null;
  run_id: string | null;
  task_digest: string | null;
  task_payload_ref: string | null;
  delivery_status: string;
}

export class FeishuNormalizedTaskStore {
  private readonly secrets: readonly string[];

  constructor(
    private readonly db: D1Database,
    private readonly objects: R2Bucket,
    options: { secrets?: readonly string[] } = {},
  ) {
    this.secrets = options.secrets ?? [];
  }

  async accept(rawInput: FeishuNormalizedTaskInput): Promise<FeishuNormalizedTaskResult> {
    const input = InputSchema.parse(rawInput);
    const ingress = await this.ingress(input.ingressOutboxId);
    if (ingress === null) throw new FeishuNormalizedTaskError('not_found');
    const ids = await taskRevisionIds(input.task);
    const taskDigest = await taskRevisionDigest(input.task);
    const objectKey = `tasks/${ids.taskId}/${taskDigest.slice('sha256:'.length)}.json`;
    const payloadRef = `r2://${objectKey}`;
    if (ingress.delivery_state === 'settled') {
      if (
        ingress.task_id !== ids.taskId || ingress.run_id !== ids.runId ||
        ingress.task_digest !== taskDigest || ingress.task_payload_ref !== payloadRef
      ) throw new FeishuNormalizedTaskError('state_conflict');
      return {
        ingressOutboxId: ingress.outbox_id,
        taskId: ids.taskId,
        runId: ids.runId,
        disposition: 'duplicate',
      };
    }
    if (
      ingress.delivery_state !== 'queued' || ingress.queue_observed_at === null ||
      ingress.delivery_status !== 'accepted'
    ) throw new FeishuNormalizedTaskError('not_ready');
    if (
      (input.task.source.system !== 'feishu' && input.task.source.system !== 'meego') ||
      input.task.source.tenantKey !== ingress.tenant_key ||
      input.task.eventId !== ingress.event_id
    ) throw new FeishuNormalizedTaskError('binding_mismatch');
    if (new SecretScanner({ secrets: [...this.secrets] }).scan(input.task).length > 0) {
      throw new FeishuNormalizedTaskError('secret_detected');
    }

    try {
      await putImmutableJsonObject(this.objects, {
        key: objectKey,
        body: JSON.stringify(input.task),
        metadata: { taskDigest },
      });
    } catch (error) {
      if (error instanceof ImmutableR2ObjectConflictError) {
        throw new FeishuNormalizedTaskError('revision_conflict');
      }
      throw new FeishuNormalizedTaskError('storage_unavailable');
    }

    let taskResult;
    try {
      taskResult = await new TaskIntakeStore(this.db).acceptTaskRevision({
        task: input.task,
        payloadRef,
        now: input.now.toISOString(),
      });
    } catch (error) {
      if (error instanceof TaskRevisionConflictError) {
        throw new FeishuNormalizedTaskError('revision_conflict');
      }
      throw error;
    }
    const settledAt = input.now.toISOString();
    await this.db.prepare(
      `UPDATE feishu_ingress_outbox
       SET delivery_state = 'settled', task_id = ?, run_id = ?, task_digest = ?,
           task_payload_ref = ?, settled_at = ?, updated_at = ?
       WHERE outbox_id = ? AND delivery_state = 'queued' AND queue_observed_at IS NOT NULL
         AND task_id IS NULL AND run_id IS NULL`,
    ).bind(
      taskResult.taskId,
      taskResult.runId,
      taskDigest,
      payloadRef,
      settledAt,
      settledAt,
      input.ingressOutboxId,
    ).run();
    const persisted = await this.ingress(input.ingressOutboxId);
    if (
      persisted?.delivery_state !== 'settled' || persisted.task_id !== taskResult.taskId ||
      persisted.run_id !== taskResult.runId || persisted.task_digest !== taskDigest ||
      persisted.task_payload_ref !== payloadRef
    ) throw new FeishuNormalizedTaskError('state_conflict');
    return {
      ingressOutboxId: input.ingressOutboxId,
      taskId: taskResult.taskId,
      runId: taskResult.runId,
      disposition: 'linked',
    };
  }

  private async ingress(outboxId: string): Promise<IngressRow | null> {
    return await this.db.prepare(
      `SELECT ingress.outbox_id, ingress.delivery_state, ingress.tenant_key,
              ingress.event_id, ingress.event_digest, ingress.queue_observed_at,
              ingress.task_id, ingress.run_id, ingress.task_digest,
              ingress.task_payload_ref, deliveries.status AS delivery_status
       FROM feishu_ingress_outbox AS ingress
       JOIN feishu_webhook_deliveries AS deliveries
         ON deliveries.delivery_id = ingress.delivery_id
       WHERE ingress.outbox_id = ?`,
    ).bind(outboxId).first<IngressRow>();
  }
}
