/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import {
  AttemptStuckDetector,
} from '../../src/storage/attempt-lifecycle-store.js';
import { RunnerAttemptStore } from '../../src/storage/runner-attempt-store.js';
import {
  WorkflowOutboxProcessor,
  type WorkflowEffectClient,
} from '../../src/outbox/workflow-outbox.js';

const BASE_URL = 'https://delivery-loop.test';
const RUN_ID = 'run-attempt-revocation';
const ATTEMPT_ID = 'attempt-revocation';
const RAW_TOKEN = 'runner-token-to-revoke';
const RAW_TOOL_TOKEN = 'runner-tool-token-to-revoke';
const BASE_SHA = '9'.repeat(40);
const NOW = new Date('2026-07-25T10:00:00.000Z');

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

async function seedActiveAttempt(): Promise<void> {
  const nowIso = NOW.toISOString();
  const expiresAt = new Date(NOW.getTime() + 5 * 60_000).toISOString();
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (
         'task-attempt-revocation', 'manual', 'attempt-revocation',
         'attempt-revocation', '1', ?, 'r2://tasks/attempt-revocation', 'system',
         'attempt-revocation', 'example/repo', 'main', 'none', 'bug',
         'Attempt revocation', 'p1', 1, 0, 0, 0, 1, ?, ?
       )`,
    ).bind(`sha256:${'6'.repeat(64)}`, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, created_at, updated_at
       ) VALUES (?, 'task-attempt-revocation', '1', ?, ?, ?, 'planning', 3, ?, ?)`,
    ).bind(RUN_ID, `sha256:${'6'.repeat(64)}`, BASE_SHA, RUN_ID, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, github_run_id, version, lease_generation,
         lease_expires_at, heartbeat_at, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'running', ?, 'example/repo',
                 'example/repo/.github/workflows/delivery-agent.yml@refs/heads/main',
                 '55555', 5, 2, ?, ?, ?, ?)`,
    ).bind(ATTEMPT_ID, RUN_ID, BASE_SHA, expiresAt, nowIso, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest, tool_token_digest,
         lease_generation, scopes_json, expires_at, created_at
       ) VALUES ('token-attempt-revocation', ?, ?, ?, ?, 2, '["repo:read"]', ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      `sha256:${'7'.repeat(64)}`,
      await canonicalSha256(RAW_TOKEN),
      await canonicalSha256(RAW_TOOL_TOKEN),
      expiresAt,
      nowIso,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO outbox (
         outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
         delivery_state, created_at, updated_at
       ) VALUES (
         'dispatch-attempt-revocation', ?, 'analysis_dispatch', 'github_actions',
         ?, 'analysis-dispatch:attempt-revocation', 'pending', ?, ?
       )`,
    ).bind(RUN_ID, `d1://attempts/${ATTEMPT_ID}`, nowIso, nowIso),
  ]);
}

async function cancel(expectedRunVersion: number): Promise<Response> {
  return await SELF.fetch(`${BASE_URL}/v1/runs/${RUN_ID}/cancel`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-task-intake-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ expectedRunVersion }),
  });
}

async function callTool(token = RAW_TOOL_TOKEN): Promise<Response> {
  return await SELF.fetch(`${BASE_URL}/v1/attempts/${ATTEMPT_ID}/tools/call`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ toolPath: 'repo/read', arguments: { path: 'src/index.ts' } }),
  });
}

beforeEach(async () => {
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
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM idempotency_keys'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  await seedActiveAttempt();
});

