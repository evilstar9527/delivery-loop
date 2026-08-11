/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import type { TaskEnvelope } from '../../src/domain/task.js';
import { safeAutomatedReviewProjection, taskApi } from '../../src/http/task-api.js';

const BASE_URL = 'https://delivery-loop.test';
const TEST_TOKEN = 'test-task-intake-token';
const NOW = '2026-07-25T09:00:00.000Z';
const BASE_SHA = 'd'.repeat(40);
const TASK_CANARY = 'CANARY_PRIVATE_TASK_DESCRIPTION';
const CHECKPOINT_CANARY = 'CANARY_PRIVATE_CHECKPOINT_SUMMARY';
const EVIDENCE_CANARY = 'CANARY_PRIVATE_EVIDENCE_CONTENT';
const PLAN_ASSUMPTION_CANARY = 'CANARY_PRIVATE_PLAN_ASSUMPTION';
const PLAN_EVIDENCE_REF = 'd1://evidence/private-analysis-source-reference';
const RESULT_EVENT_ID = 'event-query-result';
const ACTION_RUN_ID = '940001';
const APP = taskApi({
  baseShaResolverFromEnv: () => ({
    async resolveBaseSha() {
      return BASE_SHA;
    },
  }),
});

function taskEnvelope(taskKey: string): TaskEnvelope {
  return {
    schemaVersion: '1',
    eventId: `event-${taskKey}`,
    occurredAt: NOW,
    source: {
      system: 'manual',
      tenantKey: 'tenant-query-test',
      taskKey,
      revision: '1',
      url: `https://tasks.example.test/${taskKey}`,
    },
    actor: { type: 'user', id: 'user-query-test' },
    target: {
      owner: 'example',
      repo: 'delivery-target',
      baseBranch: 'main',
      environment: 'test',
    },
    intent: {
      kind: 'bug',
      title: 'Expose a safe control-plane status view',
      description: TASK_CANARY,
      acceptanceCriteria: ['Status reads come only from the durable D1 projection.'],
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

async function apiGet(path: string, authenticated = true): Promise<Response> {
  const headers = new Headers();
  if (authenticated) headers.set('authorization', `Bearer ${TEST_TOKEN}`);
  return await APP.request(`${BASE_URL}${path}`, { headers }, env);
}

async function createTask(taskKey: string): Promise<{ taskId: string; runId: string }> {
  const response = await APP.request(`${BASE_URL}/v1/tasks`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      'content-type': 'application/json',
      'idempotency-key': `query-${taskKey}`,
    },
    body: JSON.stringify(taskEnvelope(taskKey)),
  }, env);
  expect(response.status).toBe(202);
  return (await response.json()) as { taskId: string; runId: string };
}

async function seedPlanProjection(runId: string): Promise<void> {
  const attemptId = `attempt-${runId}`;
  const planId = `plan-${runId}`;
  const planDigest = `sha256:${'6'.repeat(64)}`;
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `UPDATE runs
       SET base_sha = ?, state = 'awaiting_approval', version = 2,
           active_plan_id = ?, active_plan_version = 1, active_plan_digest = ?, updated_at = ?
       WHERE run_id = ?`,
    ).bind(BASE_SHA, planId, planDigest, NOW, runId),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, version,
         lease_generation, lease_token_digest, lease_expires_at, heartbeat_at,
         result_event_id, result_sequence, result_payload_ref, result_digest,
         result_reported_at, github_run_id, github_status, github_conclusion,
         github_observed_at, github_external_updated_at, github_observation_version,
         created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'completed', ?, 5, 2, ?, ?, ?, ?, 1, ?, ?, ?,
                 ?, 'completed', 'success', ?, ?, 1, ?, ?)`,
    ).bind(
      attemptId,
      runId,
      BASE_SHA,
      `sha256:${'7'.repeat(64)}`,
      '2026-07-25T09:03:00.000Z',
      '2026-07-25T09:01:30.000Z',
      RESULT_EVENT_ID,
      `d1://execution-plans/${planId}`,
      planDigest,
      '2026-07-25T09:01:45.000Z',
      ACTION_RUN_ID,
      '2026-07-25T09:02:05.000Z',
      '2026-07-25T09:02:00.000Z',
      NOW,
      '2026-07-25T09:02:05.000Z',
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_heartbeat_receipts (
         heartbeat_id, run_id, attempt_id, lease_generation,
         previous_attempt_version, attempt_version, previous_heartbeat_at,
         heartbeat_at, lease_expires_at, created_at
       ) VALUES (?, ?, ?, 2, 2, 3, ?, ?, ?, ?),
                (?, ?, ?, 2, 3, 4, ?, ?, ?, ?)`,
    ).bind(
      `heartbeat-${runId}-3`,
      runId,
      attemptId,
      NOW,
      '2026-07-25T09:00:45.000Z',
      '2026-07-25T09:02:15.000Z',
      '2026-07-25T09:00:45.000Z',
      `heartbeat-${runId}-4`,
      runId,
      attemptId,
      '2026-07-25T09:00:45.000Z',
      '2026-07-25T09:01:30.000Z',
      '2026-07-25T09:03:00.000Z',
      '2026-07-25T09:01:30.000Z',
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, '1', ?, ?, 'active', ?, ?, ?, ?)`,
    ).bind(
      planId,
      runId,
      BASE_SHA,
      planDigest,
      attemptId,
      'Verify the safe status projection.',
      NOW,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plan_assumptions (plan_id, position, assumption)
       VALUES (?, 0, ?)`,
    ).bind(planId, PLAN_ASSUMPTION_CANARY),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plan_evidence_refs (plan_id, position, evidence_ref)
       VALUES (?, 0, ?)`,
    ).bind(planId, PLAN_EVIDENCE_REF),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES (?, 'inspect', 'investigation', 'Inspect projection',
                 'Read only normalized control-plane fields.', 1, 0)`,
    ).bind(planId),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_acceptance_criteria (
         plan_id, item_id, acceptance_criterion_index
       ) VALUES (?, 'inspect', 0)`,
    ).bind(planId),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (plan_id, item_id, status, version, updated_at)
       VALUES (?, 'inspect', 'passed', 4, ?)`,
    ).bind(planId, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_done_when (plan_id, item_id, position, condition)
       VALUES (?, 'inspect', 0, 'Safe status metadata is returned.')`,
    ).bind(planId),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, 'inspect', 'repo_read')`,
    ).bind(planId),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
       VALUES (?, 'inspect', 'policy:status-query')`,
    ).bind(planId),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_evidence_kinds (plan_id, item_id, evidence_kind)
       VALUES (?, 'inspect', 'diagnostic')`,
    ).bind(planId),
    env.DB_CONTROL.prepare(
      `INSERT INTO checkpoints (
         checkpoint_id, attempt_id, sequence, plan_id, plan_version, plan_item_id,
         head_sha, payload_ref, payload_digest, summary, next_step, created_at
       ) VALUES (?, ?, 7, ?, 1, 'inspect', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      `checkpoint-${runId}`,
      attemptId,
      planId,
      BASE_SHA,
      `r2://checkpoints/${attemptId}/7.json`,
      `sha256:${'8'.repeat(64)}`,
      CHECKPOINT_CANARY,
      `${CHECKPOINT_CANARY}-next`,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, command_ref, exit_code, sha, external_url, artifact_ref,
         artifact_digest, summary, verification_status, observed_at, created_at
       ) VALUES (?, ?, ?, ?, 1, 'inspect', 'diagnostic', 'passed',
                 'policy:status-query', 0, ?, ?, ?, ?, ?, 'verified', ?, ?)`,
    ).bind(
      `evidence-${runId}`,
      runId,
      attemptId,
      planId,
      BASE_SHA,
      `https://github.com/example/repo/actions/runs/1?token=${EVIDENCE_CANARY}`,
      `r2://evidence/${EVIDENCE_CANARY}`,
      `sha256:${'9'.repeat(64)}`,
      EVIDENCE_CANARY,
      NOW,
      NOW,
    ),
  ]);
}

