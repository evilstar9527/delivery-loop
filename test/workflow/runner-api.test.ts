/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import { RunnerAttemptStore } from '../../src/storage/runner-attempt-store.js';

const BASE_URL = 'https://delivery-loop.test';
const RAW_TOKEN = 'runner-token-before-first-heartbeat';
const RAW_TOOL_TOKEN = 'runner-tool-token-before-first-heartbeat';
const RUN_ID = 'run-runner-api';
const ATTEMPT_ID = 'attempt-runner-api';
const PLAN_ID = 'plan-runner-api';
const BASE_SHA = '1'.repeat(40);
const PLAN_DIGEST = `sha256:${'2'.repeat(64)}`;

async function runnerPost(path: string, token: string, body: unknown): Promise<Response> {
  return await SELF.fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function seedRunner(): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (
         'task-runner-api', 'manual', 'runner-api-test', 'runner-api-test', '1', ?,
         'r2://tasks/runner-api', 'system', 'runner-api-test', 'example/repo',
         'main', 'test', 'bug', 'Runner API test', 'p1', 1, 0, 0, 0, 1, ?, ?
       )`,
    ).bind(`sha256:${'3'.repeat(64)}`, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, created_at, updated_at
       ) VALUES (?, 'task-runner-api', '1', ?, ?, ?, 'planning', 1, ?, ?)`,
    ).bind(RUN_ID, `sha256:${'3'.repeat(64)}`, BASE_SHA, RUN_ID, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, github_run_id, version, lease_generation,
         lease_token_digest, lease_expires_at, heartbeat_at, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'running', ?, 'example/repo',
                 'example/repo/.github/workflows/delivery-agent.yml@refs/heads/main',
                 '123456', 1, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      RUN_ID,
      BASE_SHA,
      `sha256:${'4'.repeat(64)}`,
      expiresAt,
      nowIso,
      nowIso,
      nowIso,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest, tool_token_digest,
         lease_generation, scopes_json, expires_at, created_at
       ) VALUES ('token-runner-api', ?, ?, ?, ?, 1, '["repo:read"]', ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      `sha256:${'5'.repeat(64)}`,
      await canonicalSha256(RAW_TOKEN),
      await canonicalSha256(RAW_TOOL_TOKEN),
      expiresAt,
      nowIso,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, '1', ?, ?, 'validated', ?, 'Runner result plan', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, ATTEMPT_ID, nowIso, nowIso),
  ]);
}

beforeEach(async () => {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM attempt_revocations'),
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
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM idempotency_keys'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  await seedRunner();
});

