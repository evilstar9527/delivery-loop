/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentCheckpointV1 } from '../../src/domain/checkpoint.js';
import { canonicalSha256 } from '../../src/domain/digest.js';
import {
  WorkflowOutboxProcessor,
  type WorkflowEffectClient,
} from '../../src/outbox/workflow-outbox.js';
import { AgentCheckpointStore } from '../../src/storage/agent-checkpoint-store.js';
import { AttemptStuckDetector } from '../../src/storage/attempt-lifecycle-store.js';
import { AttemptLeaseStore } from '../../src/storage/attempt-lease-store.js';
import { RecoveryAttemptStore } from '../../src/storage/recovery-attempt-store.js';
import { RunnerAttemptStore } from '../../src/storage/runner-attempt-store.js';

const BASE_URL = 'https://delivery-loop.test';
const RUN_ID = 'run-checkpoint-api';
const TASK_ID = 'task-checkpoint-api';
const ANALYSIS_ATTEMPT_ID = 'attempt-checkpoint-analysis';
const ATTEMPT_ID = 'attempt-checkpoint-implement';
const PLAN_ID = 'plan-checkpoint-v1';
const PLAN_ITEM_ID = 'implement-checkpoint';
const RAW_TOKEN = 'runner-checkpoint-token-before-rotation';
const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);
const PLAN_DIGEST = `sha256:${'3'.repeat(64)}`;
const PASSED_ITEM_ID = 'already-passed-item';

class FakeWorkflowEffects implements WorkflowEffectClient {
  readonly terminated: string[] = [];

  async ensureRun(): Promise<'created'> {
    return 'created';
  }

  async sendEvent(): Promise<void> {}

  async terminateRun(runId: string): Promise<void> {
    this.terminated.push(runId);
  }
}

function checkpoint(sequence = 1): AgentCheckpointV1 {
  return {
    schemaVersion: '1',
    sequence,
    provider: 'codex',
    providerSessionRef: 'session/checkpoint-safe-1',
    planVersion: 1,
    planItemId: PLAN_ITEM_ID,
    headBranch: 'agent/task-checkpoint/attempt-checkpoint-implement',
    headSha: HEAD_SHA,
    completedAcceptanceCriteria: ['The checkpoint persistence contract is implemented.'],
    evidenceRefs: ['d1://evidence/evidence-checkpoint-1'],
    summary: `Safe semantic checkpoint ${sequence}.`,
    nextStep: 'Run the focused checkpoint verification suite.',
    workingTreeDigest: `sha256:${'4'.repeat(64)}`,
  };
}

async function putCheckpoint(
  value: unknown,
  options: {
    token?: string;
    expectedVersion?: number;
    leaseGeneration?: number;
  } = {},
): Promise<Response> {
  return await SELF.fetch(`${BASE_URL}/v1/attempts/${ATTEMPT_ID}/checkpoint`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${options.token ?? RAW_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      expectedVersion: options.expectedVersion ?? 1,
      leaseGeneration: options.leaseGeneration ?? 1,
      checkpoint: value,
    }),
  });
}

async function retryRun(planItemId = PLAN_ITEM_ID, expectedRunVersion = 4): Promise<Response> {
  return await SELF.fetch(`${BASE_URL}/v1/runs/${RUN_ID}/retry`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-task-intake-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ expectedRunVersion, planVersion: 1, planItemId }),
  });
}

