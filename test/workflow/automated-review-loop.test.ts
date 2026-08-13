/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import {
  AutomatedReviewContextV1Schema,
  automatedReviewContextDigest,
} from '../../src/domain/automated-review.js';
import { taskRevisionDigest, type TaskEnvelope } from '../../src/domain/task.js';
import {
  AutomatedReviewContextStore,
  AutomatedReviewResultStore,
  AutomatedReviewScheduler,
} from '../../src/storage/automated-review-store.js';
import type { RunnerAuthorization } from '../../src/storage/runner-attempt-store.js';
import { EXECUTION_TOOL_ACTIONS, TRIAGE_TOOL_ACTIONS } from '../../src/domain/tool-bridge.js';
import {
  GitHubDispatchOutboxProcessor,
  type GitHubDispatchEffects,
  type GitHubDispatchRequest,
} from '../../src/outbox/github-dispatcher.js';
import { ExecutionAttemptContextStore } from '../../src/storage/execution-attempt-store.js';
import { AnalysisAttemptContextStore } from '../../src/storage/analysis-attempt-store.js';
import { ExecutionHeadStore } from '../../src/storage/execution-head-store.js';
import { ExecutionProgressReconciler } from '../../src/reconciliation/execution-progress-reconciler.js';
import { TaskQueryStore } from '../../src/storage/task-query-store.js';
import { Case8AuditReportStore } from '../../src/storage/case8-audit-report-store.js';
import {
  GitHubRunReconciler,
  type GitHubRunExternalFactClient,
} from '../../src/reconciliation/github-run-reconciler.js';
import type { GitHubWorkflowRunFact } from '../../src/storage/github-run-observation-store.js';

const RUN_ID = 'run-automated-review';
const TASK_ID = 'task-automated-review';
const PLAN_ID = 'plan-automated-review';
const ITEM_ID = 'implement-and-verify';
const ANALYSIS_ATTEMPT_ID = 'attempt-automated-review-analysis';
const PRIOR_ATTEMPT_ID = 'attempt-automated-review-implement';
const DRAFT_ID = 'draft-automated-review';
const PUBLICATION_ID = 'publication-automated-review';
const BASE_SHA = 'a'.repeat(40);
const PARENT_SHA = 'b'.repeat(40);
const HEAD_SHA = 'c'.repeat(40);
const PLAN_DIGEST = `sha256:${'d'.repeat(64)}`;
const BRANCH = `agent/${TASK_ID}/${PRIOR_ATTEMPT_ID}`;
const NOW = '2026-08-08T02:00:00.000Z';

class FakeDispatch implements GitHubDispatchEffects {
  requests = 0;
  lastRequest: GitHubDispatchRequest | null = null;

  async ensureDispatch(request: GitHubDispatchRequest) {
    this.requests += 1;
    this.lastRequest = request;
    return {
      disposition: 'created' as const,
      githubRunId: '70042',
      githubHeadSha: BASE_SHA,
    };
  }
}

class FakeReviewRunClient implements GitHubRunExternalFactClient {
  calls = 0;

  constructor(private readonly fact: GitHubWorkflowRunFact) {}

  async getWorkflowRun(): Promise<GitHubWorkflowRunFact> {
    this.calls += 1;
    return this.fact;
  }
}

function taskEnvelope(): TaskEnvelope {
  return {
    schemaVersion: '1',
    eventId: 'event-automated-review',
    occurredAt: NOW,
    source: {
      system: 'manual',
      tenantKey: 'automated-review',
      taskKey: TASK_ID,
      revision: 'revision-1',
    },
    actor: { type: 'user', id: 'owner' },
    target: {
      owner: 'example',
      repo: 'delivery-target',
      baseBranch: 'main',
      environment: 'test',
    },
    intent: {
      kind: 'bug',
      title: 'Fix the exact reported regression',
      description: 'Implement the requested correction and preserve the existing safety boundary.',
      acceptanceCriteria: ['The regression is fixed and all required verification passes.'],
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

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare("DELETE FROM quota_policies WHERE scope_key <> '*'"),
    env.DB_CONTROL.prepare('DELETE FROM approval_invalidations'),
    env.DB_CONTROL.prepare('DELETE FROM review_approval_recoveries'),
    env.DB_CONTROL.prepare('DELETE FROM review_approval_recovery_approvals'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revision_analysis_retries'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revisions'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revision_source_facts'),
    env.DB_CONTROL.prepare('DELETE FROM automated_review_replacement_redispatches'),
    env.DB_CONTROL.prepare('DELETE FROM automated_review_loop_quota_slots'),
    env.DB_CONTROL.prepare('DELETE FROM automated_review_quota_recovery_slots'),
    env.DB_CONTROL.prepare('DELETE FROM automated_review_fix_attempts'),
    env.DB_CONTROL.prepare('DELETE FROM automated_reviews'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_revocations'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_publications'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_drafts'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_done_when_evidence'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_verifications'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_head_updates'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM github_write_credentials'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_evidence_kinds'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_command_refs'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_effects'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_done_when'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_progress'),
    env.DB_CONTROL.prepare('DELETE FROM plan_items'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plans'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  const objects = await env.TASK_OBJECTS.list();
  if (objects.objects.length > 0) {
    await env.TASK_OBJECTS.delete(objects.objects.map((object) => object.key));
  }
  const results = await env.TASK_OBJECTS.list({ prefix: 'automated-reviews/' });
  if (results.objects.length > 0) {
    await env.TASK_OBJECTS.delete(results.objects.map((object) => object.key));
  }
}

async function seed(): Promise<void> {
  const task = taskEnvelope();
  const taskDigest = await taskRevisionDigest(task);
  const taskKey = `tasks/${TASK_ID}.json`;
  const body = '# Delivery Loop Draft PR\n\nReview this exact head.\n';
  const bodyDigest = await canonicalSha256(body);
  await env.TASK_OBJECTS.put(taskKey, JSON.stringify(task), {
    customMetadata: { taskDigest },
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
       ) VALUES (?, 'manual', 'automated-review', ?, 'revision-1', ?, ?, 'user',
                 'owner', 'example/delivery-target', 'main', 'test', 'bug',
                 'Fix the exact reported regression', 'p1', 1, 1, 0, 0, 1, ?, ?)`),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, 'revision-1', ?, ?, ?, 'pull_request_open', 9, ?, 1, ?, ?, ?)`),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'completed', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 1, 0, ?, ?)`),
  ].map((statement, index) => index === 0
    ? statement.bind(TASK_ID, TASK_ID, taskDigest, `r2://${taskKey}`, NOW, NOW)
    : index === 1
      ? statement.bind(RUN_ID, TASK_ID, taskDigest, BASE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, NOW, NOW)
      : statement.bind(ANALYSIS_ATTEMPT_ID, RUN_ID, BASE_SHA, NOW, NOW)));
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, 'revision-1', ?, ?, 'active', ?,
                 'Implement the correction and verify every declared condition.', ?, ?)`
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, ANALYSIS_ATTEMPT_ID, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, plan_item_id,
         claimed_progress_version, head_branch, head_sha, version,
         lease_generation, created_at, updated_at
       ) VALUES (?, ?, 2, 'implement', 'completed', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 ?, 1, ?, 1, ?, ?, 4, 2, ?, ?)`
    ).bind(PRIOR_ATTEMPT_ID, RUN_ID, BASE_SHA, PLAN_ID, ITEM_ID, BRANCH, HEAD_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES (?, ?, 'change', 'Implement and verify',
                 'Apply the exact fix and pass trusted verification.', 1, 0)`
    ).bind(PLAN_ID, ITEM_ID),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_done_when (plan_id, item_id, position, condition)
       VALUES (?, ?, 0, 'The regression is fixed and required verification passes.')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
       VALUES (?, ?, 'verify:all')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
       VALUES (?, ?, 'test:unit')`,
    ).bind(PLAN_ID, ITEM_ID),
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
       ) VALUES (?, ?, 'passed', NULL, 3, ?)`,
    ).bind(PLAN_ID, ITEM_ID, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-automated-review', ?, 'revision-1', ?, 1, ?, ?,
                 'repo_write', 'user:owner', 'approve', ?,
                 '2099-01-01T00:00:00.000Z', ?)`,
    ).bind(RUN_ID, PLAN_ID, PLAN_DIGEST, BASE_SHA, `sha256:${'e'.repeat(64)}`, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, sha, summary, verification_status, observed_at, created_at
       ) VALUES ('evidence-automated-review-commit', ?, ?, ?, 1, ?, 'commit',
                 'passed', ?, 'Trusted bot commit.', 'verified', ?, ?)`,
    ).bind(RUN_ID, PRIOR_ATTEMPT_ID, PLAN_ID, ITEM_ID, HEAD_SHA, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_head_updates (
         update_id, evidence_id, run_id, attempt_id, plan_id, plan_version,
         plan_item_id, lease_generation, parent_sha, head_sha, branch, created_at
       ) VALUES ('head-automated-review', 'evidence-automated-review-commit', ?, ?, ?, 1,
                 ?, 2, ?, ?, ?, ?)`,
    ).bind(RUN_ID, PRIOR_ATTEMPT_ID, PLAN_ID, ITEM_ID, PARENT_SHA, HEAD_SHA, BRANCH, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO pull_request_drafts (
         draft_id, run_id, run_version, task_id, task_revision, task_digest,
         plan_id, plan_version, plan_digest, attempt_id, head_update_id,
         head_sha, branch, body, body_digest, status, created_at
       ) VALUES (?, ?, 8, ?, 'revision-1', ?, ?, 1, ?, ?, 'head-automated-review',
                 ?, ?, ?, ?, 'prepared', ?)`,
    ).bind(
      DRAFT_ID,
      RUN_ID,
      TASK_ID,
      taskDigest,
      PLAN_ID,
      PLAN_DIGEST,
      PRIOR_ATTEMPT_ID,
      HEAD_SHA,
      BRANCH,
      body,
      bodyDigest,
      NOW,
    ),
  ]);
  await env.DB_CONTROL.prepare(
    `INSERT INTO pull_request_publications (
       publication_id, run_id, run_version, draft_id, approval_id,
       repository, base_branch, head_branch, head_sha, title, body_digest,
       status, github_pr_number, github_pr_url, github_external_updated_at,
       github_observation_version, evidence_id, created_at, updated_at
     ) VALUES (?, ?, 8, ?, 'approval-automated-review', 'example/delivery-target',
               'main', ?, ?, 'Delivery Loop automated review', ?, 'verified', 42,
               'https://github.com/example/delivery-target/pull/42', ?, 1, NULL, ?, ?)`,
  ).bind(PUBLICATION_ID, RUN_ID, DRAFT_ID, BRANCH, HEAD_SHA, bodyDigest, NOW, NOW, NOW).run();
}

async function fillAttemptBudget(limit = 20): Promise<void> {
  const row = await env.DB_CONTROL.prepare(
    'SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?',
  ).bind(RUN_ID).first<{ count: number }>();
  const count = row?.count ?? 0;
  if (count > limit) throw new Error('attempt budget is already exceeded');
  if (count === limit) return;
  await env.DB_CONTROL.batch(Array.from({ length: limit - count }, (_, index) => {
    const ordinal = count + index + 1;
    return env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, ?, 'analysis', 'failed', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 1, 0, ?, ?)`,
    ).bind(`attempt-budget-filler-${ordinal}`, RUN_ID, ordinal, BASE_SHA, NOW, NOW);
  }));
}

