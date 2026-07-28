/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  QUOTA_RESOURCES,
  QUOTA_SCOPE_TYPES,
} from '../../src/domain/quota.js';
import {
  QuotaControlError,
  QuotaControlStore,
} from '../../src/storage/quota-control-store.js';
import {
  QuotaOverrideError,
  QuotaOverrideStore,
} from '../../src/storage/quota-override-store.js';
import { canonicalSha256 } from '../../src/domain/digest.js';

const NOW = new Date('2026-07-26T10:00:00.000Z');
const LATER = new Date('2026-07-26T10:01:00.000Z');
const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

interface SeededRun {
  taskId: string;
  runId: string;
  tenant: string;
  repository: string;
  principal: string;
}

async function seedRun(
  suffix: string,
  options: { priority?: 'p0' | 'p1'; tenant?: string; repository?: string; principal?: string } = {},
): Promise<SeededRun> {
  const taskId = `task_quota_${suffix}`;
  const runId = `run_quota_${suffix}`;
  const tenant = options.tenant ?? `tenant-${suffix}`;
  const repository = options.repository ?? `example/repo-${suffix}`;
  const principal = options.principal ?? `user:user-${suffix}`;
  const now = NOW.toISOString();
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'manual', ?, ?, '1', ?, ?, 'user', ?, ?, 'main', 'test',
                 'bug', 'quota test', ?, 1, 0, 0, 0, 1, ?, ?)`,
    ).bind(
      taskId,
      tenant,
      suffix,
      DIGEST,
      `r2://tasks/${taskId}.json`,
      principal,
      repository,
      options.priority ?? 'p1',
      now,
      now,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, created_at, updated_at
       ) VALUES (?, ?, '1', ?, ?, ?, 'queued', 0, ?, ?)`,
    ).bind(runId, taskId, DIGEST, SHA, runId, now, now),
  ]);
  return { taskId, runId, tenant, repository, principal };
}

async function seedAttempt(runId: string, suffix: string, ordinal: number): Promise<string> {
  const attemptId = `attempt_quota_${suffix}`;
  await env.DB_CONTROL.prepare(
    `INSERT INTO attempts (
       attempt_id, run_id, ordinal, mode, status, base_sha,
       version, lease_generation, created_at, updated_at
     ) VALUES (?, ?, ?, 'analysis', 'pending', ?, 0, 0, ?, ?)`,
  ).bind(attemptId, runId, ordinal, SHA, NOW.toISOString(), NOW.toISOString()).run();
  return attemptId;
}

async function exactPolicy(
  scopeType: string,
  scopeKey: string,
  resource: string,
  limit: number,
): Promise<void> {
  await env.DB_CONTROL.prepare(
    `INSERT INTO quota_policies (
       policy_id, scope_type, scope_key, resource_type, limit_value,
       window_kind, enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(scope_type, scope_key, resource_type)
     DO UPDATE SET limit_value = excluded.limit_value, updated_at = excluded.updated_at`,
  ).bind(
    `policy_${scopeType}_${crypto.randomUUID()}`,
    scopeType,
    scopeKey,
    resource,
    limit,
    resource === 'concurrency' ? 'instant' : scopeType === 'run' ? 'run_lifetime' : 'utc_day',
    NOW.toISOString(),
    NOW.toISOString(),
  ).run();
}

async function seedModelProfile(
  suffix: string,
  options: {
    maxInputTokens?: number;
    maxOutputTokens?: number;
    inputMicrousdPerMillion?: number;
    cachedInputMicrousdPerMillion?: number;
    outputMicrousdPerMillion?: number;
  } = {},
): Promise<string> {
  const profileId = `profile-${suffix}`;
  await env.DB_CONTROL.prepare(
    `INSERT INTO quota_model_profiles (
       profile_id, provider, model, max_input_tokens, max_output_tokens,
       input_microusd_per_million, cached_input_microusd_per_million,
       output_microusd_per_million, enabled, created_at, updated_at
     ) VALUES (?, 'openai', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).bind(
    profileId,
    `test-${suffix}`,
    options.maxInputTokens ?? 40,
    options.maxOutputTokens ?? 40,
    options.inputMicrousdPerMillion ?? 10_000_000,
    options.cachedInputMicrousdPerMillion ?? 1_000_000,
    options.outputMicrousdPerMillion ?? 10_000_000,
    NOW.toISOString(),
    NOW.toISOString(),
  ).run();
  return profileId;
}

