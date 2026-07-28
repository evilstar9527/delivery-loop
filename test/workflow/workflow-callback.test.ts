/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, introspectWorkflowInstance } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  analysisAttemptId,
  type AttemptResultSignalV1,
} from '../../src/domain/workflow-event.js';
import {
  CloudflareWorkflowEffectClient,
  WorkflowOutboxProcessor,
  type WorkflowEffectClient,
} from '../../src/outbox/workflow-outbox.js';
import {
  AttemptLifecycleStore,
  AttemptStuckDetector,
} from '../../src/storage/attempt-lifecycle-store.js';
import {
  WorkflowSignalConflictError,
  WorkflowSignalStore,
} from '../../src/storage/workflow-signal-store.js';
import type { DeliveryRunWorkflowParams } from '../../src/workflows/delivery-run-workflow.js';

const NOW = new Date('2026-07-25T10:00:00.000Z');
const BASE_SHA = '9'.repeat(40);

interface SeededCallback {
  runId: string;
  taskId: string;
  attemptId: string;
  planId: string;
  signal: AttemptResultSignalV1;
}

async function clearDatabase(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM attempt_revocations'),
    env.DB_CONTROL.prepare('DELETE FROM github_api_observations'),
    env.DB_CONTROL.prepare('DELETE FROM github_webhook_deliveries'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
    env.DB_CONTROL.prepare('DELETE FROM checkpoints'),
    env.DB_CONTROL.prepare('DELETE FROM workflow_signals'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_external_facts'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_evidence_kinds'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_command_refs'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_effects'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_dependencies'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_done_when'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_acceptance_criteria'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_progress'),
    env.DB_CONTROL.prepare('DELETE FROM plan_items'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plan_evidence_refs'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plan_assumptions'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plans'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM idempotency_keys'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
}

async function seedTaskAndRun(
  label: string,
  state: 'queued' | 'planning' = 'planning',
): Promise<SeededCallback> {
  const taskId = `task-callback-${label}`;
  const runId = `run-callback-${label}`;
  const attemptId = analysisAttemptId(runId);
  const planId = `plan-callback-${label}-v1`;
  const digest = `sha256:${label.charCodeAt(0).toString(16).padStart(2, '0').repeat(32)}`;
  const nowIso = NOW.toISOString();
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (
         ?, 'manual', 'callback-test', ?, '1', ?, ?, 'system', 'callback-test',
         'example/repo', 'main', 'none', 'bug', 'Workflow callback test', 'p1',
         1, 0, 0, 0, 1, ?, ?
       )`,
    ).bind(
      taskId,
      taskId,
      `sha256:${'1'.repeat(64)}`,
      `r2://tasks/${taskId}`,
      nowIso,
      nowIso,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, created_at, updated_at
       ) VALUES (?, ?, '1', ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      runId,
      taskId,
      `sha256:${'1'.repeat(64)}`,
      BASE_SHA,
      runId,
      state,
      state === 'queued' ? 0 : 1,
      nowIso,
      nowIso,
    ),
  ]);
  if (state === 'planning') {
    await env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, lease_expires_at,
         heartbeat_at, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'running', ?, 'example/repo', ?, 1, 1, ?, ?, ?, ?)`,
    )
      .bind(
        attemptId,
        runId,
        BASE_SHA,
        'example/repo/.github/workflows/delivery-agent.yml@refs/heads/main',
        new Date(NOW.getTime() + 90_000).toISOString(),
        nowIso,
        nowIso,
        nowIso,
      )
      .run();
  }
  return {
    runId,
    taskId,
    attemptId,
    planId,
    signal: {
      schemaVersion: '1',
      eventId: `delivery-callback-${label}-1`,
      runId,
      type: 'attempt_completed',
      attemptId,
      sequence: 1,
      payloadRef: `d1://execution-plans/${planId}`,
      digest,
      occurredAt: nowIso,
    },
  };
}

async function acceptResult(callback: SeededCallback): Promise<void> {
  const nowIso = NOW.toISOString();
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest,
         status, created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, '1', ?, ?, 'validated', ?, 'Callback plan', ?, ?)`,
    ).bind(
      callback.planId,
      callback.runId,
      BASE_SHA,
      callback.signal.digest,
      callback.attemptId,
      nowIso,
      nowIso,
    ),
    env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET result_event_id = ?, result_sequence = ?, result_payload_ref = ?,
           result_digest = ?, result_reported_at = ?, updated_at = ?
       WHERE attempt_id = ? AND run_id = ? AND status = 'running'`,
    ).bind(
      callback.signal.eventId,
      callback.signal.sequence,
      callback.signal.payloadRef,
      callback.signal.digest,
      nowIso,
      nowIso,
      callback.attemptId,
      callback.runId,
    ),
  ]);
}

