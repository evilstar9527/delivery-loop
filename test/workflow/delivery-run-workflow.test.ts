/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, introspectWorkflowInstance } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  computeExecutionPlanDigest,
  type ExecutionPlanBodyV1,
  type ExecutionPlanV1,
} from '../../src/domain/plan.js';
import {
  analysisAttemptId,
  type AttemptResultSignalV1,
} from '../../src/domain/workflow-event.js';
import {
  CloudflareWorkflowEffectClient,
  WorkflowOutboxProcessor,
} from '../../src/outbox/workflow-outbox.js';
import {
  ExecutionPlanPersistenceError,
  ExecutionPlanStore,
} from '../../src/storage/execution-plan-store.js';
import { RunStore } from '../../src/storage/run-store.js';
import { WorkflowSignalStore } from '../../src/storage/workflow-signal-store.js';
import type { DeliveryRunWorkflowParams } from '../../src/workflows/delivery-run-workflow.js';

const NOW = '2026-07-25T00:00:00.000Z';
const TASK_DIGEST = `sha256:${'1'.repeat(64)}`;
const BASE_SHA = 'a'.repeat(40);

function immutablePlanBody(plan: ExecutionPlanV1): ExecutionPlanBodyV1 {
  return {
    schemaVersion: plan.schemaVersion,
    id: plan.id,
    runId: plan.runId,
    version: plan.version,
    taskRevision: plan.taskRevision,
    baseSha: plan.baseSha,
    createdByAttemptId: plan.createdByAttemptId,
    objective: plan.objective,
    assumptions: plan.assumptions,
    evidenceRefs: plan.evidenceRefs,
    items: plan.items,
  };
}