describe('Attempt token revocation lifecycle', () => {
  it('atomically cancels a Run, revokes all active tokens, and terminates its Workflow via outbox', async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, () => cancel(3)));
    expect(responses.every((response) => response.status === 202)).toBe(true);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies.every((body) => (body as { state?: string }).state === 'cancelled')).toBe(true);

    const run = await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    )
      .bind(RUN_ID)
      .first<Record<string, unknown>>();
    const attempt = await env.DB_CONTROL.prepare(
      `SELECT status, version, lease_generation, lease_expires_at
       FROM attempts WHERE attempt_id = ?`,
    )
      .bind(ATTEMPT_ID)
      .first<Record<string, unknown>>();
    const token = await env.DB_CONTROL.prepare(
      'SELECT revoked_at FROM attempt_tokens WHERE attempt_id = ?',
    )
      .bind(ATTEMPT_ID)
      .first<{ revoked_at: string | null }>();
    expect(run).toEqual({ state: 'cancelled', version: 4 });
    expect(attempt).toEqual({
      status: 'cancelled',
      version: 6,
      lease_generation: 3,
      lease_expires_at: null,
    });
    expect(token?.revoked_at).toBeTruthy();
    expect(
      await env.DB_CONTROL.prepare(
        `SELECT reason, revoked_lease_generation, attempt_version
         FROM attempt_revocations WHERE attempt_id = ?`,
      )
        .bind(ATTEMPT_ID)
        .first(),
    ).toEqual({ reason: 'cancelled', revoked_lease_generation: 2, attempt_version: 6 });
    expect(
      await env.DB_CONTROL.prepare(
        `SELECT delivery_state, last_error_code FROM outbox
         WHERE outbox_id = 'dispatch-attempt-revocation'`,
      ).first(),
    ).toEqual({ delivery_state: 'settled', last_error_code: 'run_cancelled' });

    const cancelOutbox = await env.DB_CONTROL.prepare(
      `SELECT outbox_id, delivery_state FROM outbox
       WHERE kind = 'workflow_cancel' AND run_id = ?`,
    )
      .bind(RUN_ID)
      .first<{ outbox_id: string; delivery_state: string }>();
    expect(cancelOutbox?.delivery_state).toBe('pending');
    const effects = new FakeWorkflowEffects();
    const processor = new WorkflowOutboxProcessor(env.DB_CONTROL, effects);
    expect(await processor.deliver(cancelOutbox!.outbox_id)).toBe('settled');
    expect(effects.terminated).toEqual([RUN_ID]);

    const lateHeartbeat = await SELF.fetch(`${BASE_URL}/v1/attempts/${ATTEMPT_ID}/heartbeat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${RAW_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: 5, leaseGeneration: 2 }),
    });
    expect(lateHeartbeat.status).toBe(401);
    expect((await callTool()).status).toBe(401);
  });

  it('rejects a stale cancel version without revoking a healthy Attempt', async () => {
    const response = await cancel(2);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'conflict' });
    expect(
      await new RunnerAttemptStore(env.DB_CONTROL).authorize(ATTEMPT_ID, RAW_TOKEN, NOW),
    ).toMatchObject({ attemptId: ATTEMPT_ID, version: 5, leaseGeneration: 2 });
    expect(
      await new RunnerAttemptStore(env.DB_CONTROL).authorizeTool(
        ATTEMPT_ID,
        RAW_TOOL_TOKEN,
        NOW,
      ),
    ).toMatchObject({ attemptId: ATTEMPT_ID, version: 5, leaseGeneration: 2 });
  });

  it('marks an expired heartbeat lost, blocks the Run, and revokes a defensively long token once', async () => {
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE attempts SET lease_expires_at = ?, heartbeat_at = ? WHERE attempt_id = ?`,
      ).bind('2026-07-25T09:58:00.000Z', '2026-07-25T09:57:00.000Z', ATTEMPT_ID),
      env.DB_CONTROL.prepare(
        `UPDATE attempt_tokens SET expires_at = ? WHERE attempt_id = ?`,
      ).bind('2026-07-25T10:05:00.000Z', ATTEMPT_ID),
    ]);
    const detector = new AttemptStuckDetector(env.DB_CONTROL, { now: () => NOW });
    expect(await detector.scan(25)).toEqual([
      { attemptId: ATTEMPT_ID, runId: RUN_ID, disposition: 'lost' },
    ]);
    expect(await detector.scan(25)).toEqual([]);

    expect(
      await env.DB_CONTROL.prepare(
        'SELECT state, version FROM runs WHERE run_id = ?',
      )
        .bind(RUN_ID)
        .first(),
    ).toEqual({ state: 'blocked', version: 4 });
    expect(
      await env.DB_CONTROL.prepare(
        `SELECT status, version, lease_generation, lease_expires_at
         FROM attempts WHERE attempt_id = ?`,
      )
        .bind(ATTEMPT_ID)
        .first(),
    ).toEqual({ status: 'lost', version: 6, lease_generation: 3, lease_expires_at: null });
    expect(
      await env.DB_CONTROL.prepare(
        `SELECT revoked_at FROM attempt_tokens WHERE attempt_id = ?`,
      )
        .bind(ATTEMPT_ID)
        .first<{ revoked_at: string | null }>(),
    ).toMatchObject({ revoked_at: NOW.toISOString() });
    expect(
      await env.DB_CONTROL.prepare(
        `SELECT reason, revoked_lease_generation FROM attempt_revocations
         WHERE attempt_id = ?`,
      )
        .bind(ATTEMPT_ID)
        .first(),
    ).toEqual({ reason: 'heartbeat_timeout', revoked_lease_generation: 2 });

    const lateHeartbeat = await SELF.fetch(`${BASE_URL}/v1/attempts/${ATTEMPT_ID}/heartbeat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${RAW_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: 5, leaseGeneration: 2 }),
    });
    expect(lateHeartbeat.status).toBe(401);
    expect((await callTool()).status).toBe(401);
  });
});