async function outbox(outboxId: string): Promise<{
  delivery_state: string;
  attempt_count: number;
  lease_token: string | null;
  last_error_code: string | null;
}> {
  const row = await env.DB_CONTROL.prepare(
    `SELECT delivery_state, attempt_count, lease_token, last_error_code
     FROM outbox WHERE outbox_id = ?`,
  )
    .bind(outboxId)
    .first<{
      delivery_state: string;
      attempt_count: number;
      lease_token: string | null;
      last_error_code: string | null;
    }>();
  if (row === null) throw new Error('callback outbox missing');
  return row;
}

class BlockingWorkflowEffects implements WorkflowEffectClient {
  readonly started: Promise<void>;
  signalCalls = 0;
  private readonly markStarted: () => void;
  private readonly waitForRelease: Promise<void>;
  private readonly markReleased: () => void;

  constructor() {
    let started!: () => void;
    let released!: () => void;
    this.started = new Promise<void>((resolve) => {
      started = resolve;
    });
    this.waitForRelease = new Promise<void>((resolve) => {
      released = resolve;
    });
    this.markStarted = started;
    this.markReleased = released;
  }

  async ensureRun(): Promise<'existing'> {
    return 'existing';
  }

  async terminateRun(): Promise<void> {}

  async sendEvent(): Promise<void> {
    this.signalCalls += 1;
    this.markStarted();
    await this.waitForRelease;
  }

  release(): void {
    this.markReleased();
  }
}

class CountingWorkflowEffects implements WorkflowEffectClient {
  signalCalls = 0;

  async ensureRun(): Promise<'existing'> {
    return 'existing';
  }

  async terminateRun(): Promise<void> {}

  async sendEvent(): Promise<void> {
    this.signalCalls += 1;
  }
}

class AmbiguousWorkflowEffects implements WorkflowEffectClient {
  signalCalls = 0;

  constructor(private readonly delegate: CloudflareWorkflowEffectClient) {}

  async ensureRun(params: DeliveryRunWorkflowParams): Promise<'created' | 'existing'> {
    return await this.delegate.ensureRun(params);
  }

  async terminateRun(runId: string): Promise<void> {
    await this.delegate.terminateRun(runId);
  }

  async sendEvent(
    runId: string,
    workflowEventType: string,
    payload: AttemptResultSignalV1,
  ): Promise<void> {
    this.signalCalls += 1;
    await this.delegate.sendEvent(runId, workflowEventType, payload);
    if (this.signalCalls === 1) throw new Error('injected ambiguous sendEvent result');
  }
}

beforeEach(async () => {
  await clearDatabase();
});

