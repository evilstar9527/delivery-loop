/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import { taskRevisionDigest, type TaskEnvelope } from '../../src/domain/task.js';
import { EXECUTION_TOOL_ACTIONS } from '../../src/domain/tool-bridge.js';

const BASE_URL = 'https://delivery-loop.test';
const NOW = new Date('2026-07-25T14:00:00.000Z');
const TASK_ID = 'task-execution-context';
const RUN_ID = 'run-execution-context';
const ATTEMPT_ID = 'attempt-execution-context';
const PLAN_ID = 'plan-execution-context';
const ITEM_ID = 'repair-and-verify';
const BASE_SHA = '1'.repeat(40);
const CHECKOUT_SHA = '2'.repeat(40);
const HEAD_SHA = '3'.repeat(40);
const PLAN_DIGEST = `sha256:${'4'.repeat(64)}`;
const RAW_TOKEN = 'execution-context-runner-token';
const BRANCH = `agent/${TASK_ID}/${ATTEMPT_ID}`;

function taskEnvelope(): TaskEnvelope {
  return {
    schemaVersion: '1',
    eventId: 'event-execution-context',
    occurredAt: NOW.toISOString(),
    source: {
      system: 'manual',
      tenantKey: 'execution-context',
      taskKey: TASK_ID,
      revision: 'revision-1',
    },
    actor: { type: 'user', id: 'execution-context-user' },
    target: {
      owner: 'example',
      repo: 'delivery-target',
      baseBranch: 'main',
      environment: 'test',
    },
    intent: {
      kind: 'bug',
      title: 'Repair a failed verification',
      description: 'The targeted test failed on the current execution head.',
      acceptanceCriteria: ['The trusted targeted and required verification commands pass.'],
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

async function fetchAttempt(
  path: string,
  options: { token?: string; method?: string; body?: unknown } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return await SELF.fetch(`${BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM verification_suite_commands'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suites'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_head_updates'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
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
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  const objects = await env.TASK_OBJECTS.list();
  if (objects.objects.length > 0) {
    await env.TASK_OBJECTS.delete(objects.objects.map((object) => object.key));
  }
}

async function seed(): Promise<void> {
  const task = taskEnvelope();
  const taskDigest = await taskRevisionDigest(task);
  const key = `tasks/${TASK_ID}/${taskDigest.slice('sha256:'.length)}.json`;
  const now = NOW.toISOString();
  const expiresAt = '2099-01-01T00:00:00.000Z';
  await env.TASK_OBJECTS.put(key, JSON.stringify(task), {
    customMetadata: { taskDigest },
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'manual', 'execution-context', ?, 'revision-1', ?, ?, 'user',
                 'execution-context-user', 'example/delivery-target', 'main', 'test',
                 'bug', 'Repair a failed verification', 'p1', 1, 1, 0, 0, 1, ?, ?)`,
    ).bind(TASK_ID, TASK_ID, taskDigest, `r2://${key}`, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, 'revision-1', ?, ?, ?, 'executing', 5, ?, 1, ?, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, taskDigest, BASE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, github_run_id, plan_id, plan_version, plan_item_id,
         claimed_progress_version, head_sha, version, lease_generation,
         lease_expires_at, heartbeat_at, created_at, updated_at
       ) VALUES (?, ?, 1, 'implement', 'running', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 '9001', ?, 1, ?, 1, ?, 2, 1, ?, ?, ?, ?)`,
    ).bind(ATTEMPT_ID, RUN_ID, BASE_SHA, PLAN_ID, ITEM_ID, CHECKOUT_SHA, expiresAt, now, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, 'revision-1', ?, ?, 'active', ?,
                 'Repair and verify the approved change.', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, ATTEMPT_ID, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest, tool_token_digest,
         lease_generation, scopes_json, expires_at, created_at
       ) VALUES ('token-execution-context', ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      `sha256:${'5'.repeat(64)}`,
      await canonicalSha256(RAW_TOKEN),
      `sha256:${'6'.repeat(64)}`,
      JSON.stringify(EXECUTION_TOOL_ACTIONS),
      expiresAt,
      now,
    ),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES (?, ?, 'change', 'Repair and verify',
               'Apply the smallest fix and execute trusted verification.', 1, 0)`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_done_when (plan_id, item_id, position, condition)
       VALUES (?, ?, 0, 'Targeted and required verification pass on the new head.')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
       VALUES (?, ?, 'test:unit')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
       VALUES (?, ?, 'verify:all')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_evidence_kinds (plan_id, item_id, evidence_kind)
       VALUES (?, ?, 'test')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, ?, 'repo_write')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (
         plan_id, item_id, status, active_attempt_id, version, updated_at
       ) VALUES (?, ?, 'in_progress', ?, 2, ?)`,
    ).bind(PLAN_ID, ITEM_ID, ATTEMPT_ID, now),
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('execution Attempt context and head API', () => {
  it('uses the frozen base as checkout for an initial implement Attempt without a head', async () => {
    await env.DB_CONTROL.prepare(
      'UPDATE attempts SET head_sha = NULL WHERE attempt_id = ?',
    ).bind(ATTEMPT_ID).run();

    const response = await fetchAttempt(`/v1/attempts/${ATTEMPT_ID}/context`, {
      token: RAW_TOKEN,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      attempt: {
        id: ATTEMPT_ID,
        mode: 'implement',
        baseSha: BASE_SHA,
        checkoutSha: BASE_SHA,
        targetBranch: BRANCH,
        targetBranchMode: 'new',
      },
    });
  });

  it('records the first bot head from the frozen base when implement has no prior head', async () => {
    await env.DB_CONTROL.prepare(
      'UPDATE attempts SET head_sha = NULL WHERE attempt_id = ?',
    ).bind(ATTEMPT_ID).run();

    const wrongParent = await fetchAttempt(`/v1/attempts/${ATTEMPT_ID}/head`, {
      method: 'POST',
      token: RAW_TOKEN,
      body: {
        expectedVersion: 2,
        leaseGeneration: 1,
        parentSha: CHECKOUT_SHA,
        headSha: HEAD_SHA,
        branch: BRANCH,
      },
    });
    expect(wrongParent.status).toBe(409);

    const responses = await Promise.all(Array.from({ length: 20 }, async () =>
      await fetchAttempt(`/v1/attempts/${ATTEMPT_ID}/head`, {
        method: 'POST',
        token: RAW_TOKEN,
        body: {
          expectedVersion: 2,
          leaseGeneration: 1,
          parentSha: BASE_SHA,
          headSha: HEAD_SHA,
          branch: BRANCH,
        },
      })));

    expect(responses.every((response) => response.status === 200 || response.status === 201))
      .toBe(true);
    const results = await Promise.all(responses.map(async (response) => await response.json<{
      created: boolean;
      version: number;
      leaseGeneration: number;
      parentSha: string;
      headSha: string;
      branch: string;
    }>()));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.every((result) =>
      result.version === 3 &&
      result.leaseGeneration === 1 &&
      result.parentSha === BASE_SHA &&
      result.headSha === HEAD_SHA &&
      result.branch === BRANCH)).toBe(true);
    expect(await env.DB_CONTROL.prepare(
      `SELECT head_branch, head_sha, version
       FROM attempts WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first()).toEqual({
      head_branch: BRANCH,
      head_sha: HEAD_SHA,
      version: 3,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT parent_sha, head_sha, branch
       FROM attempt_head_updates WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first()).toEqual({
      parent_sha: BASE_SHA,
      head_sha: HEAD_SHA,
      branch: BRANCH,
    });
  });

  it('starts verification on the first bot head recorded from the frozen base', async () => {
    await env.DB_CONTROL.prepare(
      'UPDATE attempts SET head_sha = NULL WHERE attempt_id = ?',
    ).bind(ATTEMPT_ID).run();

    const head = await fetchAttempt(`/v1/attempts/${ATTEMPT_ID}/head`, {
      method: 'POST',
      token: RAW_TOKEN,
      body: {
        expectedVersion: 2,
        leaseGeneration: 1,
        parentSha: BASE_SHA,
        headSha: HEAD_SHA,
        branch: BRANCH,
      },
    });
    expect(head.status).toBe(201);
    expect(await head.json()).toMatchObject({ version: 3, headSha: HEAD_SHA });

    const verification = await fetchAttempt(`/v1/attempts/${ATTEMPT_ID}/verifications`, {
      method: 'POST',
      token: RAW_TOKEN,
      body: {
        expectedVersion: 3,
        leaseGeneration: 1,
        manifest: {
          schemaVersion: '1',
          headSha: HEAD_SHA,
          policyDigest: `sha256:${'7'.repeat(64)}`,
          targetedCommandRefs: ['test:unit'],
          requiredVerifyCommandRefs: ['verify:all'],
        },
      },
    });
    expect(verification.status).toBe(201);
    expect(await verification.json()).toMatchObject({
      created: true,
      status: 'running',
      commands: [
        { position: 0, phase: 'targeted', commandRef: 'test:unit' },
        { position: 1, phase: 'required_verify', commandRef: 'verify:all' },
      ],
    });
  });

  it('returns only the active Plan Item context and atomically records one exact bot head', async () => {
    const contextResponse = await fetchAttempt(`/v1/attempts/${ATTEMPT_ID}/context`, {
      token: RAW_TOKEN,
    });
    expect(contextResponse.status).toBe(200);
    expect(contextResponse.headers.get('cache-control')).toBe('no-store');
    expect(await contextResponse.json()).toMatchObject({
      schemaVersion: '1',
      attempt: {
        id: ATTEMPT_ID,
        runId: RUN_ID,
        mode: 'implement',
        version: 2,
        leaseGeneration: 1,
        baseSha: BASE_SHA,
        checkoutSha: CHECKOUT_SHA,
        repository: 'example/delivery-target',
        baseBranch: 'main',
        planId: PLAN_ID,
        planVersion: 1,
        planItemId: ITEM_ID,
      },
      task: taskEnvelope(),
      item: {
        id: ITEM_ID,
        kind: 'change',
        required: true,
        doneWhen: ['Targeted and required verification pass on the new head.'],
        commandRefs: ['test:unit', 'verify:all'],
        evidenceKinds: ['test'],
        effects: ['repo_write'],
      },
    });

    const body = {
      expectedVersion: 2,
      leaseGeneration: 1,
      parentSha: CHECKOUT_SHA,
      headSha: HEAD_SHA,
      branch: BRANCH,
    };
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => fetchAttempt(`/v1/attempts/${ATTEMPT_ID}/head`, {
        method: 'POST',
        token: RAW_TOKEN,
        body,
      })),
    );
    expect(
      responses
        .map((response) => response.status)
        .filter((status) => status !== 200 && status !== 201),
    ).toEqual([]);
    const results = await Promise.all(responses.map(async (response) => await response.json()));
    expect(results.every((result) =>
      JSON.stringify(result) === JSON.stringify({
        updateId: (result as { updateId: string }).updateId,
        evidenceId: (result as { evidenceId: string }).evidenceId,
        created: (result as { created: boolean }).created,
        version: 3,
        leaseGeneration: 1,
        parentSha: CHECKOUT_SHA,
        headSha: HEAD_SHA,
        branch: BRANCH,
      }))).toBe(true);
    expect(results.filter((result) => (result as { created: boolean }).created)).toHaveLength(1);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM attempt_head_updates',
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT head_branch, head_sha, version, lease_generation
       FROM attempts WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first()).toEqual({
      head_branch: BRANCH,
      head_sha: HEAD_SHA,
      version: 3,
      lease_generation: 1,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT kind, status, sha, verification_status, summary
       FROM evidence WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first()).toEqual({
      kind: 'commit',
      status: 'passed',
      sha: HEAD_SHA,
      verification_status: 'unverified',
      summary: 'Trusted Runner recorded the bot commit head.',
    });
  });

  it('rejects stale, forged, extra-field, and non-execution requests without changing head', async () => {
    const forged = await fetchAttempt(`/v1/attempts/${ATTEMPT_ID}/head`, {
      method: 'POST',
      token: RAW_TOKEN,
      body: {
        expectedVersion: 2,
        leaseGeneration: 1,
        parentSha: CHECKOUT_SHA,
        headSha: HEAD_SHA,
        branch: 'agent/another-task/another-attempt',
      },
    });
    expect(forged.status).toBe(409);
    const extra = await fetchAttempt(`/v1/attempts/${ATTEMPT_ID}/head`, {
      method: 'POST',
      token: RAW_TOKEN,
      body: {
        expectedVersion: 2,
        leaseGeneration: 1,
        parentSha: CHECKOUT_SHA,
        headSha: HEAD_SHA,
        branch: BRANCH,
        status: 'passed',
      },
    });
    expect(extra.status).toBe(400);
    expect((await fetchAttempt(`/v1/attempts/${ATTEMPT_ID}/context`, {
      token: 'wrong-token',
    })).status).toBe(401);
    await env.DB_CONTROL.prepare(
      `UPDATE plan_item_progress SET active_attempt_id = NULL, status = 'blocked', version = version + 1
       WHERE plan_id = ? AND item_id = ?`,
    ).bind(PLAN_ID, ITEM_ID).run();
    expect((await fetchAttempt(`/v1/attempts/${ATTEMPT_ID}/context`, {
      token: RAW_TOKEN,
    })).status).toBe(409);
    expect(await env.DB_CONTROL.prepare(
      'SELECT head_branch, head_sha, version FROM attempts WHERE attempt_id = ?',
    ).bind(ATTEMPT_ID).first()).toEqual({
      head_branch: null,
      head_sha: CHECKOUT_SHA,
      version: 2,
    });
  });
});