async function seedCheckpointAttempt(): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
  const taskDigest = `sha256:${'5'.repeat(64)}`;
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (
         ?, 'manual', 'checkpoint-test', 'checkpoint-test', '1', ?,
         'r2://tasks/checkpoint-test', 'system', 'checkpoint-test', 'example/repo',
         'main', 'test', 'requirement', 'Checkpoint contract', 'p1', 1,
         1, 0, 0, 1, ?, ?
       )`,
    ).bind(TASK_ID, taskDigest, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, '1', ?, ?, ?, 'executing', 3, ?, 1, ?, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, taskDigest, BASE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, github_run_id, version, lease_generation,
         created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'completed', ?, 'example/repo',
                 'example/repo/.github/workflows/delivery-agent.yml@refs/heads/main',
                 '300001', 2, 1, ?, ?)`,
    ).bind(ANALYSIS_ATTEMPT_ID, RUN_ID, BASE_SHA, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, '1', ?, ?, 'active', ?, 'Implement checkpoint persistence', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, ANALYSIS_ATTEMPT_ID, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES (?, ?, 'change', 'Persist checkpoints',
                 'Persist semantic recovery checkpoints safely.', 1, 0)`,
    ).bind(PLAN_ID, PLAN_ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES (?, ?, 'verification', 'Completed predecessor',
                 'This completed Item must never be scheduled again.', 1, 1)`,
    ).bind(PLAN_ID, PASSED_ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_dependencies (plan_id, item_id, depends_on_item_id)
       VALUES (?, ?, ?)`,
    ).bind(PLAN_ID, PLAN_ITEM_ID, PASSED_ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, github_run_id, plan_id, plan_version, plan_item_id,
         head_branch, head_sha, version, lease_generation, lease_token_digest,
         lease_expires_at, heartbeat_at, created_at, updated_at
       ) VALUES (?, ?, 2, 'implement', 'running', ?, 'example/repo',
                 'example/repo/.github/workflows/delivery-agent.yml@refs/heads/main',
                 '300002', ?, 1, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      RUN_ID,
      BASE_SHA,
      PLAN_ID,
      PLAN_ITEM_ID,
      checkpoint().headBranch,
      HEAD_SHA,
      `sha256:${'6'.repeat(64)}`,
      expiresAt,
      nowIso,
      nowIso,
      nowIso,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (
         plan_id, item_id, status, active_attempt_id, version, updated_at
       ) VALUES (?, ?, 'in_progress', ?, 2, ?)`,
    ).bind(PLAN_ID, PLAN_ITEM_ID, ATTEMPT_ID, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (
         plan_id, item_id, status, version, updated_at
       ) VALUES (?, ?, 'passed', 4, ?)`,
    ).bind(PLAN_ID, PASSED_ITEM_ID, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest, lease_generation,
         scopes_json, expires_at, created_at
       ) VALUES ('token-checkpoint-api', ?, ?, ?, 1,
                 '["repo:read","checkpoint:write"]', ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      `sha256:${'7'.repeat(64)}`,
      await canonicalSha256(RAW_TOKEN),
      expiresAt,
      nowIso,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, artifact_digest, summary, verification_status,
         observed_at, created_at
       ) VALUES ('evidence-checkpoint-1', ?, ?, ?, 1, ?, 'test', 'passed', ?,
                 'Focused checkpoint test passed.', 'verified', ?, ?)`,
    ).bind(
      RUN_ID,
      ATTEMPT_ID,
      PLAN_ID,
      PLAN_ITEM_ID,
      `sha256:${'8'.repeat(64)}`,
      nowIso,
      nowIso,
    ),
  ]);
}