async function seedQueuedRun(params: DeliveryRunWorkflowParams): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (
         ?, 'manual', 'test', ?, ?, ?, 'r2://tasks/workflow-test', 'system', 'workflow-test',
         'example/repo', 'main', 'test', 'bug', 'Workflow test task', 'p1',
         1, 0, 0, 0, 1, ?, ?
       )`,
    ).bind(
      params.taskId,
      params.taskId,
      params.taskRevision,
      params.taskDigest,
      NOW,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha, workflow_instance_id,
         state, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
    ).bind(
      params.runId,
      params.taskId,
      params.taskRevision,
      params.taskDigest,
      BASE_SHA,
      params.runId,
      NOW,
      NOW,
    ),
  ]);
}

async function seedValidatedPlan(
  runId: string,
  attemptId: string,
  planId: string,
): Promise<ExecutionPlanV1> {
  const body: ExecutionPlanBodyV1 = {
    schemaVersion: '1',
    id: planId,
    runId,
    version: 1,
    taskRevision: 'rev-1',
    baseSha: BASE_SHA,
    createdByAttemptId: attemptId,
    objective: 'Diagnose the task without granting write effects.',
    assumptions: ['The repository snapshot matches the analysis attempt.'],
    evidenceRefs: ['d1://evidence/diagnostic-workflow-1'],
    items: [
      {
        id: 'summarize',
        kind: 'verification',
        title: 'Verify the diagnosis',
        objective: 'Check the diagnosis against the trusted snapshot.',
        acceptanceCriteriaIndexes: [0],
        doneWhen: ['The diagnosis is consistent with the trusted repository snapshot.'],
        verification: {
          commandRefs: ['policy:diagnose'],
          evidenceKinds: ['diagnostic'],
        },
        effects: ['repo_read'],
        dependsOn: ['investigate'],
        required: true,
      },
      {
        id: 'investigate',
        kind: 'investigation',
        title: 'Confirm the cause',
        objective: 'Record a source-backed diagnosis.',
        acceptanceCriteriaIndexes: [0],
        doneWhen: ['The diagnosis has a referenced Evidence record.'],
        verification: {
          commandRefs: ['policy:diagnose'],
          evidenceKinds: ['diagnostic'],
        },
        effects: ['repo_read'],
        dependsOn: [],
        required: true,
      },
    ],
  };
  const proposal: ExecutionPlanV1 = {
    ...body,
    digest: await computeExecutionPlanDigest(body),
    status: 'proposed',
  };
  return await new ExecutionPlanStore(env.DB_CONTROL).saveValidatedProposal(
    proposal,
    {
      runId,
      taskRevision: 'rev-1',
      baseSha: BASE_SHA,
      expectedVersion: 1,
      acceptanceCriteriaCount: 1,
      allowedCommandRefs: ['policy:diagnose'],
      allowedEffects: ['repo_read'],
      requiresRepositoryChange: false,
    },
    NOW,
  );
}

async function scalarCount(sql: string, value: string): Promise<number> {
  const row = await env.DB_CONTROL.prepare(sql)
    .bind(value)
    .first<{ count: number }>();
  if (row === null) throw new Error('count query returned no row');
  return row.count;
}

async function restartFromAnalysisWait(runId: string): Promise<void> {
  const workflow = await env.DELIVERY_RUN.get(runId);
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await workflow.restart({
        from: { name: 'await-analysis-result', type: 'waitForEvent' },
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

describe('DeliveryRunWorkflow durable analysis handoff', () => {
  it('reuses successful steps across restart and activates a D1-backed plan once', async () => {
    const runId = '019f96f7-3e5d-72b0-a4de-aa56d7306343';
    const taskId = 'task-workflow-restart';
    const attemptId = analysisAttemptId(runId);
    const planId = 'plan-workflow-restart-v1';
    const params: DeliveryRunWorkflowParams = {
      schemaVersion: '1',
      runId,
      taskId,
      taskRevision: 'rev-1',
      taskDigest: TASK_DIGEST,
    };
    await seedQueuedRun(params);

    // Watt's test isolation rule: the introspector must always be disposed.
    await using instance = await introspectWorkflowInstance(env.DELIVERY_RUN, runId);
    await env.DELIVERY_RUN.create({ id: runId, params });

    const dispatch = (await instance.waitForStepResult({
      name: 'dispatch-analysis-attempt',
    })) as { attemptId: string; outboxId: string; payloadRef: string };
    expect(dispatch).toEqual({
      attemptId,
      outboxId: `dispatch-${attemptId}`,
      payloadRef: `d1://attempts/${attemptId}`,
    });

    const store = new RunStore(env.DB_CONTROL);
    const waitingProjection = await store.getRun(runId);
    expect(waitingProjection).toMatchObject({
      runId,
      workflowInstanceId: runId,
      state: 'planning',
      version: 1,
      baseSha: BASE_SHA,
    });
    expect(
      await scalarCount('SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?', runId),
    ).toBe(1);
    expect(
      await scalarCount('SELECT COUNT(*) AS count FROM outbox WHERE run_id = ?', runId),
    ).toBe(1);

    const plan = await seedValidatedPlan(runId, attemptId, planId);
    expect(plan.status).toBe('validated');
    const planStore = new ExecutionPlanStore(env.DB_CONTROL);
    const idempotent = await planStore.saveValidatedProposal(
      { ...plan, status: 'proposed' },
      {
        runId,
        taskRevision: 'rev-1',
        baseSha: BASE_SHA,
        expectedVersion: 1,
        acceptanceCriteriaCount: 1,
        allowedCommandRefs: ['policy:diagnose'],
        allowedEffects: ['repo_read'],
        requiresRepositoryChange: false,
      },
      NOW,
    );
    expect(idempotent.status).toBe('validated');

    const conflictingBody = immutablePlanBody(plan);
    conflictingBody.objective = 'Silently replace the immutable plan body.';
    const conflictingProposal: ExecutionPlanV1 = {
      ...conflictingBody,
      digest: await computeExecutionPlanDigest(conflictingBody),
      status: 'proposed',
    };
    await expect(
      planStore.saveValidatedProposal(
        conflictingProposal,
        {
          runId,
          taskRevision: 'rev-1',
          baseSha: BASE_SHA,
          expectedVersion: 1,
          acceptanceCriteriaCount: 1,
          allowedCommandRefs: ['policy:diagnose'],
          allowedEffects: ['repo_read'],
          requiresRepositoryChange: false,
        },
        NOW,
      ),
    ).rejects.toMatchObject({
      name: ExecutionPlanPersistenceError.name,
      code: 'plan_conflict',
    });
    expect(
      await scalarCount('SELECT COUNT(*) AS count FROM plan_items WHERE plan_id = ?', planId),
    ).toBe(2);
    expect(
      await scalarCount(
        'SELECT COUNT(*) AS count FROM plan_item_done_when WHERE plan_id = ?',
        planId,
      ),
    ).toBe(2);
    expect(
      await scalarCount(
        'SELECT COUNT(*) AS count FROM plan_item_evidence_kinds WHERE plan_id = ?',
        planId,
      ),
    ).toBe(2);
    expect(
      await scalarCount(
        'SELECT COUNT(*) AS count FROM plan_item_dependencies WHERE plan_id = ?',
        planId,
      ),
    ).toBe(1);

    // Restart at the waiter: register/dispatch are before the target and must stay cached.
    await restartFromAnalysisWait(runId);
    expect(
      await scalarCount('SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?', runId),
    ).toBe(1);
    expect(
      await scalarCount('SELECT COUNT(*) AS count FROM outbox WHERE run_id = ?', runId),
    ).toBe(1);
    expect((await store.getRun(runId))?.version).toBe(1);

    const signal: AttemptResultSignalV1 = {
      schemaVersion: '1',
      eventId: 'event-analysis-completed-1',
      runId,
      type: 'attempt_completed',
      attemptId,
      sequence: 1,
      payloadRef: `d1://execution-plans/${planId}`,
      digest: plan.digest,
      occurredAt: '2026-07-25T00:01:00.000Z',
    };
    await env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET status = 'running', version = 1, lease_generation = 1,
           lease_expires_at = ?, heartbeat_at = ?,
           result_event_id = ?, result_sequence = ?, result_payload_ref = ?,
           result_digest = ?, result_reported_at = ?, updated_at = ?
       WHERE attempt_id = ? AND run_id = ? AND status = 'pending'`,
    )
      .bind(
        '2026-07-25T00:02:30.000Z',
        signal.occurredAt,
        signal.eventId,
        signal.sequence,
        signal.payloadRef,
        signal.digest,
        signal.occurredAt,
        signal.occurredAt,
        attemptId,
        runId,
      )
      .run();
    const signalOutbox = await new WorkflowSignalStore(env.DB_CONTROL).enqueueAttemptResult(
      signal,
      '2026-07-25T00:01:00.000Z',
    );
    const signalDelivery = await new WorkflowOutboxProcessor(
      env.DB_CONTROL,
      new CloudflareWorkflowEffectClient(env.DELIVERY_RUN),
    ).deliver(signalOutbox.outboxId);
    expect(signalDelivery).toBe('settled');

    expect(await instance.waitForStepResult({ name: 'activate-analysis-plan' })).toEqual({
      runId,
      state: 'awaiting_approval',
      activePlanId: planId,
      activePlanVersion: 1,
      activePlanDigest: plan.digest,
    });
    const workflowStatus = (await (await env.DELIVERY_RUN.get(runId)).status()).status;
    expect(['queued', 'running', 'paused', 'waiting', 'waitingForPause']).toContain(
      workflowStatus,
    );
    expect(await store.getRun(runId)).toMatchObject({
      runId,
      workflowInstanceId: runId,
      state: 'awaiting_approval',
      version: 2,
      activePlanId: planId,
      activePlanVersion: 1,
      activePlanDigest: plan.digest,
    });
    expect(
      await scalarCount('SELECT COUNT(*) AS count FROM outbox WHERE run_id = ?', runId),
    ).toBe(2);
    const attempt = await env.DB_CONTROL.prepare(
      'SELECT status FROM attempts WHERE attempt_id = ?',
    )
      .bind(attemptId)
      .first<{ status: string }>();
    expect(attempt?.status).toBe('completed');
    const persistedPlan = await env.DB_CONTROL.prepare(
      'SELECT status FROM execution_plans WHERE plan_id = ?',
    )
      .bind(planId)
      .first<{ status: string }>();
    expect(persistedPlan?.status).toBe('active');
    await (await env.DELIVERY_RUN.get(runId)).terminate();
    await instance.waitForStatus('terminated');
  });
});
