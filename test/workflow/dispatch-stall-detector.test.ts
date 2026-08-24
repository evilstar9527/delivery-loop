/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DISPATCH_STALL_THRESHOLD_SECONDS,
  DispatchStallDetector,
  type DispatchStallLogRecord,
} from '../../src/reconciliation/dispatch-stall-detector.js';

const NOW = new Date('2026-08-20T12:00:00.000Z');
const DIGEST = `sha256:${'a'.repeat(64)}`;
const BASE_SHA = 'b'.repeat(40);
const THRESHOLD = DEFAULT_DISPATCH_STALL_THRESHOLD_SECONDS;

function before(seconds: number, offsetMs = 0): string {
  return new Date(NOW.getTime() - seconds * 1_000 + offsetMs).toISOString();
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM dispatch_stall_incidents'),
    env.DB_CONTROL.prepare('DELETE FROM outbox_dead_letters'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
}

async function seedRun(runId: string, state: string, updatedAt: string): Promise<void> {
  const taskId = `task-${runId}`;
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'manual', 'stall-test', ?, 'revision-1', ?,
                 'r2://tasks/stall-test', 'system', 'control-plane',
                 'example/delivery-target', 'main', 'none', 'bug',
                 'CANARY_STALL_TASK_BODY', 'p1', 1, 1, 0, 0, 1, ?, ?)`,
    ).bind(taskId, taskId, DIGEST, updatedAt, updatedAt),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, created_at, updated_at
       ) VALUES (?, ?, 'revision-1', ?, ?, ?, ?, 1, ?, ?)`,
    ).bind(runId, taskId, DIGEST, BASE_SHA, runId, state, updatedAt, updatedAt),
  ]);
}

/**
 * Reproduces the production stall: an `agent_execution_start` delivery that
 * exhausted its retries and was captured as an open dead letter, leaving the
 * outbox row pending but permanently unclaimable.
 */
