/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { taskRevisionDigest, taskRevisionIds, type TaskEnvelope } from '../../src/domain/task.js';
import {
  AnalysisAttemptContextStore,
} from '../../src/storage/analysis-attempt-store.js';
import {
  SupplementalContextRevisionStore,
} from '../../src/storage/supplemental-context-revision-store.js';
import type { RunnerAuthorization } from '../../src/storage/runner-attempt-store.js';

const PRIOR_TASK_ID = 'task-supplemental-prior';
const CURRENT_RUN_ID = 'run-supplemental-current';
const OLD_PLAN_ID = 'plan-supplemental-v1';
const OLD_ANALYSIS_ATTEMPT_ID = 'attempt-supplemental-analysis-v1';
const ACTIVE_ATTEMPT_ID = 'attempt-supplemental-active-v1';
const BASE_SHA = 'a'.repeat(40);
const OLD_PLAN_DIGEST = `sha256:${'b'.repeat(64)}`;
const NOW = '2026-07-26T01:00:00.000Z';
const CONTEXT_BODY = 'The failing request is limited to archived records with an empty owner field.';

function task(revision: string, eventId: string, description: string): TaskEnvelope {
  return {
    schemaVersion: '1',
    eventId,
    occurredAt: NOW,
    source: {
      system: 'feishu',
      tenantKey: 'tenant-supplemental',
      taskKey: 'work-item-42',
      revision,
      url: 'https://tasks.example.test/work-item-42',
    },
    actor: { type: 'user', id: 'user-supplemental' },
    target: {
      owner: 'example',
      repo: 'delivery-target',
      baseBranch: 'main',
      environment: 'test',
    },
    intent: {
      kind: 'bug',
      title: 'Archived records fail to load',
      description,
      acceptanceCriteria: ['Archived and active records both load without an owner.'],
      priority: 'p1',
    },
    policy: {
      allowRepositoryWrite: true,
      allowTestDeploy: false,
      allowProductionDeploy: false,
      requireHumanApproval: true,
    },
  };
}

function nextTask(): TaskEnvelope {
  return task('revision-2', 'event-supplemental-2', 'Investigate the newly narrowed failure case.');
}

function defaultInput(): Record<string, unknown> {
  return {
    schemaVersion: '1',
    priorTaskId: PRIOR_TASK_ID,
    task: nextTask(),
    context: CONTEXT_BODY,
    applyToCurrentRun: false,
  };
}

