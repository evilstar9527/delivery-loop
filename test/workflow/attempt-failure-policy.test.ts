/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';

const BASE_URL = 'https://delivery-loop.test';
const TASK_ID = 'task-failure-policy';
const RUN_ID = 'run-failure-policy';
const BASE_SHA = '9'.repeat(40);
const PLAN_ID = 'plan-failure-policy';
const PLAN_ITEM_ID = 'implement-failure-policy';
const PLAN_DIGEST = `sha256:${'2'.repeat(64)}`;

interface FailureBody {
  schemaVersion: '1';
  eventId: string;
  sequence: number;
  type: 'attempt_failed';
  failureCode:
    | 'invalid_agent_output'
    | 'tool_unavailable'
    | 'verification_nonzero_exit';
  failureSite: 'agent_output' | 'tool_logs_search' | 'full_verification';
  attemptedPaths: Array<
    'repository_inspection' | 'log_query' | 'code_change' | 'targeted_test' | 'full_verification'
  >;
  neededHumanInput:
    | 'clarify_requirement'
    | 'grant_context_access'
    | 'manual_investigation';
  occurredAt: string;
  expectedVersion: number;
  leaseGeneration: number;
}

async function seedRun(): Promise<void> {
  const now = new Date().toISOString();
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (
         ?, 'manual', 'failure-policy', 'failure-policy', '1', ?,
         'r2://tasks/failure-policy', 'system', 'failure-policy', 'example/repo',
         'main', 'test', 'bug', 'Failure policy test', 'p1', 1, 0, 0, 0, 1, ?, ?
       )`,
    ).bind(TASK_ID, `sha256:${'1'.repeat(64)}`, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, created_at, updated_at
       ) VALUES (?, ?, '1', ?, ?, ?, 'planning', 1, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, `sha256:${'1'.repeat(64)}`, BASE_SHA, RUN_ID, now, now),
  ]);
}

async function seedAttempt(
  ordinal: number,
  options: {
    mode?: 'analysis' | 'implement';
    planId?: string;
    planVersion?: number;
    planItemId?: string;
  } = {},
): Promise<{ attemptId: string; token: string }> {
  const attemptId = `attempt-failure-policy-${ordinal}`;
  const token = `failure-policy-token-${ordinal}`;
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, github_run_id, plan_id, plan_version, plan_item_id,
         version, lease_generation,
         lease_expires_at, heartbeat_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'running', ?, 'example/repo',
                 'example/repo/.github/workflows/delivery-agent.yml@refs/heads/main',
                 ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
    ).bind(
      attemptId,
      RUN_ID,
      ordinal,
      options.mode ?? 'analysis',
      BASE_SHA,
      String(900 + ordinal),
      options.planId ?? null,
      options.planVersion ?? null,
      options.planItemId ?? null,
      expiresAt,
      nowIso,
      nowIso,
      nowIso,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest, lease_generation,
         scopes_json, expires_at, created_at
       ) VALUES (?, ?, ?, ?, 1, '["repo:read"]', ?, ?)`,
    ).bind(
      `token-failure-policy-${ordinal}`,
      attemptId,
      `sha256:${String(ordinal).repeat(64)}`,
      await canonicalSha256(token),
      expiresAt,
      nowIso,
    ),
  ]);
  return { attemptId, token };
}

async function seedActiveImplementationPlan(createdByAttemptId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `UPDATE runs
       SET state = 'executing', active_plan_id = ?, active_plan_version = 1,
           active_plan_digest = ?, updated_at = ?
       WHERE run_id = ?`,
    ).bind(PLAN_ID, PLAN_DIGEST, now, RUN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, '1', ?, ?, 'active', ?, 'Implement the bounded fix', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, createdByAttemptId, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES (?, ?, 'change', 'Apply fix', 'Apply the bounded implementation', 1, 0)`,
    ).bind(PLAN_ID, PLAN_ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (
         plan_id, item_id, status, active_attempt_id, version, updated_at
       ) VALUES (?, ?, 'in_progress', ?, 1, ?)`,
    ).bind(PLAN_ID, PLAN_ITEM_ID, createdByAttemptId, now),
  ]);
}

function failureBody(
  ordinal: number,
  overrides: Partial<FailureBody> = {},
): FailureBody {
  return {
    schemaVersion: '1',
    eventId: `failure-event-${ordinal}`,
    sequence: 1,
    type: 'attempt_failed',
    failureCode: 'invalid_agent_output',
    failureSite: 'agent_output',
    attemptedPaths: ['repository_inspection'],
    neededHumanInput: 'clarify_requirement',
    occurredAt: `2026-07-25T17:0${ordinal}:00.000Z`,
    expectedVersion: 1,
    leaseGeneration: 1,
    ...overrides,
  };
}

