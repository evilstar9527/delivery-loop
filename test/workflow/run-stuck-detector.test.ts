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
    env.DB_CONTROL.prepare('DELETE FROM attempt_execution_instances'),
    env.DB_CONTROL.prepare('DELETE FROM run_stuck_incidents'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_revocations'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suite_commands'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suites'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_progress'),
    env.DB_CONTROL.prepare('DELETE FROM plan_items'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plans'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    // attempts references executor_profiles(profile_id); delete it before the
    // profiles/routes it points at, or the FK check fails.
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM executor_routes'),
    env.DB_CONTROL.prepare('DELETE FROM executor_profiles'),
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

  it('does not fence a successful execution while completion facts await projection', async () => {
    const runId = 'run-stuck-success-projection';
    const attemptId = 'attempt-stuck-success-projection';
    const planId = 'plan-stuck-success-projection';
    const itemId = 'item-stuck-success-projection';
    const headSha = 'c'.repeat(40);
    const nowIso = NOW.toISOString();
    await seedRun(runId, 'executing', before(DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.running));
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, github_run_id, github_head_sha, github_status,
           github_conclusion, github_external_updated_at, head_sha, plan_id,
           plan_version, plan_item_id, version, lease_generation, lease_expires_at,
           heartbeat_at, created_at, updated_at
         ) VALUES (?, ?, 1, 'implement', 'running', ?, 'example/delivery-target',
                   'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                   '70001', ?, 'completed', 'success', ?, ?, ?, 1, ?, 3, 1, ?, ?, ?, ?)`,
      ).bind(
        attemptId,
        runId,
        BASE_SHA,
        headSha,
        nowIso,
        headSha,
        planId,
        itemId,
        new Date(NOW.getTime() - 1_000).toISOString(),
        before(DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.running),
        before(DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.running),
        before(DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.running),
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO execution_plans (
           plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
           created_by_attempt_id, objective, created_at, updated_at
         ) VALUES (?, ?, 1, 'revision-1', ?, ?, 'active', ?, 'safe completion projection', ?, ?)`,
      ).bind(planId, runId, BASE_SHA, DIGEST, attemptId, nowIso, nowIso),
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_items (
           plan_id, item_id, kind, title, objective, required, position
         ) VALUES (?, ?, 'change', 'safe completion projection', 'safe completion projection', 1, 0)`,
      ).bind(planId, itemId),
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_item_progress (
           plan_id, item_id, status, active_attempt_id, version, updated_at
         ) VALUES (?, ?, 'in_progress', ?, 1, ?)`,
      ).bind(planId, itemId, attemptId, nowIso),
      env.DB_CONTROL.prepare(
        `INSERT INTO verification_suites (
           suite_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           lease_generation, head_sha, delivery_policy_digest, targeted_command_count,
           required_command_count, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?, 1, 1, 'completed', ?, ?)`,
      ).bind(
        `suite-${attemptId}`,
        runId,
        attemptId,
        planId,
        itemId,
        headSha,
        DIGEST,
        nowIso,
        nowIso,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO evidence (
           evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           kind, status, command_ref, exit_code, sha, summary, verification_status,
           observed_at, created_at
         ) VALUES (?, ?, ?, ?, 1, ?, 'commit', 'passed', NULL, 0, ?,
                   'safe commit evidence', 'unverified', ?, ?)`,
      ).bind(`evidence-commit-${attemptId}`, runId, attemptId, planId, itemId, headSha, nowIso, nowIso),
      env.DB_CONTROL.prepare(
        `INSERT INTO evidence (
           evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           kind, status, command_ref, exit_code, sha, summary, verification_status,
           observed_at, created_at
         ) VALUES (?, ?, ?, ?, 1, ?, 'test', 'passed', 'verify:all', 0, ?,
                   'safe test evidence', 'unverified', ?, ?)`,
      ).bind(`evidence-test-${attemptId}`, runId, attemptId, planId, itemId, headSha, nowIso, nowIso),
      env.DB_CONTROL.prepare(
        `UPDATE runs SET active_plan_id = ?, active_plan_version = 1,
                         active_plan_digest = ?, updated_at = ?
         WHERE run_id = ?`,
      ).bind(planId, DIGEST, nowIso, runId),
    ]);

    await expect(new RunStuckDetector(env.DB_CONTROL, {
      now: () => NOW,
      sink: () => undefined,
    }).scan()).resolves.toEqual({ detected: [], resolved: [] });

    // Also cover the narrower CAS race: selection sees an in-progress Action,
    // then the trusted API projection becomes completed/success immediately
    // before the watchdog mutation batch executes.
    await env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET github_status = 'in_progress', github_conclusion = NULL,
           github_external_updated_at = NULL
       WHERE attempt_id = ?`,
    ).bind(attemptId).run();
    let projectedBeforeMutation = false;
    const racingDb = {
      prepare: (query: string) => env.DB_CONTROL.prepare(query),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!projectedBeforeMutation) {
          projectedBeforeMutation = true;
          await env.DB_CONTROL.prepare(
            `UPDATE attempts
             SET github_status = 'completed', github_conclusion = 'success',
                 github_external_updated_at = ?
             WHERE attempt_id = ?`,
          ).bind(nowIso, attemptId).run();
        }
        return await env.DB_CONTROL.batch(statements);
      },
    } as D1Database;
    await expect(new RunStuckDetector(racingDb, {
      now: () => NOW,
      sink: () => undefined,
    }).scan()).resolves.toEqual({ detected: [], resolved: [] });
    expect(projectedBeforeMutation).toBe(true);
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, version, lease_generation FROM attempts WHERE attempt_id = ?`,
    ).bind(attemptId).first()).toEqual({
      status: 'running',
      version: 3,
      lease_generation: 1,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT state, version FROM runs WHERE run_id = ?`,
    ).bind(runId).first()).toEqual({ state: 'executing', version: 1 });
  });

  it('does not fence a running Attempt while its publisher execution is still active', async () => {
    const runId = 'run-stuck-active-publisher';
    const attemptId = 'attempt-stuck-active-publisher';
    const nowIso = NOW.toISOString();
    await seedRun(runId, 'executing', before(DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.running));
    // A running implement Attempt whose heartbeat has gone stale past the
    // threshold: the credential-free work lane finished and stopped
    // heartbeating, and the publisher execution (which does the heavy
    // install + verify) is legitimately still running. It must not be fenced.
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, version, lease_generation, lease_token_digest,
           lease_expires_at, heartbeat_at, created_at, updated_at
         ) VALUES (?, ?, 1, 'implement', 'running', ?, 'example/delivery-target',
                   'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                   3, 1, ?, ?, ?, ?, ?)`,
      ).bind(
        attemptId,
        runId,
        BASE_SHA,
        `sha256:${'c'.repeat(64)}`,
        before(DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.running),
        before(DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.running),
        before(DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.running),
        before(DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.running),
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO executor_profiles (
           profile_id, schema_version, provider_kind, plugin_schema_version,
           release_digest, configuration_json, capabilities_json, status,
           created_at, activated_at
         ) VALUES ('publisher-profile-active', '1', 'cloudflare_sandbox', '1',
                   ?, '{}', '{}', 'active', ?, ?)`,
      ).bind(`sha256:${'b'.repeat(64)}`, nowIso, nowIso),
      env.DB_CONTROL.prepare(
        `INSERT INTO executor_routes (
           route_id, repository, attempt_mode, execution_role, profile_id,
           route_version, status, created_at, updated_at
         ) VALUES ('publisher-route-active', 'example/delivery-target',
                   'implement', 'publisher', 'publisher-profile-active', 5,
                   'active', ?, ?)`,
      ).bind(nowIso, nowIso),
      env.DB_CONTROL.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         ) VALUES (?, ?, 'agent_execution_start', 'agent_executor', ?, ?,
                   'pending', ?, ?)`,
      ).bind(
        `outbox-publisher-${attemptId}`,
        runId,
        `d1://executions/execution-publisher-${attemptId}`,
        `publisher-dispatch:${attemptId}`,
        nowIso,
        nowIso,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempt_execution_instances (
           execution_id, attempt_id, attempt_version, lease_generation,
           execution_role, executor_profile_id, executor_route_version,
           spec_digest, spec_json, release_digest, provider_kind,
           plugin_schema_version, status, outbox_id, created_at, updated_at
         ) VALUES (?, ?, 3, 1, 'publisher',
                   'publisher-profile-active', 5,
                   ?, '{}', ?, 'cloudflare_sandbox', '1', 'running', ?, ?, ?)`,
      ).bind(
        `execution-publisher-${attemptId}`,
        attemptId,
        `sha256:${'a'.repeat(64)}`,
        `sha256:${'b'.repeat(64)}`,
        `outbox-publisher-${attemptId}`,
        nowIso,
        nowIso,
      ),
    ]);

    const scans = await Promise.all(Array.from({ length: 5 }, async () =>
      await new RunStuckDetector(env.DB_CONTROL, {
        now: () => NOW,
        sink: () => undefined,
      }).scan()));
    expect(scans.flatMap((scan) => scan.detected)).toEqual([]);
    expect(await env.DB_CONTROL.prepare(
      `SELECT status FROM attempts WHERE attempt_id = ?`,
    ).bind(attemptId).first()).toEqual({ status: 'running' });
  });

  // Seeds a running implement Attempt plus a `work` execution instance whose
  // binding satisfies the profile-binding trigger (the Attempt must carry the
  // matching executor_profile_id + executor_route_version). `executionStartedAt`
  // controls the execution's wall-clock age, which drives the ceiling guard.
  async function seedActiveWorkExecution(
    runId: string,
    attemptId: string,
    executionStartedAt: string,
  ): Promise<void> {
    const nowIso = NOW.toISOString();
    const staleHeartbeat = before(DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.running);
    await seedRun(runId, 'executing', staleHeartbeat);
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO executor_profiles (
           profile_id, schema_version, provider_kind, plugin_schema_version,
           release_digest, configuration_json, capabilities_json, status,
           created_at, activated_at
         ) VALUES ('work-profile-active', '1', 'cloudflare_sandbox', '1',
                   ?, '{}', '{}', 'active', ?, ?)`,
      ).bind(`sha256:${'b'.repeat(64)}`, nowIso, nowIso),
      env.DB_CONTROL.prepare(
        `INSERT INTO executor_routes (
           route_id, repository, attempt_mode, execution_role, profile_id,
           route_version, status, created_at, updated_at
         ) VALUES ('work-route-active', 'example/delivery-target',
                   'implement', 'work', 'work-profile-active', 5,
                   'active', ?, ?)`,
      ).bind(nowIso, nowIso),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, version, lease_generation, lease_token_digest,
           lease_expires_at, heartbeat_at, created_at, updated_at,
           executor_profile_id, executor_route_version
         ) VALUES (?, ?, 1, 'implement', 'running', ?, 'example/delivery-target',
                   'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                   3, 1, ?, ?, ?, ?, ?, 'work-profile-active', 5)`,
      ).bind(
        attemptId,
        runId,
        BASE_SHA,
        `sha256:${'c'.repeat(64)}`,
        staleHeartbeat,
        staleHeartbeat,
        staleHeartbeat,
        staleHeartbeat,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         ) VALUES (?, ?, 'agent_execution_start', 'agent_executor', ?, ?,
                   'pending', ?, ?)`,
      ).bind(
        `outbox-work-${attemptId}`,
        runId,
        `d1://executions/execution-work-${attemptId}`,
        `work-dispatch:${attemptId}`,
        nowIso,
        nowIso,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempt_execution_instances (
           execution_id, attempt_id, attempt_version, lease_generation,
           execution_role, executor_profile_id, executor_route_version,
           spec_digest, spec_json, release_digest, provider_kind,
           plugin_schema_version, status, outbox_id, created_at, started_at,
           updated_at
         ) VALUES (?, ?, 3, 1, 'work',
                   'work-profile-active', 5,
                   ?, '{}', ?, 'cloudflare_sandbox', '1', 'running', ?, ?, ?, ?)`,
      ).bind(
        `execution-work-${attemptId}`,
        attemptId,
        `sha256:${'a'.repeat(64)}`,
        `sha256:${'b'.repeat(64)}`,
        `outbox-work-${attemptId}`,
        executionStartedAt,
        executionStartedAt,
        nowIso,
      ),
    ]);
  }

  it('does not fence a running Attempt while its work execution is fresh', async () => {
    // The work lane stopped heartbeating (stale past the running threshold) but
    // its execution is still well within the wall-clock ceiling — a legitimately
    // long edit/verify. It must not be fenced.
    await seedActiveWorkExecution(
      'run-stuck-active-work',
      'attempt-stuck-active-work',
      NOW.toISOString(),
    );

    const scans = await Promise.all(Array.from({ length: 5 }, async () =>
      await new RunStuckDetector(env.DB_CONTROL, {
        now: () => NOW,
        sink: () => undefined,
      }).scan()));
    expect(scans.flatMap((scan) => scan.detected)).toEqual([]);
    expect(await env.DB_CONTROL.prepare(
      `SELECT status FROM attempts WHERE attempt_id = ?`,
    ).bind('attempt-stuck-active-work').first()).toEqual({ status: 'running' });
  });

  it('fences a running Attempt whose work execution has hung past the wall-clock ceiling', async () => {
    // The work execution's container is alive-but-hung: still `running`, but it
    // has exceeded the max wall-clock budget. The reconciler never marks a live
    // container terminal, so without an age ceiling the Attempt is exempted
    // forever and its lease expiry ignored. Past the ceiling the exemption must
    // clear and the watchdog must fence the Attempt.
    await seedActiveWorkExecution(
      'run-stuck-hung-work',
      'attempt-stuck-hung-work',
      before(76 * 60), // 76 min old > 75 min ceiling
    );

    const scan = await new RunStuckDetector(env.DB_CONTROL, {
      now: () => NOW,
      sink: () => undefined,
    }).scan();
    expect(scan.detected).toEqual([
      expect.objectContaining({
        attemptId: 'attempt-stuck-hung-work',
        action: 'fence_lost_attempt',
      }),
    ]);
    expect(await env.DB_CONTROL.prepare(
      `SELECT status FROM attempts WHERE attempt_id = ?`,
    ).bind('attempt-stuck-hung-work').first()).toEqual({ status: 'lost' });
  });

  it('does not trust GitHub success without the matching completion facts', async () => {
    const runId = 'run-stuck-success-without-evidence';
    const attemptId = 'attempt-stuck-success-without-evidence';
    const headSha = 'd'.repeat(40);
    await seedRun(
      runId,
      'executing',
      before(DEFAULT_RUN_STUCK_THRESHOLDS_SECONDS.running),
    );
    await seedRunningAttempt(runId, attemptId);
    await env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET mode = 'implement', github_status = 'completed', github_conclusion = 'success',
           head_sha = ?, github_external_updated_at = ?
       WHERE attempt_id = ?`,
    ).bind(headSha, NOW.toISOString(), attemptId).run();

    const scan = await new RunStuckDetector(env.DB_CONTROL, {
      now: () => NOW,
      sink: () => undefined,
    }).scan();
    expect(scan.detected).toEqual([
      expect.objectContaining({ attemptId, action: 'fence_lost_attempt' }),
    ]);
    expect(await env.DB_CONTROL.prepare(
      `SELECT status FROM attempts WHERE attempt_id = ?`,
    ).bind(attemptId).first()).toEqual({ status: 'lost' });
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
