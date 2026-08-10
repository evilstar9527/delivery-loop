/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { taskRevisionDigest, type TaskEnvelope } from '../../src/domain/task.js';
import { ExecutionProgressReconciler } from
  '../../src/reconciliation/execution-progress-reconciler.js';
import { PullRequestDraftStore } from '../../src/storage/pull-request-draft-store.js';

const NOW = new Date('2026-08-04T10:00:00.000Z');
const RUN_ID = 'run-execution-progress';
const TASK_ID = 'task-execution-progress';
const PLAN_ID = 'plan-execution-progress';
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const PLAN_DIGEST = `sha256:${'c'.repeat(64)}`;
const TASK_OBJECT_KEY = 'tasks/execution-progress.json';

const TASK: TaskEnvelope = {
  schemaVersion: '1',
  eventId: 'event-execution-progress',
  occurredAt: '2026-08-04T09:00:00.000Z',
  source: {
    system: 'manual',
    tenantKey: 'execution-progress',
    taskKey: 'execution-progress',
    revision: 'revision-1',
  },
  actor: { type: 'user', id: 'requester' },
  target: {
    owner: 'example',
    repo: 'delivery-target',
    baseBranch: 'main',
    environment: 'none',
  },
  intent: {
    kind: 'bug',
    title: 'Fix the bounded execution path',
    description: 'A safe synthetic bug used by the control-plane workflow test.',
    acceptanceCriteria: ['The targeted and required verification pass on one bot commit.'],
    priority: 'p1',
  },
  policy: {
    allowRepositoryWrite: true,
    allowTestDeploy: false,
    allowProductionDeploy: false,
    requireHumanApproval: true,
  },
};

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM pull_request_draft_evidence'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_draft_criteria'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_publications'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_drafts'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_done_when_evidence'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_verifications'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_head_updates'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suite_commands'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suites'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_revocations'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
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
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  await env.TASK_OBJECTS.delete(TASK_OBJECT_KEY);
}