async function seedDeadLetteredDispatch(
  runId: string,
  options: { errorCode?: string; status?: string; capturedAt?: string } = {},
): Promise<{ outboxId: string; deadLetterId: string }> {
  const outboxId = `outbox-${runId}`;
  const deadLetterId = `dl-${runId}`;
  const errorCode = options.errorCode ?? 'executor_unavailable';
  const status = options.status ?? 'open';
  const capturedAt = options.capturedAt ?? before(THRESHOLD);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO outbox (
         outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
         delivery_state, attempt_count, lease_token, lease_expires_at,
         last_error_code, created_at, updated_at
       ) VALUES (?, ?, 'agent_execution_start', 'agent_executor', ?, ?,
                 'pending', 8, NULL, NULL, ?, ?, ?)`,
    ).bind(
      outboxId,
      runId,
      `d1://attempt-executions/exec-${runId}`,
      `agent-execution-start:${runId}`,
      errorCode,
      capturedAt,
      capturedAt,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO outbox_dead_letters (
         dead_letter_id, outbox_id, run_id, source_queue, source_message_id,
         source_attempts, outbox_kind, destination, outbox_attempt_count,
         last_error_code, status, captured_at, replay_requested_at
       ) VALUES (?, ?, ?, 'delivery-loop-workflow-outbox', ?, 1,
                 'agent_execution_start', 'agent_executor', 8, ?, ?, ?, ?)`,
    ).bind(
      deadLetterId,
      outboxId,
      runId,
      `msg-${runId}`,
      errorCode,
      status,
      capturedAt,
      status === 'replay_requested' ? capturedAt : null,
    ),
  ]);
  return { outboxId, deadLetterId };
}

async function runState(runId: string): Promise<{ state: string; version: number } | null> {
  return await env.DB_CONTROL
    .prepare('SELECT state, version FROM runs WHERE run_id = ?')
    .bind(runId)
    .first<{ state: string; version: number }>();
}

function detector(records: DispatchStallLogRecord[], thresholdSeconds = THRESHOLD) {
  return new DispatchStallDetector(env.DB_CONTROL, {
    now: () => NOW,
    thresholdSeconds,
    sink: (record) => { records.push(record); },
  });
}

beforeEach(reset);

describe('dispatch stall detector', () => {
  it('cancels a run stranded behind an open dead letter and records why', async () => {
    // The exact production shape: dispatch dead-lettered, run left in planning.
    await seedRun('run-stall-1', 'planning', before(THRESHOLD));
    const { outboxId, deadLetterId } = await seedDeadLetteredDispatch('run-stall-1');

    const records: DispatchStallLogRecord[] = [];
    const incidents = await detector(records).scan(5);

    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.runId).toBe('run-stall-1');
    expect(incidents[0]?.disposition).toBe('cancelled');
    expect(incidents[0]?.observedRunState).toBe('planning');
    expect(incidents[0]?.lastErrorCode).toBe('executor_unavailable');
    // The dispatch identifiers are the whole diagnostic value: they are what
    // lets an operator find the cause after the task has left the board.
    expect(incidents[0]?.outboxId).toBe(outboxId);
    expect(incidents[0]?.deadLetterId).toBe(deadLetterId);

    expect((await runState('run-stall-1'))?.state).toBe('cancelled');

    const row = await env.DB_CONTROL
      .prepare('SELECT disposition, last_error_code FROM dispatch_stall_incidents WHERE run_id = ?')
      .bind('run-stall-1')
      .first<{ disposition: string; last_error_code: string }>();
    expect(row?.disposition).toBe('cancelled');
    expect(row?.last_error_code).toBe('executor_unavailable');

    expect(records).toHaveLength(1);
    expect(records[0]?.event).toBe('dispatch_stall_cancelled');
  });

  it('leaves a run alone until the threshold elapses', async () => {
    // One second short of the threshold: the dispatch might still be replayed.
    await seedRun('run-stall-2', 'planning', before(THRESHOLD, 1_000));
    await seedDeadLetteredDispatch('run-stall-2', { capturedAt: before(THRESHOLD, 1_000) });

    const records: DispatchStallLogRecord[] = [];
    expect(await detector(records).scan(5)).toEqual([]);
    expect((await runState('run-stall-2'))?.state).toBe('planning');
    expect(records).toEqual([]);
  });

  it('ignores a dead letter an operator asked to replay', async () => {
    // replay_requested means recovery is in flight; cancelling would destroy it.
    await seedRun('run-stall-3', 'planning', before(THRESHOLD));
    await seedDeadLetteredDispatch('run-stall-3', { status: 'replay_requested' });

    expect(await detector([]).scan(5)).toEqual([]);
    expect((await runState('run-stall-3'))?.state).toBe('planning');
  });

  it('never cancels the same stall twice', async () => {
    await seedRun('run-stall-4', 'planning', before(THRESHOLD));
    await seedDeadLetteredDispatch('run-stall-4');

    expect(await detector([]).scan(5)).toHaveLength(1);
    const versionAfterFirst = (await runState('run-stall-4'))?.version;

    // A second scan a minute later must not re-cancel or duplicate history.
    const second = new DispatchStallDetector(env.DB_CONTROL, {
      now: () => new Date(NOW.getTime() + 60_000),
      thresholdSeconds: THRESHOLD,
      sink: () => {},
    });
    expect(await second.scan(5)).toEqual([]);
    expect((await runState('run-stall-4'))?.version).toBe(versionAfterFirst);

    const count = await env.DB_CONTROL
      .prepare('SELECT COUNT(*) AS n FROM dispatch_stall_incidents WHERE run_id = ?')
      .bind('run-stall-4')
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('does not touch runs that already reached a terminal state', async () => {
    await seedRun('run-stall-5', 'succeeded', before(THRESHOLD));
    await seedDeadLetteredDispatch('run-stall-5');

    expect(await detector([]).scan(5)).toEqual([]);
    expect((await runState('run-stall-5'))?.state).toBe('succeeded');
  });

  it('ignores dead letters from other dispatch kinds', async () => {
    // Only agent_execution_start strands a run this way; a dead-lettered
    // notification or PR effect must not cancel the work.
    await seedRun('run-stall-6', 'planning', before(THRESHOLD));
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, attempt_count, last_error_code, created_at, updated_at
         ) VALUES ('outbox-other', 'run-stall-6', 'feishu_delivery_card', 'feishu',
                   'd1://cards/run-stall-6', 'card:run-stall-6', 'pending', 8,
                   'feishu_unavailable', ?, ?)`,
      ).bind(before(THRESHOLD), before(THRESHOLD)),
      env.DB_CONTROL.prepare(
        `INSERT INTO outbox_dead_letters (
           dead_letter_id, outbox_id, run_id, source_queue, source_message_id,
           source_attempts, outbox_kind, destination, outbox_attempt_count,
           last_error_code, status, captured_at
         ) VALUES ('dl-other', 'outbox-other', 'run-stall-6',
                   'delivery-loop-workflow-outbox', 'msg-other', 1,
                   'feishu_delivery_card', 'feishu', 8, 'feishu_unavailable',
                   'open', ?)`,
      ).bind(before(THRESHOLD)),
    ]);

    expect(await detector([]).scan(5)).toEqual([]);
    expect((await runState('run-stall-6'))?.state).toBe('planning');
  });

  it('records a conflict instead of looping when the run cannot be cancelled', async () => {
    // An Attempt that already reported a result makes cancelRun refuse. The
    // stall must still be recorded, or every scan would retry it forever.
    await seedRun('run-stall-7', 'executing', before(THRESHOLD));
    await seedDeadLetteredDispatch('run-stall-7');
    await env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, result_event_id,
         result_sequence, result_reported_at, created_at, updated_at
       ) VALUES ('attempt-stall-7', 'run-stall-7', 1, 'analysis', 'running', ?,
                 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 1, 1, 'evt-stall-7', 1, ?, ?, ?)`,
    ).bind(BASE_SHA, before(THRESHOLD), before(THRESHOLD), before(THRESHOLD)).run();

    const records: DispatchStallLogRecord[] = [];
    const incidents = await detector(records).scan(5);

    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.disposition).toBe('cancel_conflicted');
    // The run keeps its state: a reported result outranks our cancellation.
    expect((await runState('run-stall-7'))?.state).toBe('executing');
    expect(records[0]?.event).toBe('dispatch_stall_conflicted');

    // And the conflict is durable, so the next scan does not retry it.
    expect(await detector([]).scan(5)).toEqual([]);
  });

  it('rejects an out-of-range threshold rather than scanning with it', () => {
    expect(() => new DispatchStallDetector(env.DB_CONTROL, { thresholdSeconds: 30 }))
      .toThrow(/between 60 and 604800/);
  });
});
