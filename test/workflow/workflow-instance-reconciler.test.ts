/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunState } from '../../src/domain/run.js';
import {
  WorkflowInstanceReconciler,
  type WorkflowInstanceFactClient,
  type WorkflowInstancePlatformStatus,
} from '../../src/reconciliation/workflow-instance-reconciler.js';
import {
  WorkflowOutboxProcessor,
  type WorkflowEffectClient,
} from '../../src/outbox/workflow-outbox.js';
import { TaskQueryStore } from '../../src/storage/task-query-store.js';

const NOW = '2026-07-26T08:30:00.000Z';
const DIGEST = `sha256:${'a'.repeat(64)}`;

class FakeStatusClient implements WorkflowInstanceFactClient {
  readonly statuses = new Map<string, WorkflowInstancePlatformStatus>();

  async getWorkflowStatus(runId: string) {
    return { status: this.statuses.get(runId) ?? 'unknown' };
  }
}

class FakeWorkflowEffects implements WorkflowEffectClient {
  readonly ensureRun = vi.fn(async () => 'created' as const);
  readonly terminateRun = vi.fn(async () => {});
  readonly sendEvent = vi.fn(async () => {});
  readonly restartRunForReconciliation = vi.fn(async () => 'restarted' as const);
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM workflow_instance_reconciliation_observations'),
    env.DB_CONTROL.prepare('DELETE FROM workflow_instance_reconciliation_state'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
}

async function seedRun(runId: string, state: RunState, version: number): Promise<void> {
  const taskId = `task-${runId}`;
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'manual', 'workflow-reconciliation', ?, '1', ?, ?, 'system',
                 'workflow-reconciler-test', 'example/repo', 'main', 'none',
                 'bug', 'Workflow reconciliation fixture', 'p1', 1, 0, 0, 0, 1, ?, ?)`,
    ).bind(taskId, taskId, DIGEST, `r2://tasks/${taskId}/1`, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, created_at, updated_at
       ) VALUES (?, ?, '1', ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(runId, taskId, DIGEST, 'b'.repeat(40), runId, state, version, NOW, NOW),
  ]);
}

async function repairOutbox(runId: string): Promise<{
  outbox_id: string;
  kind: string;
  delivery_state: string;
}> {
  const row = await env.DB_CONTROL.prepare(
    `SELECT outbox_id, kind, delivery_state FROM outbox
     WHERE run_id = ? AND kind LIKE 'workflow_reconcile_%'`,
  ).bind(runId).first<{
    outbox_id: string;
    kind: string;
    delivery_state: string;
  }>();
  if (row === null) throw new Error(`missing repair outbox for ${runId}`);
  return row;
}

beforeEach(async () => await reset());