async function supersedeActivePlan(): Promise<void> {
  const now = new Date().toISOString();
  const nextPlanId = 'plan-checkpoint-v2';
  const nextDigest = `sha256:${'9'.repeat(64)}`;
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `UPDATE execution_plans SET status = 'superseded', updated_at = ? WHERE plan_id = ?`,
    ).bind(now, PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 2, '1', ?, ?, 'active', ?, 'Replacement plan', ?, ?)`,
    ).bind(nextPlanId, RUN_ID, BASE_SHA, nextDigest, ANALYSIS_ATTEMPT_ID, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES (?, ?, 'change', 'Replacement item', 'Use the new plan only.', 1, 0)`,
    ).bind(nextPlanId, PLAN_ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (plan_id, item_id, status, version, updated_at)
       VALUES (?, ?, 'ready', 0, ?)`,
    ).bind(nextPlanId, PLAN_ITEM_ID, now),
    env.DB_CONTROL.prepare(
      `UPDATE runs
       SET active_plan_id = ?, active_plan_version = 2, active_plan_digest = ?,
           version = version + 1, updated_at = ?
       WHERE run_id = ?`,
    ).bind(nextPlanId, nextDigest, now, RUN_ID),
  ]);
}

beforeEach(async () => {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM attempt_revocations'),
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
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM idempotency_keys'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  const objects = await env.CHECKPOINT_OBJECTS.list();
  if (objects.objects.length > 0) {
    await env.CHECKPOINT_OBJECTS.delete(objects.objects.map((object) => object.key));
  }
  await seedCheckpointAttempt();
});

describe('authenticated AgentCheckpoint v1 API', () => {
  it('persists a digest-bound R2 payload and a safe D1 projection, then loads it for recovery', async () => {
    const response = await putCheckpoint(checkpoint());
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      checkpointId: string;
      sequence: number;
      payloadRef: string;
      digest: string;
      created: boolean;
    };
    expect(body).toMatchObject({ sequence: 1, created: true });
    expect(body.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(body.payloadRef).toMatch(/^r2:\/\/checkpoints\//);

    const projection = await env.DB_CONTROL.prepare(
      `SELECT checkpoint_id, attempt_id, sequence, plan_id, plan_version,
              plan_item_id, head_sha, payload_ref, payload_digest, summary, next_step
       FROM checkpoints WHERE attempt_id = ?`,
    )
      .bind(ATTEMPT_ID)
      .first<Record<string, unknown>>();
    expect(projection).toMatchObject({
      checkpoint_id: body.checkpointId,
      attempt_id: ATTEMPT_ID,
      sequence: 1,
      plan_id: PLAN_ID,
      plan_version: 1,
      plan_item_id: PLAN_ITEM_ID,
      head_sha: HEAD_SHA,
      payload_ref: body.payloadRef,
      payload_digest: body.digest,
      summary: checkpoint().summary,
      next_step: checkpoint().nextStep,
    });

    const objectKey = body.payloadRef.slice('r2://'.length);
    const object = await env.CHECKPOINT_OBJECTS.get(objectKey);
    expect(object).not.toBeNull();
    expect(object?.customMetadata).toMatchObject({
      checkpointDigest: body.digest,
      attemptId: ATTEMPT_ID,
      sequence: '1',
    });
    expect(JSON.parse((await object?.text()) ?? '{}')).toEqual(checkpoint());

    const recovery = await new AgentCheckpointStore(
      env.DB_CONTROL,
      env.CHECKPOINT_OBJECTS,
    ).loadLatestForRecovery(RUN_ID, 1, PLAN_ITEM_ID);
    expect(recovery).toMatchObject({
      checkpointId: body.checkpointId,
      attemptId: ATTEMPT_ID,
      digest: body.digest,
      checkpoint: checkpoint(),
    });

    const status = await SELF.fetch(`${BASE_URL}/v1/runs/${RUN_ID}/plan`, {
      headers: { authorization: `Bearer ${env.TASK_INTAKE_TOKEN}` },
    });
    const statusText = await status.text();
    expect(status.status).toBe(200);
    expect(statusText).not.toContain(checkpoint().summary);
    expect(statusText).not.toContain(checkpoint().nextStep);
    expect(statusText).not.toContain(body.payloadRef);
    expect(JSON.parse(statusText)).toMatchObject({
      checkpoints: [
        {
          id: body.checkpointId,
          attemptId: ATTEMPT_ID,
          sequence: 1,
          planId: PLAN_ID,
          planVersion: 1,
          planItemId: PLAN_ITEM_ID,
          headSha: HEAD_SHA,
          payloadDigest: body.digest,
        },
      ],
    });
  });

  it('converges concurrent duplicates and rejects out-of-order or changed sequences', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, async () => await putCheckpoint(checkpoint(1))),
    );
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(19);

    const sequenceThree = await putCheckpoint(checkpoint(3));
    expect(sequenceThree.status).toBe(201);
    expect((await putCheckpoint(checkpoint(2))).status).toBe(409);
    expect((await putCheckpoint(checkpoint(3))).status).toBe(200);
    expect(
      (
        await putCheckpoint({
          ...checkpoint(3),
          summary: 'Changed content cannot replace the same sequence.',
        })
      ).status,
    ).toBe(409);

    const rows = await env.DB_CONTROL.prepare(
      `SELECT sequence FROM checkpoints WHERE attempt_id = ? ORDER BY sequence`,
    )
      .bind(ATTEMPT_ID)
      .all<{ sequence: number }>();
    expect(rows.results).toEqual([{ sequence: 1 }, { sequence: 3 }]);
    expect((await env.CHECKPOINT_OBJECTS.list()).objects).toHaveLength(2);
  });

  it('rejects incomplete, stale, wrongly bound, or old-plan checkpoints', async () => {
    const incomplete = checkpoint() as unknown as Record<string, unknown>;
    delete incomplete.nextStep;
    expect((await putCheckpoint(incomplete)).status).toBe(400);
    expect((await putCheckpoint({ ...checkpoint(), unknown: true })).status).toBe(400);
    expect((await putCheckpoint(checkpoint(), { token: 'wrong-token-value' })).status).toBe(401);
    expect((await putCheckpoint(checkpoint(), { expectedVersion: 2 })).status).toBe(409);
    expect((await putCheckpoint(checkpoint(), { leaseGeneration: 2 })).status).toBe(409);
    expect((await putCheckpoint({ ...checkpoint(), planVersion: 2 })).status).toBe(409);
    expect((await putCheckpoint({ ...checkpoint(), planItemId: 'different-item' })).status).toBe(409);
    expect((await putCheckpoint({ ...checkpoint(), headSha: 'a'.repeat(40) })).status).toBe(409);
    expect(
      (await putCheckpoint({ ...checkpoint(), evidenceRefs: ['d1://evidence/missing'] })).status,
    ).toBe(409);
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM checkpoints').first()).toEqual({
      count: 0,
    });
    expect((await env.CHECKPOINT_OBJECTS.list()).objects).toHaveLength(0);

    const accepted = await putCheckpoint(checkpoint());
    expect(accepted.status).toBe(201);
    await supersedeActivePlan();
    expect((await putCheckpoint(checkpoint(2))).status).toBe(409);
    expect(
      await new AgentCheckpointStore(
        env.DB_CONTROL,
        env.CHECKPOINT_OBJECTS,
      ).loadLatestForRecovery(RUN_ID, 1, PLAN_ITEM_ID),
    ).toBeNull();
  });

  it('requires an explicit checkpoint write scope', async () => {
    await env.DB_CONTROL.prepare(
      `UPDATE attempt_tokens SET scopes_json = '["repo:read"]' WHERE attempt_id = ?`,
    )
      .bind(ATTEMPT_ID)
      .run();
    const response = await putCheckpoint(checkpoint());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'policy_denied' });
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM checkpoints').first()).toEqual({
      count: 0,
    });
    expect((await env.CHECKPOINT_OBJECTS.list()).objects).toHaveLength(0);
  });

  it('rejects an attempt-token canary before D1 or R2 persistence', async () => {
    const response = await putCheckpoint({
      ...checkpoint(),
      summary: `Never persist ${RAW_TOKEN}`,
    });
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(text).not.toContain(RAW_TOKEN);
    expect(JSON.parse(text)).toMatchObject({ code: 'policy_denied' });
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM checkpoints').first()).toEqual({
      count: 0,
    });
    expect((await env.CHECKPOINT_OBJECTS.list()).objects).toHaveLength(0);
  });

  it('rejects every configured Worker Secret, not only the historical partial list', async () => {
    const configuredSecret = env.FEISHU_EVENT_ENCRYPT_KEY;
    if (configuredSecret === undefined) throw new Error('test Feishu Secret is unavailable');
    const response = await putCheckpoint({
      ...checkpoint(),
      summary: `Never persist ${configuredSecret}`,
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(configuredSecret);
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM checkpoints').first()).toEqual({
      count: 0,
    });
    expect((await env.CHECKPOINT_OBJECTS.list()).objects).toHaveLength(0);
  });

  it('fails closed when the published R2 payload no longer matches its digest', async () => {
    const response = await putCheckpoint(checkpoint());
    expect(response.status).toBe(201);
    const body = (await response.json()) as { payloadRef: string; digest: string };
    const objectKey = body.payloadRef.slice('r2://'.length);
    await env.CHECKPOINT_OBJECTS.put(
      objectKey,
      JSON.stringify({ ...checkpoint(), summary: 'tampered' }),
      { customMetadata: { checkpointDigest: body.digest, attemptId: ATTEMPT_ID, sequence: '1' } },
    );
    await expect(
      new AgentCheckpointStore(
        env.DB_CONTROL,
        env.CHECKPOINT_OBJECTS,
      ).loadLatestForRecovery(RUN_ID, 1, PLAN_ITEM_ID),
    ).rejects.toMatchObject({ code: 'payload_conflict' });
  });

  it('recovers a lost Attempt once from its checkpoint and never reschedules a passed Item', async () => {
    expect((await putCheckpoint(checkpoint())).status).toBe(201);
    const detectorNow = new Date(Date.now() + 10 * 60_000);
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE attempts SET lease_expires_at = ?, heartbeat_at = ? WHERE attempt_id = ?`,
      ).bind(
        new Date(detectorNow.getTime() - 60_000).toISOString(),
        new Date(detectorNow.getTime() - 120_000).toISOString(),
        ATTEMPT_ID,
      ),
      env.DB_CONTROL.prepare(
        `UPDATE attempt_tokens SET expires_at = ? WHERE attempt_id = ?`,
      ).bind(new Date(detectorNow.getTime() + 5 * 60_000).toISOString(), ATTEMPT_ID),
    ]);
    const detector = new AttemptStuckDetector(env.DB_CONTROL, { now: () => detectorNow });
    expect(await detector.scan()).toEqual([
      { attemptId: ATTEMPT_ID, runId: RUN_ID, disposition: 'lost' },
    ]);
    await expect(
      new RunnerAttemptStore(env.DB_CONTROL).authorize(ATTEMPT_ID, RAW_TOKEN, detectorNow),
    ).rejects.toMatchObject({ code: 'invalid_token' });

    const recovery = new RecoveryAttemptStore(env.DB_CONTROL, env.CHECKPOINT_OBJECTS);
    await expect(
      recovery.schedule({
        runId: RUN_ID,
        expectedRunVersion: 4,
        planVersion: 1,
        planItemId: PLAN_ITEM_ID,
      }),
    ).rejects.toMatchObject({ code: 'workflow_cancel_pending' });

    const cancelOutbox = await env.DB_CONTROL.prepare(
      `SELECT outbox_id FROM outbox
       WHERE run_id = ? AND kind = 'workflow_cancel' AND delivery_state = 'pending'`,
    )
      .bind(RUN_ID)
      .first<{ outbox_id: string }>();
    const effects = new FakeWorkflowEffects();
    expect(
      await new WorkflowOutboxProcessor(env.DB_CONTROL, effects).deliver(cancelOutbox!.outbox_id),
    ).toBe('settled');
    expect(effects.terminated).toEqual([RUN_ID]);

    const results = await Promise.all(
      Array.from({ length: 20 }, async () => await retryRun()),
    );
    expect(results.every((response) => response.status === 202)).toBe(true);
    const bodies = (await Promise.all(results.map(async (response) => await response.json()))) as Array<{
      attemptId: string;
      runId: string;
      ordinal: number;
      planVersion: number;
      planItemId: string;
      recoveredFromAttemptId: string;
      checkpointId: string;
      checkpointRef: string;
      checkpointDigest: string;
      headBranch?: string;
      headSha: string;
      created: boolean;
    }>;
    expect(bodies.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(bodies.map((result) => result.attemptId)).size).toBe(1);
    const recovered = bodies[0]!;
    expect(recovered).toMatchObject({
      runId: RUN_ID,
      ordinal: 3,
      planVersion: 1,
      planItemId: PLAN_ITEM_ID,
      recoveredFromAttemptId: ATTEMPT_ID,
      headBranch: checkpoint().headBranch,
      headSha: HEAD_SHA,
    });
    const recoveryProjection = await SELF.fetch(`${BASE_URL}/v1/runs/${RUN_ID}/plan`, {
      headers: { authorization: 'Bearer test-task-intake-token' },
    });
    expect(recoveryProjection.status).toBe(200);
    const recoveryView = await recoveryProjection.json<{
      attempts: Array<Record<string, unknown>>;
    }>();
    expect(recoveryView.attempts).toContainEqual(expect.objectContaining({
      id: recovered.attemptId,
      ordinal: 3,
      status: 'pending',
      headBranch: checkpoint().headBranch,
      headSha: HEAD_SHA,
      recovery: {
        recoveredFromAttemptId: ATTEMPT_ID,
        checkpointId: recovered.checkpointId,
      },
    }));
    expect(
      await env.DB_CONTROL.prepare(
        `SELECT state, version FROM runs WHERE run_id = ?`,
      )
        .bind(RUN_ID)
        .first(),
    ).toEqual({ state: 'executing', version: 5 });
    expect(
      await env.DB_CONTROL.prepare(
        `SELECT status, active_attempt_id, version
         FROM plan_item_progress WHERE plan_id = ? AND item_id = ?`,
      )
        .bind(PLAN_ID, PLAN_ITEM_ID)
        .first(),
    ).toEqual({ status: 'in_progress', active_attempt_id: recovered.attemptId, version: 3 });
    expect(
      await env.DB_CONTROL.prepare(
        `SELECT status, version FROM plan_item_progress WHERE plan_id = ? AND item_id = ?`,
      )
        .bind(PLAN_ID, PASSED_ITEM_ID)
        .first(),
    ).toEqual({ status: 'passed', version: 4 });
    expect(
      await env.DB_CONTROL.prepare(
        `SELECT COUNT(*) AS count FROM attempts WHERE plan_id = ? AND plan_item_id = ?`,
      )
        .bind(PLAN_ID, PASSED_ITEM_ID)
        .first(),
    ).toEqual({ count: 0 });

    const passedRetry = await retryRun(PASSED_ITEM_ID, 5);
    expect(passedRetry.status).toBe(409);
    expect(await passedRetry.json()).toMatchObject({ code: 'conflict' });

    const lease = await new AttemptLeaseStore(env.DB_CONTROL, {
      now: () => detectorNow,
      generateLeaseToken: () => 'recovered-attempt-lease-token',
    }).acquireWriteLease(RUN_ID, recovered.attemptId, 0);
    expect(lease).toMatchObject({ acquired: true, attemptId: recovered.attemptId });
    expect(
      await new AgentCheckpointStore(
        env.DB_CONTROL,
        env.CHECKPOINT_OBJECTS,
      ).loadLatestForRecovery(RUN_ID, 1, PLAN_ITEM_ID),
    ).toMatchObject({ checkpoint: checkpoint() });

    if (!lease.acquired) throw new Error('missing recovered Attempt lease');
    const secondDetectorNow = new Date(new Date(lease.leaseExpiresAt).getTime() + 60_000);
    const secondDetector = new AttemptStuckDetector(env.DB_CONTROL, {
      now: () => secondDetectorNow,
    });
    expect(await secondDetector.scan()).toEqual([
      { attemptId: recovered.attemptId, runId: RUN_ID, disposition: 'lost' },
    ]);
    const secondRecovery = await recovery.schedule(
      {
        runId: RUN_ID,
        expectedRunVersion: 6,
        planVersion: 1,
        planItemId: PLAN_ITEM_ID,
      },
      secondDetectorNow,
    );
    expect(secondRecovery).toMatchObject({
      ordinal: 4,
      recoveredFromAttemptId: recovered.attemptId,
      checkpointId: recovered.checkpointId,
      headSha: HEAD_SHA,
      created: true,
    });
    expect(secondRecovery.attemptId).not.toBe(recovered.attemptId);
    expect(
      await env.DB_CONTROL.prepare(
        `SELECT COUNT(*) AS count FROM attempts WHERE plan_id = ? AND plan_item_id = ?`,
      )
        .bind(PLAN_ID, PASSED_ITEM_ID)
        .first(),
    ).toEqual({ count: 0 });
  });
});
