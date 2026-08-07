/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import { taskRevisionDigest, type TaskEnvelope } from '../../src/domain/task.js';
import { EXECUTION_TOOL_ACTIONS } from '../../src/domain/tool-bridge.js';
import {
  GitHubDispatchOutboxProcessor,
  type GitHubDispatchEffects,
  type GitHubDispatchRequest,
} from '../../src/outbox/github-dispatcher.js';
import {
  GitHubReviewFeedbackReconciler,
  GitHubReviewFeedbackRecoveryReconciler,
  type GitHubReviewFeedbackExternalFactClient,
} from '../../src/reconciliation/github-review-feedback-reconciler.js';
import { ExecutionAttemptContextStore } from '../../src/storage/execution-attempt-store.js';
import { AnalysisAttemptContextStore } from '../../src/storage/analysis-attempt-store.js';
import { ExecutionHeadStore } from '../../src/storage/execution-head-store.js';
import type { RunnerAuthorization } from '../../src/storage/runner-attempt-store.js';

const BASE_URL = 'https://delivery-loop.test';
const WEBHOOK_SECRET = 'test-github-webhook-secret';
const RUN_ID = 'run-review-feedback';
const TASK_ID = 'task-review-feedback';
const PLAN_ID = 'plan-review-feedback';
const ITEM_ID = 'review-and-verify';
const ANALYSIS_ATTEMPT_ID = 'attempt-review-analysis';
const PRIOR_ATTEMPT_ID = 'attempt-review-pr-head';
const DRAFT_ID = 'pr_draft_review_feedback';
const PUBLICATION_ID = 'pr_pub_review_feedback';
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const FIXED_HEAD_SHA = 'c'.repeat(40);
const PARENT_SHA = 'd'.repeat(40);
const PLAN_DIGEST = `sha256:${'e'.repeat(64)}`;
const BRANCH = `agent/${TASK_ID}/${PRIOR_ATTEMPT_ID}`;
const BODY = '# Delivery Loop Draft PR\n\nReview this exact head.\n';
const REVIEW_BODY = 'Please fix the retry race and keep the existing permission boundary.';
const NOW = '2026-07-25T18:00:00.000Z';

function taskEnvelope(): TaskEnvelope {
  return {
    schemaVersion: '1',
    eventId: 'event-review-feedback',
    occurredAt: NOW,
    source: {
      system: 'manual',
      tenantKey: 'review-feedback',
      taskKey: TASK_ID,
      revision: 'revision-5',
    },
    actor: { type: 'user', id: 'review-feedback-user' },
    target: {
      owner: 'example',
      repo: 'delivery-target',
      baseBranch: 'main',
      environment: 'test',
    },
    intent: {
      kind: 'bug',
      title: 'Address review feedback safely',
      description: 'The review feedback must be applied only to the reviewed head.',
      acceptanceCriteria: ['Trusted tests pass after the exact-head review fix.'],
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

class FakeDispatch implements GitHubDispatchEffects {
  readonly requests: GitHubDispatchRequest[] = [];

  async ensureDispatch(request: GitHubDispatchRequest) {
    this.requests.push(request);
    return {
      disposition: 'created' as const,
      githubRunId: '70042',
      githubHeadSha: BASE_SHA,
    };
  }
}

class FakeReviewFeedbackClient implements GitHubReviewFeedbackExternalFactClient {
  readonly requests: Array<{
    repository: string;
    number: number;
    headBranch: string;
    baseBranch: string;
  }> = [];

  async observeReviewFeedback(request: {
    repository: string;
    number: number;
    headBranch: string;
    baseBranch: string;
  }) {
    this.requests.push(request);
    return [{
      repository: request.repository,
      number: request.number,
      reviewId: '9001',
      body: REVIEW_BODY,
      bodyDigest: await canonicalSha256(REVIEW_BODY),
      sourceHeadSha: HEAD_SHA,
      branch: request.headBranch,
      baseBranch: request.baseBranch,
      url: 'https://github.com/example/delivery-target/pull/42',
      submittedAt: '2026-07-25T18:01:00.000Z',
    }];
  }
}

async function signature(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  ));
  return `sha256=${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function reviewPayload(overrides: {
  reviewId?: number;
  body?: string;
  commitSha?: string;
  headSha?: string;
} = {}): string {
  const commitSha = overrides.commitSha ?? HEAD_SHA;
  return JSON.stringify({
    action: 'submitted',
    review: {
      id: overrides.reviewId ?? 9001,
      body: overrides.body ?? REVIEW_BODY,
      state: 'changes_requested',
      commit_id: commitSha,
      html_url: 'https://github.com/example/delivery-target/pull/42#pullrequestreview-9001',
      submitted_at: '2026-07-25T18:01:00Z',
      user: { id: 101, login: 'reviewer', type: 'User' },
    },
    pull_request: {
      number: 42,
      html_url: 'https://github.com/example/delivery-target/pull/42',
      head: {
        ref: BRANCH,
        sha: overrides.headSha ?? commitSha,
        repo: { full_name: 'example/delivery-target' },
      },
      base: {
        ref: 'main',
        repo: { full_name: 'example/delivery-target' },
      },
    },
    repository: { full_name: 'example/delivery-target' },
  });
}

async function sendReview(
  payload: string,
  deliveryId = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
): Promise<Response> {
  return await SELF.fetch(`${BASE_URL}/v1/webhooks/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request_review',
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': await signature(payload),
    },
    body: payload,
  });
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM approval_invalidations'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revisions'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revision_source_facts'),
    env.DB_CONTROL.prepare('DELETE FROM review_feedback_attempts'),
    env.DB_CONTROL.prepare('DELETE FROM github_review_feedbacks'),
    env.DB_CONTROL.prepare('DELETE FROM github_review_webhook_deliveries'),
    env.DB_CONTROL.prepare('DELETE FROM github_pull_request_api_observations'),
    env.DB_CONTROL.prepare('DELETE FROM github_pull_request_webhook_deliveries'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_publications'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_draft_evidence'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_draft_criteria'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_draft_unfinished_items'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_drafts'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_head_updates'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_done_when_evidence'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_verifications'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suite_commands'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suites'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
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
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  const reviewObjects = await env.TASK_OBJECTS.list({ prefix: 'review-feedback/' });
  if (reviewObjects.objects.length > 0) {
    await env.TASK_OBJECTS.delete(reviewObjects.objects.map((object) => object.key));
  }
  const taskObjects = await env.TASK_OBJECTS.list({ prefix: 'tasks/' });
  if (taskObjects.objects.length > 0) {
    await env.TASK_OBJECTS.delete(taskObjects.objects.map((object) => object.key));
  }
}