function applyCurrentInput(): Record<string, unknown> {
  return {
    schemaVersion: '1',
    priorTaskId: PRIOR_TASK_ID,
    task: nextTask(),
    context: CONTEXT_BODY,
    applyToCurrentRun: true,
    currentRun: {
      runId: CURRENT_RUN_ID,
      expectedRunVersion: 10,
      taskRevision: 'revision-1',
      planVersion: 1,
      planDigest: OLD_PLAN_DIGEST,
      baseSha: BASE_SHA,
    },
  };
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM supplemental_context_revisions'),
    env.DB_CONTROL.prepare('DELETE FROM approval_invalidations'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revisions'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revision_source_facts'),
    env.DB_CONTROL.prepare('DELETE FROM github_write_credentials'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
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
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  const objects = await env.TASK_OBJECTS.list();
  if (objects.objects.length > 0) {
    await env.TASK_OBJECTS.delete(objects.objects.map((object) => object.key));
  }
}

async function seedCurrentRun(): Promise<void> {
  const prior = task('revision-1', 'event-supplemental-1', 'Find the cause of the archived record failure.');
  const taskDigest = await taskRevisionDigest(prior);
  const payloadKey = `tasks/${PRIOR_TASK_ID}/${taskDigest.slice('sha256:'.length)}.json`;
  await env.TASK_OBJECTS.put(payloadKey, JSON.stringify(prior), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { taskDigest },
  });
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision, source_url,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'feishu', 'tenant-supplemental', 'work-item-42', 'revision-1',
                 'https://tasks.example.test/work-item-42', ?, ?, 'user',
                 'user-supplemental', 'example/delivery-target', 'main', 'test', 'bug',
                 'Archived records fail to load', 'p1', 1, 1, 0, 0, 1, ?, ?)`,
    ).bind(PRIOR_TASK_ID, taskDigest, `r2://${payloadKey}`, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha, workflow_instance_id,
         state, version, active_plan_id, active_plan_version, active_plan_digest,
         created_at, updated_at
       ) VALUES (?, ?, 'revision-1', ?, ?, ?, 'executing', 10, ?, 1, ?, ?, ?)`,
    ).bind(
      CURRENT_RUN_ID,
      PRIOR_TASK_ID,
      taskDigest,
      BASE_SHA,
      CURRENT_RUN_ID,
      OLD_PLAN_ID,
      OLD_PLAN_DIGEST,
      NOW,
      NOW,
    ),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'completed', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 1, 1, ?, ?)`,
    ).bind(OLD_ANALYSIS_ATTEMPT_ID, CURRENT_RUN_ID, BASE_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, 'revision-1', ?, ?, 'active', ?,
                 'Execute the approved plan before supplemental context arrived.', ?, ?)`,
    ).bind(
      OLD_PLAN_ID,
      CURRENT_RUN_ID,
      BASE_SHA,
      OLD_PLAN_DIGEST,
      OLD_ANALYSIS_ATTEMPT_ID,
      NOW,
      NOW,
    ),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, version, lease_generation,
         lease_token_digest, lease_expires_at, created_at, updated_at
       ) VALUES (?, ?, 2, 'implement', 'running', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 ?, 1, 3, 2, ?, '2099-01-01T00:00:00.000Z', ?, ?)`,
    ).bind(
      ACTIVE_ATTEMPT_ID,
      CURRENT_RUN_ID,
      BASE_SHA,
      OLD_PLAN_ID,
      `sha256:${'c'.repeat(64)}`,
      NOW,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest, tool_token_digest,
         lease_generation, scopes_json, expires_at, created_at
       ) VALUES ('token-supplemental-active', ?, ?, ?, ?, 2,
                 '["repo:read","checkpoint:write"]', '2099-01-01T00:00:00.000Z', ?)`,
    ).bind(
      ACTIVE_ATTEMPT_ID,
      `sha256:${'d'.repeat(64)}`,
      `sha256:${'e'.repeat(64)}`,
      `sha256:${'f'.repeat(64)}`,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-supplemental-v1', ?, 'revision-1', ?, 1, ?, ?,
                 'repo_write', 'user:approver', 'approve', ?,
                 '2099-01-01T00:00:00.000Z', ?)`,
    ).bind(
      CURRENT_RUN_ID,
      OLD_PLAN_ID,
      OLD_PLAN_DIGEST,
      BASE_SHA,
      `sha256:${'1'.repeat(64)}`,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO outbox (
         outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
         delivery_state, created_at, updated_at
       ) VALUES ('dispatch-supplemental-old', ?, 'execution_dispatch',
                 'github_actions', ?, 'execution:supplemental-old', 'pending', ?, ?)`,
    ).bind(CURRENT_RUN_ID, `d1://attempts/${ACTIVE_ATTEMPT_ID}`, NOW, NOW),
  ]);
}

beforeEach(async () => {
  await reset();
  await seedCurrentRun();
});