describe('authenticated Runner heartbeat and result API', () => {
  it('CAS-renews one of 20 concurrent heartbeats and rotates the opaque token', async () => {
    const body = { expectedVersion: 1, leaseGeneration: 1 };
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        runnerPost(`/v1/attempts/${ATTEMPT_ID}/heartbeat`, RAW_TOKEN, body),
      ),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    const winner = responses.find((response) => response.status === 200);
    if (winner === undefined) throw new Error('missing heartbeat winner');
    const result = (await winner.json()) as {
      attemptToken: string;
      toolBridgeToken: string;
      version: number;
      leaseGeneration: number;
      expiresAt: string;
    };
    expect(result).toMatchObject({ version: 2, leaseGeneration: 1 });
    expect(result.attemptToken).not.toBe(RAW_TOKEN);
    expect(result.toolBridgeToken).not.toBe(RAW_TOOL_TOKEN);
    expect(result.toolBridgeToken).not.toBe(result.attemptToken);

    const row = await env.DB_CONTROL.prepare(
      `SELECT attempts.version, attempts.lease_generation, attempts.lease_expires_at,
              attempts.heartbeat_at, attempt_tokens.token_digest,
              attempt_tokens.tool_token_digest, attempt_tokens.expires_at
       FROM attempts JOIN attempt_tokens ON attempt_tokens.attempt_id = attempts.attempt_id
       WHERE attempts.attempt_id = ?`,
    )
      .bind(ATTEMPT_ID)
      .first<{
        version: number;
        lease_generation: number;
        lease_expires_at: string;
        heartbeat_at: string;
        token_digest: string;
        tool_token_digest: string;
        expires_at: string;
      }>();
    expect(row).toMatchObject({
      version: 2,
      lease_generation: 1,
      lease_expires_at: result.expiresAt,
      token_digest: await canonicalSha256(result.attemptToken),
      tool_token_digest: await canonicalSha256(result.toolBridgeToken),
      expires_at: result.expiresAt,
    });
    expect(row?.heartbeat_at).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(result.attemptToken);
    expect(JSON.stringify(row)).not.toContain(result.toolBridgeToken);
    const receipt = await env.DB_CONTROL.prepare(
      `SELECT heartbeat_id, previous_attempt_version, attempt_version,
              previous_heartbeat_at, heartbeat_at, lease_expires_at
       FROM attempt_heartbeat_receipts WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first<Record<string, unknown>>();
    expect(receipt).toMatchObject({
      previous_attempt_version: 1,
      attempt_version: 2,
      heartbeat_at: row?.heartbeat_at,
      lease_expires_at: result.expiresAt,
    });
    expect(receipt?.heartbeat_id).toMatch(/^heartbeat_[a-f0-9]{54}$/);
    expect(JSON.stringify(receipt)).not.toContain('token');

    const stale = await runnerPost(
      `/v1/attempts/${ATTEMPT_ID}/heartbeat`,
      RAW_TOKEN,
      body,
    );
    expect(stale.status).toBe(401);
    const staleTool = await SELF.fetch(
      `${BASE_URL}/v1/attempts/${ATTEMPT_ID}/tools/call`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${RAW_TOOL_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          toolPath: 'repo/read',
          arguments: { path: 'src/index.ts' },
        }),
      },
    );
    expect(staleTool.status).toBe(401);
  });

  it('persists consecutive 45-second heartbeat receipts without token material', async () => {
    const initial = await env.DB_CONTROL.prepare(
      'SELECT heartbeat_at FROM attempts WHERE attempt_id = ?',
    ).bind(ATTEMPT_ID).first<{ heartbeat_at: string }>();
    if (initial === null) throw new Error('missing initial heartbeat');
    const firstAt = new Date(Date.parse(initial.heartbeat_at) + 45_000);
    const store = new RunnerAttemptStore(env.DB_CONTROL);
    const first = await store.heartbeat(
      ATTEMPT_ID,
      RAW_TOKEN,
      { expectedVersion: 1, leaseGeneration: 1 },
      firstAt,
    );
    const secondAt = new Date(firstAt.getTime() + 45_000);
    await store.heartbeat(
      ATTEMPT_ID,
      first.attemptToken,
      { expectedVersion: 2, leaseGeneration: 1 },
      secondAt,
    );
    const receipts = await env.DB_CONTROL.prepare(
      `SELECT previous_attempt_version, attempt_version, previous_heartbeat_at,
              heartbeat_at, lease_expires_at
       FROM attempt_heartbeat_receipts WHERE attempt_id = ? ORDER BY attempt_version`,
    ).bind(ATTEMPT_ID).all<Record<string, unknown>>();
    expect(receipts.results).toEqual([
      {
        previous_attempt_version: 1,
        attempt_version: 2,
        previous_heartbeat_at: initial.heartbeat_at,
        heartbeat_at: firstAt.toISOString(),
        lease_expires_at: new Date(firstAt.getTime() + 90_000).toISOString(),
      },
      {
        previous_attempt_version: 2,
        attempt_version: 3,
        previous_heartbeat_at: firstAt.toISOString(),
        heartbeat_at: secondAt.toISOString(),
        lease_expires_at: new Date(secondAt.getTime() + 90_000).toISOString(),
      },
    ]);
  });

  it('persists a reference-only result and outbox without trusting GitHub self-report', async () => {
    const heartbeat = await runnerPost(
      `/v1/attempts/${ATTEMPT_ID}/heartbeat`,
      RAW_TOKEN,
      { expectedVersion: 1, leaseGeneration: 1 },
    );
    expect(heartbeat.status).toBe(200);
    const heartbeatBody = (await heartbeat.json()) as {
      attemptToken: string;
      toolBridgeToken: string;
      version: number;
    };
    const response = await runnerPost(
      `/v1/attempts/${ATTEMPT_ID}/complete`,
      heartbeatBody.attemptToken,
      {
        schemaVersion: '1',
        eventId: 'runner-result-event-1',
        sequence: 1,
        payloadRef: `d1://execution-plans/${PLAN_ID}`,
        digest: PLAN_DIGEST,
        occurredAt: new Date().toISOString(),
        expectedVersion: heartbeatBody.version,
        leaseGeneration: 1,
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true });
    const revokedTool = await SELF.fetch(
      `${BASE_URL}/v1/attempts/${ATTEMPT_ID}/tools/call`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${heartbeatBody.toolBridgeToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          toolPath: 'repo/read',
          arguments: { path: 'src/index.ts' },
        }),
      },
    );
    expect(revokedTool.status).toBe(401);

    const attempt = await env.DB_CONTROL.prepare(
      `SELECT status, version, result_event_id, result_sequence, result_payload_ref,
              result_digest, result_reported_at, github_status, github_conclusion
       FROM attempts WHERE attempt_id = ?`,
    )
      .bind(ATTEMPT_ID)
      .first<Record<string, unknown>>();
    expect(attempt).toMatchObject({
      status: 'running',
      version: 3,
      result_event_id: 'runner-result-event-1',
      result_sequence: 1,
      result_payload_ref: `d1://execution-plans/${PLAN_ID}`,
      result_digest: PLAN_DIGEST,
      github_status: null,
      github_conclusion: null,
    });
    expect(attempt?.result_reported_at).toBeTruthy();
    const signalCount = await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM workflow_signals WHERE run_id = ?',
    )
      .bind(RUN_ID)
      .first<{ count: number }>();
    const outboxCount = await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox
       WHERE run_id = ? AND kind = 'workflow_signal' AND delivery_state = 'pending'`,
    )
      .bind(RUN_ID)
      .first<{ count: number }>();
    expect(signalCount?.count).toBe(1);
    expect(outboxCount?.count).toBe(1);
    expect(
      await env.DB_CONTROL.prepare(
        `SELECT reason, revoked_lease_generation, attempt_version
         FROM attempt_revocations WHERE attempt_id = ?`,
      )
        .bind(ATTEMPT_ID)
        .first(),
    ).toEqual({
      reason: 'completed',
      revoked_lease_generation: 1,
      attempt_version: 3,
    });

    const replay = await runnerPost(
      `/v1/attempts/${ATTEMPT_ID}/complete`,
      heartbeatBody.attemptToken,
      {
        schemaVersion: '1',
        eventId: 'runner-result-event-1',
        sequence: 1,
        payloadRef: `d1://execution-plans/${PLAN_ID}`,
        digest: PLAN_DIGEST,
        occurredAt: new Date().toISOString(),
        expectedVersion: heartbeatBody.version,
        leaseGeneration: 1,
      },
    );
    expect(replay.status).toBe(401);
  });

  it('accepts sequence one independently for two analysis attempts in the same Run', async () => {
    const store = new RunnerAttemptStore(env.DB_CONTROL);
    const now = new Date();
    const first = await store.complete(
      ATTEMPT_ID,
      RAW_TOKEN,
      {
        schemaVersion: '1',
        eventId: 'runner-result-event-first-attempt',
        sequence: 1,
        payloadRef: `d1://execution-plans/${PLAN_ID}`,
        digest: PLAN_DIGEST,
        occurredAt: now.toISOString(),
        expectedVersion: 1,
        leaseGeneration: 1,
      },
      now,
    );

    const secondAttemptId = 'attempt-runner-api-replan';
    const secondPlanId = 'plan-runner-api-replan';
    const secondPlanDigest = `sha256:${'6'.repeat(64)}`;
    const secondToken = 'runner-token-replan-attempt';
    const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, github_run_id, version, lease_generation,
           lease_token_digest, lease_expires_at, heartbeat_at, created_at, updated_at
         ) VALUES (?, ?, 2, 'analysis', 'running', ?, 'example/repo',
                   'example/repo/.github/workflows/delivery-agent.yml@refs/heads/main',
                   '123457', 1, 1, ?, ?, ?, ?, ?)`,
      ).bind(
        secondAttemptId,
        RUN_ID,
        BASE_SHA,
        `sha256:${'7'.repeat(64)}`,
        expiresAt,
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempt_tokens (
           token_id, attempt_id, oidc_token_digest, token_digest, tool_token_digest,
           lease_generation, scopes_json, expires_at, created_at
         ) VALUES ('token-runner-api-replan', ?, ?, ?, ?, 1, '["repo:read"]', ?, ?)`,
      ).bind(
        secondAttemptId,
        `sha256:${'8'.repeat(64)}`,
        await canonicalSha256(secondToken),
        `sha256:${'9'.repeat(64)}`,
        expiresAt,
        now.toISOString(),
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO execution_plans (
           plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
           created_by_attempt_id, objective, created_at, updated_at
         ) VALUES (?, ?, 2, '1', ?, ?, 'validated', ?,
                   'Runner replan result', ?, ?)`,
      ).bind(
        secondPlanId,
        RUN_ID,
        BASE_SHA,
        secondPlanDigest,
        secondAttemptId,
        now.toISOString(),
        now.toISOString(),
      ),
    ]);

    const second = await store.complete(
      secondAttemptId,
      secondToken,
      {
        schemaVersion: '1',
        eventId: 'runner-result-event-second-attempt',
        sequence: 1,
        payloadRef: `d1://execution-plans/${secondPlanId}`,
        digest: secondPlanDigest,
        occurredAt: now.toISOString(),
        expectedVersion: 1,
        leaseGeneration: 1,
      },
      now,
    );

    expect(first.signalId).not.toBe(second.signalId);
    expect(await env.DB_CONTROL.prepare(
      `SELECT attempt_id, sequence FROM workflow_signals
       WHERE run_id = ? ORDER BY attempt_id`,
    ).bind(RUN_ID).all()).toMatchObject({
      results: [
        { attempt_id: ATTEMPT_ID, sequence: 1 },
        { attempt_id: secondAttemptId, sequence: 1 },
      ],
    });
  });

  it('rejects stale generation, expired token, and untrusted result fields without echoing them', async () => {
    const staleGeneration = await runnerPost(
      `/v1/attempts/${ATTEMPT_ID}/heartbeat`,
      RAW_TOKEN,
      { expectedVersion: 1, leaseGeneration: 2 },
    );
    expect(staleGeneration.status).toBe(409);

    const canary = 'CANARY_UNTRUSTED_GITHUB_CONCLUSION';
    const untrusted = await runnerPost(
      `/v1/attempts/${ATTEMPT_ID}/complete`,
      RAW_TOKEN,
      {
        schemaVersion: '1',
        eventId: 'runner-result-event-invalid',
        sequence: 1,
        payloadRef: `d1://execution-plans/${PLAN_ID}`,
        digest: PLAN_DIGEST,
        occurredAt: new Date().toISOString(),
        expectedVersion: 1,
        leaseGeneration: 1,
        githubConclusion: canary,
      },
    );
    expect(untrusted.status).toBe(400);
    expect(await untrusted.text()).not.toContain(canary);

    await env.DB_CONTROL.prepare(
      'UPDATE attempt_tokens SET expires_at = ? WHERE attempt_id = ?',
    )
      .bind(new Date(Date.now() - 1_000).toISOString(), ATTEMPT_ID)
      .run();
    const expired = await runnerPost(
      `/v1/attempts/${ATTEMPT_ID}/heartbeat`,
      RAW_TOKEN,
      { expectedVersion: 1, leaseGeneration: 1 },
    );
    expect(expired.status).toBe(401);
  });
});

