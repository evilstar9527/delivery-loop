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
} from '../../src/outbox/github-dispatcher.js';
import { ExecutionAttemptContextStore } from '../../src/storage/execution-attempt-store.js';
import { AnalysisAttemptContextStore } from '../../src/storage/analysis-attempt-store.js';
import { ExecutionHeadStore } from '../../src/storage/execution-head-store.js';
import { ExecutionProgressReconciler } from '../../src/reconciliation/execution-progress-reconciler.js';
import { TaskQueryStore } from '../../src/storage/task-query-store.js';
import { Case8AuditReportStore } from '../../src/storage/case8-audit-report-store.js';

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

  async ensureDispatch() {
    this.requests += 1;
    return {
      disposition: 'created' as const,
      githubRunId: '70042',
      githubHeadSha: BASE_SHA,
    };
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
    env.DB_CONTROL.prepare('DELETE FROM approval_invalidations'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revision_analysis_retries'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revisions'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revision_source_facts'),
    env.DB_CONTROL.prepare('DELETE FROM automated_review_fix_attempts'),
    env.DB_CONTROL.prepare('DELETE FROM automated_reviews'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_revocations'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_publications'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_drafts'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_head_updates'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
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

  it('serves automated context and replays the same result after token revocation', async () => {
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
    const result = {
      schemaVersion: '1' as const,
      contextDigest: await automatedReviewContextDigest(context),
      verdict: 'approved' as const,
      summary: 'No blocker or major findings remain.',
      findings: [],
    };
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
    expect(await new AutomatedReviewScheduler(env.DB_CONTROL)
      .scheduleRun(RUN_ID, new Date(NOW))).toMatchObject({
        iteration: 2,
        headSha: fixedHead,
        created: true,
      });
  });
});