async function seed(approval: 'approve' | 'reject' | 'none' = 'approve'): Promise<void> {
  const now = NOW.toISOString();
  const taskDigest = await taskRevisionDigest(TASK);
  await env.TASK_OBJECTS.put(TASK_OBJECT_KEY, JSON.stringify(TASK), {
    customMetadata: { taskDigest },
  });
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'manual', 'execution-progress', 'execution-progress', 'revision-1', ?, ?,
                 'user', 'requester', 'example/delivery-target', 'main', 'none', 'bug', ?,
                 'p1', 1, 1, 0, 0, 1, ?, ?)`,
    ).bind(TASK_ID, taskDigest, `r2://${TASK_OBJECT_KEY}`, TASK.intent.title, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, 'revision-1', ?, ?, ?, 'awaiting_approval', 2, ?, 1, ?, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, taskDigest, BASE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES ('attempt-analysis-progress', ?, 1, 'analysis', 'completed', ?,
                 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 1, 0, ?, ?)`,
    ).bind(RUN_ID, BASE_SHA, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, 'revision-1', ?, ?, 'active', 'attempt-analysis-progress',
                 'Implement and verify one bounded change.', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, now, now),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES (?, 'change', 'change', 'Implement and verify',
               'Make the bounded fix and prove it on the committed head.', 1, 0)`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (plan_id, item_id, status, version, updated_at)
       VALUES (?, 'change', 'pending', 0, ?)`,
    ).bind(PLAN_ID, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_acceptance_criteria
       (plan_id, item_id, acceptance_criterion_index) VALUES (?, 'change', 0)`,
    ).bind(PLAN_ID),
    ...[
      'The bot commit contains the bounded fix.',
      'Targeted and required verification pass on the committed head.',
    ].map((condition, position) => env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_done_when (plan_id, item_id, position, condition)
       VALUES (?, 'change', ?, ?)`,
    ).bind(PLAN_ID, position, condition)),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, 'change', 'repo_write')`,
    ).bind(PLAN_ID),
    ...['test:unit', 'verify:all'].map((commandRef) => env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
       VALUES (?, 'change', ?)`,
    ).bind(PLAN_ID, commandRef)),
    ...['commit', 'test'].map((kind) => env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_evidence_kinds (plan_id, item_id, evidence_kind)
       VALUES (?, 'change', ?)`,
    ).bind(PLAN_ID, kind)),
  ]);
  if (approval !== 'none') {
    await env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-execution-progress', ?, 'revision-1', ?, 1, ?, ?,
                 'repo_write', 'human-reviewer', ?, ?, ?, ?)`,
    ).bind(
      RUN_ID,
      PLAN_ID,
      PLAN_DIGEST,
      BASE_SHA,
      approval,
      `sha256:${'d'.repeat(64)}`,
      new Date(NOW.getTime() + 60 * 60_000).toISOString(),
      now,
    ).run();
  }
}

async function seedOlderUnschedulableRuns(count: number): Promise<void> {
  const createdAt = new Date(NOW.getTime() - 60 * 60_000).toISOString();
  const taskDigest = await taskRevisionDigest(TASK);
  for (let index = 0; index < count; index += 1) {
    const taskId = `task-execution-noise-${index}`;
    const runId = `run-execution-noise-${index}`;
    const attemptId = `attempt-analysis-noise-${index}`;
    const planId = `plan-execution-noise-${index}`;
    const planDigest = `sha256:${index.toString(16).padStart(64, '0')}`;
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO tasks (
           task_id, source_system, tenant_key, source_task_key, task_revision,
           task_digest, payload_ref, actor_type, actor_id, target_repository,
           target_base_branch, target_environment, intent_kind, title, priority,
           acceptance_criteria_count, allow_repository_write, allow_test_deploy,
           allow_production_deploy, require_human_approval, created_at, updated_at
         ) VALUES (?, 'manual', 'execution-progress', ?, 'revision-1', ?, ?,
                   'user', 'requester', 'example/delivery-target', 'main', 'none',
                   'bug', 'Historical unschedulable Run', 'p2', 1, 1, 0, 0, 1, ?, ?)`,
      ).bind(
        taskId,
        `execution-noise-${index}`,
        taskDigest,
        `r2://${TASK_OBJECT_KEY}`,
        createdAt,
        createdAt,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO runs (
           run_id, task_id, task_revision, task_digest, base_sha,
           workflow_instance_id, state, version, active_plan_id,
           active_plan_version, active_plan_digest, created_at, updated_at
         ) VALUES (?, ?, 'revision-1', ?, ?, ?, 'executing', 3, ?, 1, ?, ?, ?)`,
      ).bind(
        runId,
        taskId,
        taskDigest,
        BASE_SHA,
        runId,
        planId,
        planDigest,
        createdAt,
        createdAt,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, version, lease_generation, created_at, updated_at
         ) VALUES (?, ?, 1, 'analysis', 'completed', ?, 'example/delivery-target',
                   'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                   1, 0, ?, ?)`,
      ).bind(attemptId, runId, BASE_SHA, createdAt, createdAt),
      env.DB_CONTROL.prepare(
        `INSERT INTO execution_plans (
           plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
           created_by_attempt_id, objective, created_at, updated_at
         ) VALUES (?, ?, 1, 'revision-1', ?, ?, 'active', ?,
                   'Historical plan without a schedulable change item.', ?, ?)`,
      ).bind(planId, runId, BASE_SHA, planDigest, attemptId, createdAt, createdAt),
    ]);
  }
}

