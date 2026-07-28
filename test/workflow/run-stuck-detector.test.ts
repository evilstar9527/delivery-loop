/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS,
  RunStuckDetector,
  type RunStuckLogRecord,
} from '../../src/reconciliation/run-stuck-detector.js';
import { TaskQueryStore } from '../../src/storage/task-query-store.js';

const NOW = new Date('2026-07-26T12:00:00.000Z');
const DIGEST = `sha256:${'a'.repeat(64)}`;
const BASE_SHA = 'b'.repeat(40);

function before(seconds: number, offsetMs = 0): string {
  return new Date(NOW.getTime() - seconds * 1_000 + offsetMs).toISOString();
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM run_stuck_incidents'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_revocations'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
}

async function seedRun(
  runId: string,
  state: 'queued' | 'executing' | 'awaiting_review' | 'deploying',
  updatedAt: string,
): Promise<void> {
  const taskId = `task-${runId}`;
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'manual', 'stuck-test', ?, 'revision-1', ?,
                 'r2://tasks/stuck-test', 'system', 'control-plane',
                 'example/delivery-target', 'main', 'none', 'bug',
                 'CANARY_STUCK_TASK_BODY', 'p1', 1, 0, 0, 0, 1, ?, ?)`,
    ).bind(taskId, taskId, DIGEST, updatedAt, updatedAt),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, created_at, updated_at
       ) VALUES (?, ?, 'revision-1', ?, ?, ?, ?, 1, ?, ?)`,
    ).bind(runId, taskId, DIGEST, BASE_SHA, runId, state, updatedAt, updatedAt),
  ]);
}

async function seedQueuedOutbox(runId: string): Promise<void> {
  await env.DB_CONTROL.prepare(
    `INSERT INTO outbox (
       outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
       delivery_state, attempt_count, lease_token, lease_expires_at,
       last_error_code, created_at, updated_at
     ) VALUES (?, ?, 'workflow_create', 'cloudflare_workflows', ?, ?,
               'delivering', 1, 'expired-lease', ?, 'workflow_unavailable', ?, ?)`,
  ).bind(
    `outbox-${runId}`,
    runId,
    `d1://runs/${runId}`,
    `workflow-create:${runId}`,
    before(60),
    before(DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.queued),
    before(DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.queued),
  ).run();
}

