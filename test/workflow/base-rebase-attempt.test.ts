/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import { taskRevisionDigest, type TaskEnvelope } from '../../src/domain/task.js';
import { EXECUTION_TOOL_ACTIONS } from '../../src/domain/tool-bridge.js';
import { GitHubDispatchOutboxProcessor } from '../../src/outbox/github-dispatcher.js';
import { BaseRebaseAttemptReconciler } from '../../src/reconciliation/base-rebase-attempt-reconciler.js';
import { repositoryAttemptBranch } from '../../src/runner/git-repository-writer.js';
import { ExecutionAttemptContextStore } from '../../src/storage/execution-attempt-store.js';
import { TaskQueryStore } from '../../src/storage/task-query-store.js';

const RUN_ID = 'run-base-rebase-attempt';
const TASK_ID = 'task-base-rebase-attempt';
const OLD_PLAN_ID = 'plan-base-rebase-v1';
const NEW_PLAN_ID = 'plan-base-rebase-v2';
const OLD_ANALYSIS_ID = 'attempt-base-rebase-analysis-v1';
const NEW_ANALYSIS_ID = 'attempt-base-rebase-analysis-v2';
const SOURCE_ATTEMPT_ID = 'attempt-base-rebase-source';
const ITEM_ID = 'change-and-verify';
const REPOSITORY = 'example/delivery-target';
const OLD_BASE_SHA = 'a'.repeat(40);
const NEW_BASE_SHA = 'b'.repeat(40);
const SOURCE_HEAD_SHA = 'c'.repeat(40);
const OLD_PLAN_DIGEST = `sha256:${'1'.repeat(64)}`;
const NEW_PLAN_DIGEST = `sha256:${'2'.repeat(64)}`;
const SOURCE_DIGEST = `sha256:${'4'.repeat(64)}`;
const SOURCE_BRANCH = repositoryAttemptBranch(TASK_ID, SOURCE_ATTEMPT_ID);
const NOW = '2026-07-26T02:00:00.000Z';
const LEASE_EXPIRES_AT = '2099-01-01T00:00:00.000Z';

