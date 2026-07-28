/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, introspectWorkflowInstance } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TaskEnvelope } from '../../src/domain/task.js';
import {
  analysisAttemptId,
  attemptResultEventName,
  type AttemptResultSignalV1,
} from '../../src/domain/workflow-event.js';
import {
  CloudflareWorkflowEffectClient,
  WorkflowOutboxProcessor,
  type WorkflowEffectClient,
} from '../../src/outbox/workflow-outbox.js';
import { TaskIntakeStore } from '../../src/storage/task-intake-store.js';
import { WorkflowSignalStore } from '../../src/storage/workflow-signal-store.js';
import type { DeliveryRunWorkflowParams } from '../../src/workflows/delivery-run-workflow.js';

const NOW = '2026-07-25T06:00:00.000Z';
const BASE_SHA = 'c'.repeat(40);

function task(taskKey: string): TaskEnvelope {
  return {
    schemaVersion: '1',
    eventId: `event-${taskKey}`,
    occurredAt: NOW,
    source: {
      system: 'manual',
      tenantKey: 'tenant-workflow-outbox',
      taskKey,
      revision: '1',
    },
    actor: { type: 'system', id: 'workflow-outbox-test' },
    target: {
      owner: 'example',
      repo: 'delivery-target',
      baseBranch: 'main',
      environment: 'test',
    },
    intent: {
      kind: 'bug',
      title: 'Deliver workflow outbox once',
      description: 'The durable control workflow must be created idempotently.',
      acceptanceCriteria: ['One Workflow instance exists for the Run.'],
      priority: 'p1',
    },
    policy: {
      allowRepositoryWrite: false,
      allowTestDeploy: false,
      allowProductionDeploy: false,
      requireHumanApproval: true,
    },
  };
}

async function seedRun(taskKey: string, withBaseSha = true): Promise<{
  taskId: string;
  runId: string;
  outboxId: string;
}> {
  return await new TaskIntakeStore(env.DB_CONTROL).acceptTaskRevision({
    task: task(taskKey),
    ...(withBaseSha ? { baseSha: BASE_SHA } : {}),
    payloadRef: `r2://tasks/${taskKey}/1`,
    now: NOW,
  });
}

async function outbox(outboxId: string): Promise<{
  delivery_state: string;
  attempt_count: number;
  last_error_code: string | null;
}> {
  const row = await env.DB_CONTROL.prepare(
    `SELECT delivery_state, attempt_count, last_error_code
     FROM outbox WHERE outbox_id = ?`,
  )
    .bind(outboxId)
    .first<{
      delivery_state: string;
      attempt_count: number;
      last_error_code: string | null;
    }>();
  if (row === null) throw new Error(`missing outbox ${outboxId}`);
  return row;
}

class FakeWorkflowEffects implements WorkflowEffectClient {
  createCalls = 0;
  signalCalls = 0;
  failCreates = 0;
  failSignals = 0;

  async ensureRun(): Promise<'created' | 'existing'> {
    this.createCalls += 1;
    if (this.failCreates > 0) {
      this.failCreates -= 1;
      throw new Error('injected create failure');
    }
    return this.createCalls === 1 ? 'created' : 'existing';
  }

  async terminateRun(): Promise<void> {}

  async sendEvent(): Promise<void> {
    this.signalCalls += 1;
    if (this.failSignals > 0) {
      this.failSignals -= 1;
      throw new Error('injected sendEvent failure');
    }
  }
}