async function startReview(attemptId: string): Promise<RunnerAuthorization> {
  await env.DB_CONTROL.prepare(
    `UPDATE attempts SET status = 'running', version = 1, lease_generation = 1,
       lease_expires_at = '2099-01-01T00:00:00.000Z', updated_at = ?
     WHERE attempt_id = ? AND status IN ('pending', 'starting')`,
  ).bind(NOW, attemptId).run();
  return {
    attemptId,
    runId: RUN_ID,
    mode: 'analysis',
    status: 'running',
    version: 1,
    leaseGeneration: 1,
    leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    scopes: ['repo:read'],
  };
}

async function scheduleAndContext(): Promise<{
  authorization: RunnerAuthorization;
  context: NonNullable<Awaited<ReturnType<AutomatedReviewContextStore['get']>>>;
}> {
  const scheduled = await new AutomatedReviewScheduler(env.DB_CONTROL)
    .scheduleRun(RUN_ID, new Date(NOW));
  if (scheduled === null) throw new Error('automated review was not scheduled');
  const authorization = await startReview(scheduled.attemptId);
  const context = await new AutomatedReviewContextStore(env.DB_CONTROL, env.TASK_OBJECTS)
    .get(authorization);
  if (context === null) throw new Error('automated review context was not created');
  return { authorization, context };
}