function task(): TaskEnvelope {
  return {
    schemaVersion: '1',
    eventId: 'event-base-rebase-attempt',
    occurredAt: NOW,
    source: {
      system: 'manual',
      tenantKey: 'base-rebase-attempt',
      taskKey: TASK_ID,
      revision: 'revision-1',
    },
    actor: { type: 'system', id: 'base-rebase-attempt' },
    target: {
      owner: 'example',
      repo: 'delivery-target',
      baseBranch: 'main',
      environment: 'test',
    },
    intent: {
      kind: 'requirement',
      title: 'Replay the verified change on the new base',
      description: 'Preserve the verified bot change when main advances safely.',
      acceptanceCriteria: ['The replay is verified on the new base.'],
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
    env.DB_CONTROL.prepare('DELETE FROM base_rebase_approval_invalidations'),
    env.DB_CONTROL.prepare('DELETE FROM base_rebase_attempts'),
    env.DB_CONTROL.prepare('DELETE FROM base_conflict_approval_invalidations'),
    env.DB_CONTROL.prepare('DELETE FROM github_base_conflicts'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_publications'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_drafts'),
    env.DB_CONTROL.prepare('DELETE FROM approval_invalidations'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revisions'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revision_source_facts'),
    env.DB_CONTROL.prepare('DELETE FROM github_base_observations'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_done_when_evidence'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_verifications'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suite_commands'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suites'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_head_updates'),
    env.DB_CONTROL.prepare('DELETE FROM github_write_credentials'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_revocations'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
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
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  const objects = await env.TASK_OBJECTS.list();
  if (objects.objects.length > 0) {
    await env.TASK_OBJECTS.delete(objects.objects.map((object) => object.key));
  }
}

async function seed(): Promise<{ taskDigest: string; revisionId: string }> {
  const envelope = task();
  const taskDigest = await taskRevisionDigest(envelope);
  await env.TASK_OBJECTS.put('tasks/base-rebase-attempt.json', JSON.stringify(envelope), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
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
       ) VALUES (?, 'manual', 'base-rebase-attempt', ?, 'revision-1', ?,
                 'r2://tasks/base-rebase-attempt.json', 'system',
                 'base-rebase-attempt', ?, 'main', 'test', 'requirement',
                 'Replay the verified change on the new base', 'p1', 1,
                 1, 0, 0, 1, ?, ?)`,
    ).bind(TASK_ID, TASK_ID, taskDigest, REPOSITORY, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, 'revision-1', ?, ?, ?, 'executing', 20, ?, 2, ?, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, taskDigest, NEW_BASE_SHA, RUN_ID, NEW_PLAN_ID, NEW_PLAN_DIGEST, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'completed', ?, ?,
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 1, 1, ?, ?)`,
    ).bind(OLD_ANALYSIS_ID, RUN_ID, OLD_BASE_SHA, REPOSITORY, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 3, 'analysis', 'completed', ?, ?,
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 1, 1, ?, ?)`,
    ).bind(NEW_ANALYSIS_ID, RUN_ID, NEW_BASE_SHA, REPOSITORY, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, 'revision-1', ?, ?, 'superseded', ?,
                 'Apply and verify the bounded change.', ?, ?)`,
    ).bind(OLD_PLAN_ID, RUN_ID, OLD_BASE_SHA, OLD_PLAN_DIGEST, OLD_ANALYSIS_ID, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 2, 'revision-1', ?, ?, 'active', ?,
                 'Apply and verify the bounded change.', ?, ?)`,
    ).bind(NEW_PLAN_ID, RUN_ID, NEW_BASE_SHA, NEW_PLAN_DIGEST, NEW_ANALYSIS_ID, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, plan_id, plan_version, plan_item_id,
         claimed_progress_version, head_branch, head_sha, version,
         lease_generation, created_at, updated_at
       ) VALUES (?, ?, 2, 'implement', 'completed', ?, ?,
                 'example/delivery-target/.github/workflows/delivery-agent.yml@refs/heads/main',
                 ?, 1, ?, 1, ?, ?, 2, 1, ?, ?)`,
    ).bind(
      SOURCE_ATTEMPT_ID,
      RUN_ID,
      OLD_BASE_SHA,
      REPOSITORY,
      OLD_PLAN_ID,
      ITEM_ID,
      SOURCE_BRANCH,
      SOURCE_HEAD_SHA,
      NOW,
      NOW,
    ),
    ...[OLD_PLAN_ID, NEW_PLAN_ID].map((planId) => env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES (?, ?, 'verification', 'Replay change',
                 'Apply and verify the bounded change.', 1, 0)`,
    ).bind(planId, ITEM_ID)),
  ]);
  for (const planId of [OLD_PLAN_ID, NEW_PLAN_ID]) {
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_item_done_when (plan_id, item_id, position, condition)
         VALUES (?, ?, 0, 'The bot change and trusted checks pass.')`,
      ).bind(planId, ITEM_ID),
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_item_effects (plan_id, item_id, effect)
         VALUES (?, ?, 'repo_write')`,
      ).bind(planId, ITEM_ID),
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
         VALUES (?, ?, 'test:unit')`,
      ).bind(planId, ITEM_ID),
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
         VALUES (?, ?, 'verify:all')`,
      ).bind(planId, ITEM_ID),
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_item_evidence_kinds (plan_id, item_id, evidence_kind)
         VALUES (?, ?, 'commit')`,
      ).bind(planId, ITEM_ID),
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_item_evidence_kinds (plan_id, item_id, evidence_kind)
         VALUES (?, ?, 'test')`,
      ).bind(planId, ITEM_ID),
    ]);
  }
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (
         plan_id, item_id, status, version, updated_at
       ) VALUES (?, ?, 'passed', 2, ?)`,
    ).bind(OLD_PLAN_ID, ITEM_ID, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (
         plan_id, item_id, status, version, updated_at
       ) VALUES (?, ?, 'ready', 1, ?)`,
    ).bind(NEW_PLAN_ID, ITEM_ID, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, sha, summary, verification_status, observed_at, created_at
       ) VALUES ('evidence-base-rebase-source', ?, ?, ?, 1, ?, 'commit',
                 'passed', ?, 'Verified source bot head.', 'verified', ?, ?)`,
    ).bind(RUN_ID, SOURCE_ATTEMPT_ID, OLD_PLAN_ID, ITEM_ID, SOURCE_HEAD_SHA, NOW, NOW),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_head_updates (
         update_id, evidence_id, run_id, attempt_id, plan_id, plan_version,
         plan_item_id, lease_generation, parent_sha, head_sha, branch, created_at
       ) VALUES ('head-base-rebase-source', 'evidence-base-rebase-source', ?, ?, ?,
                 1, ?, 1, ?, ?, ?, ?)`,
    ).bind(RUN_ID, SOURCE_ATTEMPT_ID, OLD_PLAN_ID, ITEM_ID, OLD_BASE_SHA, SOURCE_HEAD_SHA, SOURCE_BRANCH, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_verifications (
         verification_id, run_id, plan_id, plan_version, plan_item_id,
         attempt_id, head_sha, progress_version, evidence_set_digest,
         status, created_at
       ) VALUES ('verification-base-rebase-source', ?, ?, 1, ?, ?, ?, 1, ?,
                 'passed', ?)`,
    ).bind(RUN_ID, OLD_PLAN_ID, ITEM_ID, SOURCE_ATTEMPT_ID, SOURCE_HEAD_SHA, `sha256:${'6'.repeat(64)}`, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_done_when_evidence (
         verification_id, plan_id, item_id, done_when_position,
         evidence_position, evidence_id
       ) VALUES ('verification-base-rebase-source', ?, ?, 0, 0,
                 'evidence-base-rebase-source')`,
    ).bind(OLD_PLAN_ID, ITEM_ID),
  ]);
  const observationId = 'github-base-observation-for-rebase';
  const sourceRef = `d1://github-base-observations/${observationId}`;
  const revisionId = 'plan-revision-base-only';
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO github_base_observations (
         observation_id, run_id, expected_run_version, prior_plan_id,
         prior_plan_version, prior_plan_digest, repository, base_branch,
         before_sha, after_sha, relationship, ahead_by, reference_digest,
         comparison_digest, source_digest, observed_at, created_at
       ) VALUES (?, ?, 10, ?, 1, ?, ?, 'main', ?, ?, 'ahead', 1, ?, ?, ?, ?, ?)`,
    ).bind(
      observationId,
      RUN_ID,
      OLD_PLAN_ID,
      OLD_PLAN_DIGEST,
      REPOSITORY,
      OLD_BASE_SHA,
      NEW_BASE_SHA,
      `sha256:${'7'.repeat(64)}`,
      `sha256:${'8'.repeat(64)}`,
      SOURCE_DIGEST,
      NOW,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_revision_source_facts (
         source_ref, run_id, expected_run_version, prior_plan_id,
         prior_plan_version, prior_plan_digest, source_kind, source_digest,
         requested_base_sha, observed_at, created_at
       ) VALUES (?, ?, 10, ?, 1, ?, 'base_update', ?, ?, ?, ?)`,
    ).bind(sourceRef, RUN_ID, OLD_PLAN_ID, OLD_PLAN_DIGEST, SOURCE_DIGEST, NEW_BASE_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_revisions (
         revision_id, run_id, expected_run_version, prior_plan_id,
         prior_plan_version, prior_plan_digest, prior_base_sha, source_kind,
         source_ref, source_digest, requested_base_sha, analysis_attempt_id,
         new_plan_id, new_plan_version, new_plan_digest, body_changed,
         base_changed, effects_changed, status, created_at, activated_at, updated_at
       ) VALUES (?, ?, 10, ?, 1, ?, ?, 'base_update', ?, ?, ?, ?, ?, 2, ?,
                 0, 1, 0, 'activated', ?, ?, ?)`,
    ).bind(
      revisionId,
      RUN_ID,
      OLD_PLAN_ID,
      OLD_PLAN_DIGEST,
      OLD_BASE_SHA,
      sourceRef,
      SOURCE_DIGEST,
      NEW_BASE_SHA,
      NEW_ANALYSIS_ID,
      NEW_PLAN_ID,
      NEW_PLAN_DIGEST,
      NOW,
      NOW,
      NOW,
    ),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-base-rebase-old', ?, 'revision-1', ?, 1, ?, ?,
                 'repo_write', 'user:approver', 'approve', ?, ?, ?)`,
    ).bind(RUN_ID, OLD_PLAN_ID, OLD_PLAN_DIGEST, OLD_BASE_SHA, `sha256:${'9'.repeat(64)}`, LEASE_EXPIRES_AT, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-base-rebase-new', ?, 'revision-1', ?, 2, ?, ?,
                 'repo_write', 'user:approver', 'approve', ?, ?, ?)`,
    ).bind(RUN_ID, NEW_PLAN_ID, NEW_PLAN_DIGEST, NEW_BASE_SHA, `sha256:${'a'.repeat(64)}`, LEASE_EXPIRES_AT, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO approval_invalidations (
         approval_id, revision_id, reason, invalidated_at
       ) VALUES ('approval-base-rebase-old', ?, 'plan_revision_started', ?)`,
    ).bind(revisionId, NOW),
  ]);
  return { taskDigest, revisionId };
}