beforeEach(async () => {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM workflow_signals'),
    env.DB_CONTROL.prepare('DELETE FROM idempotency_keys'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
});

describe('Workflow outbox delivery', () => {
  it('lets one of 20 concurrent consumers create the run_id Workflow instance', async () => {
    const seeded = await seedRun('create-concurrent');
    await using instance = await introspectWorkflowInstance(env.DELIVERY_RUN, seeded.runId);
    const processor = new WorkflowOutboxProcessor(
      env.DB_CONTROL,
      new CloudflareWorkflowEffectClient(env.DELIVERY_RUN),
    );

    const deliveries = await Promise.all(
      Array.from({ length: 20 }, () => processor.deliver(seeded.outboxId)),
    );
    expect(deliveries).toContain('settled');
    await instance.waitForStepResult({ name: 'dispatch-analysis-attempt' });
    expect(await outbox(seeded.outboxId)).toEqual({
      delivery_state: 'settled',
      attempt_count: 1,
      last_error_code: null,
    });
    expect(await processor.deliver(seeded.outboxId)).toBe('settled');
    expect((await outbox(seeded.outboxId)).attempt_count).toBe(1);
    expect(
      await env.DB_CONTROL.prepare(
        `SELECT COUNT(*) AS count FROM attempts
         WHERE run_id = ? AND attempt_id = ?`,
      )
        .bind(seeded.runId, analysisAttemptId(seeded.runId))
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });

    const workflow = await env.DELIVERY_RUN.get(seeded.runId);
    expect((await workflow.status()).status).not.toBe('unknown');
    await workflow.terminate();
    await instance.waitForStatus('terminated');
  });

  it('rolls create failure back to pending and replays without deleting Task or Run', async () => {
    const seeded = await seedRun('create-retry');
    const effects = new FakeWorkflowEffects();
    effects.failCreates = 1;
    const processor = new WorkflowOutboxProcessor(env.DB_CONTROL, effects);

    expect(await processor.deliver(seeded.outboxId)).toBe('retry');
    expect(await outbox(seeded.outboxId)).toEqual({
      delivery_state: 'pending',
      attempt_count: 1,
      last_error_code: 'workflow_unavailable',
    });
    expect(
      await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM tasks WHERE task_id = ?')
        .bind(seeded.taskId)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM runs WHERE run_id = ?')
        .bind(seeded.runId)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });

    expect(await processor.deliver(seeded.outboxId)).toBe('settled');
    expect(await outbox(seeded.outboxId)).toEqual({
      delivery_state: 'settled',
      attempt_count: 2,
      last_error_code: null,
    });
    expect(effects.createCalls).toBe(2);
  });

  it('does not create a Workflow before a trusted base SHA is persisted', async () => {
    const seeded = await seedRun('base-sha-blocked', false);
    const effects = new FakeWorkflowEffects();
    const processor = new WorkflowOutboxProcessor(env.DB_CONTROL, effects);

    expect(await processor.deliver(seeded.outboxId)).toBe('retry');
    expect(effects.createCalls).toBe(0);
    expect(await outbox(seeded.outboxId)).toEqual({
      delivery_state: 'pending',
      attempt_count: 1,
      last_error_code: 'base_sha_unresolved',
    });
  });

  it('reclaims an expired delivering lease with a new fencing token', async () => {
    const seeded = await seedRun('expired-lease');
    await env.DB_CONTROL.prepare(
      `UPDATE outbox
       SET delivery_state = 'delivering',
           attempt_count = 1,
           lease_token = 'stale-lease',
           lease_expires_at = '2026-07-25T05:59:00.000Z'
       WHERE outbox_id = ?`,
    )
      .bind(seeded.outboxId)
      .run();
    const effects = new FakeWorkflowEffects();
    const processor = new WorkflowOutboxProcessor(env.DB_CONTROL, effects, {
      now: () => new Date(NOW),
      generateLeaseToken: () => 'fresh-lease',
    });

    expect(await processor.deliver(seeded.outboxId)).toBe('settled');
    expect(effects.createCalls).toBe(1);
    expect(await outbox(seeded.outboxId)).toEqual({
      delivery_state: 'settled',
      attempt_count: 2,
      last_error_code: null,
    });
  });

  it('reconciles an ambiguous create error to the existing Workflow instance', async () => {
    let created = false;
    let createCalls = 0;
    const binding = {
      async create(): Promise<never> {
        createCalls += 1;
        created = true;
        throw new Error('transport failed after create');
      },
      async get(): Promise<{
        status(): Promise<{ status: 'running' | 'unknown' }>;
      }> {
        return {
          async status() {
            return { status: created ? 'running' : 'unknown' };
          },
        };
      },
    } as unknown as Workflow<DeliveryRunWorkflowParams>;
    const client = new CloudflareWorkflowEffectClient(binding);

    expect(
      await client.ensureRun({
        schemaVersion: '1',
        runId: 'run-ambiguous-create',
        taskId: 'task-ambiguous-create',
        taskRevision: '1',
        taskDigest: `sha256:${'5'.repeat(64)}`,
      }),
    ).toBe('existing');
    expect(createCalls).toBe(1);
  });

  it('replays sendEvent failure and settles one signal outbox', async () => {
    const seeded = await seedRun('signal-retry');
    const signal: AttemptResultSignalV1 = {
      schemaVersion: '1',
      eventId: 'event-signal-retry-1',
      runId: seeded.runId,
      type: 'attempt_completed',
      attemptId: analysisAttemptId(seeded.runId),
      sequence: 1,
      payloadRef: 'd1://execution-plans/plan-signal-retry-v1',
      digest: `sha256:${'6'.repeat(64)}`,
      occurredAt: NOW,
    };
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE runs SET state = 'planning', version = 1, updated_at = ?
         WHERE run_id = ? AND state = 'queued' AND version = 0`,
      ).bind(NOW, seeded.runId),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha,
           version, lease_generation, lease_expires_at, heartbeat_at,
           result_event_id, result_sequence, result_payload_ref, result_digest,
           result_reported_at, created_at, updated_at
         ) VALUES (
           ?, ?, 1, 'analysis', 'running', ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )`,
      ).bind(
        signal.attemptId,
        seeded.runId,
        BASE_SHA,
        '2026-07-25T06:02:00.000Z',
        NOW,
        signal.eventId,
        signal.sequence,
        signal.payloadRef,
        signal.digest,
        NOW,
        NOW,
        NOW,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO execution_plans (
           plan_id, run_id, plan_version, task_revision, base_sha, digest,
           status, created_by_attempt_id, objective, created_at, updated_at
         ) VALUES (
           'plan-signal-retry-v1', ?, 1, '1', ?, ?, 'validated', ?,
           'Workflow signal retry fixture', ?, ?
         )`,
      ).bind(
        seeded.runId,
        BASE_SHA,
        signal.digest,
        signal.attemptId,
        NOW,
        NOW,
      ),
    ]);
    const signalOutbox = await new WorkflowSignalStore(env.DB_CONTROL).enqueueAttemptResult(
      signal,
      NOW,
    );
    const effects = new FakeWorkflowEffects();
    effects.failSignals = 1;
    const processor = new WorkflowOutboxProcessor(env.DB_CONTROL, effects);

    expect(await processor.deliver(signalOutbox.outboxId)).toBe('retry');
    expect((await outbox(signalOutbox.outboxId)).delivery_state).toBe('pending');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => processor.deliver(signalOutbox.outboxId)),
    );
    expect(results).toContain('settled');
    expect(await outbox(signalOutbox.outboxId)).toEqual({
      delivery_state: 'settled',
      attempt_count: 2,
      last_error_code: null,
    });
    expect(effects.signalCalls).toBe(2);

    const stored = await env.DB_CONTROL.prepare(
      `SELECT workflow_event_type FROM workflow_signals WHERE signal_id = ?`,
    )
      .bind(signalOutbox.signalId)
      .first<{ workflow_event_type: string }>();
    expect(stored?.workflow_event_type).toBe(attemptResultEventName(signal.attemptId));
  });
});
