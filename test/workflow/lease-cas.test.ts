/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import {
  AttemptLeaseStore,
  type AcquiredAttemptLease,
} from '../../src/storage/attempt-lease-store.js';
import { RunStore, RunTransitionConflictError } from '../../src/storage/run-store.js';

const BASE_SHA = 'c'.repeat(40);
const NOW = new Date('2026-07-25T08:00:00.000Z');

async function seedRun(runId: string, state: string, version = 0): Promise<void> {
  const taskId = `task-${runId}`;
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (
         ?, 'manual', 'lease-cas-test', ?, 'rev-1', ?, 'r2://tasks/lease-cas-test',
         'system', 'lease-cas-test', 'example/repo', 'main', 'test', 'bug',
         'Lease CAS test', 'p1', 1, 1, 0, 0, 1, ?, ?
       )`,
    ).bind(taskId, taskId, `sha256:${'5'.repeat(64)}`, NOW.toISOString(), NOW.toISOString()),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha, workflow_instance_id,
         state, version, created_at, updated_at
       ) VALUES (?, ?, 'rev-1', ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      runId,
      taskId,
      `sha256:${'5'.repeat(64)}`,
      BASE_SHA,
      runId,
      state,
      version,
      NOW.toISOString(),
      NOW.toISOString(),
    ),
  ]);
}

async function seedWriteAttempt(runId: string, attemptId: string, ordinal: number): Promise<void> {
  await env.DB_CONTROL.prepare(
    `INSERT INTO attempts (
       attempt_id, run_id, ordinal, mode, status, base_sha,
       lease_generation, version, created_at, updated_at
     ) VALUES (?, ?, ?, 'implement', 'pending', ?, 0, 0, ?, ?)`,
  )
    .bind(attemptId, runId, ordinal, BASE_SHA, NOW.toISOString(), NOW.toISOString())
    .run();
}

function acquired(
  result: Awaited<ReturnType<AttemptLeaseStore['acquireWriteLease']>>,
): result is AcquiredAttemptLease {
  return result.acquired;
}

describe('Run CAS and attempt write leases', () => {
  it('allows only one concurrent Run transition from the same expected version', async () => {
    const runId = 'run-cas-transition';
    await seedRun(runId, 'queued');
    const store = new RunStore(env.DB_CONTROL);

    const results = await Promise.allSettled([
      store.transition(runId, 'queued', 'planning', 0, NOW.toISOString()),
      store.transition(runId, 'queued', 'planning', 0, NOW.toISOString()),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: {
        name: RunTransitionConflictError.name,
        code: 'run_version_conflict',
      },
    });
    expect(await store.getRun(runId)).toMatchObject({ state: 'planning', version: 1 });
  });

  it('lets exactly one of 20 workers acquire a generation-fenced write lease', async () => {
    const runId = 'run-lease-race';
    const attemptId = 'attempt-lease-race';
    await seedRun(runId, 'executing');
    await seedWriteAttempt(runId, attemptId, 1);
    let tokenSequence = 0;
    const store = new AttemptLeaseStore(env.DB_CONTROL, {
      now: () => NOW,
      leaseMs: 30_000,
      generateLeaseToken: () => `raw-runner-token-${++tokenSequence}`,
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.acquireWriteLease(runId, attemptId, 0)),
    );
    const winners = results.filter(acquired);
    expect(winners).toHaveLength(1);
    expect(results.filter((result) => !result.acquired)).toHaveLength(19);
    const winner = winners[0];
    if (winner === undefined) throw new Error('missing lease winner');
    expect(winner).toMatchObject({
      acquired: true,
      attemptId,
      runId,
      version: 1,
      leaseGeneration: 1,
      leaseExpiresAt: '2026-07-25T08:00:30.000Z',
    });

    const row = await env.DB_CONTROL.prepare(
      `SELECT status, version, lease_generation, lease_token_digest, lease_expires_at
       FROM attempts WHERE attempt_id = ?`,
    )
      .bind(attemptId)
      .first<{
        status: string;
        version: number;
        lease_generation: number;
        lease_token_digest: string;
        lease_expires_at: string;
      }>();
    expect(row).toEqual({
      status: 'running',
      version: 1,
      lease_generation: 1,
      lease_token_digest: await canonicalSha256(winner.leaseToken),
      lease_expires_at: winner.leaseExpiresAt,
    });
    expect(row?.lease_token_digest).not.toContain(winner.leaseToken);
  });

  it('increments generation on expiry and rejects stale token or generation heartbeats', async () => {
    const runId = 'run-lease-fencing';
    const attemptId = 'attempt-lease-fencing';
    await seedRun(runId, 'executing');
    await seedWriteAttempt(runId, attemptId, 1);

    const firstStore = new AttemptLeaseStore(env.DB_CONTROL, {
      now: () => NOW,
      leaseMs: 30_000,
      generateLeaseToken: () => 'first-raw-token',
    });
    const first = await firstStore.acquireWriteLease(runId, attemptId, 0);
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error('first lease was not acquired');

    const afterExpiry = new Date('2026-07-25T08:00:31.000Z');
    const secondStore = new AttemptLeaseStore(env.DB_CONTROL, {
      now: () => afterExpiry,
      leaseMs: 30_000,
      generateLeaseToken: () => 'second-raw-token',
    });
    const second = await secondStore.acquireWriteLease(runId, attemptId, 1);
    expect(second).toMatchObject({
      acquired: true,
      version: 2,
      leaseGeneration: 2,
      leaseExpiresAt: '2026-07-25T08:01:01.000Z',
    });
    if (!second.acquired) throw new Error('second lease was not acquired');

    expect(
      await secondStore.heartbeat({
        runId,
        attemptId,
        expectedVersion: 2,
        leaseGeneration: first.leaseGeneration,
        leaseToken: first.leaseToken,
      }),
    ).toMatchObject({ renewed: false, reason: 'lease_conflict' });
    expect(
      await secondStore.heartbeat({
        runId,
        attemptId,
        expectedVersion: 2,
        leaseGeneration: second.leaseGeneration,
        leaseToken: second.leaseToken,
      }),
    ).toMatchObject({
      renewed: true,
      version: 3,
      leaseGeneration: 2,
      leaseExpiresAt: '2026-07-25T08:01:01.000Z',
    });
  });

  it('allows only one active write lease across different attempts of one Run', async () => {
    const runId = 'run-one-write-lease';
    await seedRun(runId, 'executing');
    await seedWriteAttempt(runId, 'attempt-write-a', 1);
    await seedWriteAttempt(runId, 'attempt-write-b', 2);
    const store = new AttemptLeaseStore(env.DB_CONTROL, {
      now: () => NOW,
      leaseMs: 30_000,
    });

    const results = await Promise.all([
      store.acquireWriteLease(runId, 'attempt-write-a', 0),
      store.acquireWriteLease(runId, 'attempt-write-b', 0),
    ]);
    expect(results.filter(acquired)).toHaveLength(1);

    const active = await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count
       FROM attempts
       WHERE run_id = ?
         AND mode IN ('implement', 'review_fix', 'deploy')
         AND lease_token_digest IS NOT NULL
         AND lease_expires_at > ?`,
    )
      .bind(runId, NOW.toISOString())
      .first<{ count: number }>();
    expect(active?.count).toBe(1);
  });
});