async function authenticatedReviewAttempt(): Promise<{
  attemptId: string;
  token: string;
  expectedVersion: number;
  leaseGeneration: number;
}> {
  const response = await sendReview(reviewPayload());
  expect(response.status).toBe(202);
  const attempt = await env.DB_CONTROL.prepare(
    `SELECT review_attempt_id AS attempt_id
     FROM review_feedback_attempts`,
  ).first<{ attempt_id: string }>();
  if (attempt === null) throw new Error('review Attempt fixture was not created');
  const token = 'review-plan-revision-attempt-token';
  const [tokenDigest, oidcDigest, toolDigest] = await Promise.all([
    canonicalSha256(token),
    canonicalSha256('review-plan-revision-oidc-token'),
    canonicalSha256('review-plan-revision-tool-token'),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET status = 'running', version = 1, lease_generation = 1,
           lease_token_digest = ?, lease_expires_at = '2099-01-01T00:00:00.000Z',
           updated_at = ?
       WHERE attempt_id = ? AND status = 'pending'`,
    ).bind(tokenDigest, NOW, attempt.attempt_id),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_tokens (
         token_id, attempt_id, oidc_token_digest, token_digest,
         tool_token_digest, lease_generation, scopes_json,
         expires_at, created_at
       ) VALUES ('token-review-plan-revision', ?, ?, ?, ?, 1, ?,
                 '2099-01-01T00:00:00.000Z', ?)`,
    ).bind(
      attempt.attempt_id,
      oidcDigest,
      tokenDigest,
      toolDigest,
      JSON.stringify(EXECUTION_TOOL_ACTIONS),
      NOW,
    ),
  ]);
  return {
    attemptId: attempt.attempt_id,
    token,
    expectedVersion: 1,
    leaseGeneration: 1,
  };
}