describe('Cloudflare Workflow ↔ D1 Run reconciliation', () => {
  it('repairs the three mismatch directions and leaves consistent pairs untouched', async () => {
    await seedRun('run-restart', 'executing', 7);
    await seedRun('run-recreate', 'queued', 0);
    await seedRun('run-terminate', 'succeeded', 12);
    await seedRun('run-active-ok', 'planning', 1);
    await seedRun('run-terminal-ok', 'failed', 9);
    const client = new FakeStatusClient();
    client.statuses.set('run-restart', 'complete');
    client.statuses.set('run-recreate', 'unknown');
    client.statuses.set('run-terminate', 'running');
    client.statuses.set('run-active-ok', 'waiting');
    client.statuses.set('run-terminal-ok', 'terminated');
    const reconciler = new WorkflowInstanceReconciler(
      env.DB_CONTROL,
      client,
      () => new Date(NOW),
    );

    const results = await reconciler.reconcileBatch(25);
    expect(results).toEqual(expect.arrayContaining([
      { runId: 'run-restart', disposition: 'restart_requested' },
      { runId: 'run-recreate', disposition: 'recreate_requested' },
      { runId: 'run-terminate', disposition: 'terminate_requested' },
      { runId: 'run-active-ok', disposition: 'consistent' },
      { runId: 'run-terminal-ok', disposition: 'consistent' },
    ]));
    expect(await repairOutbox('run-restart')).toMatchObject({
      kind: 'workflow_reconcile_restart',
      delivery_state: 'pending',
    });
    expect(await repairOutbox('run-recreate')).toMatchObject({
      kind: 'workflow_reconcile_create',
      delivery_state: 'pending',
    });
    expect(await repairOutbox('run-terminate')).toMatchObject({
      kind: 'workflow_reconcile_terminate',
      delivery_state: 'pending',
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM workflow_instance_reconciliation_observations',
    ).first()).toEqual({ count: 3 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE kind LIKE 'workflow_reconcile_%'`,
    ).first()).toEqual({ count: 3 });
    const projection = await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus('run-restart');
    expect(projection?.run).toMatchObject({
      workflowInstance: {
        id: 'run-restart',
        runVersion: 7,
        d1State: 'executing',
        platformStatus: 'complete',
        factDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        reconciliations: [{
          action: 'restart_workflow',
          status: 'open',
        }],
      },
    });
    expect(JSON.stringify(projection)).not.toContain('error');
    expect(JSON.stringify(projection)).not.toContain('output');
  });

  it('converges 20 scanners and processors to one audited repair effect', async () => {
    await seedRun('run-concurrent-restart', 'awaiting_review', 4);
    const client = new FakeStatusClient();
    client.statuses.set('run-concurrent-restart', 'errored');
    const reconciler = new WorkflowInstanceReconciler(
      env.DB_CONTROL,
      client,
      () => new Date(NOW),
    );
    const reconciliations = await Promise.all(
      Array.from({ length: 20 }, () => reconciler.reconcileRun('run-concurrent-restart')),
    );
    expect(reconciliations.every((result) =>
      result === 'restart_requested' || result === 'duplicate')).toBe(true);
    const outbox = await repairOutbox('run-concurrent-restart');
    const effects = new FakeWorkflowEffects();
    const processor = new WorkflowOutboxProcessor(env.DB_CONTROL, effects, {
      now: () => new Date(NOW),
      generateLeaseToken: () => crypto.randomUUID(),
    });
    const deliveries = await Promise.all(
      Array.from({ length: 20 }, () => processor.deliver(outbox.outbox_id)),
    );
    expect(deliveries.every((result) => result === 'settled' || result === 'busy')).toBe(true);
    expect(effects.restartRunForReconciliation).toHaveBeenCalledOnce();
    expect(effects.ensureRun).not.toHaveBeenCalled();
    expect(effects.terminateRun).not.toHaveBeenCalled();
    expect(await env.DB_CONTROL.prepare(
      `SELECT repair_observed_at FROM workflow_instance_reconciliation_observations
       WHERE run_id = 'run-concurrent-restart'`,
    ).first()).toEqual({ repair_observed_at: NOW });
    expect(await env.DB_CONTROL.prepare(
      'SELECT delivery_state FROM outbox WHERE outbox_id = ?',
    ).bind(outbox.outbox_id).first()).toEqual({ delivery_state: 'settled' });
    client.statuses.set('run-concurrent-restart', 'waiting');
    await expect(reconciler.reconcileRun('run-concurrent-restart')).resolves.toBe('consistent');
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, resolution_code
       FROM workflow_instance_reconciliation_observations
       WHERE run_id = 'run-concurrent-restart'`,
    ).first()).toEqual({ status: 'resolved', resolution_code: 'workflow_active' });
  });

  it('settles a stale repair without touching Workflow after the D1 Run advances', async () => {
    await seedRun('run-stale-repair', 'executing', 3);
    const client = new FakeStatusClient();
    client.statuses.set('run-stale-repair', 'terminated');
    const reconciler = new WorkflowInstanceReconciler(
      env.DB_CONTROL,
      client,
      () => new Date(NOW),
    );
    expect(await reconciler.reconcileRun('run-stale-repair')).toBe('restart_requested');
    const outbox = await repairOutbox('run-stale-repair');
    await env.DB_CONTROL.prepare(
      `UPDATE runs SET state = 'cancelled', version = 4, updated_at = ? WHERE run_id = ?`,
    ).bind('2026-07-26T08:31:00.000Z', 'run-stale-repair').run();
    const effects = new FakeWorkflowEffects();
    const processor = new WorkflowOutboxProcessor(env.DB_CONTROL, effects, {
      now: () => new Date('2026-07-26T08:31:00.000Z'),
    });

    await expect(processor.deliver(outbox.outbox_id)).resolves.toBe('settled');
    expect(effects.restartRunForReconciliation).not.toHaveBeenCalled();
    expect(effects.ensureRun).not.toHaveBeenCalled();
    expect(effects.terminateRun).not.toHaveBeenCalled();
    expect(await env.DB_CONTROL.prepare(
      'SELECT last_error_code FROM outbox WHERE outbox_id = ?',
    ).bind(outbox.outbox_id).first()).toEqual({
      last_error_code: 'workflow_reconciliation_stale',
    });
  });

  it('executes recreate and terminate only through their original fenced repair intents', async () => {
    await seedRun('run-create-effect', 'queued', 0);
    await seedRun('run-terminate-effect', 'blocked', 6);
    const client = new FakeStatusClient();
    client.statuses.set('run-create-effect', 'unknown');
    client.statuses.set('run-terminate-effect', 'paused');
    const reconciler = new WorkflowInstanceReconciler(
      env.DB_CONTROL,
      client,
      () => new Date(NOW),
    );
    await reconciler.reconcileBatch(25);
    const createOutbox = await repairOutbox('run-create-effect');
    const terminateOutbox = await repairOutbox('run-terminate-effect');
    const effects = new FakeWorkflowEffects();
    const processor = new WorkflowOutboxProcessor(env.DB_CONTROL, effects, {
      now: () => new Date(NOW),
    });

    await expect(processor.deliver(createOutbox.outbox_id)).resolves.toBe('settled');
    await expect(processor.deliver(terminateOutbox.outbox_id)).resolves.toBe('settled');
    expect(effects.ensureRun).toHaveBeenCalledOnce();
    expect(effects.terminateRun).toHaveBeenCalledOnce();
    expect(effects.restartRunForReconciliation).not.toHaveBeenCalled();
    const stored = await env.DB_CONTROL.prepare(
      `SELECT fact_digest, platform_status, d1_state, action, repair_observed_at
       FROM workflow_instance_reconciliation_observations ORDER BY run_id`,
    ).all();
    expect(stored.results).toHaveLength(2);
    expect(JSON.stringify(stored.results)).not.toContain('CANARY');
  });

  it('does not race an explicit controlled replay of a terminal instance', async () => {
    await seedRun('run-controlled-replay', 'awaiting_approval', 2);
    await env.DB_CONTROL.prepare(
      `INSERT INTO outbox (
         outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
         delivery_state, created_at, updated_at
       ) VALUES ('outbox-controlled-replay', 'run-controlled-replay',
                 'workflow_replay', 'cloudflare_workflows',
                 'd1://workflow-replays/replay-controlled',
                 'workflow-replay:controlled', 'pending', ?, ?)`,
    ).bind(NOW, NOW).run();
    const client = new FakeStatusClient();
    client.statuses.set('run-controlled-replay', 'terminated');
    const reconciler = new WorkflowInstanceReconciler(
      env.DB_CONTROL,
      client,
      () => new Date(NOW),
    );

    await expect(reconciler.reconcileRun('run-controlled-replay')).resolves.toBe(
      'controlled_replay_pending',
    );
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE kind LIKE 'workflow_reconcile_%'`,
    ).first()).toEqual({ count: 0 });
  });

  it('uses the durable last-checked cursor so a batch limit cannot starve later Runs', async () => {
    for (let index = 0; index < 30; index += 1) {
      await seedRun(`run-fair-${String(index).padStart(2, '0')}`, 'queued', 0);
    }
    const reconciler = new WorkflowInstanceReconciler(
      env.DB_CONTROL,
      new FakeStatusClient(),
      () => new Date(NOW),
    );

    await reconciler.reconcileBatch(25);
    await reconciler.reconcileBatch(25);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM workflow_instance_reconciliation_state',
    ).first()).toEqual({ count: 30 });
  });
});