async function seedRunningAttempt(runId: string, attemptId: string): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, lease_token_digest,
         lease_expires_at, heartbeat_at, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'running', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 1, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      attemptId,
      runId,
      BASE_SHA,
      `sha256:${'c'.repeat(64)}`,
      new Date(NOW.getTime() + 10 * 60_000).toISOString(),
      before(DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.running),
      before(DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.running),
      before(DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.running),
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest,
         lease_generation, scopes_json, expires_at, created_at
       ) VALUES (?, ?, ?, ?, 1, '["repo:read"]', ?, ?)`,
    ).bind(
      `token-${attemptId}`,
      attemptId,
      `sha256:${'d'.repeat(64)}`,
      `sha256:${'e'.repeat(64)}`,
      new Date(NOW.getTime() + 10 * 60_000).toISOString(),
      before(DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.running),
    ),
  ]);
}

beforeEach(reset);

describe('multi-state durable stuck detector', () => {
  it('opens one bounded alert at each queued/review/deploy threshold and re-arms queued work', async () => {
    const queuedRun = 'run-stuck-queued';
    const reviewRun = 'run-stuck-review';
    const deployRun = 'run-stuck-deploy';
    await seedRun(queuedRun, 'queued', before(DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.queued));
    await seedQueuedOutbox(queuedRun);
    await seedRun(
      reviewRun,
      'awaiting_review',
      before(DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.awaitingReview),
    );
    await seedRun(
      deployRun,
      'deploying',
      before(DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.deploying),
    );

    const early = new RunStuckDetector(env.DB_CONTROL, {
      now: () => new Date(NOW.getTime() - 1),
      sink: () => undefined,
    });
    await expect(early.scan()).resolves.toEqual({ detected: [], resolved: [] });

    const logs: RunStuckLogRecord[] = [];
    const scans = await Promise.all(Array.from({ length: 20 }, async () =>
      await new RunStuckDetector(env.DB_CONTROL, {
        now: () => NOW,
        sink: (record) => logs.push(record),
      }).scan()
    ));
    expect(scans.flatMap((scan) => scan.detected)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: queuedRun,
        stateKind: 'queued',
        action: 'requeue_workflow_create',
        status: 'open',
      }),
      expect.objectContaining({
        runId: reviewRun,
        stateKind: 'awaiting_review',
        action: 'escalate_human_review',
        status: 'open',
      }),
      expect.objectContaining({
        runId: deployRun,
        stateKind: 'deploying',
        action: 'reconcile_external_deployment',
        status: 'open',
      }),
    ]));
    expect(scans.flatMap((scan) => scan.detected)).toHaveLength(3);
    expect(scans.flatMap((scan) => scan.resolved)).toHaveLength(0);
    expect(logs).toHaveLength(3);
    expect(new Set(logs.map((record) => record.incidentId))).toHaveLength(3);
    expect(JSON.stringify(logs)).not.toContain('CANARY_STUCK_TASK_BODY');
    expect(JSON.stringify(logs)).not.toContain('r2://');
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state, lease_token, lease_expires_at, last_error_code
       FROM outbox WHERE outbox_id = ?`,
    ).bind(`outbox-${queuedRun}`).first()).toEqual({
      delivery_state: 'pending',
      lease_token: null,
      lease_expires_at: null,
      last_error_code: 'stuck_requeued',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM run_stuck_incidents WHERE status = 'open'`,
    ).first()).toEqual({ count: 3 });
    await expect(env.DB_CONTROL.prepare(
      `UPDATE run_stuck_incidents SET threshold_seconds = 60
       WHERE run_id = ? AND state_kind = 'awaiting_review'`,
    ).bind(reviewRun).run()).rejects.toThrow('run stuck incident identity is immutable');

    const status = await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus(reviewRun);
    expect(status?.run).toMatchObject({
      id: reviewRun,
      stuckIncidents: [{
        stateKind: 'awaiting_review',
        action: 'escalate_human_review',
        status: 'open',
      }],
    });
  });

  it('fences a running Attempt exactly at the heartbeat threshold and resolves the incident', async () => {
    const runId = 'run-stuck-running';
    const attemptId = 'attempt-stuck-running';
    await seedRun(
      runId,
      'executing',
      before(DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.running),
    );
    await seedRunningAttempt(runId, attemptId);

    await expect(new RunStuckDetector(env.DB_CONTROL, {
      now: () => new Date(NOW.getTime() - 1),
      sink: () => undefined,
    }).scan()).resolves.toEqual({ detected: [], resolved: [] });

    const logs: RunStuckLogRecord[] = [];
    const scans = await Promise.all(Array.from({ length: 20 }, async () =>
      await new RunStuckDetector(env.DB_CONTROL, {
        now: () => NOW,
        sink: (record) => logs.push(record),
      }).scan()
    ));
    expect(scans.flatMap((scan) => scan.detected)).toEqual([
      expect.objectContaining({
        runId,
        attemptId,
        stateKind: 'running',
        action: 'fence_lost_attempt',
      }),
    ]);
    expect(scans.flatMap((scan) => scan.resolved)).toEqual([
      expect.objectContaining({
        runId,
        attemptId,
        stateKind: 'running',
        status: 'resolved',
        resolutionCode: 'attempt_fenced',
      }),
    ]);
    expect(logs.map((record) => record.event).sort()).toEqual([
      'run_stuck_detected',
      'run_stuck_resolved',
    ]);
    expect(await env.DB_CONTROL.prepare(
      `SELECT state, version FROM runs WHERE run_id = ?`,
    ).bind(runId).first()).toEqual({ state: 'blocked', version: 2 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, version, lease_generation, lease_token_digest, lease_expires_at
       FROM attempts WHERE attempt_id = ?`,
    ).bind(attemptId).first()).toEqual({
      status: 'lost',
      version: 2,
      lease_generation: 2,
      lease_token_digest: null,
      lease_expires_at: null,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT revoked_at FROM attempt_tokens WHERE attempt_id = ?`,
    ).bind(attemptId).first()).toEqual({ revoked_at: NOW.toISOString() });
    expect(await env.DB_CONTROL.prepare(
      `SELECT kind, destination, delivery_state FROM outbox WHERE run_id = ?`,
    ).bind(runId).first()).toEqual({
      kind: 'workflow_cancel',
      destination: 'cloudflare_workflows',
      delivery_state: 'pending',
    });
  });

  it('auto-resolves durable alerts when injected workflow, review, and deployment faults recover', async () => {
    const runs = [
      ['run-recover-queued', 'queued', DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.queued],
      [
        'run-recover-review',
        'awaiting_review',
        DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.awaitingReview,
      ],
      ['run-recover-deploy', 'deploying', DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.deploying],
    ] as const;
    for (const [runId, state, threshold] of runs) await seedRun(runId, state, before(threshold));
    const detector = new RunStuckDetector(env.DB_CONTROL, {
      now: () => NOW,
      sink: () => undefined,
    });
    expect((await detector.scan()).detected).toHaveLength(3);

    const recoveredAt = new Date(NOW.getTime() + 60_000).toISOString();
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE runs SET state = 'planning', version = version + 1, updated_at = ?
         WHERE run_id = 'run-recover-queued'`,
      ).bind(recoveredAt),
      env.DB_CONTROL.prepare(
        `UPDATE runs SET state = 'ready_to_merge', version = version + 1, updated_at = ?
         WHERE run_id = 'run-recover-review'`,
      ).bind(recoveredAt),
      env.DB_CONTROL.prepare(
        `UPDATE runs SET state = 'succeeded', version = version + 1, updated_at = ?
         WHERE run_id = 'run-recover-deploy'`,
      ).bind(recoveredAt),
    ]);
    const recoveryLogs: RunStuckLogRecord[] = [];
    const recovered = await new RunStuckDetector(env.DB_CONTROL, {
      now: () => new Date(recoveredAt),
      sink: (record) => recoveryLogs.push(record),
    }).scan();
    expect(recovered.detected).toEqual([]);
    expect(recovered.resolved).toHaveLength(3);
    expect(recovered.resolved.every(
      (incident) => incident.resolutionCode === 'run_progressed',
    )).toBe(true);
    expect(recoveryLogs).toHaveLength(3);
    expect(recoveryLogs.every((record) => record.event === 'run_stuck_resolved')).toBe(true);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM run_stuck_incidents WHERE status = 'open'`,
    ).first()).toEqual({ count: 0 });
  });
});