async function requestPlanRevision(
  attempt: Awaited<ReturnType<typeof authenticatedReviewAttempt>>,
  body: unknown = {
    expectedVersion: attempt.expectedVersion,
    leaseGeneration: attempt.leaseGeneration,
  },
): Promise<Response> {
  return await SELF.fetch(
    `${BASE_URL}/v1/attempts/${attempt.attemptId}/plan-revision`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${attempt.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
}

async function seed(): Promise<void> {
  const task = taskEnvelope();
  const taskDigest = await taskRevisionDigest(task);
  const taskKey = `tasks/${TASK_ID}.json`;
  const bodyDigest = await canonicalSha256(BODY);
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
       ) VALUES (?, 'manual', 'review-feedback', ?, 'revision-5', ?, ?, 'user',
                 'review-feedback-user', 'example/delivery-target', 'main', 'test',
                 'bug', 'Address review feedback safely', 'p1', 1, 1, 0, 0, 1, ?, ?)`,
    ).bind(TASK_ID, TASK_ID, taskDigest, `r2://${taskKey}`, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, 'revision-5', ?, ?, ?, 'pull_request_open', 9, ?, 3, ?, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, taskDigest, BASE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'completed', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 1, 0, ?, ?)`,
    ).bind(ANALYSIS_ATTEMPT_ID, RUN_ID, BASE_SHA, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 3, 'revision-5', ?, ?, 'active', ?,
                 'Apply review feedback and rerun trusted verification.', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, ANALYSIS_ATTEMPT_ID, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, plan_item_id,
         claimed_progress_version, head_branch, head_sha, version,
         lease_generation, created_at, updated_at
       ) VALUES (?, ?, 2, 'implement', 'completed', ?, 'example/delivery-target',
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 ?, 3, ?, 1, ?, ?, 4, 2, ?, ?)`,
    ).bind(PRIOR_ATTEMPT_ID, RUN_ID, BASE_SHA, PLAN_ID, ITEM_ID, BRANCH, HEAD_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES (?, ?, 'verification', 'Review and verify',
                 'Apply exact-head review feedback and rerun trusted tests.', 1, 0)`,
    ).bind(PLAN_ID, ITEM_ID),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_done_when (plan_id, item_id, position, condition)
       VALUES (?, ?, 0, 'Review feedback is addressed and trusted verification passes.')`,
    ).bind(PLAN_ID, ITEM_ID),
    ...['test:unit', 'verify:all'].map((commandRef) =>
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
         VALUES (?, ?, ?)`,
      ).bind(PLAN_ID, ITEM_ID, commandRef),
    ),
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
       ) VALUES ('approval-review-feedback', ?, 'revision-5', ?, 3, ?, ?,
                 'repo_write', 'user:approver', 'approve', ?,
                 '2099-01-01T00:00:00.000Z', ?)`,
    ).bind(RUN_ID, PLAN_ID, PLAN_DIGEST, BASE_SHA, `sha256:${'f'.repeat(64)}`, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, sha, summary, verification_status, observed_at, created_at
       ) VALUES ('evidence-review-commit', ?, ?, ?, 3, ?, 'commit', 'passed', ?,
                 'Trusted Runner recorded the bot commit head.', 'unverified', ?, ?)`,
    ).bind(RUN_ID, PRIOR_ATTEMPT_ID, PLAN_ID, ITEM_ID, HEAD_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version,
         kind, status, sha, external_url, artifact_ref, artifact_digest,
         summary, verification_status, observed_at, created_at
       ) VALUES ('evidence-review-pr', ?, ?, ?, 3, 'pull_request', 'passed', ?,
                 'https://github.com/example/delivery-target/pull/42',
                 'd1://pull-request-publications/pr_pub_review_feedback', ?,
                 'GitHub externally verified the Draft PR.', 'verified', ?, ?)`,
    ).bind(RUN_ID, PRIOR_ATTEMPT_ID, PLAN_ID, HEAD_SHA, bodyDigest, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_head_updates (
         update_id, evidence_id, run_id, attempt_id, plan_id, plan_version,
         plan_item_id, lease_generation, parent_sha, head_sha, branch, created_at
       ) VALUES ('head-review-pr', 'evidence-review-commit', ?, ?, ?, 3, ?, 2, ?, ?, ?, ?)`,
    ).bind(RUN_ID, PRIOR_ATTEMPT_ID, PLAN_ID, ITEM_ID, PARENT_SHA, HEAD_SHA, BRANCH, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO pull_request_drafts (
         draft_id, run_id, run_version, task_id, task_revision, task_digest,
         plan_id, plan_version, plan_digest, attempt_id, head_update_id,
         head_sha, branch, body, body_digest, status, created_at
       ) VALUES (?, ?, 8, ?, 'revision-5', ?, ?, 3, ?, ?, 'head-review-pr',
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
      BODY,
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
     ) VALUES (?, ?, 8, ?, 'approval-review-feedback', 'example/delivery-target',
               'main', ?, ?, ?, ?, 'verified', 42,
               'https://github.com/example/delivery-target/pull/42',
               '2026-07-25T17:59:00.000Z', 1, 'evidence-review-pr', ?, ?)`,
  ).bind(PUBLICATION_ID, RUN_ID, DRAFT_ID, BRANCH, HEAD_SHA, `Delivery Loop: ${TASK_ID}`, bodyDigest, NOW, NOW).run();
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('head-bound GitHub review feedback', () => {
  it('replaces one lost pre-effect review Attempt and preserves same-PR feedback lineage', async () => {
    const response = await sendReview(reviewPayload());
    expect(response.status).toBe(202);
    const lost = await env.DB_CONTROL.prepare(
      'SELECT review_attempt_id AS attempt_id FROM review_feedback_attempts',
    ).first<{ attempt_id: string }>();
    if (lost === null) throw new Error('review Attempt fixture was not created');
    await env.DB_CONTROL.prepare(
      `UPDATE attempts
       SET status = 'lost', github_status = 'completed', github_conclusion = 'failure',
           version = version + 1, lease_generation = lease_generation + 1, updated_at = ?
       WHERE attempt_id = ?`,
    ).bind(NOW, lost.attempt_id).run();

    const recovery = new GitHubReviewFeedbackRecoveryReconciler(
      env.DB_CONTROL,
      () => new Date(NOW),
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, () => recovery.recoverAttempt(lost.attempt_id)),
    );
    expect(results.some((result) => result.created)).toBe(true);
    expect(new Set(results.map((result) => result.replacementAttemptId)).size).toBe(1);
    const replacementAttemptId = results[0]!.replacementAttemptId;
    expect(await env.DB_CONTROL.prepare(
      `SELECT mode, status, head_sha, recovered_from_attempt_id
       FROM attempts WHERE attempt_id = ?`,
    ).bind(replacementAttemptId).first()).toEqual({
      mode: 'review_fix',
      status: 'pending',
      head_sha: HEAD_SHA,
      recovered_from_attempt_id: lost.attempt_id,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT active_attempt_id, status, version FROM plan_item_progress
       WHERE plan_id = ? AND item_id = ?`,
    ).bind(PLAN_ID, ITEM_ID).first()).toEqual({
      active_attempt_id: replacementAttemptId,
      status: 'in_progress',
      version: 5,
    });

    const outbox = await env.DB_CONTROL.prepare(
      `SELECT outbox_id FROM outbox
       WHERE payload_ref = ? AND kind = 'execution_dispatch'`,
    ).bind(`d1://attempts/${replacementAttemptId}`).first<{ outbox_id: string }>();
    const effects = new FakeDispatch();
    expect(await new GitHubDispatchOutboxProcessor(env.DB_CONTROL, effects, {
      allowedRepositories: ['example/delivery-target'],
      controlPlaneUrl: 'https://control.delivery.test',
      now: () => new Date(NOW),
    }).deliver(outbox!.outbox_id)).toBe('settled');
    expect(effects.requests).toHaveLength(1);
    expect(effects.requests[0]!.inputs).toMatchObject({
      mode: 'review_fix',
      checkout_sha: HEAD_SHA,
      plan_item_id: ITEM_ID,
    });

    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'running', lease_expires_at = '2099-01-01T00:00:00.000Z'
       WHERE attempt_id = ?`,
    ).bind(replacementAttemptId).run();
    const context = await new ExecutionAttemptContextStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).get({
      attemptId: replacementAttemptId,
      runId: RUN_ID,
      mode: 'review_fix',
      status: 'running',
      version: 1,
      leaseGeneration: 1,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      scopes: [...EXECUTION_TOOL_ACTIONS],
    });
    expect(context.attempt).toMatchObject({
      id: replacementAttemptId,
      checkoutSha: HEAD_SHA,
      targetBranch: BRANCH,
      targetBranchMode: 'existing_fast_forward',
    });
    expect(context.reviewFeedback).toMatchObject({
      reviewId: '9001',
      sourceHeadSha: HEAD_SHA,
      branch: BRANCH,
    });
  });

  it('restores only an exactly fenced blocked review Run after cancellation settles', async () => {
    expect((await sendReview(reviewPayload())).status).toBe(202);
    const lost = await env.DB_CONTROL.prepare(
      'SELECT review_attempt_id AS attempt_id FROM review_feedback_attempts',
    ).first<{ attempt_id: string }>();
    if (lost === null) throw new Error('review Attempt fixture was not created');
    const run = await env.DB_CONTROL.prepare(
      'SELECT version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first<{ version: number }>();
    if (run === null) throw new Error('review Run fixture was not created');
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE attempts
         SET status = 'lost', github_status = 'completed', github_conclusion = 'failure',
             version = version + 1, lease_generation = lease_generation + 1, updated_at = ?
         WHERE attempt_id = ?`,
      ).bind(NOW, lost.attempt_id),
      env.DB_CONTROL.prepare(
        `UPDATE runs SET state = 'blocked', version = version + 1, updated_at = ?
         WHERE run_id = ? AND version = ?`,
      ).bind(NOW, RUN_ID, run.version),
      env.DB_CONTROL.prepare(
        `INSERT INTO run_stuck_incidents (
           incident_id, run_id, state_kind, observed_run_state, run_version,
           attempt_id, threshold_seconds, action, status, detected_at,
           recovery_requested_at, resolved_at, resolution_code
         ) VALUES (?, ?, 'running', 'executing', ?, ?, 90, 'fence_lost_attempt',
                   'resolved', ?, ?, ?, 'attempt_fenced')`,
      ).bind(`incident-${lost.attempt_id}`, RUN_ID, run.version, lost.attempt_id, NOW, NOW, NOW),
      env.DB_CONTROL.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         ) VALUES (?, ?, 'workflow_cancel', 'cloudflare_workflows', ?, ?,
                   'settled', ?, ?)`,
      ).bind(
        `workflow-cancel-${RUN_ID}`,
        RUN_ID,
        `d1://runs/${RUN_ID}`,
        `workflow-cancel:${RUN_ID}`,
        NOW,
        NOW,
      ),
    ]);

    const recovery = new GitHubReviewFeedbackRecoveryReconciler(
      env.DB_CONTROL,
      () => new Date(NOW),
    );
    const results = await recovery.reconcileBatch();
    expect(results).toHaveLength(1);
    expect(results[0]!.created).toBe(true);
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({
      state: 'executing',
      version: run.version + 2,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, recovered_from_attempt_id FROM attempts
       WHERE recovered_from_attempt_id = ?`,
    ).bind(lost.attempt_id).first()).toEqual({
      status: 'pending',
      recovered_from_attempt_id: lost.attempt_id,
    });
  });

  it('rejects a blocked review Run without an exact settled fencing lineage', async () => {
    expect((await sendReview(reviewPayload())).status).toBe(202);
    const lost = await env.DB_CONTROL.prepare(
      'SELECT review_attempt_id AS attempt_id FROM review_feedback_attempts',
    ).first<{ attempt_id: string }>();
    if (lost === null) throw new Error('review Attempt fixture was not created');
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE attempts
         SET status = 'lost', github_status = 'completed', github_conclusion = 'failure',
             version = version + 1, lease_generation = lease_generation + 1, updated_at = ?
         WHERE attempt_id = ?`,
      ).bind(NOW, lost.attempt_id),
      env.DB_CONTROL.prepare(
        `UPDATE runs SET state = 'blocked', version = version + 1, updated_at = ?
         WHERE run_id = ?`,
      ).bind(NOW, RUN_ID),
    ]);

    const recovery = new GitHubReviewFeedbackRecoveryReconciler(
      env.DB_CONTROL,
      () => new Date(NOW),
    );
    expect(await recovery.reconcileBatch()).toEqual([]);
    await expect(recovery.recoverAttempt(lost.attempt_id)).rejects.toThrow(
      'GitHub review feedback recovery is unavailable',
    );
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM attempts WHERE recovered_from_attempt_id = ?',
    ).bind(lost.attempt_id).first()).toEqual({ count: 0 });
  });

  it('recovers one missed exact-head webhook from bounded GitHub API facts', async () => {
    const client = new FakeReviewFeedbackClient();
    const reconciler = new GitHubReviewFeedbackReconciler(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
      client,
      { now: () => new Date(NOW) },
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reconciler.reconcileRun(RUN_ID)),
    );
    expect(results.some((result) => result.disposition === 'applied')).toBe(true);
    expect(results.every((result) =>
      result.disposition === 'applied' || result.disposition === 'duplicate')).toBe(true);
    expect(client.requests).toHaveLength(20);
    expect(client.requests[0]).toEqual({
      repository: 'example/delivery-target',
      number: 42,
      headBranch: BRANCH,
      baseBranch: 'main',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts
       WHERE run_id = ? AND mode = 'review_fix'`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox
       WHERE kind = 'execution_dispatch' AND delivery_state = 'pending'`,
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'executing', version: 11 });
  });

  it('converges 20 signed deliveries to one same-PR review_fix Attempt and exposes only digest-verified untrusted context', async () => {
    const payload = reviewPayload();
    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      sendReview(payload, `${String(index + 1).padStart(8, '0')}-1111-2222-3333-bbbbbbbbbbbb`)));
    expect(responses.every((response) => response.status === 202)).toBe(true);
    const bodies = await Promise.all(responses.map(async (response) => await response.json())) as Array<{
      disposition: string;
      attemptId?: string;
    }>;
    expect(bodies.filter((body) => body.disposition === 'applied')).toHaveLength(1);
    expect(bodies.filter((body) => body.disposition === 'duplicate')).toHaveLength(19);
    const reviewAttempt = await env.DB_CONTROL.prepare(
      `SELECT attempts.attempt_id, attempts.mode, attempts.status, attempts.ordinal,
              attempts.head_sha, attempts.head_branch, attempts.claimed_progress_version,
              review_feedback_attempts.branch, review_feedback_attempts.source_head_sha,
              review_feedback_attempts.feedback_id
       FROM review_feedback_attempts
       JOIN attempts ON attempts.attempt_id = review_feedback_attempts.review_attempt_id`,
    ).first<{
      attempt_id: string;
      mode: string;
      status: string;
      ordinal: number;
      head_sha: string;
      head_branch: string | null;
      claimed_progress_version: number;
      branch: string;
      source_head_sha: string;
      feedback_id: string;
    }>();
    expect(reviewAttempt).toMatchObject({
      mode: 'review_fix',
      status: 'pending',
      ordinal: 3,
      head_sha: HEAD_SHA,
      head_branch: null,
      claimed_progress_version: 3,
      branch: BRANCH,
      source_head_sha: HEAD_SHA,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'executing', version: 11 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, active_attempt_id, version FROM plan_item_progress
       WHERE plan_id = ? AND item_id = ?`,
    ).bind(PLAN_ID, ITEM_ID).first()).toEqual({
      status: 'in_progress',
      active_attempt_id: reviewAttempt!.attempt_id,
      version: 4,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox
       WHERE kind = 'execution_dispatch' AND delivery_state = 'pending'`,
    ).first()).toEqual({ count: 1 });
    const columns = await env.DB_CONTROL.prepare(
      `SELECT name FROM pragma_table_info('github_review_feedbacks') ORDER BY name`,
    ).all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).not.toContain('body');
    const reviewObjects = await env.TASK_OBJECTS.list({ prefix: 'review-feedback/' });
    expect(reviewObjects.objects).toHaveLength(1);

    const outbox = await env.DB_CONTROL.prepare(
      `SELECT outbox_id FROM outbox WHERE kind = 'execution_dispatch'`,
    ).first<{ outbox_id: string }>();
    const effects = new FakeDispatch();
    expect(await new GitHubDispatchOutboxProcessor(env.DB_CONTROL, effects, {
      allowedRepositories: ['example/delivery-target'],
      controlPlaneUrl: 'https://control.delivery.test',
      now: () => new Date(NOW),
    }).deliver(outbox!.outbox_id)).toBe('settled');
    expect(effects.requests).toHaveLength(1);
    expect(effects.requests[0]!.inputs).toMatchObject({
      mode: 'review_fix',
      checkout_sha: HEAD_SHA,
      plan_version: '3',
      plan_item_id: ITEM_ID,
    });

    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'running', lease_expires_at = '2099-01-01T00:00:00.000Z'
       WHERE attempt_id = ?`,
    ).bind(reviewAttempt!.attempt_id).run();
    const authorization: RunnerAuthorization = {
      attemptId: reviewAttempt!.attempt_id,
      runId: RUN_ID,
      mode: 'review_fix',
      status: 'running',
      version: 1,
      leaseGeneration: 1,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      scopes: [...EXECUTION_TOOL_ACTIONS],
    };
    const context = await new ExecutionAttemptContextStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).get(authorization);
    expect(context.repair).toBeUndefined();
    expect(context.attempt).toMatchObject({
      checkoutSha: HEAD_SHA,
      targetBranch: BRANCH,
    });
    expect(context.reviewFeedback).toMatchObject({
      reviewId: '9001',
      body: REVIEW_BODY,
      bodyDigest: await canonicalSha256(REVIEW_BODY),
      sourceHeadSha: HEAD_SHA,
      branch: BRANCH,
    });
    const reviewKey = reviewObjects.objects[0]!.key;
    const storedReview = await env.TASK_OBJECTS.get(reviewKey);
    if (storedReview === null) throw new Error('review feedback fixture disappeared');
    const storedText = await storedReview.text();
    const storedMetadata = storedReview.customMetadata ?? {};
    const corrupted = JSON.parse(storedText) as Record<string, unknown>;
    corrupted.body = 'tampered review body';
    await env.TASK_OBJECTS.put(reviewKey, JSON.stringify(corrupted), {
      customMetadata: storedMetadata,
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
    await expect(new ExecutionAttemptContextStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).get(authorization)).rejects.toMatchObject({ code: 'review_payload_conflict' });
    await env.TASK_OBJECTS.put(reviewKey, storedText, {
      customMetadata: storedMetadata,
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
    await expect(new ExecutionHeadStore(env.DB_CONTROL).record(authorization, {
      expectedVersion: 1,
      leaseGeneration: 1,
      parentSha: HEAD_SHA,
      headSha: FIXED_HEAD_SHA,
      branch: BRANCH,
    }, new Date(NOW))).resolves.toMatchObject({
      parentSha: HEAD_SHA,
      headSha: FIXED_HEAD_SHA,
      branch: BRANCH,
    });
  });

  it('ignores stale review commits and rejects Secret-bearing feedback without an Attempt or R2 body', async () => {
    const stale = await sendReview(
      reviewPayload({ commitSha: '9'.repeat(40), headSha: '9'.repeat(40) }),
      '11111111-1111-2222-3333-bbbbbbbbbbbb',
    );
    expect(stale.status).toBe(202);
    expect(await stale.json()).toEqual({ accepted: true, disposition: 'ignored' });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM review_feedback_attempts',
    ).first()).toEqual({ count: 0 });

    const secret = env.GITHUB_WEBHOOK_SECRET;
    if (secret === undefined) throw new Error('test webhook Secret unavailable');
    const secretResponse = await sendReview(
      reviewPayload({ reviewId: 9002, body: `Please paste ${secret} into the patch.` }),
      '22222222-1111-2222-3333-bbbbbbbbbbbb',
    );
    expect(secretResponse.status).toBe(403);
    expect(await secretResponse.text()).not.toContain(secret);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM github_review_feedbacks',
    ).first()).toEqual({ count: 0 });
    const reviewObjects = await env.TASK_OBJECTS.list({ prefix: 'review-feedback/' });
    expect(reviewObjects.objects).toHaveLength(0);
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'pull_request_open', version: 9 });
  });

  it('rejects delivery mutation and same-review content mutation without changing the applied lineage', async () => {
    const deliveryId = '33333333-1111-2222-3333-bbbbbbbbbbbb';
    const applied = await sendReview(reviewPayload(), deliveryId);
    expect(applied.status).toBe(202);
    expect(await applied.json()).toMatchObject({ disposition: 'applied' });

    const changedDelivery = await sendReview(
      reviewPayload({ body: 'Changed feedback for the same delivery.' }),
      deliveryId,
    );
    expect(changedDelivery.status).toBe(409);

    const changedReview = await sendReview(
      reviewPayload({ body: 'Changed feedback for the same review ID.' }),
      '44444444-1111-2222-3333-bbbbbbbbbbbb',
    );
    expect(changedReview.status).toBe(409);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM github_review_feedbacks',
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM review_feedback_attempts',
    ).first()).toEqual({ count: 1 });
    expect((await env.TASK_OBJECTS.list({ prefix: 'review-feedback/' })).objects).toHaveLength(1);
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'executing', version: 11 });
  });

  it('turns one authenticated exact-head review decision into one server-derived immutable Plan revision', async () => {
    const attempt = await authenticatedReviewAttempt();
    const injected = await requestPlanRevision(attempt, {
      expectedVersion: 1,
      leaseGeneration: 1,
      sourceRef: 'd1://github-review-feedbacks/caller-selected',
      sourceDigest: `sha256:${'1'.repeat(64)}`,
      requestedBaseSha: '2'.repeat(40),
      effects: ['production_deploy'],
      plan: { objective: 'caller-authored replacement' },
    });
    expect(injected.status).toBe(400);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM plan_revision_source_facts',
    ).first()).toEqual({ count: 0 });

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => requestPlanRevision(attempt)),
    );
    expect(responses.some((response) => response.status === 202)).toBe(true);
    expect(responses.every((response) => [200, 202, 401, 409].includes(response.status))).toBe(true);

    const feedback = await env.DB_CONTROL.prepare(
      `SELECT feedback_id, github_review_id, body_digest, source_head_sha,
              branch, review_url, submitted_at
       FROM github_review_feedbacks`,
    ).first<{
      feedback_id: string;
      github_review_id: string;
      body_digest: string;
      source_head_sha: string;
      branch: string;
      review_url: string;
      submitted_at: string;
    }>();
    if (feedback === null) throw new Error('review feedback fixture disappeared');
    const expectedSourceDigest = await canonicalSha256({
      schemaVersion: '1',
      sourceKind: 'review_feedback',
      feedbackId: feedback.feedback_id,
      githubReviewId: feedback.github_review_id,
      bodyDigest: feedback.body_digest,
      sourceHeadSha: feedback.source_head_sha,
      branch: feedback.branch,
      reviewUrl: feedback.review_url,
      submittedAt: feedback.submitted_at,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT source_ref, run_id, expected_run_version, prior_plan_id,
              prior_plan_version, prior_plan_digest, source_kind,
              source_digest, requested_base_sha
       FROM plan_revision_source_facts`,
    ).first()).toEqual({
      source_ref: `d1://github-review-feedbacks/${feedback.feedback_id}`,
      run_id: RUN_ID,
      expected_run_version: 11,
      prior_plan_id: PLAN_ID,
      prior_plan_version: 3,
      prior_plan_digest: PLAN_DIGEST,
      source_kind: 'review_feedback',
      source_digest: expectedSourceDigest,
      requested_base_sha: BASE_SHA,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM plan_revisions',
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts
       WHERE mode = 'analysis' AND status = 'pending'`,
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox
       WHERE kind = 'analysis_dispatch' AND delivery_state = 'pending'`,
    ).first()).toEqual({ count: 1 });
    const revision = await env.DB_CONTROL.prepare(
      'SELECT analysis_attempt_id FROM plan_revisions',
    ).first<{ analysis_attempt_id: string }>();
    if (revision === null) throw new Error('missing review re-analysis Attempt');
    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'running', version = 1, lease_generation = 1,
                           lease_token_digest = ?, lease_expires_at = ?, updated_at = ?
       WHERE attempt_id = ? AND status = 'pending'`,
    ).bind(
      `sha256:${'8'.repeat(64)}`,
      '2099-01-01T00:00:00.000Z',
      NOW,
      revision.analysis_attempt_id,
    ).run();
    const revisionContext = await new AnalysisAttemptContextStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).get({
      attemptId: revision.analysis_attempt_id,
      runId: RUN_ID,
      mode: 'analysis',
      status: 'running',
      version: 1,
      leaseGeneration: 1,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      scopes: ['repo:read'],
    });
    expect(revisionContext.revisionSource).toMatchObject({
      schemaVersion: '1',
      kind: 'review_feedback',
      digest: expectedSourceDigest,
      data: {
        reviewId: feedback.github_review_id,
        body: REVIEW_BODY,
        bodyDigest: feedback.body_digest,
        sourceHeadSha: HEAD_SHA,
        branch: BRANCH,
      },
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version, base_sha FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'planning', version: 12, base_sha: BASE_SHA });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, version, lease_generation, lease_token_digest
       FROM attempts WHERE attempt_id = ?`,
    ).bind(attempt.attemptId).first()).toEqual({
      status: 'cancelled',
      version: 2,
      lease_generation: 2,
      lease_token_digest: null,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT revoked_at IS NOT NULL AS revoked FROM attempt_tokens WHERE attempt_id = ?',
    ).bind(attempt.attemptId).first()).toEqual({ revoked: 1 });
    expect((await SELF.fetch(`${BASE_URL}/v1/attempts/${attempt.attemptId}/context`, {
      headers: { authorization: `Bearer ${attempt.token}` },
    })).status).toBe(401);
  });

  it('rejects stale fencing/head/Run and a review_fix without review lineage with zero source facts', async () => {
    let attempt = await authenticatedReviewAttempt();
    expect((await requestPlanRevision(attempt, {
      expectedVersion: 0,
      leaseGeneration: 1,
    })).status).toBe(409);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM plan_revision_source_facts',
    ).first()).toEqual({ count: 0 });

    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET head_sha = ? WHERE attempt_id = ?`,
    ).bind(FIXED_HEAD_SHA, attempt.attemptId).run();
    expect((await requestPlanRevision(attempt)).status).toBe(409);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM plan_revision_source_facts',
    ).first()).toEqual({ count: 0 });

    await reset();
    await seed();
    attempt = await authenticatedReviewAttempt();
    await env.DB_CONTROL.prepare(
      `UPDATE runs SET version = version + 1 WHERE run_id = ?`,
    ).bind(RUN_ID).run();
    expect((await requestPlanRevision(attempt)).status).toBe(409);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM plan_revision_source_facts',
    ).first()).toEqual({ count: 0 });

    await reset();
    await seed();
    attempt = await authenticatedReviewAttempt();
    await env.DB_CONTROL.prepare(
      'DELETE FROM review_feedback_attempts WHERE review_attempt_id = ?',
    ).bind(attempt.attemptId).run();
    expect((await requestPlanRevision(attempt)).status).toBe(409);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM plan_revision_source_facts',
    ).first()).toEqual({ count: 0 });
  });
});