describe('runner startup stage diagnostic endpoint', () => {
  it('records a stage row for a valid attempt token and returns 202', async () => {
    const response = await runnerPost(
      `/v1/attempts/${ATTEMPT_ID}/runner-stage`,
      RAW_TOKEN,
      { stage: 'reserving_model' },
    );
    expect(response.status).toBe(202);
    const rows = await env.DB_CONTROL.prepare(
      `SELECT stage FROM runner_startup_stages WHERE attempt_id = ? ORDER BY recorded_at`,
    ).bind(ATTEMPT_ID).all<{ stage: string }>();
    expect(rows.results.map((r) => r.stage)).toEqual(['reserving_model']);
  });

  it('keeps repeated stages as distinct ordered rows (per-invocation reserve loop)', async () => {
    // Two reservations then launch — the shape a diagnosticMediation analysis
    // attempt produces; a frozen one would stop before 'launching_heartbeat'.
    for (const stage of ['reserving_model', 'reserved_model', 'reserving_model'] as const) {
      const r = await runnerPost(`/v1/attempts/${ATTEMPT_ID}/runner-stage`, RAW_TOKEN, { stage });
      expect(r.status).toBe(202);
    }
    const rows = await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS n FROM runner_startup_stages WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first<{ n: number }>();
    expect(rows?.n).toBe(3);
  });

  it('rejects an unknown attempt token with 401 and writes nothing', async () => {
    const response = await runnerPost(
      `/v1/attempts/${ATTEMPT_ID}/runner-stage`,
      'not-a-real-token',
      { stage: 'exchanged' },
    );
    expect(response.status).toBe(401);
    const rows = await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS n FROM runner_startup_stages WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('rejects an unknown stage value with 400', async () => {
    const response = await runnerPost(
      `/v1/attempts/${ATTEMPT_ID}/runner-stage`,
      RAW_TOKEN,
      { stage: 'not_a_stage' },
    );
    expect(response.status).toBe(400);
  });
});