async function seedOlderExpiredFinalizationBlocker(): Promise<void> {
  const createdAt = new Date(NOW.getTime() - 60 * 60_000).toISOString();
  const expiredAt = new Date(NOW.getTime() - 1).toISOString();
  const taskDigest = await taskRevisionDigest(TASK);
  const taskId = 'task-expired-finalization';
  const runId = 'run-expired-finalization';
  const analysisAttemptId = 'attempt-analysis-expired-finalization';
  const implementAttemptId = 'attempt-implement-expired-finalization';
  const planId = 'plan-expired-finalization';
  const planDigest = `sha256:${'f'.repeat(64)}`;
  const headSha = 'd'.repeat(40);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'manual', 'execution-progress', 'expired-finalization', 'revision-1',
                 ?, ?, 'user', 'requester', 'example/delivery-target', 'main', 'none',
                 'bug', 'Expired finalization blocker', 'p2', 1, 1, 0, 0, 1, ?, ?)`,
    ).bind(taskId, taskDigest, `r2://${TASK_OBJECT_KEY}`, createdAt, createdAt),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, 'revision-1', ?, ?, ?, 'verifying', 4, ?, 1, ?, ?, ?)`,
    ).bind(
      runId,
      taskId,
      taskDigest,
      BASE_SHA,
      runId,
      planId,
      planDigest,
      createdAt,
      createdAt,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'completed', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 1, 0, ?, ?)`,
    ).bind(analysisAttemptId, runId, BASE_SHA, createdAt, createdAt),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, 'revision-1', ?, ?, 'active', ?,
                 'Historical verified Plan with an expired approval.', ?, ?)`,
    ).bind(planId, runId, BASE_SHA, planDigest, analysisAttemptId, createdAt, createdAt),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, head_branch, head_sha, version, lease_generation,
         created_at, updated_at
       ) VALUES (?, ?, 2, 'implement', 'completed', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 ?, ?, 3, 1, ?, ?)`,
    ).bind(
      implementAttemptId,
      runId,
      BASE_SHA,
      `agent/${taskId}/${implementAttemptId}`,
      headSha,
      createdAt,
      createdAt,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES (?, 'change', 'change', 'Expired completed change',
               'A historical completed change that must not starve newer work.', 1, 0)`,
    ).bind(planId),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (plan_id, item_id, status, version, updated_at)
       VALUES (?, 'change', 'passed', 3, ?)`,
    ).bind(planId, createdAt),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, 'change', 'repo_write')`,
    ).bind(planId),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, sha, summary, verification_status, observed_at, created_at
       ) VALUES ('evidence-expired-finalization', ?, ?, ?, 1, 'change', 'commit',
                 'passed', ?, 'Historical bot commit.', 'verified', ?, ?)`,
    ).bind(runId, implementAttemptId, planId, headSha, createdAt, createdAt),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_head_updates (
         update_id, evidence_id, run_id, attempt_id, plan_id, plan_version,
         plan_item_id, lease_generation, parent_sha, head_sha, branch, created_at
       ) VALUES ('head-update-expired-finalization', 'evidence-expired-finalization',
                 ?, ?, ?, 1, 'change', 1, ?, ?, ?, ?)`,
    ).bind(
      runId,
      implementAttemptId,
      planId,
      BASE_SHA,
      headSha,
      `agent/${taskId}/${implementAttemptId}`,
      createdAt,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-expired-finalization', ?, 'revision-1', ?, 1, ?, ?,
                 'repo_write', 'human-reviewer', 'approve', ?, ?, ?)`,
    ).bind(
      runId,
      planId,
      planDigest,
      BASE_SHA,
      `sha256:${'9'.repeat(64)}`,
      expiredAt,
      createdAt,
    ),
  ]);
}

async function simulateSuccessfulAction(attemptId: string): Promise<void> {
  const expiredLease = new Date(NOW.getTime() - 60_000).toISOString();
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'running', version = 2, lease_generation = 1,
         lease_expires_at = ?, heartbeat_at = ?, head_branch = ?, head_sha = ?,
         github_run_id = '9001', github_status = 'completed', github_conclusion = 'success',
         github_observed_at = ?, github_external_updated_at = ?, updated_at = ?
       WHERE attempt_id = ?`,
    ).bind(
      expiredLease,
      expiredLease,
      `agent/${TASK_ID}/${attemptId}`,
      HEAD_SHA,
      NOW.toISOString(),
      NOW.toISOString(),
      NOW.toISOString(),
      attemptId,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, sha, summary, verification_status, observed_at, created_at
       ) VALUES ('evidence-progress-commit', ?, ?, ?, 1, 'change', 'commit', 'passed', ?,
                 'Bot commit created.', 'unverified', ?, ?)`,
    ).bind(RUN_ID, attemptId, PLAN_ID, HEAD_SHA, NOW.toISOString(), NOW.toISOString()),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_head_updates (
         update_id, evidence_id, run_id, attempt_id, plan_id, plan_version,
         plan_item_id, lease_generation, parent_sha, head_sha, branch, created_at
       ) VALUES ('head-update-progress', 'evidence-progress-commit', ?, ?, ?, 1,
                 'change', 1, ?, ?, ?, ?)`,
    ).bind(
      RUN_ID,
      attemptId,
      PLAN_ID,
      BASE_SHA,
      HEAD_SHA,
      `agent/${TASK_ID}/${attemptId}`,
      NOW.toISOString(),
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO verification_suites (
         suite_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         lease_generation, head_sha, delivery_policy_digest,
         targeted_command_count, required_command_count, status, created_at, updated_at
       ) VALUES ('suite-progress', ?, ?, ?, 1, 'change', 1, ?, ?, 1, 1,
                 'completed', ?, ?)`,
    ).bind(
      RUN_ID,
      attemptId,
      PLAN_ID,
      HEAD_SHA,
      `sha256:${'e'.repeat(64)}`,
      NOW.toISOString(),
      NOW.toISOString(),
    ),
    ...[
      { id: 'evidence-progress-targeted', position: 0, phase: 'targeted', ref: 'test:unit' },
      { id: 'evidence-progress-required', position: 1, phase: 'required_verify', ref: 'verify:all' },
    ].map((entry) => env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, command_ref, exit_code, duration_ms, sha, summary,
         verification_status, observed_at, created_at
       ) VALUES (?, ?, ?, ?, 1, 'change', 'test', 'passed', ?, 0, 1000, ?,
                 'Trusted verification passed.', 'unverified', ?, ?)`,
    ).bind(
      entry.id,
      RUN_ID,
      attemptId,
      PLAN_ID,
      entry.ref,
      HEAD_SHA,
      NOW.toISOString(),
      NOW.toISOString(),
    )),
  ]);
  await env.DB_CONTROL.batch([
    ...[
      { id: 'evidence-progress-targeted', position: 0, phase: 'targeted', ref: 'test:unit' },
      { id: 'evidence-progress-required', position: 1, phase: 'required_verify', ref: 'verify:all' },
    ].map((entry) => env.DB_CONTROL.prepare(
      `INSERT INTO verification_suite_commands (
         suite_id, position, phase, command_ref, result_status, evidence_id, updated_at
       ) VALUES ('suite-progress', ?, ?, ?, 'passed', ?, ?)`,
    ).bind(entry.position, entry.phase, entry.ref, entry.id, NOW.toISOString())),
  ]);
}