async function reportFailure(
  attemptId: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return await SELF.fetch(`${BASE_URL}/v1/attempts/${attemptId}/events`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function taskStatus(): Promise<Record<string, unknown>> {
  const response = await SELF.fetch(`${BASE_URL}/v1/tasks/${TASK_ID}`, {
    headers: { authorization: `Bearer ${env.TASK_INTAKE_TOKEN}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(async () => {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM run_blockers'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_failure_paths'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_failures'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  await seedRun();
});

describe('bounded Attempt failure policy and blocker projection', () => {
  it('blocks on the second consecutive trusted fingerprint and exposes card-safe paths/input', async () => {
    const first = await seedAttempt(1);
    const firstResponses = await Promise.all(
      Array.from({ length: 20 }, () =>
        reportFailure(first.attemptId, first.token, failureBody(1)),
      ),
    );
    expect(firstResponses.some((response) => response.status === 202)).toBe(true);
    expect(firstResponses.every((response) => [202, 401, 409].includes(response.status))).toBe(true);
    const firstAccepted = firstResponses.find((response) => response.status === 202);
    if (firstAccepted === undefined) throw new Error('missing accepted failure report');
    expect(await firstAccepted.json()).toMatchObject({
      accepted: true,
      blocked: false,
      retryAllowed: true,
      attemptCount: 1,
      consecutiveFingerprintCount: 1,
    });
    expect(
      await env.DB_CONTROL.prepare(
        'SELECT COUNT(*) AS count FROM attempt_failures WHERE run_id = ?',
      ).bind(RUN_ID).first<{ count: number }>(),
    ).toEqual({ count: 1 });

    const second = await seedAttempt(2);
    const secondResponse = await reportFailure(
      second.attemptId,
      second.token,
      failureBody(2, {
        attemptedPaths: ['log_query', 'targeted_test'],
        neededHumanInput: 'manual_investigation',
      }),
    );
    expect(secondResponse.status).toBe(202);
    const secondBody = (await secondResponse.json()) as Record<string, unknown>;
    expect(secondBody).toMatchObject({
      accepted: true,
      blocked: true,
      retryAllowed: false,
      attemptCount: 2,
      consecutiveFingerprintCount: 2,
      blocker: { reason: 'repeated_fingerprint' },
    });

    expect(
      await env.DB_CONTROL.prepare('SELECT state, version FROM runs WHERE run_id = ?')
        .bind(RUN_ID)
        .first(),
    ).toEqual({ state: 'blocked', version: 2 });
    expect(
      await env.DB_CONTROL.prepare(
        `SELECT delivery_state FROM outbox
         WHERE run_id = ? AND kind = 'workflow_cancel'`,
      ).bind(RUN_ID).first(),
    ).toEqual({ delivery_state: 'pending' });
    expect(
      await env.DB_CONTROL.prepare(
        `SELECT COUNT(*) AS count FROM attempt_tokens
         WHERE attempt_id IN (?, ?) AND revoked_at IS NOT NULL`,
      ).bind(first.attemptId, second.attemptId).first(),
    ).toEqual({ count: 2 });

    const status = await taskStatus();
    expect(status).toMatchObject({
      run: {
        state: 'blocked',
        blocker: {
          reason: 'repeated_fingerprint',
          attemptCount: 2,
          consecutiveFingerprintCount: 2,
          attemptedPaths: [
            {
              attemptId: first.attemptId,
              ordinal: 1,
              paths: [
                {
                  code: 'repository_inspection',
                  label: 'Inspected the trusted repository snapshot',
                },
              ],
            },
            {
              attemptId: second.attemptId,
              ordinal: 2,
              paths: [
                { code: 'log_query', label: 'Queried bounded diagnostic logs' },
                { code: 'targeted_test', label: 'Ran trusted targeted verification' },
              ],
            },
          ],
          neededHumanInput: {
            code: 'manual_investigation',
            prompt: 'Review the safe failure summary and choose the next investigation path.',
          },
        },
      },
    });
    expect(JSON.stringify(status)).not.toMatch(
      /attemptToken|toolBridgeToken|tokenDigest|oidcToken|stack|raw error/i,
    );

    for (const statement of [
      "UPDATE attempt_failures SET failure_code = 'raw_error' WHERE run_id = ?",
      "UPDATE attempt_failures SET failure_site = 'raw_site' WHERE run_id = ?",
      "UPDATE attempt_failures SET needed_human_input = 'raw_prompt' WHERE run_id = ?",
      "UPDATE attempt_failure_paths SET path_code = 'raw_path' WHERE failure_id IN (SELECT failure_id FROM attempt_failures WHERE run_id = ?)",
      "UPDATE run_blockers SET needed_human_input = 'raw_prompt' WHERE run_id = ?",
    ]) {
      await expect(env.DB_CONTROL.prepare(statement).bind(RUN_ID).run()).rejects.toThrow();
    }
  });

  it('blocks on the third Attempt even when all trusted fingerprints differ', async () => {
    const attempts = [await seedAttempt(1)];
    const first = await reportFailure(
      attempts[0]!.attemptId,
      attempts[0]!.token,
      failureBody(1),
    );
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ blocked: false, attemptCount: 1 });

    attempts.push(await seedAttempt(2));
    const second = await reportFailure(
      attempts[1]!.attemptId,
      attempts[1]!.token,
      failureBody(2, {
        failureCode: 'tool_unavailable',
        failureSite: 'tool_logs_search',
        attemptedPaths: ['log_query'],
        neededHumanInput: 'grant_context_access',
      }),
    );
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({
      blocked: false,
      attemptCount: 2,
      consecutiveFingerprintCount: 1,
    });

    attempts.push(await seedAttempt(3));
    const third = await reportFailure(
      attempts[2]!.attemptId,
      attempts[2]!.token,
      failureBody(3, {
        failureCode: 'verification_nonzero_exit',
        failureSite: 'full_verification',
        attemptedPaths: ['code_change', 'full_verification'],
        neededHumanInput: 'manual_investigation',
      }),
    );
    expect(third.status).toBe(202);
    expect(await third.json()).toMatchObject({
      blocked: true,
      attemptCount: 3,
      consecutiveFingerprintCount: 1,
      blocker: { reason: 'attempt_limit' },
    });
  });

  it('rejects raw error text, stack, and caller-selected fingerprints without persistence', async () => {
    const attempt = await seedAttempt(1);
    const canary = 'CANARY_RAW_FAILURE_MUST_NOT_PERSIST';
    for (const extra of [
      { message: canary },
      { stack: canary },
      { fingerprint: canary },
    ]) {
      const response = await reportFailure(attempt.attemptId, attempt.token, {
        ...failureBody(1),
        ...extra,
      });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(canary);
    }
    expect(
      await env.DB_CONTROL.prepare(
        'SELECT COUNT(*) AS count FROM attempt_failures WHERE run_id = ?',
      ).bind(RUN_ID).first(),
    ).toEqual({ count: 0 });
    const columns = await env.DB_CONTROL.prepare('PRAGMA table_info(attempt_failures)')
      .all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(['message', 'stack', 'raw_error']),
    );
  });

  it('blocks the active execution Plan and PlanItem on a repeated implementation failure', async () => {
    const first = await seedAttempt(1, {
      mode: 'implement',
      planId: PLAN_ID,
      planVersion: 1,
      planItemId: PLAN_ITEM_ID,
    });
    await seedActiveImplementationPlan(first.attemptId);
    const firstResponse = await reportFailure(
      first.attemptId,
      first.token,
      failureBody(1, {
        failureCode: 'verification_nonzero_exit',
        failureSite: 'full_verification',
        attemptedPaths: ['code_change', 'full_verification'],
        neededHumanInput: 'manual_investigation',
      }),
    );
    expect(firstResponse.status).toBe(202);
    expect(await firstResponse.json()).toMatchObject({ blocked: false, retryAllowed: true });

    const second = await seedAttempt(2, {
      mode: 'implement',
      planId: PLAN_ID,
      planVersion: 1,
      planItemId: PLAN_ITEM_ID,
    });
    await env.DB_CONTROL.prepare(
      `UPDATE plan_item_progress
       SET active_attempt_id = ?, version = version + 1, updated_at = ?
       WHERE plan_id = ? AND item_id = ?`,
    ).bind(second.attemptId, new Date().toISOString(), PLAN_ID, PLAN_ITEM_ID).run();
    const secondResponse = await reportFailure(
      second.attemptId,
      second.token,
      failureBody(2, {
        failureCode: 'verification_nonzero_exit',
        failureSite: 'full_verification',
        attemptedPaths: ['code_change', 'full_verification'],
        neededHumanInput: 'manual_investigation',
      }),
    );
    expect(secondResponse.status).toBe(202);
    expect(await secondResponse.json()).toMatchObject({
      blocked: true,
      retryAllowed: false,
      blocker: { reason: 'repeated_fingerprint' },
    });
    expect(
      await env.DB_CONTROL.prepare('SELECT state FROM runs WHERE run_id = ?')
        .bind(RUN_ID)
        .first(),
    ).toEqual({ state: 'blocked' });
    expect(
      await env.DB_CONTROL.prepare('SELECT status FROM execution_plans WHERE plan_id = ?')
        .bind(PLAN_ID)
        .first(),
    ).toEqual({ status: 'blocked' });
    expect(
      await env.DB_CONTROL.prepare(
        `SELECT status, active_attempt_id FROM plan_item_progress
         WHERE plan_id = ? AND item_id = ?`,
      ).bind(PLAN_ID, PLAN_ITEM_ID).first(),
    ).toEqual({ status: 'blocked', active_attempt_id: second.attemptId });
  });
});