async function activateAttempt(attemptId: string): Promise<{ token: string; version: number }> {
  const token = 'base-rebase-attempt-token';
  await env.DB_CONTROL.prepare(
    `UPDATE attempts
     SET status = 'running', version = 1, lease_generation = 1,
         lease_token_digest = ?, lease_expires_at = ?, updated_at = ?
     WHERE attempt_id = ? AND status IN ('pending', 'starting')`,
  ).bind(`sha256:${'b'.repeat(64)}`, LEASE_EXPIRES_AT, NOW, attemptId).run();
  await env.DB_CONTROL.prepare(
    `INSERT INTO attempt_tokens (
       token_id, attempt_id, oidc_token_digest, token_digest, tool_token_digest,
       lease_generation, scopes_json, expires_at, created_at
     ) VALUES ('token-base-rebase-attempt', ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).bind(
    attemptId,
    await canonicalSha256('base-rebase-oidc'),
    await canonicalSha256(token),
    await canonicalSha256('base-rebase-tool-token'),
    JSON.stringify(EXECUTION_TOOL_ACTIONS),
    LEASE_EXPIRES_AT,
    NOW,
  ).run();
  return { token, version: 1 };
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('base-only Plan revision rebase Attempt', () => {
  it('converges 20 schedules, dispatches the fixed workflow, and returns exact rebase context', async () => {
    const reconciler = new BaseRebaseAttemptReconciler(env.DB_CONTROL, {
      now: () => new Date(NOW),
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reconciler.reconcileRun(RUN_ID)),
    );
    expect(results.filter((result) => result === 'scheduled')).toHaveLength(1);
    expect(results.every((result) => result === 'scheduled' || result === 'duplicate')).toBe(true);
    const lineage = await env.DB_CONTROL.prepare(
      `SELECT rebase_id, source_attempt_id, rebase_attempt_id, old_base_sha,
              new_base_sha, source_branch, source_head_sha, target_branch, status
       FROM base_rebase_attempts`,
    ).first<Record<string, string>>();
    expect(lineage).toMatchObject({
      source_attempt_id: SOURCE_ATTEMPT_ID,
      old_base_sha: OLD_BASE_SHA,
      new_base_sha: NEW_BASE_SHA,
      source_branch: SOURCE_BRANCH,
      source_head_sha: SOURCE_HEAD_SHA,
      status: 'scheduled',
    });
    const attemptId = String(lineage?.rebase_attempt_id);
    expect(lineage?.target_branch).toBe(repositoryAttemptBranch(TASK_ID, attemptId));
    expect(await env.DB_CONTROL.prepare(
      `SELECT mode, status, base_sha, head_sha, head_branch, plan_id,
              plan_version, plan_item_id
       FROM attempts WHERE attempt_id = ?`,
    ).bind(attemptId).first()).toEqual({
      mode: 'review_fix',
      status: 'pending',
      base_sha: NEW_BASE_SHA,
      head_sha: SOURCE_HEAD_SHA,
      head_branch: null,
      plan_id: NEW_PLAN_ID,
      plan_version: 2,
      plan_item_id: ITEM_ID,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, active_attempt_id FROM plan_item_progress
       WHERE plan_id = ? AND item_id = ?`,
    ).bind(NEW_PLAN_ID, ITEM_ID).first()).toEqual({
      status: 'in_progress',
      active_attempt_id: attemptId,
    });

    const calls: unknown[] = [];
    const processor = new GitHubDispatchOutboxProcessor(env.DB_CONTROL, {
      ensureDispatch: async (request) => {
        calls.push(request);
        return { disposition: 'created', githubRunId: '49001' };
      },
    }, {
      allowedRepositories: [REPOSITORY],
      controlPlaneUrl: 'https://control.delivery.test',
      now: () => new Date(NOW),
      generateLeaseToken: () => 'base-rebase-dispatch-lease',
    });
    const outbox = await env.DB_CONTROL.prepare(
      `SELECT outbox_id FROM outbox
       WHERE kind = 'execution_dispatch' AND payload_ref = ?`,
    ).bind(`d1://attempts/${attemptId}`).first<{ outbox_id: string }>();
    expect(outbox).not.toBeNull();
    expect(await processor.deliver(outbox!.outbox_id)).toBe('settled');
    expect(calls).toMatchObject([{
      repository: REPOSITORY,
      ref: 'refs/heads/main',
      inputs: {
        attempt_id: attemptId,
        base_sha: NEW_BASE_SHA,
        checkout_sha: SOURCE_HEAD_SHA,
        mode: 'review_fix',
        plan_version: '2',
        plan_item_id: ITEM_ID,
      },
    }]);
    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'running' WHERE attempt_id = ? AND status = 'starting'`,
    ).bind(attemptId).run();
    const context = await new ExecutionAttemptContextStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).get({
      attemptId,
      runId: RUN_ID,
      mode: 'review_fix',
      status: 'running',
      version: 1,
      leaseGeneration: 1,
      leaseExpiresAt: new Date(new Date(NOW).getTime() + 10 * 60_000).toISOString(),
      scopes: [...EXECUTION_TOOL_ACTIONS],
    });
    expect(context).toMatchObject({
      attempt: {
        id: attemptId,
        baseSha: NEW_BASE_SHA,
        checkoutSha: SOURCE_HEAD_SHA,
        targetBranch: repositoryAttemptBranch(TASK_ID, attemptId),
        targetBranchMode: 'new',
      },
      baseRebase: {
        sourceAttemptId: SOURCE_ATTEMPT_ID,
        sourceBranch: SOURCE_BRANCH,
        sourceHeadSha: SOURCE_HEAD_SHA,
        oldBaseSha: OLD_BASE_SHA,
        newBaseSha: NEW_BASE_SHA,
      },
    });
    expect(context).not.toHaveProperty('repair');
    expect(context).not.toHaveProperty('reviewFeedback');
    const status = await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus(RUN_ID);
    expect(status).not.toBeNull();
    if (status === null) throw new Error('expected the seeded Run status');
    expect(status.attempts.find((attempt) => attempt.id === attemptId)).toMatchObject({
      id: attemptId,
      baseRebase: {
        sourceAttemptId: SOURCE_ATTEMPT_ID,
        sourceHeadSha: SOURCE_HEAD_SHA,
        oldBaseSha: OLD_BASE_SHA,
        newBaseSha: NEW_BASE_SHA,
        targetBranch: repositoryAttemptBranch(TASK_ID, attemptId),
        status: 'scheduled',
      },
    });
  });

  it('does not schedule an automatic rebase for a branch that entered PR publication', async () => {
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO pull_request_drafts (
           draft_id, run_id, run_version, task_id, task_revision, task_digest,
           plan_id, plan_version, plan_digest, attempt_id, head_update_id,
           head_sha, branch, body, body_digest, status, created_at
         ) VALUES ('draft-base-rebase-published', ?, 9, ?, 'revision-1', ?, ?, 1, ?, ?,
                   'head-base-rebase-source', ?, ?, 'body', ?, 'prepared', ?)`,
      ).bind(
        RUN_ID,
        TASK_ID,
        await taskRevisionDigest(task()),
        OLD_PLAN_ID,
        OLD_PLAN_DIGEST,
        SOURCE_ATTEMPT_ID,
        SOURCE_HEAD_SHA,
        SOURCE_BRANCH,
        `sha256:${'c'.repeat(64)}`,
        NOW,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO pull_request_publications (
           publication_id, run_id, run_version, draft_id, approval_id,
           repository, base_branch, head_branch, head_sha, title, body_digest,
           status, created_at, updated_at
         ) VALUES ('publication-base-rebase-published', ?, 9,
                   'draft-base-rebase-published', 'approval-base-rebase-old', ?,
                   'main', ?, ?, 'Published source', ?, 'verified', ?, ?)`,
      ).bind(
        RUN_ID,
        REPOSITORY,
        SOURCE_BRANCH,
        SOURCE_HEAD_SHA,
        `sha256:${'c'.repeat(64)}`,
        NOW,
        NOW,
      ),
    ]);
    expect(await new BaseRebaseAttemptReconciler(
      env.DB_CONTROL,
      { now: () => new Date(NOW) },
    ).reconcileRun(RUN_ID)).toBe('not_found');
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM base_rebase_attempts',
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, active_attempt_id FROM plan_item_progress
       WHERE plan_id = ? AND item_id = ?`,
    ).bind(NEW_PLAN_ID, ITEM_ID).first()).toEqual({ status: 'ready', active_attempt_id: null });
  });

  it('turns a trusted content conflict into one safe blocker and revokes the new approval', async () => {
    const reconciler = new BaseRebaseAttemptReconciler(env.DB_CONTROL, {
      now: () => new Date(NOW),
    });
    expect(await reconciler.reconcileRun(RUN_ID)).toBe('scheduled');
    const lineage = await env.DB_CONTROL.prepare(
      'SELECT rebase_attempt_id FROM base_rebase_attempts',
    ).first<{ rebase_attempt_id: string }>();
    if (lineage === null) throw new Error('missing rebase Attempt');
    const active = await activateAttempt(lineage.rebase_attempt_id);
    const response = await SELF.fetch(
      `https://delivery-loop.test/v1/attempts/${lineage.rebase_attempt_id}/base-rebase/conflict`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${active.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          expectedVersion: active.version,
          leaseGeneration: 1,
          reason: 'content_conflict',
        }),
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      accepted: true,
      status: 'blocked',
      reason: 'content_conflict',
      runVersion: 21,
    });
    const replay = await SELF.fetch(
      `https://delivery-loop.test/v1/attempts/${lineage.rebase_attempt_id}/base-rebase/conflict`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${active.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          expectedVersion: active.version,
          leaseGeneration: 1,
          reason: 'content_conflict',
        }),
      },
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      accepted: true,
      status: 'blocked',
      reason: 'content_conflict',
      created: false,
      runVersion: 21,
    });
    const wrongTokenReplay = await SELF.fetch(
      `https://delivery-loop.test/v1/attempts/${lineage.rebase_attempt_id}/base-rebase/conflict`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${active.token}-wrong`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          expectedVersion: active.version,
          leaseGeneration: 1,
          reason: 'content_conflict',
        }),
      },
    );
    expect(wrongTokenReplay.status).toBe(401);
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version, base_sha FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'blocked', version: 21, base_sha: NEW_BASE_SHA });
    expect(await env.DB_CONTROL.prepare(
      'SELECT status FROM execution_plans WHERE plan_id = ?',
    ).bind(NEW_PLAN_ID).first()).toEqual({ status: 'blocked' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, version, lease_generation, lease_token_digest
       FROM attempts WHERE attempt_id = ?`,
    ).bind(lineage.rebase_attempt_id).first()).toEqual({
      status: 'cancelled',
      version: 2,
      lease_generation: 2,
      lease_token_digest: null,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT revoked_at IS NOT NULL AS revoked FROM attempt_tokens WHERE attempt_id = ?',
    ).bind(lineage.rebase_attempt_id).first()).toEqual({ revoked: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT reason, revoked_lease_generation, attempt_version
       FROM attempt_revocations WHERE attempt_id = ?`,
    ).bind(lineage.rebase_attempt_id).first()).toEqual({
      reason: 'cancelled',
      revoked_lease_generation: 1,
      attempt_version: 2,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM invalidated_approvals
       WHERE approval_id = 'approval-base-rebase-new'`,
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state FROM outbox WHERE kind = 'workflow_cancel'`,
    ).first()).toEqual({ delivery_state: 'pending' });
    expect(await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus(RUN_ID)).toMatchObject({
      run: {
        state: 'blocked',
        blocker: {
          kind: 'base_rebase_conflict',
          reason: 'base_rebase_content_conflict',
          sourceHeadSha: SOURCE_HEAD_SHA,
          oldBaseSha: OLD_BASE_SHA,
          newBaseSha: NEW_BASE_SHA,
          neededHumanInput: { code: 'manual_rebase' },
        },
      },
    });
  });

  it('accepts completion only after the rebased head and full suite are durably recorded', async () => {
    const reconciler = new BaseRebaseAttemptReconciler(env.DB_CONTROL, {
      now: () => new Date(NOW),
    });
    expect(await reconciler.reconcileRun(RUN_ID)).toBe('scheduled');
    const lineage = await env.DB_CONTROL.prepare(
      'SELECT rebase_attempt_id, target_branch FROM base_rebase_attempts',
    ).first<{ rebase_attempt_id: string; target_branch: string }>();
    if (lineage === null) throw new Error('missing rebase Attempt');
    const active = await activateAttempt(lineage.rebase_attempt_id);
    const rebasedHeadSha = 'd'.repeat(40);
    const post = async (path: string, body: unknown): Promise<Response> => await SELF.fetch(
      `https://delivery-loop.test${path}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${active.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    const head = await post(`/v1/attempts/${lineage.rebase_attempt_id}/head`, {
      expectedVersion: 1,
      leaseGeneration: 1,
      parentSha: SOURCE_HEAD_SHA,
      headSha: rebasedHeadSha,
      branch: lineage.target_branch,
    });
    expect(head.status).toBe(201);
    const suiteStart = await post(`/v1/attempts/${lineage.rebase_attempt_id}/verifications`, {
      expectedVersion: 2,
      leaseGeneration: 1,
      manifest: {
        schemaVersion: '1',
        headSha: rebasedHeadSha,
        policyDigest: `sha256:${'e'.repeat(64)}`,
        targetedCommandRefs: ['test:unit'],
        requiredVerifyCommandRefs: ['verify:all'],
      },
    });
    expect(suiteStart.status).toBe(201);
    const suite = (await suiteStart.json()) as { suiteId: string };
    for (const [position, command] of [
      { phase: 'targeted', commandRef: 'test:unit' },
      { phase: 'required_verify', commandRef: 'verify:all' },
    ].entries()) {
      const recorded = await post(
        `/v1/attempts/${lineage.rebase_attempt_id}/verifications/${suite.suiteId}/results`,
        {
          expectedVersion: 2,
          leaseGeneration: 1,
          result: {
            schemaVersion: '1',
            position,
            ...command,
            exitCode: 0,
            durationMs: 10 + position,
            headSha: rebasedHeadSha,
          },
        },
      );
      expect(recorded.status).toBe(201);
    }
    const completed = await post(
      `/v1/attempts/${lineage.rebase_attempt_id}/base-rebase/complete`,
      {
        expectedVersion: 2,
        leaseGeneration: 1,
        headSha: rebasedHeadSha,
        suiteId: suite.suiteId,
      },
    );
    expect(completed.status).toBe(201);
    expect(await completed.json()).toMatchObject({
      accepted: true,
      status: 'passed',
      headSha: rebasedHeadSha,
      suiteId: suite.suiteId,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, result_head_sha, verification_suite_id, blocker_reason
       FROM base_rebase_attempts`,
    ).first()).toEqual({
      status: 'passed',
      result_head_sha: rebasedHeadSha,
      verification_suite_id: suite.suiteId,
      blocker_reason: null,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'executing', version: 20 });
  });
});
