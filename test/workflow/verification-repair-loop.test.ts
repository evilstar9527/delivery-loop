/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import { taskRevisionDigest, type TaskEnvelope } from '../../src/domain/task.js';
import { EXECUTION_TOOL_ACTIONS } from '../../src/domain/tool-bridge.js';
import {
  GitHubDispatchOutboxProcessor,
  type GitHubDispatchEffects,
  type GitHubDispatchRequest,
  type GitHubDispatchResult,
} from '../../src/outbox/github-dispatcher.js';

const BASE_URL = 'https://delivery-loop.test';
const RUN_ID = 'run-verification-repair';
const TASK_ID = 'task-verification-repair';
const PLAN_ID = 'plan-verification-repair';
const ITEM_ID = 'verify-and-repair';
const INITIAL_ATTEMPT_ID = 'attempt-verification-repair-initial';
const REPOSITORY = 'example/delivery-target';
const BASE_SHA = '1'.repeat(40);
const INITIAL_HEAD_SHA = '2'.repeat(40);
const PLAN_DIGEST = `sha256:${'3'.repeat(64)}`;
const POLICY_DIGEST = `sha256:${'4'.repeat(64)}`;
function taskEnvelope(): TaskEnvelope {
  return {
    schemaVersion: '1',
    eventId: 'event-verification-repair',
    occurredAt: '2026-07-25T00:00:00.000Z',
    source: {
      system: 'manual',
      tenantKey: 'verification-repair',
      taskKey: 'verification-repair',
      revision: '1',
    },
    actor: { type: 'system', id: 'verification-repair' },
    target: {
      owner: 'example',
      repo: 'delivery-target',
      baseBranch: 'main',
      environment: 'test',
    },
    intent: {
      kind: 'bug',
      title: 'Bounded verification repair',
      description: 'Repair the trusted failed verification without changing policy.',
      acceptanceCriteria: ['All trusted verification commands pass on the repair head.'],
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
const TASK_DIGEST = await taskRevisionDigest(taskEnvelope());
const INITIAL_TOKEN = 'verification-repair-initial-token';
const TEST_STARTED_AT = new Date();
const LEASE_EXPIRES_AT = new Date(TEST_STARTED_AT.getTime() + 30 * 60_000).toISOString();
const COMMANDS = [
  { phase: 'targeted' as const, commandRef: 'test:unit' },
  { phase: 'required_verify' as const, commandRef: 'verify:all' },
  { phase: 'required_verify' as const, commandRef: 'verify:integration' },
];

interface RepairProjection {
  id: string;
  attemptId: string;
  ordinal: number;
  mode: 'review_fix';
  failedAttemptId: string;
  sourceSuiteId: string;
  sourceEvidenceId: string;
  dispatchOutboxId: string;
  created: boolean;
}

interface FailureResponse {
  accepted: true;
  blocked: boolean;
  retryAllowed: boolean;
  attemptCount: number;
  consecutiveFingerprintCount: number;
  repair?: RepairProjection;
  verificationFailure?: {
    sourceSuiteId: string;
    sourceEvidenceId: string;
    headSha: string;
    factDigest: string;
  };
  blocker?: { reason: 'repeated_fingerprint' | 'attempt_limit' };
}

class FakeDispatchEffects implements GitHubDispatchEffects {
  readonly requests: GitHubDispatchRequest[] = [];

  async ensureDispatch(request: GitHubDispatchRequest): Promise<GitHubDispatchResult> {
    this.requests.push(request);
    return { disposition: 'created', githubRunId: String(8_000 + this.requests.length) };
  }
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM run_blockers'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_failure_paths'),
    // attempt_repairs is removed by its failure FK cascade.
    env.DB_CONTROL.prepare('DELETE FROM attempt_failures'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_done_when_evidence'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_verifications'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suite_commands'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suites'),
    env.DB_CONTROL.prepare('DELETE FROM github_write_credentials'),
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
  const objects = await env.TASK_OBJECTS.list();
  if (objects.objects.length > 0) {
    await env.TASK_OBJECTS.delete(objects.objects.map((object) => object.key));
  }
}

async function seed(): Promise<void> {
  const nowIso = TEST_STARTED_AT.toISOString();
  await env.TASK_OBJECTS.put('tasks/verification-repair', JSON.stringify(taskEnvelope()), {
    customMetadata: { taskDigest: TASK_DIGEST },
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
       ) VALUES (
         ?, 'manual', 'verification-repair', 'verification-repair', '1', ?,
         'r2://tasks/verification-repair', 'system', 'verification-repair', ?,
         'main', 'test', 'bug', 'Bounded verification repair', 'p1', 1,
         1, 0, 0, 1, ?, ?
       )`,
    ).bind(TASK_ID, TASK_DIGEST, REPOSITORY, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, '1', ?, ?, ?, 'executing', 4, ?, 1, ?, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, TASK_DIGEST, BASE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES (
         'attempt-verification-repair-analysis', ?, 1, 'analysis', 'completed', ?, ?,
         ?, 1, 0, ?, ?
       )`,
    ).bind(
      RUN_ID,
      BASE_SHA,
      REPOSITORY,
      `${REPOSITORY}/.github/workflows/delivery-agent.yml@refs/heads/main`,
      nowIso,
      nowIso,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, '1', ?, ?, 'active',
                 'attempt-verification-repair-analysis',
                 'Repair test failures within a durable bound.', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, plan_item_id,
         claimed_progress_version, head_branch, head_sha, version,
         lease_generation, lease_token_digest, lease_expires_at, heartbeat_at,
         created_at, updated_at
       ) VALUES (?, ?, 2, 'implement', 'running', ?, ?, ?, ?, 1, ?, 1,
                 'agent/task-verification-repair/initial', ?, 2, 1, ?, ?, ?, ?, ?)`
    ).bind(
      INITIAL_ATTEMPT_ID,
      RUN_ID,
      BASE_SHA,
      REPOSITORY,
      `${REPOSITORY}/.github/workflows/delivery-agent.yml@refs/heads/main`,
      PLAN_ID,
      ITEM_ID,
      INITIAL_HEAD_SHA,
      await canonicalSha256('verification-repair-lease'),
      LEASE_EXPIRES_AT,
      nowIso,
      nowIso,
      nowIso,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest, lease_generation,
         scopes_json, expires_at, created_at
       ) VALUES ('token-verification-repair-initial', ?, ?, ?, 1,
                 '["repo:read","checkpoint:write"]', ?, ?)`
    ).bind(
      INITIAL_ATTEMPT_ID,
      `sha256:${'6'.repeat(64)}`,
      await canonicalSha256(INITIAL_TOKEN),
      LEASE_EXPIRES_AT,
      nowIso,
    ),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES (?, ?, 'verification', 'Verify and repair',
                 'Run trusted tests and repair bounded failures.', 1, 0)`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_done_when (plan_id, item_id, position, condition)
       VALUES (?, ?, 0, 'All trusted verification commands pass.')`,
    ).bind(PLAN_ID, ITEM_ID),
    ...COMMANDS.map((command) =>
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
         VALUES (?, ?, ?)`,
      ).bind(PLAN_ID, ITEM_ID, command.commandRef),
    ),
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
    ).bind(PLAN_ID, ITEM_ID, INITIAL_ATTEMPT_ID, nowIso),
  ]);
}

async function postJson(
  path: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return await SELF.fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function recordFailedVerification(input: {
  attemptId: string;
  token: string;
  expectedVersion: number;
  leaseGeneration: number;
  headSha: string;
  failedCommandRef: string;
}): Promise<{ suiteId: string; evidenceId: string; failureSite: string }> {
  const started = await postJson(
    `/v1/attempts/${input.attemptId}/verifications`,
    input.token,
    {
      expectedVersion: input.expectedVersion,
      leaseGeneration: input.leaseGeneration,
      manifest: {
        schemaVersion: '1',
        headSha: input.headSha,
        policyDigest: POLICY_DIGEST,
        targetedCommandRefs: ['test:unit'],
        requiredVerifyCommandRefs: ['verify:all', 'verify:integration'],
      },
    },
  );
  expect(started.status).toBe(201);
  const suite = (await started.json()) as { suiteId: string };
  let failedEvidenceId = '';
  let failureSite = '';
  for (const [position, command] of COMMANDS.entries()) {
    const exitCode = command.commandRef === input.failedCommandRef ? 17 : 0;
    const response = await postJson(
      `/v1/attempts/${input.attemptId}/verifications/${suite.suiteId}/results`,
      input.token,
      {
        expectedVersion: input.expectedVersion,
        leaseGeneration: input.leaseGeneration,
        result: {
          schemaVersion: '1',
          position,
          phase: command.phase,
          commandRef: command.commandRef,
          exitCode,
          durationMs: 100 + position,
          headSha: input.headSha,
        },
      },
    );
    expect(response.status).toBe(201);
    const result = (await response.json()) as { evidenceId: string };
    if (exitCode !== 0) {
      failedEvidenceId = result.evidenceId;
      failureSite = command.phase === 'targeted' ? 'targeted_verification' : 'full_verification';
      break;
    }
  }
  if (failedEvidenceId.length === 0) throw new Error('test did not record failed Evidence');
  return { suiteId: suite.suiteId, evidenceId: failedEvidenceId, failureSite };
}

async function reportVerificationFailure(input: {
  attemptId: string;
  token: string;
  expectedVersion: number;
  leaseGeneration: number;
  eventId: string;
  failureSite: string;
  extra?: Record<string, unknown>;
}): Promise<Response> {
  return await postJson(`/v1/attempts/${input.attemptId}/events`, input.token, {
    schemaVersion: '1',
    eventId: input.eventId,
    sequence: 1,
    type: 'attempt_failed',
    failureCode: 'verification_nonzero_exit',
    failureSite: input.failureSite,
    attemptedPaths: ['code_change', 'targeted_test', 'full_verification'],
    neededHumanInput: 'manual_investigation',
    occurredAt: TEST_STARTED_AT.toISOString(),
    expectedVersion: input.expectedVersion,
    leaseGeneration: input.leaseGeneration,
    ...input.extra,
  });
}

function dispatcher(effects: GitHubDispatchEffects): GitHubDispatchOutboxProcessor {
  return new GitHubDispatchOutboxProcessor(env.DB_CONTROL, effects, {
    allowedRepositories: [REPOSITORY],
    controlPlaneUrl: 'https://control.example.test',
    now: () => TEST_STARTED_AT,
    generateLeaseToken: () => crypto.randomUUID(),
    attemptLeaseMs: 20 * 60_000,
  });
}

async function activateRepair(
  repair: RepairProjection,
  headSha: string,
): Promise<{ token: string; version: number; leaseGeneration: number }> {
  const token = `verification-repair-token-${repair.ordinal}`;
  const nowIso = TEST_STARTED_AT.toISOString();
  const updated = await env.DB_CONTROL.prepare(
    `UPDATE attempts
     SET status = 'running', version = version + 1, head_sha = ?,
         heartbeat_at = ?, updated_at = ?
     WHERE attempt_id = ? AND status = 'starting' AND version = 1
       AND lease_generation = 1 AND lease_expires_at > ?`,
  ).bind(headSha, nowIso, nowIso, repair.attemptId, nowIso).run();
  expect(updated.meta.changes).toBe(1);
  await env.DB_CONTROL.prepare(
    `INSERT INTO attempt_tokens (
       token_id, attempt_id, oidc_token_digest, token_digest, lease_generation,
       scopes_json, expires_at, created_at
     ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
  ).bind(
    `token-verification-repair-${repair.ordinal}`,
    repair.attemptId,
    await canonicalSha256(`oidc-verification-repair-${repair.ordinal}`),
    await canonicalSha256(token),
    JSON.stringify(EXECUTION_TOOL_ACTIONS),
    LEASE_EXPIRES_AT,
    nowIso,
  ).run();
  return { token, version: 2, leaseGeneration: 1 };
}

async function scheduleFirstRepair(
  failedCommandRef = 'verify:all',
): Promise<{ repair: RepairProjection; fingerprintDigest: string }> {
  const failed = await recordFailedVerification({
    attemptId: INITIAL_ATTEMPT_ID,
    token: INITIAL_TOKEN,
    expectedVersion: 2,
    leaseGeneration: 1,
    headSha: INITIAL_HEAD_SHA,
    failedCommandRef,
  });
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      reportVerificationFailure({
        attemptId: INITIAL_ATTEMPT_ID,
        token: INITIAL_TOKEN,
        expectedVersion: 2,
        leaseGeneration: 1,
        eventId: 'verification-repair-failure-1',
        failureSite: failed.failureSite,
        ...(index === 19 ? { extra: { retry: true } } : {}),
      }),
    ),
  );
  expect(responses.some((response) => response.status === 400)).toBe(true);
  const acceptedBodies = await Promise.all(
    responses
      .filter((response) => response.status === 202)
      .map(async (response) =>
        (await response.json()) as FailureResponse & { fingerprintDigest: string }),
  );
  expect(acceptedBodies.filter((body) => body.repair?.created === true)).toHaveLength(1);
  const body = acceptedBodies.find((candidate) => candidate.repair !== undefined);
  if (body === undefined) throw new Error('missing accepted verification failure');
  expect(body).toMatchObject({
    accepted: true,
    blocked: false,
    retryAllowed: true,
    attemptCount: 1,
    consecutiveFingerprintCount: 1,
    repair: {
      mode: 'review_fix',
      failedAttemptId: INITIAL_ATTEMPT_ID,
      sourceSuiteId: failed.suiteId,
      sourceEvidenceId: failed.evidenceId,
    },
    verificationFailure: {
      sourceSuiteId: failed.suiteId,
      sourceEvidenceId: failed.evidenceId,
      headSha: INITIAL_HEAD_SHA,
    },
  });
  if (body.repair === undefined) throw new Error('repair was not scheduled');
  return { repair: body.repair, fingerprintDigest: body.fingerprintDigest };
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('bounded verification repair loop', () => {
  it('does not schedule a repair from an Agent claim without failed suite Evidence', async () => {
    const response = await reportVerificationFailure({
      attemptId: INITIAL_ATTEMPT_ID,
      token: INITIAL_TOKEN,
      expectedVersion: 2,
      leaseGeneration: 1,
      eventId: 'verification-repair-unverified-claim',
      failureSite: 'full_verification',
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as FailureResponse;
    expect(body).toMatchObject({
      blocked: false,
      retryAllowed: true,
      attemptCount: 1,
    });
    expect(body).not.toHaveProperty('repair');
    expect(body).not.toHaveProperty('verificationFailure');
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM attempt_failure_verification_facts',
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts
       WHERE run_id = ? AND mode = 'review_fix'`,
    ).bind(RUN_ID).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox
       WHERE run_id = ? AND kind = 'execution_dispatch'`,
    ).bind(RUN_ID).first()).toEqual({ count: 0 });
  });

  it('turns one trusted failed suite into one same-head review_fix dispatch', async () => {
    const { repair } = await scheduleFirstRepair();
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts
       WHERE run_id = ? AND mode = 'review_fix'`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, active_attempt_id, version FROM plan_item_progress
       WHERE plan_id = ? AND item_id = ?`,
    ).bind(PLAN_ID, ITEM_ID).first()).toEqual({
      status: 'in_progress',
      active_attempt_id: repair.attemptId,
      version: 3,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT mode, status, base_sha, head_sha FROM attempts WHERE attempt_id = ?`,
    ).bind(repair.attemptId).first()).toEqual({
      mode: 'review_fix',
      status: 'pending',
      base_sha: BASE_SHA,
      head_sha: INITIAL_HEAD_SHA,
    });
    const planResponse = await SELF.fetch(`${BASE_URL}/v1/runs/${RUN_ID}/plan`, {
      headers: { authorization: `Bearer ${env.TASK_INTAKE_TOKEN}` },
    });
    expect(planResponse.status).toBe(200);
    const plan = (await planResponse.json()) as { attempts: Array<Record<string, unknown>> };
    expect(plan.attempts.find((attempt) => attempt.id === repair.attemptId)).toMatchObject({
      mode: 'review_fix',
      status: 'pending',
      repair: {
        id: repair.id,
        failedAttemptId: INITIAL_ATTEMPT_ID,
        sourceSuiteId: repair.sourceSuiteId,
        sourceEvidenceId: repair.sourceEvidenceId,
      },
    });
    await expect(env.DB_CONTROL.prepare(
      `UPDATE evidence SET status = 'passed' WHERE evidence_id = ?`,
    ).bind(repair.sourceEvidenceId).run()).rejects.toThrow(
      'repair_failure_evidence_is_immutable',
    );
    await expect(env.DB_CONTROL.prepare(
      `UPDATE verification_suite_commands SET result_status = 'passed'
       WHERE suite_id = ? AND evidence_id = ?`,
    ).bind(repair.sourceSuiteId, repair.sourceEvidenceId).run()).rejects.toThrow(
      'repair_failure_command_is_immutable',
    );
    await expect(env.DB_CONTROL.prepare(
      `UPDATE verification_suites SET status = 'completed' WHERE suite_id = ?`,
    ).bind(repair.sourceSuiteId).run()).rejects.toThrow(
      'repair_failure_suite_is_immutable',
    );

    const effects = new FakeDispatchEffects();
    expect(await dispatcher(effects).deliver(repair.dispatchOutboxId)).toBe('settled');
    expect(effects.requests).toEqual([{
      repository: REPOSITORY,
      workflowFile: '.github/workflows/delivery-agent.yml',
      ref: 'refs/heads/main',
      inputs: {
        schema_version: '1',
        run_id: RUN_ID,
        attempt_id: repair.attemptId,
        task_digest: TASK_DIGEST,
        base_sha: BASE_SHA,
        checkout_sha: INITIAL_HEAD_SHA,
        control_plane_url: 'https://control.example.test',
        mode: 'review_fix',
        plan_version: '1',
        plan_item_id: ITEM_ID,
      },
    }]);
    const active = await activateRepair(repair, INITIAL_HEAD_SHA);
    const contextResponse = await SELF.fetch(
      `${BASE_URL}/v1/attempts/${repair.attemptId}/context`,
      { headers: { authorization: `Bearer ${active.token}` } },
    );
    expect(contextResponse.status).toBe(200);
    expect(await contextResponse.json()).toMatchObject({
      attempt: {
        id: repair.attemptId,
        taskId: TASK_ID,
        mode: 'review_fix',
        baseSha: BASE_SHA,
        checkoutSha: INITIAL_HEAD_SHA,
        planId: PLAN_ID,
        planVersion: 1,
        planItemId: ITEM_ID,
      },
      task: taskEnvelope(),
      repair: {
        failedAttemptId: INITIAL_ATTEMPT_ID,
        sourceSuiteId: repair.sourceSuiteId,
        sourceEvidenceId: repair.sourceEvidenceId,
        sourceHeadSha: INITIAL_HEAD_SHA,
        phase: expect.stringMatching(/^(targeted|required_verify)$/),
        commandRef: expect.stringMatching(/^(test|verify):/),
      },
    });
  });

  it('settles a delayed repair dispatch without GitHub effect after its Plan is blocked', async () => {
    const { repair } = await scheduleFirstRepair();
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE runs SET state = 'blocked' WHERE run_id = ?`,
      ).bind(RUN_ID),
      env.DB_CONTROL.prepare(
        `UPDATE execution_plans SET status = 'blocked' WHERE plan_id = ?`,
      ).bind(PLAN_ID),
      env.DB_CONTROL.prepare(
        `UPDATE plan_item_progress SET status = 'blocked'
         WHERE plan_id = ? AND item_id = ?`,
      ).bind(PLAN_ID, ITEM_ID),
    ]);
    const effects = new FakeDispatchEffects();
    expect(await dispatcher(effects).deliver(repair.dispatchOutboxId)).toBe('settled');
    expect(effects.requests).toHaveLength(0);
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state, last_error_code FROM outbox WHERE outbox_id = ?`,
    ).bind(repair.dispatchOutboxId).first()).toEqual({
      delivery_state: 'settled',
      last_error_code: 'repair_dispatch_stale',
    });
  });

  it('blocks the second consecutive trusted fingerprint without consuming a third Attempt', async () => {
    const { repair: firstRepair, fingerprintDigest } = await scheduleFirstRepair('verify:all');
    const effects = new FakeDispatchEffects();
    expect(await dispatcher(effects).deliver(firstRepair.dispatchOutboxId)).toBe('settled');
    const active = await activateRepair(firstRepair, '7'.repeat(40));
    const failed = await recordFailedVerification({
      attemptId: firstRepair.attemptId,
      token: active.token,
      expectedVersion: active.version,
      leaseGeneration: active.leaseGeneration,
      headSha: '7'.repeat(40),
      failedCommandRef: 'verify:all',
    });
    const response = await reportVerificationFailure({
      attemptId: firstRepair.attemptId,
      token: active.token,
      expectedVersion: active.version,
      leaseGeneration: active.leaseGeneration,
      eventId: 'verification-repair-failure-2',
      failureSite: failed.failureSite,
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      blocked: true,
      retryAllowed: false,
      fingerprintDigest,
      attemptCount: 2,
      consecutiveFingerprintCount: 2,
      blocker: { reason: 'repeated_fingerprint' },
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts
       WHERE run_id = ? AND mode = 'review_fix'`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT state FROM runs WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ state: 'blocked' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status FROM execution_plans WHERE plan_id = ?`,
    ).bind(PLAN_ID).first()).toEqual({ status: 'blocked' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, active_attempt_id FROM plan_item_progress
       WHERE plan_id = ? AND item_id = ?`,
    ).bind(PLAN_ID, ITEM_ID).first()).toEqual({
      status: 'blocked',
      active_attempt_id: firstRepair.attemptId,
    });
    const statusResponse = await SELF.fetch(`${BASE_URL}/v1/runs/${RUN_ID}/plan`, {
      headers: { authorization: `Bearer ${env.TASK_INTAKE_TOKEN}` },
    });
    expect(statusResponse.status).toBe(200);
    const status = (await statusResponse.json()) as {
      run: { blocker: { attemptedPaths: Array<Record<string, unknown>> } };
    };
    expect(status.run.blocker.attemptedPaths).toEqual(expect.arrayContaining([
      expect.objectContaining({
        attemptId: firstRepair.attemptId,
        verificationFailure: {
          sourceSuiteId: failed.suiteId,
          sourceEvidenceId: failed.evidenceId,
          headSha: '7'.repeat(40),
          factDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      }),
    ]));
  });

  it('allows two distinct trusted repairs and blocks the third failure at Watt maxAttempts=3', async () => {
    const { repair: firstRepair } = await scheduleFirstRepair('test:unit');
    const effects = new FakeDispatchEffects();
    expect(await dispatcher(effects).deliver(firstRepair.dispatchOutboxId)).toBe('settled');
    const firstActive = await activateRepair(firstRepair, '8'.repeat(40));
    const secondFact = await recordFailedVerification({
      attemptId: firstRepair.attemptId,
      token: firstActive.token,
      expectedVersion: firstActive.version,
      leaseGeneration: firstActive.leaseGeneration,
      headSha: '8'.repeat(40),
      failedCommandRef: 'verify:all',
    });
    const secondResponse = await reportVerificationFailure({
      attemptId: firstRepair.attemptId,
      token: firstActive.token,
      expectedVersion: firstActive.version,
      leaseGeneration: firstActive.leaseGeneration,
      eventId: 'verification-repair-distinct-2',
      failureSite: secondFact.failureSite,
    });
    expect(secondResponse.status).toBe(202);
    const secondBody = (await secondResponse.json()) as FailureResponse;
    expect(secondBody).toMatchObject({ blocked: false, attemptCount: 2 });
    if (secondBody.repair === undefined) throw new Error('second repair was not scheduled');

    expect(await dispatcher(effects).deliver(secondBody.repair.dispatchOutboxId)).toBe('settled');
    const secondActive = await activateRepair(secondBody.repair, '9'.repeat(40));
    const thirdFact = await recordFailedVerification({
      attemptId: secondBody.repair.attemptId,
      token: secondActive.token,
      expectedVersion: secondActive.version,
      leaseGeneration: secondActive.leaseGeneration,
      headSha: '9'.repeat(40),
      failedCommandRef: 'verify:integration',
    });
    const thirdResponse = await reportVerificationFailure({
      attemptId: secondBody.repair.attemptId,
      token: secondActive.token,
      expectedVersion: secondActive.version,
      leaseGeneration: secondActive.leaseGeneration,
      eventId: 'verification-repair-distinct-3',
      failureSite: thirdFact.failureSite,
    });
    expect(thirdResponse.status).toBe(202);
    expect(await thirdResponse.json()).toMatchObject({
      blocked: true,
      retryAllowed: false,
      attemptCount: 3,
      consecutiveFingerprintCount: 1,
      blocker: { reason: 'attempt_limit' },
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts
       WHERE run_id = ? AND mode = 'review_fix'`,
    ).bind(RUN_ID).first()).toEqual({ count: 2 });
    expect(effects.requests).toHaveLength(2);
  });
});