describe('Workflow callback delivery fencing', () => {
  it('deduplicates one immutable delivery and visibly transitions pending to delivering to settled', async () => {
    const callback = await seedTaskAndRun('dedupe');
    await acceptResult(callback);
    const store = new WorkflowSignalStore(env.DB_CONTROL);
    const refs = await Promise.all(
      Array.from({ length: 20 }, async () =>
        await store.enqueueAttemptResult(callback.signal, NOW.toISOString()),
      ),
    );
    expect(new Set(refs.map((ref) => ref.signalId)).size).toBe(1);
    expect(new Set(refs.map((ref) => ref.outboxId)).size).toBe(1);
    expect(
      await env.DB_CONTROL.prepare(
        'SELECT COUNT(*) AS count FROM workflow_signals WHERE run_id = ?',
      )
        .bind(callback.runId)
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB_CONTROL.prepare(
        `SELECT COUNT(*) AS count FROM outbox
         WHERE run_id = ? AND kind = 'workflow_signal'`,
      )
        .bind(callback.runId)
        .first(),
    ).toEqual({ count: 1 });
    await expect(
      store.enqueueAttemptResult(
        { ...callback.signal, sequence: 2 },
        NOW.toISOString(),
      ),
    ).rejects.toBeInstanceOf(WorkflowSignalConflictError);

    const effects = new BlockingWorkflowEffects();
    const processor = new WorkflowOutboxProcessor(env.DB_CONTROL, effects);
    const delivery = processor.deliver(refs[0]!.outboxId);
    await effects.started;
    expect(await outbox(refs[0]!.outboxId)).toMatchObject({
      delivery_state: 'delivering',
      attempt_count: 1,
    });
    expect((await outbox(refs[0]!.outboxId)).lease_token).toBeTruthy();
    effects.release();
    expect(await delivery).toBe('settled');
    expect(await outbox(refs[0]!.outboxId)).toEqual({
      delivery_state: 'settled',
      attempt_count: 1,
      lease_token: null,
      last_error_code: null,
    });
    expect(effects.signalCalls).toBe(1);
  });

  it('reconciles an ambiguous sendEvent without advancing the Run twice', async () => {
    const callback = await seedTaskAndRun('ambiguous', 'queued');
    const params: DeliveryRunWorkflowParams = {
      schemaVersion: '1',
      runId: callback.runId,
      taskId: callback.taskId,
      taskRevision: '1',
      taskDigest: `sha256:${'1'.repeat(64)}`,
    };
    await using instance = await introspectWorkflowInstance(env.DELIVERY_RUN, callback.runId);
    await env.DELIVERY_RUN.create({ id: callback.runId, params });
    await instance.waitForStepResult({ name: 'dispatch-analysis-attempt' });
    await env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET status = 'running', version = 1, lease_generation = 1,
           lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
       WHERE attempt_id = ?`,
    )
      .bind(
        new Date(NOW.getTime() + 90_000).toISOString(),
        NOW.toISOString(),
        NOW.toISOString(),
        callback.attemptId,
      )
      .run();
    await acceptResult(callback);
    const ref = await new WorkflowSignalStore(env.DB_CONTROL).enqueueAttemptResult(
      callback.signal,
      NOW.toISOString(),
    );
    const effects = new AmbiguousWorkflowEffects(
      new CloudflareWorkflowEffectClient(env.DELIVERY_RUN),
    );
    const processor = new WorkflowOutboxProcessor(env.DB_CONTROL, effects);

    expect(await processor.deliver(ref.outboxId)).toBe('retry');
    expect(await outbox(ref.outboxId)).toMatchObject({
      delivery_state: 'pending',
      attempt_count: 1,
      last_error_code: 'workflow_unavailable',
    });
    await instance.waitForStepResult({ name: 'activate-analysis-plan' });
    expect(['queued', 'running', 'paused', 'waiting', 'waitingForPause']).toContain(
      (await (await env.DELIVERY_RUN.get(callback.runId)).status()).status,
    );
    expect(await processor.deliver(ref.outboxId)).toBe('settled');
    expect(await outbox(ref.outboxId)).toEqual({
      delivery_state: 'settled',
      attempt_count: 2,
      lease_token: null,
      last_error_code: 'already_applied',
    });
    expect(effects.signalCalls).toBe(1);
    expect(
      await env.DB_CONTROL.prepare(
        'SELECT state, version, active_plan_id FROM runs WHERE run_id = ?',
      )
        .bind(callback.runId)
        .first(),
    ).toEqual({ state: 'awaiting_approval', version: 2, active_plan_id: callback.planId });
    await (await env.DELIVERY_RUN.get(callback.runId)).terminate();
    await instance.waitForStatus('terminated');
  });

  it('settles a callback queued before cancellation without signaling the old Workflow', async () => {
    const callback = await seedTaskAndRun('cancelled');
    const ref = await new WorkflowSignalStore(env.DB_CONTROL).enqueueAttemptResult(
      callback.signal,
      NOW.toISOString(),
    );
    await new AttemptLifecycleStore(env.DB_CONTROL).cancelRun(callback.runId, 1, NOW);
    const effects = new CountingWorkflowEffects();
    const result = await new WorkflowOutboxProcessor(env.DB_CONTROL, effects).deliver(ref.outboxId);

    expect(result).toBe('settled');
    expect(await outbox(ref.outboxId)).toEqual({
      delivery_state: 'settled',
      attempt_count: 1,
      lease_token: null,
      last_error_code: 'run_cancelled',
    });
    expect(effects.signalCalls).toBe(0);
    expect(
      await env.DB_CONTROL.prepare('SELECT state, version FROM runs WHERE run_id = ?')
        .bind(callback.runId)
        .first(),
    ).toEqual({ state: 'cancelled', version: 2 });
  });

  it('settles a result arriving after heartbeat timeout without reviving the lost Attempt', async () => {
    const callback = await seedTaskAndRun('timeout');
    const detectorNow = new Date(NOW.getTime() + 10 * 60_000);
    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET lease_expires_at = ?, heartbeat_at = ? WHERE attempt_id = ?`,
    )
      .bind(
        new Date(detectorNow.getTime() - 60_000).toISOString(),
        new Date(detectorNow.getTime() - 120_000).toISOString(),
        callback.attemptId,
      )
      .run();
    expect(
      await new AttemptStuckDetector(env.DB_CONTROL, { now: () => detectorNow }).scan(),
    ).toEqual([{ attemptId: callback.attemptId, runId: callback.runId, disposition: 'lost' }]);
    const ref = await new WorkflowSignalStore(env.DB_CONTROL).enqueueAttemptResult(
      callback.signal,
      detectorNow.toISOString(),
    );
    const effects = new CountingWorkflowEffects();
    const result = await new WorkflowOutboxProcessor(env.DB_CONTROL, effects).deliver(ref.outboxId);

    expect(result).toBe('settled');
    expect(await outbox(ref.outboxId)).toEqual({
      delivery_state: 'settled',
      attempt_count: 1,
      lease_token: null,
      last_error_code: 'attempt_lost',
    });
    expect(effects.signalCalls).toBe(0);
    expect(
      await env.DB_CONTROL.prepare('SELECT state, version FROM runs WHERE run_id = ?')
        .bind(callback.runId)
        .first(),
    ).toEqual({ state: 'blocked', version: 2 });
    expect(
      await env.DB_CONTROL.prepare(
        'SELECT status, version, lease_generation FROM attempts WHERE attempt_id = ?',
      )
        .bind(callback.attemptId)
        .first(),
    ).toEqual({ status: 'lost', version: 2, lease_generation: 2 });
  });
});