describe('immutable supplemental Task revisions', () => {
  it('wires the strict internal context endpoint without accepting caller source/effect fields', async () => {
    const body = structuredClone(defaultInput());
    delete body.priorTaskId;
    const request = async (value: unknown): Promise<Response> => await SELF.fetch(
      `https://delivery-loop.test/v1/runs/${CURRENT_RUN_ID}/context`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-task-intake-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(value),
      },
    );
    const first = await request(body);
    expect(first.status).toBe(202);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const result = await first.json() as { taskId: string; runId: string; created: boolean };
    expect(result.created).toBe(true);
    expect(first.headers.get('location')).toBe(`/v1/tasks/${result.taskId}`);
    expect((await request(body)).status).toBe(200);

    const injected = await request({
      ...body,
      sourceRef: 'r2://caller/forged.json',
      effects: ['production_deploy'],
    });
    expect(injected.status).toBe(400);
    expect(await injected.json()).toMatchObject({ code: 'invalid_argument' });
    const secret = await request({ ...body, context: 'copied test-task-intake-token' });
    expect(secret.status).toBe(403);
    expect(await secret.text()).not.toContain('test-task-intake-token');
  });

  it('converges 20 default deliveries to one queued revision without changing the current Run', async () => {
    const store = new SupplementalContextRevisionStore(env.DB_CONTROL, env.TASK_OBJECTS);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.accept(defaultInput(), new Date(NOW))),
    );
    const first = results[0];
    if (first === undefined) throw new Error('missing supplemental result');
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.contextId))).toEqual(new Set([first.contextId]));
    expect(new Set(results.map((result) => result.taskId))).toEqual(new Set([first.taskId]));
    expect(new Set(results.map((result) => result.runId))).toEqual(new Set([first.runId]));
    expect(first.disposition).toBe('queued');

    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version, active_plan_id FROM runs WHERE run_id = ?',
    ).bind(CURRENT_RUN_ID).first()).toEqual({
      state: 'executing',
      version: 10,
      active_plan_id: OLD_PLAN_ID,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, version, lease_generation, lease_token_digest
       FROM attempts WHERE attempt_id = ?`,
    ).bind(ACTIVE_ATTEMPT_ID).first()).toEqual({
      status: 'running',
      version: 3,
      lease_generation: 2,
      lease_token_digest: `sha256:${'c'.repeat(64)}`,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT revoked_at FROM attempt_tokens WHERE attempt_id = ?',
    ).bind(ACTIVE_ATTEMPT_ID).first()).toEqual({ revoked_at: null });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM approval_invalidations',
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM plan_revisions',
    ).first()).toEqual({ count: 0 });

    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(first.runId).first()).toEqual({ state: 'queued', version: 0 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state, last_error_code FROM outbox
       WHERE run_id = ? AND kind = 'workflow_create'`,
    ).bind(first.runId).first()).toEqual({ delivery_state: 'pending', last_error_code: null });
    const lineage = await env.DB_CONTROL.prepare(
      `SELECT prior_task_id, new_task_id, new_run_id, context_ref, context_digest,
              apply_to_current_run, applied_run_id
       FROM supplemental_context_revisions`,
    ).first<Record<string, unknown>>();
    expect(lineage).toMatchObject({
      prior_task_id: PRIOR_TASK_ID,
      new_task_id: first.taskId,
      new_run_id: first.runId,
      apply_to_current_run: 0,
      applied_run_id: null,
    });
    expect(JSON.stringify(lineage)).not.toContain(CONTEXT_BODY);
    expect((await env.TASK_OBJECTS.list({ prefix: 'supplemental-context/' })).objects).toHaveLength(1);
    expect((await SELF.fetch(
      `https://delivery-loop.test/v1/operations/supplemental-context/evidence` +
        `?contextId=${first.contextId}`,
    )).status).toBe(401);
    expect((await SELF.fetch(
      `https://delivery-loop.test/v1/operations/supplemental-context/evidence` +
        `?contextId=${first.contextId}&extra=1`,
      { headers: { authorization: 'Bearer test-operations-token' } },
    )).status).toBe(400);
    const evidenceResponse = await SELF.fetch(
      `https://delivery-loop.test/v1/operations/supplemental-context/evidence` +
        `?contextId=${first.contextId}`,
      { headers: { authorization: 'Bearer test-operations-token' } },
    );
    expect(evidenceResponse.status).toBe(200);
    expect(evidenceResponse.headers.get('cache-control')).toBe('no-store');
    const evidence = await evidenceResponse.json() as Record<string, unknown>;
    expect(evidence).toMatchObject({
      schemaVersion: '1',
      contextId: first.contextId,
      lineage: {
        priorTaskId: PRIOR_TASK_ID,
        newTaskId: first.taskId,
        newRunId: first.runId,
        mode: 'new_run',
      },
      objects: { contextVerified: true, newTaskVerified: true },
      newRun: { state: 'queued', version: 0 },
      workflowCreate: { deliveryState: 'pending', lastErrorCode: null },
      currentRunSnapshot: null,
      planRevision: null,
      attempts: [],
      counts: {
        contextRevisions: 1,
        newTasks: 1,
        newRuns: 1,
        workflowCreates: 1,
        planRevisions: 0,
      },
    });
    expect(JSON.stringify(evidence)).not.toContain(CONTEXT_BODY);
    expect(JSON.stringify(evidence)).not.toContain('r2://');
    expect(JSON.stringify(evidence)).not.toContain('user-supplemental');
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state FROM outbox WHERE outbox_id = 'dispatch-supplemental-old'`,
    ).first()).toEqual({ delivery_state: 'pending' });
    await expect(env.DB_CONTROL.prepare(
      `UPDATE supplemental_context_revisions SET context_digest = ? WHERE context_id = ?`,
    ).bind(`sha256:${'7'.repeat(64)}`, first.contextId).run()).rejects.toThrow(
      'supplemental_context_revision_is_immutable',
    );

    const newAnalysisAttemptId = 'attempt-supplemental-new-revision-analysis';
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE runs SET state = 'planning', version = 1, updated_at = ?
         WHERE run_id = ? AND state = 'queued' AND version = 0`,
      ).bind(NOW, first.runId),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, version, lease_generation, lease_token_digest,
           lease_expires_at, created_at, updated_at
         ) VALUES (?, ?, 1, 'analysis', 'running', ?, 'example/delivery-target',
                   'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                   1, 1, ?, '2099-01-01T00:00:00.000Z', ?, ?)`,
      ).bind(
        newAnalysisAttemptId,
        first.runId,
        BASE_SHA,
        `sha256:${'6'.repeat(64)}`,
        NOW,
        NOW,
      ),
    ]);
    const newContext = await new AnalysisAttemptContextStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).get({
      attemptId: newAnalysisAttemptId,
      runId: first.runId,
      mode: 'analysis',
      status: 'running',
      version: 1,
      leaseGeneration: 1,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      scopes: ['repo:read'],
    });
    expect(newContext.task.source.revision).toBe('revision-2');
    expect(newContext.revisionSource).toMatchObject({
      kind: 'supplemental_context',
      data: { body: CONTEXT_BODY },
    });
  });

  it('atomically absorbs the new Run and replans the exact current Run only when explicitly bound', async () => {
    const store = new SupplementalContextRevisionStore(env.DB_CONTROL, env.TASK_OBJECTS);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.accept(applyCurrentInput(), new Date(NOW))),
    );
    const first = results[0];
    if (first === undefined || first.planRevision === undefined) {
      throw new Error('missing applied supplemental result');
    }
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.every((result) => result.disposition === 'applied_to_current')).toBe(true);
    expect(new Set(results.map((result) => result.planRevision?.revisionId))).toEqual(
      new Set([first.planRevision.revisionId]),
    );
    const replayed = await store.accept(applyCurrentInput(), new Date(NOW));
    expect(replayed).toMatchObject({
      contextId: first.contextId,
      taskId: first.taskId,
      runId: first.runId,
      disposition: 'applied_to_current',
      created: false,
      planRevision: { revisionId: first.planRevision.revisionId, created: false },
    });

    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(first.runId).first()).toEqual({ state: 'cancelled', version: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state, last_error_code FROM outbox
       WHERE run_id = ? AND kind = 'workflow_create'`,
    ).bind(first.runId).first()).toEqual({
      delivery_state: 'settled',
      last_error_code: 'supplemental_context_absorbed',
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version, base_sha FROM runs WHERE run_id = ?',
    ).bind(CURRENT_RUN_ID).first()).toEqual({ state: 'planning', version: 11, base_sha: BASE_SHA });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM plan_revision_source_facts',
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM plan_revisions',
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, version, lease_generation, lease_token_digest
       FROM attempts WHERE attempt_id = ?`,
    ).bind(ACTIVE_ATTEMPT_ID).first()).toEqual({
      status: 'cancelled',
      version: 4,
      lease_generation: 3,
      lease_token_digest: null,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT revoked_at IS NOT NULL AS revoked FROM attempt_tokens WHERE attempt_id = ?',
    ).bind(ACTIVE_ATTEMPT_ID).first()).toEqual({ revoked: 1 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM approval_invalidations',
    ).first()).toEqual({ count: 1 });

    const evidenceResponse = await SELF.fetch(
      `https://delivery-loop.test/v1/operations/supplemental-context/evidence` +
        `?contextId=${first.contextId}`,
      { headers: { authorization: 'Bearer test-operations-token' } },
    );
    expect(evidenceResponse.status).toBe(200);
    const evidence = await evidenceResponse.json() as Record<string, unknown>;
    expect(evidence).toMatchObject({
      contextId: first.contextId,
      lineage: { mode: 'apply_current' },
      objects: { contextVerified: true, newTaskVerified: true },
      newRun: { state: 'cancelled', version: 1 },
      workflowCreate: {
        deliveryState: 'settled',
        lastErrorCode: 'supplemental_context_absorbed',
      },
      currentRunSnapshot: { runId: CURRENT_RUN_ID, state: 'planning', version: 11 },
      planRevision: {
        revisionId: first.planRevision.revisionId,
        expectedRunVersion: 10,
        analysisAttemptId: first.planRevision.analysisAttemptId,
        status: 'analyzing',
        analysisAttemptStatus: 'pending',
        priorApprovalCount: 1,
        approvalInvalidationCount: 1,
      },
      counts: { planRevisions: 1 },
    });
    expect(evidence).toMatchObject({
      attempts: [expect.objectContaining({
        attemptId: ACTIVE_ATTEMPT_ID,
        status: 'cancelled',
        tokenCount: 1,
        revokedTokenCount: 1,
      })],
    });
    expect(JSON.stringify(evidence)).not.toContain(CONTEXT_BODY);
    expect(JSON.stringify(evidence)).not.toContain('r2://');

    const analysisAttemptId = first.planRevision.analysisAttemptId;
    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'running', version = 1, lease_generation = 1,
                           lease_token_digest = ?, lease_expires_at = ?, updated_at = ?
       WHERE attempt_id = ? AND status = 'pending'`,
    ).bind(
      `sha256:${'2'.repeat(64)}`,
      '2099-01-01T00:00:00.000Z',
      NOW,
      analysisAttemptId,
    ).run();
    const authorization: RunnerAuthorization = {
      attemptId: analysisAttemptId,
      runId: CURRENT_RUN_ID,
      mode: 'analysis',
      status: 'running',
      version: 1,
      leaseGeneration: 1,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      scopes: ['repo:read'],
    };
    const context = await new AnalysisAttemptContextStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).get(authorization);
    expect(context.revisionSource).toMatchObject({
      schemaVersion: '1',
      kind: 'supplemental_context',
      data: {
        source: {
          system: 'feishu',
          tenantKey: 'tenant-supplemental',
          taskKey: 'work-item-42',
          priorRevision: 'revision-1',
          revision: 'revision-2',
        },
        body: CONTEXT_BODY,
        taskRevision: {
          task: { source: { revision: 'revision-2' } },
        },
      },
    });

    const source = await env.DB_CONTROL.prepare(
      'SELECT context_ref FROM supplemental_context_revisions',
    ).first<{ context_ref: string }>();
    if (source === null) throw new Error('missing supplemental source');
    const key = source.context_ref.slice('r2://'.length);
    await env.TASK_OBJECTS.put(key, JSON.stringify({ schemaVersion: '1', body: 'tampered' }));
    await expect(
      new AnalysisAttemptContextStore(env.DB_CONTROL, env.TASK_OBJECTS).get(authorization),
    ).rejects.toMatchObject({
      code: 'revision_source_conflict',
    });
  });

  it('rejects secrets, stale/expanded bindings, policy changes, and a second child revision', async () => {
    const store = new SupplementalContextRevisionStore(env.DB_CONTROL, env.TASK_OBJECTS, {
      secrets: ['configured-supplemental-secret'],
    });
    await expect(store.accept({
      ...defaultInput(),
      context: 'copied configured-supplemental-secret',
    }, new Date(NOW))).rejects.toMatchObject({
      code: 'secret_detected',
    });
    await expect(store.accept({
      ...applyCurrentInput(),
      sourceRef: 'r2://caller/forged.json',
      plan: { effects: ['repo_write'] },
    }, new Date(NOW))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    const nestedInjection = nextTask() as TaskEnvelope & {
      policy: TaskEnvelope['policy'] & { effects: string[] };
    };
    nestedInjection.policy.effects = ['production_deploy'];
    await expect(store.accept({
      ...defaultInput(),
      task: nestedInjection,
    }, new Date(NOW))).rejects.toMatchObject({ code: 'invalid_request' });
    const stale = applyCurrentInput();
    stale.currentRun = {
      ...(stale.currentRun as Record<string, unknown>),
      expectedRunVersion: 9,
    };
    await expect(store.accept(stale, new Date(NOW))).rejects.toMatchObject({
      code: 'state_conflict',
    });
    const widened = nextTask();
    widened.policy = { ...widened.policy, allowProductionDeploy: true };
    await expect(store.accept({
      ...defaultInput(),
      task: widened,
    }, new Date(NOW))).rejects.toMatchObject({
      code: 'revision_conflict',
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM supplemental_context_revisions',
    ).first()).toEqual({ count: 0 });

    const accepted = await store.accept(defaultInput(), new Date(NOW));
    await expect(store.accept({
      ...defaultInput(),
      context: 'Mutated context under the already stored source revision.',
    }, new Date(NOW))).rejects.toMatchObject({ code: 'state_conflict' });
    const third = task('revision-3', 'event-supplemental-3', 'Another branch from the stale revision.');
    await expect(store.accept({
      ...defaultInput(),
      task: third,
      context: 'A second concurrent context from the stale prior revision.',
    }, new Date(NOW))).rejects.toMatchObject({
      code: 'state_conflict',
    });
    const expectedIds = await taskRevisionIds(nextTask());
    expect(accepted.taskId).toBe(expectedIds.taskId);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM supplemental_context_revisions',
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM tasks',
    ).first()).toEqual({ count: 2 });
  });
});