async function apiPlanProjection(): Promise<Record<string, unknown>> {
  const response = await SELF.fetch(
    `https://delivery-loop.test/v1/runs/${RUN_ID}/plan`,
    { headers: { authorization: 'Bearer test-task-intake-token' } },
  );
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('automated review loop', () => {
  it('reserves one bounded run-quota slot for the unique failed review recovery', async () => {
    const scheduler = new AutomatedReviewScheduler(env.DB_CONTROL);
    const scheduled = await scheduler.scheduleRun(RUN_ID, new Date(NOW));
    if (scheduled === null) throw new Error('automated review was not scheduled');
    await env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET status = 'running', version = 2, lease_generation = 1,
           lease_expires_at = '2026-08-08T02:00:30.000Z',
           github_run_id = '70040', github_head_sha = ?,
           github_status = 'completed', github_conclusion = 'failure', updated_at = ?
       WHERE attempt_id = ? AND status = 'pending'`,
    ).bind(BASE_SHA, NOW, scheduled.attemptId).run();
    await fillAttemptBudget();
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ count: 20 });

    const recovered = await scheduler.recoverRun(
      RUN_ID,
      new Date('2026-08-08T02:02:00.000Z'),
    );
    if (recovered === null) throw new Error('automated review recovery was not created');
    expect(recovered).toMatchObject({ created: true });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ count: 21 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM automated_review_quota_recovery_slots
       WHERE review_id = ? AND root_attempt_id = ? AND replacement_attempt_id = ?`,
    ).bind(scheduled.reviewId, scheduled.attemptId, recovered.attemptId).first())
      .toEqual({ count: 1 });

    await expect(env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha,
         version, lease_generation, created_at, updated_at
       ) VALUES ('attempt-over-budget-ordinary', ?, 100, 'analysis', 'pending', ?,
                 0, 0, ?, ?)`,
    ).bind(RUN_ID, BASE_SHA, NOW, NOW).run()).rejects.toThrow('quota_attempt_exceeded');
    await expect(env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha,
         recovered_from_attempt_id, version, lease_generation, created_at, updated_at
       ) VALUES ('attempt-over-budget-second-recovery', ?, 101, 'analysis', 'pending', ?, ?,
                 0, 0, ?, ?)`,
    ).bind(RUN_ID, BASE_SHA, scheduled.attemptId, NOW, NOW).run())
      .rejects.toThrow('quota_attempt_exceeded');
  });

  it('keeps the bounded review_fix loop reachable after quota recovery', async () => {
    const scheduler = new AutomatedReviewScheduler(env.DB_CONTROL);
    const scheduled = await scheduler.scheduleRun(RUN_ID, new Date(NOW));
    if (scheduled === null) throw new Error('automated review was not scheduled');
    await env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET status = 'running', version = 2, lease_generation = 1,
           lease_expires_at = '2026-08-08T02:00:30.000Z',
           github_run_id = '70039', github_head_sha = ?,
           github_status = 'completed', github_conclusion = 'failure', updated_at = ?
       WHERE attempt_id = ? AND status = 'pending'`,
    ).bind(BASE_SHA, NOW, scheduled.attemptId).run();
    await fillAttemptBudget();
    const recovered = await scheduler.recoverRun(
      RUN_ID,
      new Date('2026-08-08T02:02:00.000Z'),
    );
    if (recovered === null) throw new Error('automated review recovery was not created');
    const authorization = await startReview(recovered.attemptId);
    const context = await new AutomatedReviewContextStore(env.DB_CONTROL, env.TASK_OBJECTS)
      .get(authorization);
    if (context === null) throw new Error('automated review context was not created');

    const result = await new AutomatedReviewResultStore(env.DB_CONTROL, env.TASK_OBJECTS)
      .complete(authorization, {
        schemaVersion: '1',
        contextDigest: await automatedReviewContextDigest(context),
        verdict: 'changes_requested',
        summary: 'One correctness issue must be fixed.',
        findings: [{
          severity: 'major',
          title: 'Preserve the exact compare-and-set boundary',
          body: 'The write must remain bound to the current immutable review snapshot.',
          path: 'src/example.ts',
          line: 42,
        }],
      }, new Date('2026-08-08T02:02:10.000Z'));
    expect(result).toMatchObject({ status: 'changes_requested', created: true });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts WHERE run_id = ? AND mode = 'review_fix'`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ count: 22 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM automated_review_loop_quota_slots
       WHERE source_review_id = ? AND attempt_mode = 'review_fix' AND slot_kind = 'review_fix'`,
    ).bind(scheduled.reviewId).first()).toEqual({ count: 1 });
  });

  it('does not bypass a repository attempt quota for failed review recovery', async () => {
    const scheduler = new AutomatedReviewScheduler(env.DB_CONTROL);
    const scheduled = await scheduler.scheduleRun(RUN_ID, new Date(NOW));
    if (scheduled === null) throw new Error('automated review was not scheduled');
    await env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET status = 'running', version = 2, lease_generation = 1,
           lease_expires_at = '2026-08-08T02:00:30.000Z',
           github_run_id = '70041', github_head_sha = ?,
           github_status = 'completed', github_conclusion = 'failure', updated_at = ?
       WHERE attempt_id = ? AND status = 'pending'`,
    ).bind(BASE_SHA, NOW, scheduled.attemptId).run();
    await fillAttemptBudget();
    await env.DB_CONTROL.prepare(
      `INSERT INTO quota_policies (
         policy_id, scope_type, scope_key, resource_type, limit_value,
         window_kind, enabled, created_at, updated_at
       ) VALUES ('policy-review-recovery-repository-attempt', 'repository',
                 'example/delivery-target', 'attempt', 20, 'utc_day', 1, ?, ?)`,
    ).bind(NOW, NOW).run();

    await expect(scheduler.recoverRun(
      RUN_ID,
      new Date('2026-08-08T02:02:00.000Z'),
    )).rejects.toThrow('quota_attempt_exceeded');
    expect(await env.DB_CONTROL.prepare(
      `SELECT status FROM attempts WHERE attempt_id = ?`,
    ).bind(scheduled.attemptId).first()).toEqual({ status: 'running' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts WHERE recovered_from_attempt_id = ?`,
    ).bind(scheduled.attemptId).first()).toEqual({ count: 0 });
  });

  it.each([
    ['tenant', 'automated-review'],
    ['repository', 'example/delivery-target'],
    ['user', 'owner'],
  ] as const)('does not bypass the %s attempt quota with a loop slot', async (scope, key) => {
    const scheduled = await new AutomatedReviewScheduler(env.DB_CONTROL)
      .scheduleRun(RUN_ID, new Date(NOW));
    if (scheduled === null) throw new Error('automated review was not scheduled');
    await fillAttemptBudget();
    const overBudgetAttemptId = `attempt-loop-scope-${scope}`;
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO quota_policies (
           policy_id, scope_type, scope_key, resource_type, limit_value,
           window_kind, enabled, created_at, updated_at
         ) VALUES (?, ?, ?, 'attempt', 20, 'utc_day', 1, ?, ?)`,
      ).bind(`policy-loop-scope-${scope}`, scope, key, NOW, NOW),
      env.DB_CONTROL.prepare(
        `INSERT INTO automated_review_loop_quota_slots (
           slot_id, run_id, source_review_id, attempt_id,
           attempt_mode, slot_kind, created_at
         ) VALUES (?, ?, ?, ?, 'review_fix', 'review_fix', ?)`,
      ).bind(
        `slot-loop-scope-${scope}`,
        RUN_ID,
        scheduled.reviewId,
        overBudgetAttemptId,
        NOW,
      ),
    ]);

    await expect(env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 21, 'review_fix', 'pending', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 0, 0, ?, ?)`,
    ).bind(overBudgetAttemptId, RUN_ID, BASE_SHA, NOW, NOW).run())
      .rejects.toThrow('quota_attempt_exceeded');
  });

  it('fences one failed exact-head review and creates one D1-only replacement', async () => {
    const scheduled = await new AutomatedReviewScheduler(env.DB_CONTROL)
      .scheduleRun(RUN_ID, new Date(NOW));
    if (scheduled === null) throw new Error('automated review was not scheduled');
    await env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET status = 'running', version = 2, lease_generation = 1,
           lease_expires_at = '2026-08-08T02:00:30.000Z',
           heartbeat_at = '2026-08-08T02:00:00.000Z',
           github_run_id = '70043', github_head_sha = ?, github_status = 'requested',
           github_observed_at = ?, updated_at = ?
       WHERE attempt_id = ? AND status = 'pending'`,
    ).bind(BASE_SHA, NOW, NOW, scheduled.attemptId).run();
    await env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest, tool_token_digest,
         lease_generation, scopes_json, expires_at, created_at
       ) VALUES ('token-review-recovery', ?, ?, ?, ?, 1, ?,
                 '2026-08-08T03:00:00.000Z', ?)`,
    ).bind(
      scheduled.attemptId,
      await canonicalSha256('review-recovery-oidc'),
      await canonicalSha256('review-recovery-attempt'),
      await canonicalSha256('review-recovery-tool'),
      JSON.stringify(TRIAGE_TOOL_ACTIONS),
      NOW,
    ).run();
    const externalUpdatedAt = '2026-08-08T02:01:00.000Z';
    const client = new FakeReviewRunClient({
      repository: 'example/delivery-target',
      githubRunId: '70043',
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'failure',
      headSha: BASE_SHA,
      headBranch: 'main',
      workflowPath: '.github/workflows/delivery-agent.yml@refs/heads/main',
      displayTitle: `delivery-loop/${scheduled.attemptId}`,
      runAttempt: 1,
      externalUpdatedAt,
    });
    const now = new Date('2026-08-08T02:02:00.000Z');
    expect(await new GitHubRunReconciler(env.DB_CONTROL, client, { now: () => now })
      .reconcileAtRiskBatch(5, 90)).toEqual([
      { attemptId: scheduled.attemptId, disposition: 'applied' },
    ]);
    expect(client.calls).toBe(1);

    const scheduler = new AutomatedReviewScheduler(env.DB_CONTROL);
    const recovered = await Promise.all(
      Array.from({ length: 20 }, () => scheduler.recoverRun(RUN_ID, now)),
    );
    const replacements = recovered.filter((entry) => entry !== null);
    expect(replacements).toHaveLength(20);
    expect(replacements.filter((entry) => entry.created)).toHaveLength(1);
    expect(new Set(replacements.map((entry) => entry.reviewId))).toEqual(
      new Set([scheduled.reviewId]),
    );
    expect(new Set(replacements.map((entry) => entry.attemptId))).toHaveLength(1);
    const replacement = replacements[0]!;
    expect(replacement.attemptId).not.toBe(scheduled.attemptId);
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, lease_generation FROM attempts WHERE attempt_id = ?`,
    ).bind(scheduled.attemptId).first()).toEqual({ status: 'lost', lease_generation: 2 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT revoked_at IS NOT NULL AS revoked FROM attempt_tokens WHERE attempt_id = ?`,
    ).bind(scheduled.attemptId).first()).toEqual({ revoked: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, recovered_from_attempt_id FROM attempts WHERE attempt_id = ?`,
    ).bind(replacement.attemptId).first()).toEqual({
      status: 'pending',
      recovered_from_attempt_id: scheduled.attemptId,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT state, version FROM runs WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ state: 'pull_request_open', version: 9 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM automated_reviews WHERE review_id = ?
         AND review_attempt_id = ? AND status = 'pending'`,
    ).bind(scheduled.reviewId, scheduled.attemptId).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE kind = 'analysis_dispatch'`,
    ).first()).toEqual({ count: 2 });

    const replacementOutbox = await env.DB_CONTROL.prepare(
      `SELECT outbox_id FROM outbox
       WHERE kind = 'analysis_dispatch' AND payload_ref = ?`,
    ).bind(`d1://attempts/${replacement.attemptId}`).first<{ outbox_id: string }>();
    if (replacementOutbox === null) {
      throw new Error('automated review replacement dispatch was not created');
    }
    const replacementEffects = new FakeDispatch();
    const replacementProcessor = new GitHubDispatchOutboxProcessor(
      env.DB_CONTROL,
      replacementEffects,
      {
        allowedRepositories: ['example/delivery-target'],
        controlPlaneUrl: 'https://control.delivery.test',
        now: () => now,
      },
    );
    expect(await replacementProcessor.deliver(replacementOutbox.outbox_id)).toBe('settled');
    expect(await replacementProcessor.deliver(replacementOutbox.outbox_id)).toBe('settled');
    expect(replacementEffects.requests).toBe(1);
    expect(replacementEffects.lastRequest).toEqual({
      repository: 'example/delivery-target',
      workflowFile: '.github/workflows/delivery-agent.yml',
      ref: 'refs/heads/main',
      inputs: {
        schema_version: '1',
        run_id: RUN_ID,
        attempt_id: replacement.attemptId,
        task_digest: expect.any(String),
        base_sha: HEAD_SHA,
        checkout_sha: HEAD_SHA,
        target_repository: 'example/delivery-target',
        control_plane_url: 'https://control.delivery.test',
        mode: 'analysis',
      },
    });

    const authorization = await startReview(replacement.attemptId);
    const context = await new AutomatedReviewContextStore(env.DB_CONTROL, env.TASK_OBJECTS)
      .get(authorization);
    if (context === null) throw new Error('replacement review context was not created');
    expect(context.attempt.id).toBe(replacement.attemptId);
    const result = await new AutomatedReviewResultStore(env.DB_CONTROL, env.TASK_OBJECTS)
      .complete(authorization, {
        schemaVersion: '1',
        contextDigest: await automatedReviewContextDigest(context),
        verdict: 'approved',
        summary: 'No blocker or major findings remain.',
        findings: [],
      }, now);
    expect(result).toEqual({
      reviewId: scheduled.reviewId,
      status: 'approved',
      created: true,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status FROM attempts WHERE attempt_id = ?`,
    ).bind(replacement.attemptId).first()).toEqual({ status: 'completed' });
  });

  it('does not recover a review from Runner failure state without a terminal GitHub fact', async () => {
    const scheduled = await new AutomatedReviewScheduler(env.DB_CONTROL)
      .scheduleRun(RUN_ID, new Date(NOW));
    if (scheduled === null) throw new Error('automated review was not scheduled');
    await env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET status = 'failed', version = 3, lease_generation = 2,
           github_run_id = '70044', github_head_sha = ?, github_status = 'requested',
           updated_at = ?
       WHERE attempt_id = ? AND status = 'pending'`,
    ).bind(BASE_SHA, NOW, scheduled.attemptId).run();
    expect(await new AutomatedReviewScheduler(env.DB_CONTROL)
      .recoverRun(RUN_ID, new Date('2026-08-08T02:02:00.000Z'))).toBeNull();
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts WHERE recovered_from_attempt_id = ?`,
    ).bind(scheduled.attemptId).first()).toEqual({ count: 0 });
  });

  it('re-arms one failed replacement once without creating another Attempt', async () => {
    const scheduler = new AutomatedReviewScheduler(env.DB_CONTROL);
    const scheduled = await scheduler.scheduleRun(RUN_ID, new Date(NOW));
    if (scheduled === null) throw new Error('automated review was not scheduled');
    await env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET status = 'running', version = 2, lease_generation = 1,
           lease_expires_at = '2026-08-08T02:00:30.000Z',
           github_run_id = '70045', github_head_sha = ?,
           github_status = 'completed', github_conclusion = 'failure', updated_at = ?
       WHERE attempt_id = ? AND status = 'pending'`,
    ).bind(BASE_SHA, NOW, scheduled.attemptId).run();
    const now = new Date('2026-08-08T02:02:00.000Z');
    const replacement = await scheduler.recoverRun(RUN_ID, now);
    if (replacement === null) throw new Error('automated review replacement was not created');
    await env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET status = 'running', version = 3, lease_generation = 2,
           lease_expires_at = '2026-08-08T02:00:30.000Z',
           github_run_id = '70046', github_head_sha = ?,
           github_status = 'completed', github_conclusion = 'failure', updated_at = ?
       WHERE attempt_id = ? AND status = 'pending'`,
    ).bind(BASE_SHA, now.toISOString(), replacement.attemptId).run();
    await env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest, tool_token_digest,
         lease_generation, scopes_json, expires_at, created_at
       ) VALUES ('token-review-replacement', ?, ?, ?, ?, 2, ?,
                 '2026-08-08T03:00:00.000Z', ?)`,
    ).bind(
      replacement.attemptId,
      await canonicalSha256('review-replacement-oidc'),
      await canonicalSha256('review-replacement-attempt'),
      await canonicalSha256('review-replacement-tool'),
      JSON.stringify(TRIAGE_TOOL_ACTIONS),
      NOW,
    ).run();

    const redispatched = await Promise.all(
      Array.from({ length: 20 }, () => scheduler.redispatchRun(RUN_ID, now)),
    );
    const redispatches = redispatched.filter((entry) => entry !== null);
    expect(redispatches).toHaveLength(20);
    expect(redispatches.filter((entry) => entry.created)).toHaveLength(1);
    expect(new Set(redispatches.map((entry) => entry.attemptId))).toEqual(
      new Set([replacement.attemptId]),
    );
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, version, lease_generation, github_run_id, github_status
       FROM attempts WHERE attempt_id = ?`,
    ).bind(replacement.attemptId).first()).toEqual({
      status: 'pending',
      version: 4,
      lease_generation: 3,
      github_run_id: null,
      github_status: null,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT revoked_at IS NOT NULL AS revoked FROM attempt_tokens WHERE attempt_id = ?`,
    ).bind(replacement.attemptId).first()).toEqual({ revoked: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM automated_review_replacement_redispatches
       WHERE review_id = ? AND replacement_attempt_id = ?`,
    ).bind(scheduled.reviewId, replacement.attemptId).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts WHERE recovered_from_attempt_id = ?`,
    ).bind(scheduled.attemptId).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox
       WHERE kind = 'analysis_dispatch' AND payload_ref = ?`,
    ).bind(`d1://attempts/${replacement.attemptId}`).first()).toEqual({ count: 2 });

    const effects = new FakeDispatch();
    const redispatch = redispatches[0]!;
    expect(await new GitHubDispatchOutboxProcessor(env.DB_CONTROL, effects, {
      allowedRepositories: ['example/delivery-target'],
      controlPlaneUrl: 'https://control.delivery.test',
      now: () => now,
    }).deliver(redispatch.outboxId)).toBe('settled');
    expect(effects.requests).toBe(1);
    expect(effects.lastRequest?.inputs.dispatch_generation).toBe('1');

    await env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET status = 'failed', github_run_id = '70047', github_head_sha = ?,
           github_status = 'completed', github_conclusion = 'failure', updated_at = ?
       WHERE attempt_id = ? AND status = 'starting'`,
    ).bind(BASE_SHA, now.toISOString(), replacement.attemptId).run();
    expect(await scheduler.redispatchFailedReplacementsBatch(5, now)).toEqual([]);
    expect(await scheduler.redispatchRun(RUN_ID, now)).toEqual({
      ...redispatch,
      created: false,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, github_run_id FROM attempts WHERE attempt_id = ?`,
    ).bind(replacement.attemptId).first()).toEqual({ status: 'failed', github_run_id: '70047' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox
       WHERE kind = 'analysis_dispatch' AND payload_ref = ?`,
    ).bind(`d1://attempts/${replacement.attemptId}`).first()).toEqual({ count: 2 });
  });

  it('serves context and accepts a result from the redispatched replacement generation', async () => {
    const scheduler = new AutomatedReviewScheduler(env.DB_CONTROL);
    const scheduled = await scheduler.scheduleRun(RUN_ID, new Date(NOW));
    if (scheduled === null) throw new Error('automated review was not scheduled');
    await env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET status = 'running', version = 2, lease_generation = 1,
           lease_expires_at = '2026-08-08T02:00:30.000Z',
           github_run_id = '70048', github_head_sha = ?,
           github_status = 'completed', github_conclusion = 'failure', updated_at = ?
       WHERE attempt_id = ? AND status = 'pending'`,
    ).bind(BASE_SHA, NOW, scheduled.attemptId).run();
    const now = new Date('2026-08-08T02:02:00.000Z');
    const replacement = await scheduler.recoverRun(RUN_ID, now);
    if (replacement === null) throw new Error('automated review replacement was not created');
    await env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET status = 'running', version = 2, lease_generation = 1,
           lease_expires_at = '2026-08-08T02:00:30.000Z',
           github_run_id = '70049', github_head_sha = ?,
           github_status = 'completed', github_conclusion = 'failure', updated_at = ?
       WHERE attempt_id = ? AND status = 'pending'`,
    ).bind(BASE_SHA, now.toISOString(), replacement.attemptId).run();

    const redispatch = await scheduler.redispatchRun(RUN_ID, now);
    if (redispatch === null) throw new Error('automated review redispatch was not created');
    const effects = new FakeDispatch();
    expect(await new GitHubDispatchOutboxProcessor(env.DB_CONTROL, effects, {
      allowedRepositories: ['example/delivery-target'],
      controlPlaneUrl: 'https://control.delivery.test',
      now: () => now,
    }).deliver(redispatch.outboxId)).toBe('settled');
    expect(effects.lastRequest?.inputs.dispatch_generation).toBe('1');

    const starting = await env.DB_CONTROL.prepare(
      `SELECT version, lease_generation FROM attempts WHERE attempt_id = ?`,
    ).bind(replacement.attemptId).first<{ version: number; lease_generation: number }>();
    if (starting === null) throw new Error('redispatched replacement was not started');
    const token = 'automated-review-redispatch-token';
    const [tokenDigest, oidcDigest, toolDigest] = await Promise.all([
      canonicalSha256(token),
      canonicalSha256('automated-review-redispatch-oidc'),
      canonicalSha256('automated-review-redispatch-tool'),
    ]);
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE attempts
         SET status = 'running', version = version + 1, lease_token_digest = ?,
             lease_expires_at = '2099-01-01T00:00:00.000Z', heartbeat_at = ?, updated_at = ?
         WHERE attempt_id = ? AND status = 'starting'
           AND version = ? AND lease_generation = ?`,
      ).bind(
        tokenDigest,
        now.toISOString(),
        now.toISOString(),
        replacement.attemptId,
        starting.version,
        starting.lease_generation,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempt_tokens (
           token_id, attempt_id, oidc_token_digest, token_digest, tool_token_digest,
           lease_generation, scopes_json, expires_at, created_at
         ) VALUES ('token-automated-review-redispatch', ?, ?, ?, ?, ?, ?,
                   '2099-01-01T00:00:00.000Z', ?)`,
      ).bind(
        replacement.attemptId,
        oidcDigest,
        tokenDigest,
        toolDigest,
        starting.lease_generation,
        JSON.stringify(TRIAGE_TOOL_ACTIONS),
        now.toISOString(),
      ),
    ]);

    const task = taskEnvelope();
    await env.TASK_OBJECTS.put(`tasks/${TASK_ID}.json`, JSON.stringify(task), {
      customMetadata: { taskDigest: `sha256:${'0'.repeat(64)}` },
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
    const staleContextResponse = await SELF.fetch(
      `https://delivery-loop.test/v1/attempts/${replacement.attemptId}/context`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(staleContextResponse.status).toBe(409);
    await env.TASK_OBJECTS.put(`tasks/${TASK_ID}.json`, JSON.stringify(task), {
      customMetadata: { taskDigest: await taskRevisionDigest(task) },
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
    const contextResponse = await SELF.fetch(
      `https://delivery-loop.test/v1/attempts/${replacement.attemptId}/context`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(contextResponse.status).toBe(200);
    const context = AutomatedReviewContextV1Schema.parse(await contextResponse.json());
    expect(context.attempt).toMatchObject({
      id: replacement.attemptId,
      leaseGeneration: starting.lease_generation,
    });
    const reservationDigest = await canonicalSha256({
      attemptId: replacement.attemptId,
      kind: 'automated_review',
      leaseGeneration: starting.lease_generation,
    });
    const reservationId =
      `model_reservation_${reservationDigest.slice('sha256:'.length, 'sha256:'.length + 48)}`;
    const reservation = await SELF.fetch(
      `https://delivery-loop.test/v1/attempts/${replacement.attemptId}/model-reservations`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          reservationId,
          profileId: 'codex-gpt-5p6-terra-medium-tool-loop-20260811',
          expectedVersion: context.attempt.version,
          leaseGeneration: context.attempt.leaseGeneration,
        }),
      },
    );
    expect(reservation.status).toBe(201);

    const result = await SELF.fetch(
      `https://delivery-loop.test/v1/attempts/${replacement.attemptId}/automated-review-result`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          schemaVersion: '1',
          contextDigest: await automatedReviewContextDigest(context),
          verdict: 'approved',
          summary: 'No blocker or major findings remain.',
          findings: [],
        }),
      },
    );
    expect(result.status).toBe(201);
    expect(await result.json()).toMatchObject({
      accepted: true,
      reviewId: scheduled.reviewId,
      status: 'approved',
      created: true,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, result_event_id IS NOT NULL AS has_result
       FROM attempts WHERE attempt_id = ?`,
    ).bind(replacement.attemptId).first()).toEqual({ status: 'completed', has_result: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts WHERE recovered_from_attempt_id = ?`,
    ).bind(scheduled.attemptId).first()).toEqual({ count: 1 });
  });

  it('converges one exact-head review and opens one review_fix for a major finding', async () => {
    const scheduler = new AutomatedReviewScheduler(env.DB_CONTROL);
    const scheduled = await Promise.all(
      Array.from({ length: 20 }, () => scheduler.scheduleRun(RUN_ID, new Date(NOW))),
    );
    const created = scheduled.filter((entry) => entry !== null);
    expect(created).toHaveLength(20);
    expect(created.filter((entry) => entry.created)).toHaveLength(1);
    expect(new Set(created.map((entry) => entry.reviewId))).toHaveLength(1);
    expect(new Set(created.map((entry) => entry.attemptId))).toHaveLength(1);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM automated_reviews',
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE kind = 'analysis_dispatch'`,
    ).first()).toEqual({ count: 1 });

    const reviewOutbox = await env.DB_CONTROL.prepare(
      `SELECT outbox_id FROM outbox WHERE kind = 'analysis_dispatch'`,
    ).first<{ outbox_id: string }>();
    if (reviewOutbox === null) throw new Error('automated review dispatch was not created');
    const reviewEffects = new FakeDispatch();
    expect(await new GitHubDispatchOutboxProcessor(env.DB_CONTROL, reviewEffects, {
      allowedRepositories: ['example/delivery-target'],
      controlPlaneUrl: 'https://control.delivery.test',
      now: () => new Date(NOW),
    }).deliver(reviewOutbox.outbox_id)).toBe('settled');
    expect(reviewEffects.requests).toBe(1);

    const authorization = await startReview(created[0]!.attemptId);
    const contextStore = new AutomatedReviewContextStore(env.DB_CONTROL, env.TASK_OBJECTS);
    const context = await contextStore.get(authorization);
    expect(context?.review.headSha).toBe(HEAD_SHA);
    if (context === null) throw new Error('automated review context was not created');
    expect((await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus(RUN_ID))?.automatedReview)
      .toEqual({ iteration: 1, status: 'pending' });
    expect((await apiPlanProjection()).automatedReview).toEqual({
      iteration: 1,
      status: 'pending',
    });
    const result = {
      schemaVersion: '1' as const,
      contextDigest: await automatedReviewContextDigest(context),
      verdict: 'changes_requested' as const,
      summary: 'One correctness issue must be fixed.',
      findings: [{
        severity: 'major' as const,
        title: 'Lost update under concurrent writers',
        body: 'The update must use the existing compare-and-set version boundary.',
        path: 'src/example.ts',
        line: 42,
      }],
    };
    const store = new AutomatedReviewResultStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    );
    const first = await store.complete(authorization, result, new Date(NOW));
    const replay = await store.complete(authorization, result, new Date(NOW));
    expect(first).toEqual({
      reviewId: created[0]!.reviewId,
      status: 'changes_requested',
      fixAttemptId: expect.any(String),
      created: true,
    });
    expect(replay).toEqual({ ...first, created: false });
    expect((await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus(RUN_ID))?.automatedReview)
      .toEqual({
        iteration: 1,
        status: 'changes_requested',
        blockingFindingCount: 1,
        minorFindingCount: 0,
      });
    expect((await apiPlanProjection()).automatedReview).toEqual({
      iteration: 1,
      status: 'changes_requested',
      blockingFindingCount: 1,
      minorFindingCount: 0,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts WHERE mode = 'review_fix'`,
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT state FROM runs WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ state: 'executing' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, active_attempt_id FROM plan_item_progress
       WHERE plan_id = ? AND item_id = ?`,
    ).bind(PLAN_ID, ITEM_ID).first()).toEqual({
      status: 'in_progress',
      active_attempt_id: first.fixAttemptId,
    });

    const outbox = await env.DB_CONTROL.prepare(
      `SELECT outbox_id FROM outbox WHERE kind = 'execution_dispatch'`,
    ).first<{ outbox_id: string }>();
    if (outbox === null || first.fixAttemptId === undefined) {
      throw new Error('automated review fix dispatch was not created');
    }
    const effects = new FakeDispatch();
    expect(await new GitHubDispatchOutboxProcessor(env.DB_CONTROL, effects, {
      allowedRepositories: ['example/delivery-target'],
      controlPlaneUrl: 'https://control.delivery.test',
      now: () => new Date(NOW),
    }).deliver(outbox.outbox_id)).toBe('settled');
    expect(effects.requests).toBe(1);
    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'running', version = version + 1,
         lease_expires_at = '2099-01-01T00:00:00.000Z', updated_at = ?
       WHERE attempt_id = ? AND status = 'starting'`,
    ).bind(NOW, first.fixAttemptId).run();
    const fix = await env.DB_CONTROL.prepare(
      `SELECT version, lease_generation FROM attempts WHERE attempt_id = ?`,
    ).bind(first.fixAttemptId).first<{ version: number; lease_generation: number }>();
    if (fix === null) throw new Error('automated review fix Attempt is unavailable');
    const fixAuthorization: RunnerAuthorization = {
      attemptId: first.fixAttemptId,
      runId: RUN_ID,
      mode: 'review_fix',
      status: 'running',
      version: fix.version,
      leaseGeneration: fix.lease_generation,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      scopes: [...EXECUTION_TOOL_ACTIONS],
    };
    const fixContext = await new ExecutionAttemptContextStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).get(fixAuthorization);
    expect(fixContext.reviewFeedback).toMatchObject({
      reviewId: created[0]!.reviewId,
      sourceHeadSha: HEAD_SHA,
      branch: BRANCH,
    });
    expect(fixContext.reviewFeedback?.body).toContain('[MAJOR]');
    const fixedHead = '9'.repeat(40);
    expect(await new ExecutionHeadStore(env.DB_CONTROL).record(fixAuthorization, {
      expectedVersion: fix.version,
      leaseGeneration: fix.lease_generation,
      parentSha: HEAD_SHA,
      headSha: fixedHead,
      branch: BRANCH,
    }, new Date(NOW))).toMatchObject({ headSha: fixedHead, branch: BRANCH, created: true });
  });

  it('resolves an automated review_fix replacement through its immutable root lineage', async () => {
    const { authorization, context } = await scheduleAndContext();
    const completed = await new AutomatedReviewResultStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).complete(authorization, {
      schemaVersion: '1',
      contextDigest: await automatedReviewContextDigest(context),
      verdict: 'changes_requested',
      summary: 'One root-bound fix is required.',
      findings: [{
        severity: 'major',
        title: 'Preserve the immutable source lineage',
        body: 'A replacement must consume the same automated review feedback.',
        path: 'src/example.ts',
        line: 42,
      }],
    }, new Date(NOW));
    if (completed.fixAttemptId === undefined) {
      throw new Error('automated review fix Attempt was not created');
    }
    const rootAttemptId = completed.fixAttemptId;
    const replacementAttemptId = 'attempt-automated-fix-pre-effect-replacement';
    const replacementOutboxId = 'dispatch-automated-fix-pre-effect-replacement';
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `DELETE FROM outbox WHERE payload_ref = ? AND kind = 'execution_dispatch'`,
      ).bind(`d1://attempts/${rootAttemptId}`),
      env.DB_CONTROL.prepare(
        `UPDATE attempts
         SET status = 'failed', github_status = 'completed', github_conclusion = 'failure',
             version = version + 1, lease_generation = lease_generation + 1, updated_at = ?
         WHERE attempt_id = ? AND status = 'pending'`,
      ).bind(NOW, rootAttemptId),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, plan_id, plan_version, plan_item_id,
           claimed_progress_version, head_sha, recovered_from_attempt_id,
           version, lease_generation, created_at, updated_at
         )
         SELECT ?, run_id, ordinal + 1, mode, 'pending', base_sha, repository,
                workflow_ref, plan_id, plan_version, plan_item_id,
                claimed_progress_version + 1, head_sha, attempt_id,
                0, 0, ?, ?
         FROM attempts WHERE attempt_id = ?`,
      ).bind(replacementAttemptId, NOW, NOW, rootAttemptId),
      env.DB_CONTROL.prepare(
        `UPDATE plan_item_progress
         SET active_attempt_id = ?, version = version + 1, updated_at = ?
         WHERE plan_id = ? AND item_id = ? AND active_attempt_id = ?`,
      ).bind(replacementAttemptId, NOW, PLAN_ID, ITEM_ID, rootAttemptId),
      env.DB_CONTROL.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         ) VALUES (?, ?, 'execution_dispatch', 'github_actions', ?, ?, 'pending', ?, ?)`,
      ).bind(
        replacementOutboxId,
        RUN_ID,
        `d1://attempts/${replacementAttemptId}`,
        `execution-automated-fix-replacement:${rootAttemptId}`,
        NOW,
        NOW,
      ),
    ]);

    const effects = new FakeDispatch();
    expect(await new GitHubDispatchOutboxProcessor(env.DB_CONTROL, effects, {
      allowedRepositories: ['example/delivery-target'],
      controlPlaneUrl: 'https://control.delivery.test',
      now: () => new Date(NOW),
    }).deliver(replacementOutboxId)).toBe('settled');
    expect(effects.requests).toBe(1);
    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'running', version = version + 1,
         lease_expires_at = '2099-01-01T00:00:00.000Z', updated_at = ?
       WHERE attempt_id = ? AND status = 'starting'`,
    ).bind(NOW, replacementAttemptId).run();
    const replacement = await env.DB_CONTROL.prepare(
      `SELECT version, lease_generation FROM attempts WHERE attempt_id = ?`,
    ).bind(replacementAttemptId).first<{ version: number; lease_generation: number }>();
    if (replacement === null) throw new Error('replacement Attempt is unavailable');
    const replacementAuthorization: RunnerAuthorization = {
      attemptId: replacementAttemptId,
      runId: RUN_ID,
      mode: 'review_fix',
      status: 'running',
      version: replacement.version,
      leaseGeneration: replacement.lease_generation,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      scopes: [...EXECUTION_TOOL_ACTIONS],
    };
    const replacementContext = await new ExecutionAttemptContextStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).get(replacementAuthorization);
    expect(replacementContext.reviewFeedback).toMatchObject({
      reviewId: completed.reviewId,
      sourceHeadSha: HEAD_SHA,
      branch: BRANCH,
    });

    const fixedHead = '7'.repeat(40);
    expect(await new ExecutionHeadStore(env.DB_CONTROL).record(replacementAuthorization, {
      expectedVersion: replacement.version,
      leaseGeneration: replacement.lease_generation,
      parentSha: HEAD_SHA,
      headSha: fixedHead,
      branch: BRANCH,
    }, new Date(NOW))).toMatchObject({ headSha: fixedHead, branch: BRANCH, created: true });
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO evidence (
           evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           kind, status, command_ref, exit_code, sha, summary,
           verification_status, observed_at, created_at
         ) VALUES ('evidence-automated-fix-replacement-test', ?, ?, ?, 1, ?, 'test',
                   'passed', 'verify:all', 0, ?, 'Verified replacement test.',
                   'verified', ?, ?)`,
      ).bind(RUN_ID, replacementAttemptId, PLAN_ID, ITEM_ID, fixedHead, NOW, NOW),
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_item_verifications (
           verification_id, run_id, plan_id, plan_version, plan_item_id,
           attempt_id, head_sha, progress_version, evidence_set_digest, status, created_at
         )
         SELECT 'verification-automated-fix-replacement', ?, ?, 1, ?, ?, ?,
                progress.version, ?, 'passed', ?
         FROM plan_item_progress AS progress
         WHERE progress.plan_id = ? AND progress.item_id = ?
           AND progress.active_attempt_id = ?`,
      ).bind(
        RUN_ID,
        PLAN_ID,
        ITEM_ID,
        replacementAttemptId,
        fixedHead,
        `sha256:${'8'.repeat(64)}`,
        NOW,
        PLAN_ID,
        ITEM_ID,
        replacementAttemptId,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_item_done_when_evidence (
           verification_id, plan_id, item_id, done_when_position,
           evidence_position, evidence_id
         )
         VALUES ('verification-automated-fix-replacement', ?, ?, 0, 0,
                 'evidence-automated-fix-replacement-test')`,
      ).bind(PLAN_ID, ITEM_ID),
      env.DB_CONTROL.prepare(
        `UPDATE attempts SET status = 'completed', head_sha = ?, head_branch = ?,
             version = version + 1, updated_at = ? WHERE attempt_id = ?`,
      ).bind(fixedHead, BRANCH, NOW, replacementAttemptId),
      env.DB_CONTROL.prepare(
        `UPDATE plan_item_progress SET status = 'passed', active_attempt_id = NULL,
             version = version + 1, updated_at = ? WHERE plan_id = ? AND item_id = ?`,
      ).bind(NOW, PLAN_ID, ITEM_ID),
    ]);
    expect(await new AutomatedReviewScheduler(env.DB_CONTROL)
      .resumeFixedRuns(1, new Date(NOW))).toBe(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT state FROM runs WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ state: 'pull_request_open' });
    expect(await new AutomatedReviewScheduler(env.DB_CONTROL)
      .scheduleRun(RUN_ID, new Date(NOW))).toMatchObject({
        iteration: 2,
        headSha: fixedHead,
        created: true,
      });
  });

  it('completes an approved review without creating a write Attempt', async () => {
    const { authorization, context } = await scheduleAndContext();
    const result = {
      schemaVersion: '1' as const,
      contextDigest: await automatedReviewContextDigest(context),
      verdict: 'approved' as const,
      summary: 'No blocker or major findings remain.',
      findings: [{
        severity: 'minor' as const,
        title: 'Optional naming cleanup',
        body: 'This does not affect correctness or the declared acceptance criteria.',
      }],
    };
    const store = new AutomatedReviewResultStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    );
    expect(await store.complete(authorization, result, new Date(NOW))).toMatchObject({
      status: 'approved',
      created: true,
    });
    expect((await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus(RUN_ID))?.automatedReview)
      .toEqual({
        iteration: 1,
        status: 'approved',
        blockingFindingCount: 0,
        minorFindingCount: 1,
      });
    expect((await apiPlanProjection()).automatedReview).toEqual({
      iteration: 1,
      status: 'approved',
      blockingFindingCount: 0,
      minorFindingCount: 1,
    });
    expect(await store.complete(authorization, result, new Date(NOW))).toMatchObject({
      status: 'approved',
      created: false,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts WHERE mode = 'review_fix'`,
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT state FROM runs WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ state: 'pull_request_open' });
  });

  it('turns an automated review_fix replan decision into one readable Plan revision source', async () => {
    const { authorization, context } = await scheduleAndContext();
    const completed = await new AutomatedReviewResultStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).complete(authorization, {
      schemaVersion: '1',
      contextDigest: await automatedReviewContextDigest(context),
      verdict: 'changes_requested',
      summary: 'The approved Plan must be revised before this finding can be fixed.',
      findings: [{
        severity: 'major',
        title: 'The requested correction is outside the approved Plan body',
        body: 'Create a new Plan version before changing the documented behavior.',
        path: 'docs/Vision.md',
        line: 38,
      }],
    }, new Date(NOW));
    if (completed.fixAttemptId === undefined) {
      throw new Error('automated review fix Attempt was not created');
    }
    const token = 'automated-review-fix-replan-token';
    const [tokenDigest, oidcDigest, toolDigest] = await Promise.all([
      canonicalSha256(token),
      canonicalSha256('automated-review-fix-replan-oidc'),
      canonicalSha256('automated-review-fix-replan-tool'),
    ]);
    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'running', version = version + 1,
         lease_generation = lease_generation + 1, lease_token_digest = ?,
         lease_expires_at = '2099-01-01T00:00:00.000Z', updated_at = ?
       WHERE attempt_id = ? AND status = 'pending'`,
    ).bind(tokenDigest, NOW, completed.fixAttemptId).run();
    const fix = await env.DB_CONTROL.prepare(
      `SELECT version, lease_generation FROM attempts WHERE attempt_id = ?`,
    ).bind(completed.fixAttemptId).first<{ version: number; lease_generation: number }>();
    if (fix === null) throw new Error('automated review fix Attempt is unavailable');
    await env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest, tool_token_digest,
         lease_generation, scopes_json, expires_at, created_at
       ) VALUES ('token-automated-review-fix-replan', ?, ?, ?, ?, ?, ?,
                 '2099-01-01T00:00:00.000Z', ?)`,
    ).bind(
      completed.fixAttemptId,
      oidcDigest,
      tokenDigest,
      toolDigest,
      fix.lease_generation,
      JSON.stringify(EXECUTION_TOOL_ACTIONS),
      NOW,
    ).run();

    const responses = await Promise.all(Array.from({ length: 20 }, async () => await SELF.fetch(
      `https://delivery-loop.test/v1/attempts/${completed.fixAttemptId}/plan-revision`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          expectedVersion: fix.version,
          leaseGeneration: fix.lease_generation,
        }),
      },
    )));
    expect(responses.some((response) => response.status === 202)).toBe(true);
    expect(responses.every((response) => [200, 202, 401, 409].includes(response.status)))
      .toBe(true);
    const accepted = responses.find((response) => response.status === 202);
    if (accepted === undefined) throw new Error('automated review Plan revision was not accepted');
    const revision = await accepted.json() as {
      revisionId: string;
      analysisAttemptId: string;
      runVersion: number;
    };
    expect(revision).toMatchObject({ runVersion: 11 });
    const replay = await SELF.fetch(
      `https://delivery-loop.test/v1/attempts/${completed.fixAttemptId}/plan-revision`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          expectedVersion: fix.version,
          leaseGeneration: fix.lease_generation,
        }),
      },
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      accepted: true,
      revisionId: revision.revisionId,
      analysisAttemptId: revision.analysisAttemptId,
      created: false,
      runVersion: 11,
    });
    const rebound = await SELF.fetch(
      `https://delivery-loop.test/v1/attempts/${completed.fixAttemptId}/plan-revision`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          expectedVersion: fix.version + 1,
          leaseGeneration: fix.lease_generation,
        }),
      },
    );
    expect(rebound.status).toBe(409);
    expect(await env.DB_CONTROL.prepare(
      `SELECT source_kind, source_ref FROM plan_revision_source_facts`,
    ).first()).toEqual({
      source_kind: 'review_feedback',
      source_ref: `d1://automated-reviews/${context.review.id}`,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM plan_revision_source_facts`,
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM plan_revisions`,
    ).first()).toEqual({ count: 1 });
    const audit = await new Case8AuditReportStore(env.DB_CONTROL, {
      now: () => new Date(NOW),
    }).generate(RUN_ID);
    expect((audit.answers.checks.planRevisions as Array<Record<string, unknown>>)[0]?.source)
      .toMatchObject({
        kind: 'review_feedback',
        sourceType: 'automated_review',
        recordId: context.review.id,
        reviewId: context.review.id,
        reviewedHeadSha: HEAD_SHA,
      });
    expect(await env.DB_CONTROL.prepare(
      `SELECT state, version FROM runs WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ state: 'planning', version: 11 });

    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'running', version = 1, lease_generation = 1,
         lease_expires_at = '2099-01-01T00:00:00.000Z', updated_at = ?
       WHERE attempt_id = ? AND status = 'pending'`,
    ).bind(NOW, revision.analysisAttemptId).run();
    const revisionContext = await new AnalysisAttemptContextStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).get({
      attemptId: revision.analysisAttemptId,
      runId: RUN_ID,
      mode: 'analysis',
      status: 'running',
      version: 1,
      leaseGeneration: 1,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      scopes: ['repo:read'],
    });
    expect(revisionContext.revisionSource).toMatchObject({
      kind: 'review_feedback',
      data: {
        reviewId: context.review.id,
        sourceHeadSha: HEAD_SHA,
        branch: BRANCH,
      },
    });
    expect(revisionContext.revisionSource?.kind === 'review_feedback' &&
      revisionContext.revisionSource.data.body).toContain('[MAJOR]');
  });

  it('admits the same automated review replan from a recovered fix replacement', async () => {
    const { authorization, context } = await scheduleAndContext();
    const completed = await new AutomatedReviewResultStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).complete(authorization, {
      schemaVersion: '1',
      contextDigest: await automatedReviewContextDigest(context),
      verdict: 'changes_requested',
      summary: 'The approved Plan must be revised before this finding can be fixed.',
      findings: [{
        severity: 'major',
        title: 'The requested correction is outside the approved Plan body',
        body: 'Create a new Plan version before changing the documented behavior.',
        path: 'docs/Vision.md',
        line: 38,
      }],
    }, new Date(NOW));
    if (completed.fixAttemptId === undefined) {
      throw new Error('automated review fix Attempt was not created');
    }
    const replacementAttemptId = 'attempt-automated-review-fix-recovered-replan';
    const token = 'automated-review-fix-recovered-replan-token';
    const [tokenDigest, oidcDigest, toolDigest] = await Promise.all([
      canonicalSha256(token),
      canonicalSha256('automated-review-fix-recovered-replan-oidc'),
      canonicalSha256('automated-review-fix-recovered-replan-tool'),
    ]);
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE attempts SET status = 'failed', version = 2, lease_generation = 2,
             lease_token_digest = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE attempt_id = ? AND status = 'pending'`,
      ).bind(NOW, completed.fixAttemptId),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, plan_id, plan_version, plan_item_id,
           claimed_progress_version, head_sha, recovered_from_attempt_id,
           version, lease_generation, lease_token_digest, lease_expires_at,
           created_at, updated_at
         )
         SELECT ?, run_id, ordinal + 1, mode, 'running', base_sha, repository,
                workflow_ref, plan_id, plan_version, plan_item_id,
                claimed_progress_version + 1, head_sha, attempt_id,
                1, 1, ?, '2099-01-01T00:00:00.000Z', ?, ?
         FROM attempts WHERE attempt_id = ?`,
      ).bind(replacementAttemptId, tokenDigest, NOW, NOW, completed.fixAttemptId),
      env.DB_CONTROL.prepare(
        `UPDATE plan_item_progress SET active_attempt_id = ?, version = version + 1,
             updated_at = ? WHERE plan_id = ? AND item_id = ?
             AND active_attempt_id = ? AND status = 'in_progress'`,
      ).bind(replacementAttemptId, NOW, PLAN_ID, ITEM_ID, completed.fixAttemptId),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempt_tokens (
           token_id, attempt_id, oidc_token_digest, token_digest, tool_token_digest,
           lease_generation, scopes_json, expires_at, created_at
         ) VALUES ('token-automated-review-fix-recovered-replan', ?, ?, ?, ?, 1, ?,
                   '2099-01-01T00:00:00.000Z', ?)`,
      ).bind(
        replacementAttemptId,
        oidcDigest,
        tokenDigest,
        toolDigest,
        JSON.stringify(EXECUTION_TOOL_ACTIONS),
        NOW,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO approvals (
           approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
           base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
         ) VALUES ('approval-automated-review-fix-recovered-replan', ?, 'revision-1',
                   ?, 1, ?, ?, 'repo_write', 'user:owner', 'approve', ?,
                   '2099-01-01T00:00:00.000Z', ?)`,
      ).bind(
        RUN_ID,
        PLAN_ID,
        PLAN_DIGEST,
        BASE_SHA,
        `sha256:${'9'.repeat(64)}`,
        NOW,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO github_write_credentials (
           credential_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           approval_id, repository, lease_generation, status,
           authorization_expires_at, created_at, updated_at
         ) VALUES ('credential-automated-review-fix-recovered-replan', ?, ?, ?, 1, ?,
                   'approval-automated-review-fix-recovered-replan',
                   'example/delivery-target', 1, 'active',
                   '2099-01-01T00:00:00.000Z', ?, ?)`,
      ).bind(RUN_ID, replacementAttemptId, PLAN_ID, ITEM_ID, NOW, NOW),
      env.DB_CONTROL.prepare(
        `INSERT INTO review_approval_recovery_approvals (
           recovery_approval_id, run_id, plan_id, plan_version, plan_item_id,
           failed_attempt_id, root_review_attempt_id, approval_id, created_at, source_kind
         ) VALUES ('recovery-approval-automated-review-fix-replan', ?, ?, 1, ?, ?, ?,
                   'approval-automated-review-fix-recovered-replan', ?,
                   'automated_fix_failed_pre_effect')`,
      ).bind(
        RUN_ID,
        PLAN_ID,
        ITEM_ID,
        completed.fixAttemptId,
        completed.fixAttemptId,
        NOW,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO review_approval_recoveries (
           recovery_id, recovery_approval_id, run_id, plan_id, plan_version,
           plan_item_id, failed_attempt_id, root_review_attempt_id, approval_id,
           replacement_attempt_id, created_at, source_kind
         ) VALUES ('recovery-automated-review-fix-replan',
                   'recovery-approval-automated-review-fix-replan', ?, ?, 1, ?, ?, ?,
                   'approval-automated-review-fix-recovered-replan', ?, ?,
                   'automated_fix_failed_pre_effect')`,
      ).bind(
        RUN_ID,
        PLAN_ID,
        ITEM_ID,
        completed.fixAttemptId,
        completed.fixAttemptId,
        replacementAttemptId,
        NOW,
      ),
    ]);

    const response = await SELF.fetch(
      `https://delivery-loop.test/v1/attempts/${replacementAttemptId}/plan-revision`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ expectedVersion: 1, leaseGeneration: 1 }),
      },
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      created: true,
      runVersion: 11,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT source_kind, source_ref FROM plan_revision_source_facts`,
    ).first()).toEqual({
      source_kind: 'review_feedback',
      source_ref: `d1://automated-reviews/${context.review.id}`,
    });
  });

  it('accepts a review after heartbeat version change and replays it after token revocation', async () => {
    const scheduled = await new AutomatedReviewScheduler(env.DB_CONTROL)
      .scheduleRun(RUN_ID, new Date(NOW));
    if (scheduled === null) throw new Error('automated review was not scheduled');
    const token = 'automated-review-api-token';
    const [tokenDigest, oidcDigest, toolDigest] = await Promise.all([
      canonicalSha256(token),
      canonicalSha256('automated-review-api-oidc'),
      canonicalSha256('automated-review-api-tool'),
    ]);
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE attempts SET status = 'running', version = 1, lease_generation = 1,
           lease_token_digest = ?, lease_expires_at = '2099-01-01T00:00:00.000Z',
           updated_at = ? WHERE attempt_id = ? AND status = 'pending'`,
      ).bind(tokenDigest, NOW, scheduled.attemptId),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempt_tokens (
           token_id, attempt_id, oidc_token_digest, token_digest, tool_token_digest,
           lease_generation, scopes_json, expires_at, created_at
         ) VALUES ('token-automated-review-api', ?, ?, ?, ?, 1, ?,
                   '2099-01-01T00:00:00.000Z', ?)`,
      ).bind(
        scheduled.attemptId,
        oidcDigest,
        tokenDigest,
        toolDigest,
        JSON.stringify(TRIAGE_TOOL_ACTIONS),
        NOW,
      ),
    ]);
    const contextResponse = await SELF.fetch(
      `https://delivery-loop.test/v1/attempts/${scheduled.attemptId}/context`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(contextResponse.status).toBe(200);
    const context = AutomatedReviewContextV1Schema.parse(await contextResponse.json());
    const contextDigest = await automatedReviewContextDigest(context);
    expect(await automatedReviewContextDigest({
      ...context,
      attempt: { ...context.attempt, version: context.attempt.version + 1 },
    })).toBe(contextDigest);
    expect(await automatedReviewContextDigest({
      ...context,
      attempt: { ...context.attempt, leaseGeneration: context.attempt.leaseGeneration + 1 },
    })).not.toBe(contextDigest);
    const result = {
      schemaVersion: '1' as const,
      contextDigest,
      verdict: 'approved' as const,
      summary: 'No blocker or major findings remain.',
      findings: [],
    };
    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET version = version + 1, heartbeat_at = ?, updated_at = ?
       WHERE attempt_id = ? AND status = 'running'`,
    ).bind(NOW, NOW, scheduled.attemptId).run();
    const submit = async () => await SELF.fetch(
      `https://delivery-loop.test/v1/attempts/${scheduled.attemptId}/automated-review-result`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(result),
      },
    );
    const first = await submit();
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ accepted: true, status: 'approved', created: true });
    const replay = await submit();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      accepted: true,
      reviewId: scheduled.reviewId,
      status: 'approved',
      created: false,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM automated_reviews WHERE status = 'approved'`,
    ).first()).toEqual({ count: 1 });
  });

  it('rejects Secret-bearing and stale-head results without changing review state', async () => {
    const secret = env.GITHUB_WEBHOOK_SECRET;
    const first = await scheduleAndContext();
    const secretResult = {
      schemaVersion: '1' as const,
      contextDigest: await automatedReviewContextDigest(first.context),
      verdict: 'approved' as const,
      summary: `No major findings; diagnostic ${secret}`,
      findings: [],
    };
    await expect(new AutomatedReviewResultStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
      [secret],
    ).complete(first.authorization, secretResult, new Date(NOW))).rejects.toMatchObject({
      code: 'secret_detected',
    });

    const newerHead = 'f'.repeat(40);
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, plan_id, plan_version, plan_item_id, head_branch, head_sha,
           version, lease_generation, created_at, updated_at
         ) VALUES ('attempt-newer-head', ?, 4, 'review_fix', 'completed', ?,
                   'example/delivery-target',
                   'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                   ?, 1, ?, ?, ?, 1, 1, ?, ?)`,
      ).bind(RUN_ID, BASE_SHA, PLAN_ID, ITEM_ID, BRANCH, newerHead, NOW, NOW),
      env.DB_CONTROL.prepare(
        `INSERT INTO evidence (
           evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           kind, status, sha, summary, verification_status, observed_at, created_at
         ) VALUES ('evidence-newer-head', ?, 'attempt-newer-head', ?, 1, ?, 'commit',
                   'passed', ?, 'Newer trusted bot head.', 'verified', ?, ?)`,
      ).bind(RUN_ID, PLAN_ID, ITEM_ID, newerHead, NOW, NOW),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempt_head_updates (
           update_id, evidence_id, run_id, attempt_id, plan_id, plan_version,
           plan_item_id, lease_generation, parent_sha, head_sha, branch, created_at
         ) VALUES ('head-newer', 'evidence-newer-head', ?, 'attempt-newer-head', ?, 1,
                   ?, 1, ?, ?, ?, ?)`,
      ).bind(RUN_ID, PLAN_ID, ITEM_ID, HEAD_SHA, newerHead, BRANCH, NOW),
    ]);
    const staleResult = { ...secretResult, summary: 'No major findings remain.' };
    await expect(new AutomatedReviewResultStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).complete(first.authorization, staleResult, new Date(NOW))).rejects.toMatchObject({
      code: 'state_conflict',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, result_digest FROM automated_reviews`,
    ).first()).toEqual({ status: 'pending', result_digest: null });
  });

  it('blocks the run on the third consecutive blocking review', async () => {
    for (const [index, head] of ['1'.repeat(40), '2'.repeat(40)].entries()) {
      const iteration = index + 1;
      await env.DB_CONTROL.batch([
        env.DB_CONTROL.prepare(
          `INSERT INTO attempts (
             attempt_id, run_id, ordinal, mode, status, base_sha, repository,
             workflow_ref, version, lease_generation, created_at, updated_at
           ) VALUES (?, ?, ?, 'analysis', 'completed', ?, 'example/delivery-target',
                     'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                     1, 1, ?, ?)`,
        ).bind(`attempt-prior-review-${iteration}`, RUN_ID, iteration + 2, head, NOW, NOW),
        env.DB_CONTROL.prepare(
          `INSERT INTO automated_reviews (
             review_id, run_id, publication_id, plan_id, plan_version, plan_item_id,
             prior_attempt_id, review_attempt_id, repository, github_pr_number,
             base_branch, branch, source_head_sha, iteration, status, result_ref,
             result_digest, feedback_body_digest, blocking_finding_count,
             minor_finding_count, completed_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'example/delivery-target', 42,
                     'main', ?, ?, ?, 'changes_requested', ?, ?, ?, 1, 0, ?, ?, ?)`,
        ).bind(
          `prior-review-${iteration}`,
          RUN_ID,
          PUBLICATION_ID,
          PLAN_ID,
          ITEM_ID,
          PRIOR_ATTEMPT_ID,
          `attempt-prior-review-${iteration}`,
          BRANCH,
          head,
          iteration,
          `r2://automated-reviews/prior-${iteration}.json`,
          `sha256:${String(iteration).repeat(64)}`,
          `sha256:${String(iteration + 2).repeat(64)}`,
          NOW,
          NOW,
          NOW,
        ),
      ]);
    }
    const { authorization, context } = await scheduleAndContext();
    expect(context.review.iteration).toBe(3);
    const result = {
      schemaVersion: '1' as const,
      contextDigest: await automatedReviewContextDigest(context),
      verdict: 'changes_requested' as const,
      summary: 'A third major correctness issue remains.',
      findings: [{
        severity: 'major' as const,
        title: 'State transition is still unsafe',
        body: 'The transition does not preserve the required compare-and-set guard.',
      }],
    };
    const completed = await new AutomatedReviewResultStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).complete(authorization, result, new Date(NOW));
    expect(completed).toMatchObject({ status: 'blocked', created: true });
    expect(await env.DB_CONTROL.prepare(
      `SELECT state FROM runs WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ state: 'blocked' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status FROM execution_plans WHERE plan_id = ?`,
    ).bind(PLAN_ID).first()).toEqual({ status: 'blocked' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status FROM plan_item_progress WHERE plan_id = ? AND item_id = ?`,
    ).bind(PLAN_ID, ITEM_ID).first()).toEqual({ status: 'blocked' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts WHERE mode = 'review_fix'`,
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM run_blockers WHERE run_id = ? AND resolved_at IS NULL`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
  });

  it('reopens the same PR after verified automated review_fix completion', async () => {
    const fixedHead = '8'.repeat(40);
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, version, lease_generation, created_at, updated_at
         ) VALUES ('attempt-review-source', ?, 3, 'analysis', 'completed', ?,
                   'example/delivery-target',
                   'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                   1, 1, ?, ?)`,
      ).bind(RUN_ID, HEAD_SHA, NOW, NOW),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           workflow_ref, plan_id, plan_version, plan_item_id, claimed_progress_version,
           head_branch, head_sha, version, lease_generation, created_at, updated_at
         ) VALUES ('attempt-review-fix-completed', ?, 4, 'review_fix', 'completed', ?,
                   'example/delivery-target',
                   'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                   ?, 1, ?, 3, ?, ?, 4, 2, ?, ?)`,
      ).bind(RUN_ID, BASE_SHA, PLAN_ID, ITEM_ID, BRANCH, fixedHead, NOW, NOW),
      env.DB_CONTROL.prepare(
        `UPDATE runs SET state = 'executing', version = version + 1, updated_at = ?
         WHERE run_id = ? AND state = 'pull_request_open'`,
      ).bind(NOW, RUN_ID),
    ]);
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO automated_reviews (
           review_id, run_id, publication_id, plan_id, plan_version, plan_item_id,
           prior_attempt_id, review_attempt_id, repository, github_pr_number,
           base_branch, branch, source_head_sha, iteration, status, result_ref,
           result_digest, feedback_body_digest, blocking_finding_count,
           minor_finding_count, completed_at, created_at, updated_at
         ) VALUES ('review-completed-fix', ?, ?, ?, 1, ?, ?, 'attempt-review-source',
                   'example/delivery-target', 42, 'main', ?, ?, 1, 'changes_requested',
                   'r2://automated-reviews/completed-fix.json', ?, ?, 1, 0, ?, ?, ?)`,
      ).bind(
        RUN_ID,
        PUBLICATION_ID,
        PLAN_ID,
        ITEM_ID,
        PRIOR_ATTEMPT_ID,
        BRANCH,
        HEAD_SHA,
        `sha256:${'4'.repeat(64)}`,
        `sha256:${'5'.repeat(64)}`,
        NOW,
        NOW,
        NOW,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO automated_review_fix_attempts (
           review_id, fix_attempt_id, prior_attempt_id, branch, source_head_sha, created_at
         ) VALUES ('review-completed-fix', 'attempt-review-fix-completed', ?, ?, ?, ?)`,
      ).bind(PRIOR_ATTEMPT_ID, BRANCH, HEAD_SHA, NOW),
      env.DB_CONTROL.prepare(
        `INSERT INTO evidence (
           evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           kind, status, sha, summary, verification_status, observed_at, created_at
         ) VALUES ('evidence-completed-fix', ?, 'attempt-review-fix-completed', ?, 1, ?,
                   'commit', 'passed', ?, 'Verified automated review fix head.',
                   'verified', ?, ?)`,
      ).bind(RUN_ID, PLAN_ID, ITEM_ID, fixedHead, NOW, NOW),
    ]);
    await env.DB_CONTROL.prepare(
      `INSERT INTO attempt_head_updates (
         update_id, evidence_id, run_id, attempt_id, plan_id, plan_version,
         plan_item_id, lease_generation, parent_sha, head_sha, branch, created_at
       ) VALUES ('head-completed-fix', 'evidence-completed-fix', ?,
                 'attempt-review-fix-completed', ?, 1, ?, 2, ?, ?, ?, ?)`,
    ).bind(RUN_ID, PLAN_ID, ITEM_ID, HEAD_SHA, fixedHead, BRANCH, NOW).run();

    const progress = new ExecutionProgressReconciler(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
      { now: () => new Date(NOW) },
    );
    expect(await progress.reconcileFinalizations(5)).toEqual({
      preparedDrafts: 0,
      scheduledPublications: 0,
    });
    expect(await new AutomatedReviewScheduler(env.DB_CONTROL)
      .resumeFixedRuns(5, new Date(NOW))).toBe(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT state FROM runs WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ state: 'pull_request_open' });
    await fillAttemptBudget();
    const nextReview = await new AutomatedReviewScheduler(env.DB_CONTROL)
      .scheduleRun(RUN_ID, new Date(NOW));
    expect(nextReview).toMatchObject({
        iteration: 2,
        headSha: fixedHead,
        created: true,
      });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ count: 21 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM automated_review_loop_quota_slots
       WHERE source_review_id = 'review-completed-fix'
         AND attempt_mode = 'analysis' AND slot_kind = 'next_review'`,
    ).first()).toEqual({ count: 1 });
  });
});