beforeEach(async () => {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM attempt_heartbeat_receipts'),
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
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM idempotency_keys'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  const objects = await env.TASK_OBJECTS.list();
  if (objects.objects.length > 0) {
    await env.TASK_OBJECTS.delete(objects.objects.map((object) => object.key));
  }
});

describe('safe Task and ExecutionPlan query API', () => {
  it('returns D1-backed task/run and plan/item/attempt/checkpoint/evidence summaries', async () => {
    const ids = await createTask('safe-query');
    await seedPlanProjection(ids.runId);

    const taskResponse = await apiGet(`/v1/tasks/${ids.taskId}`);
    expect(taskResponse.status).toBe(200);
    const taskText = await taskResponse.text();
    expect(taskText).not.toContain(TASK_CANARY);
    expect(JSON.parse(taskText)).toMatchObject({
      task: {
        id: ids.taskId,
        source: { system: 'manual', taskKey: 'safe-query', revision: '1' },
        target: { repository: 'example/delivery-target', baseBranch: 'main' },
        intent: { kind: 'bug', title: 'Expose a safe control-plane status view' },
      },
      run: {
        id: ids.runId,
        state: 'awaiting_approval',
        version: 2,
        activePlan: { id: `plan-${ids.runId}`, version: 1 },
      },
    });

    const planResponse = await apiGet(`/v1/runs/${ids.runId}/plan`);
    expect(planResponse.status).toBe(200);
    const planText = await planResponse.text();
    expect(planText).not.toContain(TASK_CANARY);
    expect(planText).not.toContain(CHECKPOINT_CANARY);
    expect(planText).not.toContain(EVIDENCE_CANARY);
    expect(planText).not.toContain(PLAN_ASSUMPTION_CANARY);
    expect(planText).not.toContain(PLAN_EVIDENCE_REF);
    expect(planText).not.toContain(`sha256:${'7'.repeat(64)}`);
    expect(JSON.parse(planText)).toMatchObject({
      run: { id: ids.runId, state: 'awaiting_approval', version: 2 },
      plan: {
        id: `plan-${ids.runId}`,
        version: 1,
        status: 'active',
        assumptionCount: 1,
        evidenceRefCount: 1,
        evidenceRefsDigest: await canonicalSha256([PLAN_EVIDENCE_REF]),
      },
      items: [
        {
          id: 'inspect',
          status: 'passed',
          progressVersion: 4,
          acceptanceCriteriaIndexes: [0],
          doneWhen: ['Safe status metadata is returned.'],
          effects: ['repo_read'],
          commandRefs: ['policy:status-query'],
          evidenceKinds: ['diagnostic'],
        },
      ],
      attempts: [
        {
          id: `attempt-${ids.runId}`,
          mode: 'analysis',
          status: 'completed',
          version: 5,
          leaseGeneration: 2,
          heartbeatAt: '2026-07-25T09:01:30.000Z',
          result: {
            eventId: RESULT_EVENT_ID,
            sequence: 1,
            payloadRef: `d1://execution-plans/plan-${ids.runId}`,
            digest: `sha256:${'6'.repeat(64)}`,
            reportedAt: '2026-07-25T09:01:45.000Z',
          },
          githubRunId: ACTION_RUN_ID,
          githubStatus: 'completed',
          githubConclusion: 'success',
          githubObservedAt: '2026-07-25T09:02:05.000Z',
          githubExternalUpdatedAt: '2026-07-25T09:02:00.000Z',
          githubObservationVersion: 1,
        },
      ],
      heartbeats: [
        {
          id: `heartbeat-${ids.runId}-3`,
          attemptId: `attempt-${ids.runId}`,
          leaseGeneration: 2,
          previousVersion: 2,
          version: 3,
          previousHeartbeatAt: NOW,
          heartbeatAt: '2026-07-25T09:00:45.000Z',
          leaseExpiresAt: '2026-07-25T09:02:15.000Z',
        },
        {
          id: `heartbeat-${ids.runId}-4`,
          previousVersion: 3,
          version: 4,
          previousHeartbeatAt: '2026-07-25T09:00:45.000Z',
          heartbeatAt: '2026-07-25T09:01:30.000Z',
          leaseExpiresAt: '2026-07-25T09:03:00.000Z',
        },
      ],
      checkpoints: [
        {
          id: `checkpoint-${ids.runId}`,
          sequence: 7,
          payloadDigest: `sha256:${'8'.repeat(64)}`,
        },
      ],
      evidence: [
        {
          id: `evidence-${ids.runId}`,
          kind: 'diagnostic',
          status: 'passed',
          commandRef: 'policy:status-query',
          verificationStatus: 'verified',
          url: 'https://github.com/example/repo/actions/runs/1',
        },
      ],
    });
  });

  it('returns a stable empty-plan view for a queued Run', async () => {
    const ids = await createTask('empty-plan');
    const response = await apiGet(`/v1/runs/${ids.runId}/plan`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      run: { id: ids.runId, state: 'queued', version: 0 },
      plan: null,
      items: [],
      attempts: [],
      heartbeats: [],
      checkpoints: [],
      evidence: [],
    });
    expect(body).not.toHaveProperty('automatedReview');
  });

  it('projects only safe automated-review status fields', () => {
    expect(safeAutomatedReviewProjection(undefined)).toBeUndefined();
    expect(safeAutomatedReviewProjection(null)).toBeUndefined();
    expect(safeAutomatedReviewProjection({ iteration: 1, status: 'pending' })).toEqual({
      iteration: 1,
      status: 'pending',
    });
    expect(safeAutomatedReviewProjection({
      iteration: 2,
      status: 'approved',
      blockingFindingCount: 0,
      minorFindingCount: 1,
      summary: 'CANARY_PRIVATE_REVIEW_SUMMARY',
      findingBody: 'CANARY_PRIVATE_FINDING_BODY',
      artifactRef: 'r2://private-review',
    })).toEqual({
      iteration: 2,
      status: 'approved',
      blockingFindingCount: 0,
      minorFindingCount: 1,
    });
    expect(safeAutomatedReviewProjection({ iteration: 3, status: 'changes_requested' })).toEqual({
      iteration: 3,
      status: 'changes_requested',
    });
    expect(safeAutomatedReviewProjection({
      iteration: 3,
      status: 'blocked',
      blockingFindingCount: 2,
      minorFindingCount: 3,
    })).toEqual({
      iteration: 3,
      status: 'blocked',
      blockingFindingCount: 2,
      minorFindingCount: 3,
    });
    expect(safeAutomatedReviewProjection({ iteration: 4, status: 'approved' })).toBeUndefined();
  });

  it('fails closed for unauthenticated, invalid, and missing resources', async () => {
    expect((await apiGet('/v1/tasks/task-missing', false)).status).toBe(401);
    expect((await apiGet('/v1/runs/run-missing/plan', false)).status).toBe(401);

    const invalid = await apiGet('/v1/tasks/not%20a%20safe%20id');
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: 'invalid_argument' });

    const missingTask = await apiGet('/v1/tasks/task-missing');
    expect(missingTask.status).toBe(404);
    expect(await missingTask.json()).toMatchObject({ code: 'not_found' });
    const missingRun = await apiGet('/v1/runs/run-missing/plan');
    expect(missingRun.status).toBe(404);
    expect(await missingRun.json()).toMatchObject({ code: 'not_found' });
  });
});