beforeEach(async () => {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM quota_denials'),
    env.DB_CONTROL.prepare('DELETE FROM model_usage'),
    env.DB_CONTROL.prepare('DELETE FROM quota_model_reservations'),
    env.DB_CONTROL.prepare('DELETE FROM quota_tool_call_admissions'),
    env.DB_CONTROL.prepare('DELETE FROM quota_concurrency_reservations'),
    env.DB_CONTROL.prepare('DELETE FROM quota_overrides'),
    env.DB_CONTROL.prepare('DELETE FROM quota_override_source_events'),
    env.DB_CONTROL.prepare("DELETE FROM quota_policies WHERE scope_key <> '*'"),
    env.DB_CONTROL.prepare('DELETE FROM identity_mappings'),
    env.DB_CONTROL.prepare('DELETE FROM channel_identities'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
});

describe('durable multi-dimensional quota control', () => {
  it('installs every resource limit for tenant/repository/user/run', async () => {
    const rows = await env.DB_CONTROL.prepare(
      `SELECT scope_type, resource_type, limit_value, window_kind
       FROM quota_policies WHERE scope_key = '*' AND enabled = 1`,
    ).all<{ scope_type: string; resource_type: string; limit_value: number; window_kind: string }>();
    expect(rows.results).toHaveLength(QUOTA_SCOPE_TYPES.length * QUOTA_RESOURCES.length);
    for (const scopeType of QUOTA_SCOPE_TYPES) {
      for (const resource of QUOTA_RESOURCES) {
        expect(rows.results).toContainEqual(expect.objectContaining({
          scope_type: scopeType,
          resource_type: resource,
          limit_value: expect.any(Number),
        }));
      }
    }
  });

  it('keeps trusted model pricing immutable and bounded by the reserved worst case', async () => {
    await expect(env.DB_CONTROL.prepare(
      `INSERT INTO quota_model_profiles (
         profile_id, provider, model, max_input_tokens, max_output_tokens,
         input_microusd_per_million, cached_input_microusd_per_million,
         output_microusd_per_million, enabled, created_at, updated_at
       ) VALUES ('profile-invalid-price', 'openai', 'invalid-price', 10, 10,
                 100, 101, 100, 1, ?, ?)`,
    ).bind(NOW.toISOString(), NOW.toISOString()).run()).rejects.toThrow();
    const profileId = await seedModelProfile('immutable-price');
    await expect(env.DB_CONTROL.prepare(
      `UPDATE quota_model_profiles
       SET input_microusd_per_million = 1, updated_at = ? WHERE profile_id = ?`,
    ).bind(LATER.toISOString(), profileId).run())
      .rejects.toThrow('quota_model_profile_is_immutable');
  });

  it('enforces attempt limits in D1 for every producer and keeps idempotent retries valid', async () => {
    for (const [index, scopeType] of QUOTA_SCOPE_TYPES.entries()) {
      const run = await seedRun(`attempt-${scopeType}`);
      const scopeKey = {
        tenant: run.tenant,
        repository: run.repository,
        user: run.principal,
        run: run.runId,
      }[scopeType]!;
      await exactPolicy(scopeType, scopeKey, 'attempt', 1);
      const first = await seedAttempt(run.runId, `${index}-first`, 1);
      await expect(seedAttempt(run.runId, `${index}-second`, 2)).rejects.toThrow('quota_attempt_exceeded');
      await expect(
        env.DB_CONTROL.prepare(
          `INSERT INTO attempts (
             attempt_id, run_id, ordinal, mode, status, base_sha,
             version, lease_generation, created_at, updated_at
           ) VALUES (?, ?, 1, 'analysis', 'pending', ?, 0, 0, ?, ?)
           ON CONFLICT(attempt_id) DO NOTHING`,
        ).bind(first, run.runId, SHA, NOW.toISOString(), NOW.toISOString()).run(),
      ).resolves.toBeDefined();
    }
  });

  it('atomically admits only one concurrent Attempt and safely releases/recovers reservations', async () => {
    const run = await seedRun('concurrency');
    const first = await seedAttempt(run.runId, 'concurrency-first', 1);
    const second = await seedAttempt(run.runId, 'concurrency-second', 2);
    await exactPolicy('run', run.runId, 'concurrency', 1);
    const stores = Array.from({ length: 20 }, () => new QuotaControlStore(env.DB_CONTROL));
    const outcomes = await Promise.allSettled([
      ...stores.slice(0, 10).map((store) => store.reserveAttemptConcurrency(first, NOW)),
      ...stores.slice(10).map((store) => store.reserveAttemptConcurrency(second, NOW)),
    ]);
    const admittedAttempts = new Set(
      outcomes.flatMap((result) => result.status === 'fulfilled' ? [result.value.attemptId] : []),
    );
    expect(admittedAttempts.size).toBe(1);
    expect(outcomes.filter((result) => result.status === 'rejected').length).toBeGreaterThan(0);
    for (const rejected of outcomes.filter((result): result is PromiseRejectedResult => result.status === 'rejected')) {
      expect(rejected.reason).toBeInstanceOf(QuotaControlError);
      expect((rejected.reason as QuotaControlError).code).toBe('quota_exceeded');
    }

    const admitted = [...admittedAttempts][0]!;
    const other = admitted === first ? second : first;
    const duplicate = await new QuotaControlStore(env.DB_CONTROL).reserveAttemptConcurrency(admitted, LATER);
    expect(duplicate.disposition).toBe('existing');
    await new QuotaControlStore(env.DB_CONTROL).releaseAttemptConcurrency(admitted, LATER, 'attempt_terminal');
    await expect(
      new QuotaControlStore(env.DB_CONTROL).reserveAttemptConcurrency(other, LATER),
    ).resolves.toMatchObject({ attemptId: other, disposition: 'created' });
    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'completed', updated_at = ? WHERE attempt_id = ?`,
    ).bind(LATER.toISOString(), other).run();
    const third = await seedAttempt(run.runId, 'concurrency-third', 3);
    await expect(
      new QuotaControlStore(env.DB_CONTROL).reserveAttemptConcurrency(third, LATER),
    ).resolves.toMatchObject({ attemptId: third, disposition: 'created' });
  });

  it('re-arms a released stable concurrency reservation before an outbox retry', async () => {
    const run = await seedRun('concurrency-rearm');
    const first = await seedAttempt(run.runId, 'concurrency-rearm-first', 1);
    const second = await seedAttempt(run.runId, 'concurrency-rearm-second', 2);
    await exactPolicy('run', run.runId, 'concurrency', 1);
    const store = new QuotaControlStore(env.DB_CONTROL);
    await store.reserveAttemptConcurrency(first, NOW);
    await store.releaseAttemptConcurrency(first, LATER, 'effect_failed');
    await expect(store.reserveAttemptConcurrency(first, LATER)).resolves.toMatchObject({
      attemptId: first,
      disposition: 'existing',
    });
    await expect(store.reserveAttemptConcurrency(second, LATER)).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    const reservation = await env.DB_CONTROL.prepare(
      `SELECT released_at, release_reason
       FROM quota_concurrency_reservations WHERE attempt_id = ?`,
    ).bind(first).first<Record<string, unknown>>();
    expect(reservation).toEqual({ released_at: null, release_reason: null });
  });

  it('enforces tenant concurrency and repository tool-call budgets across Runs', async () => {
    const firstTenantRun = await seedRun('tenant-concurrency-a', {
      tenant: 'tenant-shared-concurrency',
    });
    const secondTenantRun = await seedRun('tenant-concurrency-b', {
      tenant: 'tenant-shared-concurrency',
    });
    const firstTenantAttempt = await seedAttempt(firstTenantRun.runId, 'tenant-concurrency-a', 1);
    const secondTenantAttempt = await seedAttempt(secondTenantRun.runId, 'tenant-concurrency-b', 1);
    await exactPolicy('tenant', 'tenant-shared-concurrency', 'concurrency', 1);
    const quota = new QuotaControlStore(env.DB_CONTROL);
    await quota.reserveAttemptConcurrency(firstTenantAttempt, NOW);
    await expect(quota.reserveAttemptConcurrency(secondTenantAttempt, NOW)).rejects.toMatchObject({
      code: 'quota_exceeded',
    });

    const firstRepositoryRun = await seedRun('repository-tool-a', {
      repository: 'example/shared-tool-repo',
    });
    const secondRepositoryRun = await seedRun('repository-tool-b', {
      repository: 'example/shared-tool-repo',
    });
    const firstRepositoryAttempt = await seedAttempt(firstRepositoryRun.runId, 'repository-tool-a', 1);
    const secondRepositoryAttempt = await seedAttempt(secondRepositoryRun.runId, 'repository-tool-b', 1);
    await exactPolicy('repository', 'example/shared-tool-repo', 'tool_call', 1);
    await quota.admitToolCall({
      traceId: 'tooltrace_repository_a',
      attemptId: firstRepositoryAttempt,
      occurredAt: NOW.toISOString(),
    });
    await expect(quota.admitToolCall({
      traceId: 'tooltrace_repository_b',
      attemptId: secondRepositoryAttempt,
      occurredAt: NOW.toISOString(),
    })).rejects.toMatchObject({ code: 'quota_exceeded' });

    const denials = await env.DB_CONTROL.prepare(
      `SELECT request_id, resource_type, scope_type FROM quota_denials
       WHERE request_id IN (?, ?) ORDER BY request_id`,
    ).bind(secondTenantAttempt, 'tooltrace_repository_b')
      .all<Record<string, unknown>>();
    expect(denials.results).toEqual([
      {
        request_id: secondTenantAttempt,
        resource_type: 'concurrency',
        scope_type: 'tenant',
      },
      {
        request_id: 'tooltrace_repository_b',
        resource_type: 'tool_call',
        scope_type: 'repository',
      },
    ]);
  });

  it('enforces user token and tenant/repository model-cost budgets across Runs', async () => {
    const quota = new QuotaControlStore(env.DB_CONTROL);
    const profileId = await seedModelProfile('cross-scope-model');

    const firstUserRun = await seedRun('user-model-a', { principal: 'user:shared-model-user' });
    const secondUserRun = await seedRun('user-model-b', { principal: 'user:shared-model-user' });
    const firstUserAttempt = await seedAttempt(firstUserRun.runId, 'user-model-a', 1);
    const secondUserAttempt = await seedAttempt(secondUserRun.runId, 'user-model-b', 1);
    await exactPolicy('user', 'user:shared-model-user', 'model_tokens', 100);
    await quota.reserveModelCall({
      reservationId: 'reservation_user_model_a',
      attemptId: firstUserAttempt,
      profileId,
      occurredAt: NOW.toISOString(),
    });
    await expect(quota.reserveModelCall({
      reservationId: 'reservation_user_model_b',
      attemptId: secondUserAttempt,
      profileId,
      occurredAt: NOW.toISOString(),
    })).rejects.toMatchObject({ code: 'quota_exceeded' });

    for (const [scopeType, scopeKey, seed] of [
      ['tenant', 'tenant-shared-model-cost', 'tenant-cost'],
      ['repository', 'example/shared-model-cost', 'repository-cost'],
    ] as const) {
      const first = await seedRun(`${seed}-a`, scopeType === 'tenant'
        ? { tenant: scopeKey }
        : { repository: scopeKey });
      const second = await seedRun(`${seed}-b`, scopeType === 'tenant'
        ? { tenant: scopeKey }
        : { repository: scopeKey });
      const firstAttempt = await seedAttempt(first.runId, `${seed}-a`, 1);
      const secondAttempt = await seedAttempt(second.runId, `${seed}-b`, 1);
      await exactPolicy(scopeType, scopeKey, 'model_cost_microusd', 1_000);
      await quota.reserveModelCall({
        reservationId: `reservation_${seed}_a`,
        attemptId: firstAttempt,
        profileId,
        occurredAt: NOW.toISOString(),
      });
      await expect(quota.reserveModelCall({
        reservationId: `reservation_${seed}_b`,
        attemptId: secondAttempt,
        profileId,
        occurredAt: NOW.toISOString(),
      })).rejects.toMatchObject({ code: 'quota_exceeded' });
    }

    const denials = await env.DB_CONTROL.prepare(
      `SELECT request_id, resource_type, scope_type FROM quota_denials
       WHERE request_id IN (?, ?, ?) ORDER BY request_id`,
    ).bind(
      'reservation_user_model_b',
      'reservation_tenant-cost_b',
      'reservation_repository-cost_b',
    ).all<Record<string, unknown>>();
    expect(denials.results).toEqual([
      {
        request_id: 'reservation_repository-cost_b',
        resource_type: 'model_cost_microusd',
        scope_type: 'repository',
      },
      {
        request_id: 'reservation_tenant-cost_b',
        resource_type: 'model_cost_microusd',
        scope_type: 'tenant',
      },
      {
        request_id: 'reservation_user_model_b',
        resource_type: 'model_tokens',
        scope_type: 'user',
      },
    ]);
  });

  it('reserves token/cost before model execution, then stores Watt-style per-call usage exactly once', async () => {
    const run = await seedRun('model');
    const attemptId = await seedAttempt(run.runId, 'model', 1);
    await exactPolicy('run', run.runId, 'model_tokens', 100);
    await exactPolicy('run', run.runId, 'model_cost_microusd', 1_000);
    await env.DB_CONTROL.prepare(
      `INSERT INTO quota_model_profiles (
         profile_id, provider, model, max_input_tokens, max_output_tokens,
         input_microusd_per_million, cached_input_microusd_per_million,
         output_microusd_per_million, enabled, created_at, updated_at
       ) VALUES ('profile-test', 'openai', 'test-model', 40, 40,
                 10000000, 1000000, 10000000, 1, ?, ?)`,
    ).bind(NOW.toISOString(), NOW.toISOString()).run();
    const store = new QuotaControlStore(env.DB_CONTROL);
    const reservation = await store.reserveModelCall({
      reservationId: 'model_reservation_1',
      attemptId,
      profileId: 'profile-test',
      occurredAt: NOW.toISOString(),
    });
    expect(reservation).toMatchObject({
      provider: 'openai',
      model: 'test-model',
      reservedTokens: 80,
      reservedCostMicrousd: 800,
      disposition: 'created',
    });
    await expect(store.reserveModelCall({
      reservationId: 'model_reservation_1',
      attemptId,
      profileId: 'profile-test',
      occurredAt: LATER.toISOString(),
    })).resolves.toMatchObject({ disposition: 'existing' });
    await expect(store.reserveModelCall({
      reservationId: 'model_reservation_2',
      attemptId,
      profileId: 'profile-test',
      occurredAt: NOW.toISOString(),
    })).rejects.toMatchObject({ code: 'quota_exceeded' });

    const settled = await store.settleModelCall({
      reservationId: reservation.reservationId,
      usageId: 'usage_model_1',
      attemptId,
      inputTokens: 20,
      cachedInputTokens: 10,
      outputTokens: 20,
      reasoningOutputTokens: 5,
      occurredAt: LATER.toISOString(),
    });
    expect(settled).toMatchObject({
      usageId: 'usage_model_1',
      totalTokens: 40,
      costMicrousd: 310,
      disposition: 'created',
    });
    await expect(store.settleModelCall({
      reservationId: reservation.reservationId,
      usageId: 'usage_model_1',
      attemptId,
      inputTokens: 20,
      cachedInputTokens: 10,
      outputTokens: 20,
      reasoningOutputTokens: 5,
      occurredAt: LATER.toISOString(),
    })).resolves.toMatchObject({ disposition: 'existing' });
    await expect(store.reserveModelCall({
      reservationId: 'model_reservation_1',
      attemptId,
      profileId: 'profile-test',
      occurredAt: LATER.toISOString(),
    })).rejects.toMatchObject({ code: 'state_conflict' });
    const row = await env.DB_CONTROL.prepare(
      `SELECT provider, model, input_tokens, cached_input_tokens, output_tokens,
              reasoning_output_tokens, cost_microusd
       FROM model_usage WHERE usage_id = 'usage_model_1'`,
    ).first<Record<string, unknown>>();
    expect(row).toEqual({
      provider: 'openai',
      model: 'test-model',
      input_tokens: 20,
      cached_input_tokens: 10,
      output_tokens: 20,
      reasoning_output_tokens: 5,
      cost_microusd: 310,
    });
  });

  it('admits tool calls before the upstream effect and records metadata-only denials', async () => {
    const run = await seedRun('tool');
    const attemptId = await seedAttempt(run.runId, 'tool', 1);
    await exactPolicy('run', run.runId, 'tool_call', 1);
    const store = new QuotaControlStore(env.DB_CONTROL);
    await expect(store.admitToolCall({
      traceId: 'tooltrace_quota_1',
      attemptId,
      occurredAt: NOW.toISOString(),
    })).resolves.toMatchObject({ disposition: 'created' });
    await expect(store.admitToolCall({
      traceId: 'tooltrace_quota_2',
      attemptId,
      occurredAt: NOW.toISOString(),
    })).rejects.toMatchObject({ code: 'quota_exceeded' });
    const denial = await env.DB_CONTROL.prepare(
      `SELECT run_id, attempt_id, resource_type, scope_type, reason_digest
       FROM quota_denials WHERE request_id = 'tooltrace_quota_2'`,
    ).first<Record<string, unknown>>();
    expect(denial).toMatchObject({
      run_id: run.runId,
      attempt_id: attemptId,
      resource_type: 'tool_call',
      scope_type: 'run',
      reason_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(denial)).not.toContain('arguments');
    expect(JSON.stringify(denial)).not.toContain('result');
  });

  it('requires an independent human audit record before a P0 multiplier applies', async () => {
    const run = await seedRun('p0', { priority: 'p0', principal: 'user:requester' });
    const first = await seedAttempt(run.runId, 'p0-first', 1);
    const second = await seedAttempt(run.runId, 'p0-second', 2);
    await exactPolicy('run', run.runId, 'concurrency', 1);
    const quota = new QuotaControlStore(env.DB_CONTROL);
    await quota.reserveAttemptConcurrency(first, NOW);
    await expect(quota.reserveAttemptConcurrency(second, NOW)).rejects.toMatchObject({
      code: 'quota_exceeded',
    });

    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO identity_mappings (principal, roles, created_at, updated_at)
         VALUES ('user:oncall', '["human","approve:quota_override"]', ?, ?)`,
      ).bind(NOW.toISOString(), NOW.toISOString()),
      env.DB_CONTROL.prepare(
        `INSERT INTO channel_identities (
           channel, channel_user_id, principal, created_at, updated_at
         ) VALUES (?, 'feishu-oncall', 'user:oncall', ?, ?)`,
      ).bind(`feishu:${run.tenant}`, NOW.toISOString(), NOW.toISOString()),
    ]);
    const override = await new QuotaOverrideStore(env.DB_CONTROL, { now: () => NOW }).decide({
      schemaVersion: '1',
      runId: run.runId,
      expectedRunVersion: 0,
      decision: 'approve',
      resources: ['concurrency'],
      reasonDigest: `sha256:${'c'.repeat(64)}`,
      expiresAt: '2026-07-26T12:00:00.000Z',
      source: {
        schemaVersion: '1',
        provider: 'feishu',
        tenantKey: run.tenant,
        externalEventId: 'event-quota-p0',
        externalSubject: 'feishu-oncall',
        eventDigest: `sha256:${'d'.repeat(64)}`,
        occurredAt: NOW.toISOString(),
      },
    });
    expect(override).toMatchObject({
      status: 'approved',
      principal: 'user:oncall',
      multiplier: 2,
      created: true,
    });
    await expect(quota.reserveAttemptConcurrency(second, LATER)).resolves.toMatchObject({
      attemptId: second,
      disposition: 'created',
      overrideId: override.overrideId,
    });
    const audit = await env.DB_CONTROL.prepare(
      `SELECT run_id, expected_run_version, resources_json, reason_digest,
              approver_principal, multiplier, status
       FROM quota_overrides WHERE override_id = ?`,
    ).bind(override.overrideId).first<Record<string, unknown>>();
    expect(audit).toMatchObject({
      run_id: run.runId,
      expected_run_version: 0,
      resources_json: '["concurrency"]',
      reason_digest: `sha256:${'c'.repeat(64)}`,
      approver_principal: 'user:oncall',
      multiplier: 2,
      status: 'approved',
    });
  });

  it('rejects a non-P0 override before unresolved identity can grant anything', async () => {
    const run = await seedRun('p1', { priority: 'p1', principal: 'user:requester' });
    const store = new QuotaOverrideStore(env.DB_CONTROL, { now: () => NOW });
    await expect(store.decide({
      schemaVersion: '1',
      runId: run.runId,
      expectedRunVersion: 0,
      decision: 'approve',
      resources: ['attempt'],
      reasonDigest: `sha256:${'e'.repeat(64)}`,
      expiresAt: '2026-07-26T12:00:00.000Z',
      source: {
        schemaVersion: '1',
        provider: 'feishu',
        tenantKey: run.tenant,
        externalEventId: 'event-non-p0',
        externalSubject: 'unknown-user',
        eventDigest: `sha256:${'f'.repeat(64)}`,
        occurredAt: NOW.toISOString(),
      },
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof QuotaOverrideError && error.code === 'not_p0');
  });

  it('audits and rejects P0 self, service, unauthorized, wrong-tenant, and stale decisions', async () => {
    const run = await seedRun('p0-negative', {
      priority: 'p0',
      principal: 'user:requester-negative',
    });
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO identity_mappings (principal, roles, created_at, updated_at) VALUES
          ('user:requester-negative', '["human","approve:quota_override"]', ?, ?),
          ('service:quota-oncall', '["human","approve:quota_override"]', ?, ?),
          ('user:quota-viewer', '["human"]', ?, ?),
          ('user:wrong-tenant-oncall', '["human","approve:quota_override"]', ?, ?)`,
      ).bind(
        NOW.toISOString(), NOW.toISOString(),
        NOW.toISOString(), NOW.toISOString(),
        NOW.toISOString(), NOW.toISOString(),
        NOW.toISOString(), NOW.toISOString(),
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO channel_identities (
           channel, channel_user_id, principal, created_at, updated_at
         ) VALUES
          (?, 'self-user', 'user:requester-negative', ?, ?),
          (?, 'service-user', 'service:quota-oncall', ?, ?),
          (?, 'viewer-user', 'user:quota-viewer', ?, ?),
          ('feishu:wrong-tenant', 'wrong-user', 'user:wrong-tenant-oncall', ?, ?)`,
      ).bind(
        `feishu:${run.tenant}`, NOW.toISOString(), NOW.toISOString(),
        `feishu:${run.tenant}`, NOW.toISOString(), NOW.toISOString(),
        `feishu:${run.tenant}`, NOW.toISOString(), NOW.toISOString(),
        NOW.toISOString(), NOW.toISOString(),
      ),
    ]);
    const store = new QuotaOverrideStore(env.DB_CONTROL, { now: () => NOW });
    const decide = async (
      event: string,
      subject: string,
      tenantKey = run.tenant,
    ) => await store.decide({
      schemaVersion: '1',
      runId: run.runId,
      expectedRunVersion: 0,
      decision: 'approve',
      resources: ['attempt'],
      reasonDigest: `sha256:${'3'.repeat(64)}`,
      expiresAt: '2026-07-26T12:00:00.000Z',
      source: {
        schemaVersion: '1',
        provider: 'feishu',
        tenantKey,
        externalEventId: event,
        externalSubject: subject,
        eventDigest: `sha256:${'4'.repeat(64)}`,
        occurredAt: NOW.toISOString(),
      },
    });
    await expect(decide('event-self', 'self-user')).resolves.toMatchObject({
      status: 'identity_rejected',
      rejectionReason: 'task_actor_self_approval',
    });
    await expect(decide('event-service', 'service-user')).resolves.toMatchObject({
      status: 'identity_rejected',
      rejectionReason: 'actor_not_human',
    });
    await expect(decide('event-viewer', 'viewer-user')).resolves.toMatchObject({
      status: 'identity_rejected',
      rejectionReason: 'actor_not_authorized',
    });
    await expect(decide('event-wrong-tenant', 'wrong-user', 'wrong-tenant'))
      .resolves.toMatchObject({
        status: 'identity_rejected',
        rejectionReason: 'source_tenant_mismatch',
      });
    await expect(store.decide({
      schemaVersion: '1',
      runId: run.runId,
      expectedRunVersion: 1,
      decision: 'approve',
      resources: ['attempt'],
      reasonDigest: `sha256:${'5'.repeat(64)}`,
      expiresAt: '2026-07-26T12:00:00.000Z',
      source: {
        schemaVersion: '1',
        provider: 'feishu',
        tenantKey: run.tenant,
        externalEventId: 'event-stale',
        externalSubject: 'viewer-user',
        eventDigest: `sha256:${'6'.repeat(64)}`,
        occurredAt: NOW.toISOString(),
      },
    })).rejects.toMatchObject({ code: 'state_conflict' });
  });

  it('exposes fenced Runner reservation/settlement and authenticated P0 approval APIs', async () => {
    const run = await seedRun('api', { priority: 'p0', principal: 'user:requester-api' });
    const attemptId = await seedAttempt(run.runId, 'api', 1);
    const attemptToken = 'quota-api-attempt-token';
    const tokenDigest = await canonicalSha256(attemptToken);
    const oidcDigest = await canonicalSha256('quota-api-oidc');
    const toolDigest = await canonicalSha256('quota-api-tool-token');
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE attempts SET status = 'running', version = 1, lease_generation = 1,
             lease_expires_at = '2099-01-01T00:00:00.000Z', heartbeat_at = ?, updated_at = ?
         WHERE attempt_id = ?`,
      ).bind(NOW.toISOString(), NOW.toISOString(), attemptId),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempt_tokens (
           token_id, attempt_id, oidc_token_digest, token_digest, tool_token_digest,
           lease_generation, scopes_json, expires_at, created_at
         ) VALUES ('quota_api_token', ?, ?, ?, ?, 1, '["repo:read"]',
                   '2099-01-01T00:00:00.000Z', ?)`,
      ).bind(attemptId, oidcDigest, tokenDigest, toolDigest, NOW.toISOString()),
      env.DB_CONTROL.prepare(
        `INSERT INTO quota_model_profiles (
           profile_id, provider, model, max_input_tokens, max_output_tokens,
           input_microusd_per_million, cached_input_microusd_per_million,
           output_microusd_per_million, enabled, created_at, updated_at
         ) VALUES ('profile-api', 'openai', 'test-api-model', 100, 100,
                   1000000, 100000, 2000000, 1, ?, ?)`,
      ).bind(NOW.toISOString(), NOW.toISOString()),
      env.DB_CONTROL.prepare(
        `INSERT INTO identity_mappings (principal, roles, created_at, updated_at)
         VALUES ('user:quota-api-oncall', '["human","approve:quota_override"]', ?, ?)`,
      ).bind(NOW.toISOString(), NOW.toISOString()),
      env.DB_CONTROL.prepare(
        `INSERT INTO channel_identities (
           channel, channel_user_id, principal, created_at, updated_at
         ) VALUES (?, 'feishu-quota-api', 'user:quota-api-oncall', ?, ?)`,
      ).bind(`feishu:${run.tenant}`, NOW.toISOString(), NOW.toISOString()),
    ]);

    const staleTimestampReservation = await SELF.fetch(
      `https://delivery-loop.test/v1/attempts/${attemptId}/model-reservations`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${attemptToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          reservationId: 'model_reservation_api_stale_time',
          profileId: 'profile-api',
          expectedVersion: 1,
          leaseGeneration: 1,
          occurredAt: '2020-01-01T00:00:00.000Z',
        }),
      },
    );
    expect(staleTimestampReservation.status).toBe(400);

    const reservationBody = {
      reservationId: 'model_reservation_api_1',
      profileId: 'profile-api',
      expectedVersion: 1,
      leaseGeneration: 1,
    };
    const reserve = await SELF.fetch(
      `https://delivery-loop.test/v1/attempts/${attemptId}/model-reservations`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${attemptToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(reservationBody),
      },
    );
    expect(reserve.status).toBe(201);
    expect(await reserve.json()).toMatchObject({
      reservationId: reservationBody.reservationId,
      model: 'test-api-model',
      disposition: 'created',
    });

    const usageBody = {
      reservationId: reservationBody.reservationId,
      usageId: 'model_usage_api_1',
      expectedVersion: 1,
      leaseGeneration: 1,
      inputTokens: 50,
      cachedInputTokens: 20,
      outputTokens: 25,
      reasoningOutputTokens: 5,
    };
    const usage = await SELF.fetch(
      `https://delivery-loop.test/v1/attempts/${attemptId}/model-usage`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${attemptToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(usageBody),
      },
    );
    expect(usage.status).toBe(201);
    expect(await usage.json()).toMatchObject({
      usageId: usageBody.usageId,
      totalTokens: 75,
      costMicrousd: 82,
      disposition: 'created',
    });

    const approvalNow = new Date();
    const override = await SELF.fetch(
      `https://delivery-loop.test/v1/runs/${run.runId}/quota-overrides`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-approval-adapter-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          schemaVersion: '1',
          expectedRunVersion: 0,
          decision: 'approve',
          resources: ['model_tokens', 'model_cost_microusd'],
          reasonDigest: `sha256:${'1'.repeat(64)}`,
          expiresAt: new Date(approvalNow.getTime() + 2 * 60 * 60_000).toISOString(),
          source: {
            schemaVersion: '1',
            provider: 'feishu',
            tenantKey: run.tenant,
            externalEventId: 'quota-api-approval-event',
            externalSubject: 'feishu-quota-api',
            eventDigest: `sha256:${'2'.repeat(64)}`,
            occurredAt: approvalNow.toISOString(),
          },
        }),
      },
    );
    expect(override.status).toBe(201);
    const overrideText = await override.text();
    expect(JSON.parse(overrideText)).toMatchObject({
      status: 'approved',
      principal: 'user:quota-api-oncall',
      multiplier: 2,
      created: true,
    });
    expect(overrideText).not.toContain(attemptToken);

    const status = await SELF.fetch(
      `https://delivery-loop.test/v1/runs/${run.runId}/plan`,
      { headers: { authorization: 'Bearer test-task-intake-token' } },
    );
    expect(status.status).toBe(200);
    const statusText = await status.text();
    const statusBody = JSON.parse(statusText) as {
      run: { quota: { limits: unknown[]; overrides: unknown[]; modelCalls: unknown[] } };
    };
    expect(statusBody.run.quota.limits).toHaveLength(20);
    expect(statusBody.run.quota.overrides).toEqual([
      expect.objectContaining({
        status: 'approved',
        reasonDigest: `sha256:${'1'.repeat(64)}`,
      }),
    ]);
    expect(statusBody.run.quota.modelCalls).toEqual([
      expect.objectContaining({
        id: usageBody.usageId,
        inputTokens: 50,
        outputTokens: 25,
        costMicrousd: 82,
      }),
    ]);
    expect(statusText).not.toContain(attemptToken);
    expect(statusText).not.toContain('quota-api-oidc');
    expect(statusText).not.toContain('quota-api-tool-token');
  });
});