beforeEach(reset);

describe('execution progress reconciliation', () => {
  it.each(['none', 'reject'] as const)(
    'keeps the Run behind the human gate when repo_write approval is %s',
    async (approval) => {
      await seed(approval);
      await new ExecutionProgressReconciler(env.DB_CONTROL, env.TASK_OBJECTS, {
        now: () => NOW,
      }).reconcileBatch(25);

      expect(await env.DB_CONTROL.prepare(
        'SELECT state, version FROM runs WHERE run_id = ?',
      ).bind(RUN_ID).first()).toEqual({ state: 'awaiting_approval', version: 2 });
      expect(await env.DB_CONTROL.prepare(
        `SELECT COUNT(*) AS count FROM attempts WHERE run_id = ? AND mode = 'implement'`,
      ).bind(RUN_ID).first()).toEqual({ count: 0 });
      expect(await env.DB_CONTROL.prepare(
        `SELECT COUNT(*) AS count FROM outbox WHERE run_id = ? AND kind = 'execution_dispatch'`,
      ).bind(RUN_ID).first()).toEqual({ count: 0 });
    },
  );

  it('does not execute under an expired approval', async () => {
    await seed('approve');
    await env.DB_CONTROL.prepare(
      `UPDATE approvals SET expires_at = ? WHERE approval_id = 'approval-execution-progress'`,
    ).bind(new Date(NOW.getTime() - 1).toISOString()).run();

    await new ExecutionProgressReconciler(env.DB_CONTROL, env.TASK_OBJECTS, {
      now: () => NOW,
    }).reconcileBatch(25);

    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'awaiting_approval', version: 2 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE run_id = ? AND kind = 'execution_dispatch'`,
    ).bind(RUN_ID).first()).toEqual({ count: 0 });
  });

  it('converges 20 schedulers to one initial implement Attempt and outbox', async () => {
    await seed('approve');
    const reconciler = () => new ExecutionProgressReconciler(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
      { now: () => NOW },
    ).reconcileBatch(25);

    await Promise.all(Array.from({ length: 20 }, reconciler));

    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'executing', version: 3 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts WHERE run_id = ? AND mode = 'implement'`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE run_id = ? AND kind = 'execution_dispatch'`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
  });

  it('does not let older unschedulable Runs starve a ready approved Run', async () => {
    await seed('approve');
    await seedOlderUnschedulableRuns(5);

    await new ExecutionProgressReconciler(env.DB_CONTROL, env.TASK_OBJECTS, {
      now: () => NOW,
    }).reconcileBatch(5);

    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts WHERE run_id = ? AND mode = 'implement'`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE run_id = ? AND kind = 'execution_dispatch'`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
  });

  it('claims an already activated ready Item through the early D1-only path', async () => {
    await seed('approve');
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE runs SET state = 'executing', version = 3, updated_at = ?
         WHERE run_id = ? AND state = 'awaiting_approval' AND version = 2`,
      ).bind(NOW.toISOString(), RUN_ID),
      env.DB_CONTROL.prepare(
        `UPDATE plan_item_progress SET status = 'ready', version = 1, updated_at = ?
         WHERE plan_id = ? AND item_id = 'change' AND status = 'pending'`,
      ).bind(NOW.toISOString(), PLAN_ID),
    ]);
    const reconciler = new ExecutionProgressReconciler(env.DB_CONTROL, env.TASK_OBJECTS, {
      now: () => NOW,
    });

    expect(await reconciler.reconcileReadyAttempts(1)).toBe(1);
    expect(await reconciler.reconcileReadyAttempts(1)).toBe(0);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts WHERE run_id = ? AND mode = 'implement'`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE run_id = ? AND kind = 'execution_dispatch'`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
  });

  it('verifies a successful Action and creates one durable Draft PR publication', async () => {
    await seed('approve');
    const reconciler = new ExecutionProgressReconciler(env.DB_CONTROL, env.TASK_OBJECTS, {
      now: () => NOW,
    });
    await reconciler.reconcileBatch(25);
    const attempt = await env.DB_CONTROL.prepare(
      `SELECT attempt_id FROM attempts WHERE run_id = ? AND mode = 'implement'`,
    ).bind(RUN_ID).first<{ attempt_id: string }>();
    if (attempt === null) throw new Error('initial execution Attempt was not scheduled');
    await simulateSuccessfulAction(attempt.attempt_id);

    await Promise.all(Array.from({ length: 20 }, async () => {
      await new ExecutionProgressReconciler(env.DB_CONTROL, env.TASK_OBJECTS, {
        now: () => NOW,
      }).reconcileBatch(25);
    }));

    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'verifying', version: 4 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status FROM plan_item_progress WHERE plan_id = ? AND item_id = 'change'`,
    ).bind(PLAN_ID).first()).toEqual({ status: 'passed' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status FROM attempts WHERE attempt_id = ?`,
    ).bind(attempt.attempt_id).first()).toEqual({ status: 'completed' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM plan_item_verifications WHERE plan_id = ?`,
    ).bind(PLAN_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM pull_request_drafts WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM pull_request_publications WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE run_id = ? AND kind = 'pull_request'`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
  });

  it('resumes Draft PR finalization after verification survived an interrupted preparation', async () => {
    await seed('approve');
    const reconciler = new ExecutionProgressReconciler(env.DB_CONTROL, env.TASK_OBJECTS, {
      now: () => NOW,
    });
    await reconciler.reconcileScheduling(25);
    const attempt = await env.DB_CONTROL.prepare(
      `SELECT attempt_id FROM attempts WHERE run_id = ? AND mode = 'implement'`,
    ).bind(RUN_ID).first<{ attempt_id: string }>();
    if (attempt === null) throw new Error('initial execution Attempt was not scheduled');
    await simulateSuccessfulAction(attempt.attempt_id);

    await env.TASK_OBJECTS.delete(TASK_OBJECT_KEY);
    expect(await reconciler.reconcileObservedCompletions(25)).toEqual({
      verifiedItems: 1,
      preparedDrafts: 0,
      scheduledPublications: 0,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'verifying', version: 4 });

    const taskDigest = await taskRevisionDigest(TASK);
    await env.TASK_OBJECTS.put(TASK_OBJECT_KEY, JSON.stringify(TASK), {
      customMetadata: { taskDigest },
    });
    expect(await reconciler.reconcileFinalizations(1)).toEqual({
      preparedDrafts: 1,
      scheduledPublications: 1,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM pull_request_drafts WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM pull_request_publications WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE run_id = ? AND kind = 'pull_request'`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
  });

  it('schedules an already prepared Draft without reopening the Task object', async () => {
    await seed('approve');
    const reconciler = new ExecutionProgressReconciler(env.DB_CONTROL, env.TASK_OBJECTS, {
      now: () => NOW,
    });
    await reconciler.reconcileScheduling(25);
    const attempt = await env.DB_CONTROL.prepare(
      `SELECT attempt_id FROM attempts WHERE run_id = ? AND mode = 'implement'`,
    ).bind(RUN_ID).first<{ attempt_id: string }>();
    if (attempt === null) throw new Error('initial execution Attempt was not scheduled');
    await simulateSuccessfulAction(attempt.attempt_id);

    await env.TASK_OBJECTS.delete(TASK_OBJECT_KEY);
    expect(await reconciler.reconcileObservedCompletions(25)).toEqual({
      verifiedItems: 1,
      preparedDrafts: 0,
      scheduledPublications: 0,
    });
    const taskDigest = await taskRevisionDigest(TASK);
    await env.TASK_OBJECTS.put(TASK_OBJECT_KEY, JSON.stringify(TASK), {
      customMetadata: { taskDigest },
    });
    const draft = await new PullRequestDraftStore(env.DB_CONTROL, env.TASK_OBJECTS).prepare({
      runId: RUN_ID,
      expectedRunVersion: 4,
      planVersion: 1,
      planDigest: PLAN_DIGEST,
      headSha: HEAD_SHA,
    }, NOW);
    expect(draft.created).toBe(true);

    await env.TASK_OBJECTS.delete(TASK_OBJECT_KEY);
    expect(await reconciler.reconcilePreparedPublications(1)).toBe(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM pull_request_publications WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE run_id = ? AND kind = 'pull_request'`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
  });

  it('does not let an older expired approval starve a recoverable finalization', async () => {
    await seed('approve');
    const reconciler = new ExecutionProgressReconciler(env.DB_CONTROL, env.TASK_OBJECTS, {
      now: () => NOW,
    });
    await reconciler.reconcileScheduling(25);
    const attempt = await env.DB_CONTROL.prepare(
      `SELECT attempt_id FROM attempts WHERE run_id = ? AND mode = 'implement'`,
    ).bind(RUN_ID).first<{ attempt_id: string }>();
    if (attempt === null) throw new Error('initial execution Attempt was not scheduled');
    await simulateSuccessfulAction(attempt.attempt_id);

    await env.TASK_OBJECTS.delete(TASK_OBJECT_KEY);
    expect(await reconciler.reconcileObservedCompletions(25)).toEqual({
      verifiedItems: 1,
      preparedDrafts: 0,
      scheduledPublications: 0,
    });
    const taskDigest = await taskRevisionDigest(TASK);
    await env.TASK_OBJECTS.put(TASK_OBJECT_KEY, JSON.stringify(TASK), {
      customMetadata: { taskDigest },
    });
    await seedOlderExpiredFinalizationBlocker();

    expect(await reconciler.reconcileFinalizations(1)).toEqual({
      preparedDrafts: 1,
      scheduledPublications: 1,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM pull_request_publications WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM pull_request_publications
       WHERE run_id = 'run-expired-finalization'`,
    ).first()).toEqual({ count: 0 });
  });
});
