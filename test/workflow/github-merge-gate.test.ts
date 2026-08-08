/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityMapper } from '../../src/auth/identity-mapper.js';
import { canonicalSha256 } from '../../src/domain/digest.js';
import type { GitHubMergeGateFact } from '../../src/domain/github-merge-gate.js';
import type { GitHubPullRequestMergeFact } from '../../src/domain/github-merge-status.js';
import {
  GitHubMergeGateReconciler,
  type GitHubMergeGateExternalFactClient,
} from '../../src/reconciliation/github-merge-gate-reconciler.js';
import {
  GitHubMergeStatusReconciler,
} from '../../src/reconciliation/github-merge-status-reconciler.js';
import { TaskQueryStore } from '../../src/storage/task-query-store.js';
import { GitHubMergeStatusStore } from '../../src/storage/github-merge-status-store.js';
import { IdentityBoundApprovalStore } from '../../src/storage/identity-bound-approval-store.js';

const NOW = '2026-07-26T03:00:00.000Z';
const RUN_ID = 'run-merge-gate';
const TASK_ID = 'task-merge-gate';
const PLAN_ID = 'plan-merge-gate';
const ANALYSIS_ATTEMPT_ID = 'attempt-merge-analysis';
const HEAD_ATTEMPT_ID = 'attempt-merge-head';
const ITEM_ID = 'delivery';
const DRAFT_ID = 'draft-merge-gate';
const PUBLICATION_ID = 'publication-merge-gate';
const REPOSITORY = 'example/delivery-target';
const BRANCH = `agent/${TASK_ID}/${HEAD_ATTEMPT_ID}`;
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const PARENT_SHA = 'c'.repeat(40);
const TASK_DIGEST = `sha256:${'1'.repeat(64)}`;
const PLAN_DIGEST = `sha256:${'2'.repeat(64)}`;
const BODY_DIGEST = `sha256:${'3'.repeat(64)}`;
const MERGE_SHA = 'd'.repeat(40);
const WEBHOOK_SECRET = 'test-github-webhook-secret';

function fact(overrides: Partial<GitHubMergeGateFact> = {}): GitHubMergeGateFact {
  return {
    schemaVersion: '1',
    repository: REPOSITORY,
    number: 7,
    pullRequestAuthorLogin: 'delivery-author',
    headBranch: BRANCH,
    headSha: HEAD_SHA,
    baseBranch: 'main',
    baseSha: BASE_SHA,
    pullRequestBaseSha: BASE_SHA,
    state: 'open',
    draft: false,
    mergeability: 'mergeable',
    mergeState: 'clean',
    reviewDecision: 'approved',
    requiredApprovals: 1,
    approvedReviewCount: 1,
    requiredChecks: [{ context: 'ci', integrationId: 42, state: 'passed' }],
    policyDigest: `sha256:${'4'.repeat(64)}`,
    checksDigest: `sha256:${'5'.repeat(64)}`,
    reviewsDigest: `sha256:${'6'.repeat(64)}`,
    externalUpdatedAt: NOW,
    ...overrides,
  };
}

function mergeFact(
  overrides: Partial<GitHubPullRequestMergeFact> = {},
): GitHubPullRequestMergeFact {
  return {
    schemaVersion: '1',
    repository: REPOSITORY,
    number: 7,
    url: 'https://github.test/example/delivery-target/pull/7',
    state: 'closed',
    merged: true,
    headBranch: BRANCH,
    headSha: HEAD_SHA,
    baseBranch: 'main',
    mergeSha: MERGE_SHA,
    mergedByLogin: 'merge-reviewer',
    mergedAt: '2026-07-26T03:01:00.000Z',
    externalUpdatedAt: '2026-07-26T03:01:01.000Z',
    ...overrides,
  };
}

class FakeClient implements GitHubMergeGateExternalFactClient {
  calls = 0;
  current = fact();

  async observeMergeGate(): Promise<GitHubMergeGateFact> {
    this.calls += 1;
    return structuredClone(this.current);
  }
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM automated_review_fix_attempts'),
    env.DB_CONTROL.prepare('DELETE FROM automated_reviews'),
    env.DB_CONTROL.prepare('DELETE FROM github_merge_observations'),
    env.DB_CONTROL.prepare('DELETE FROM github_merges'),
    env.DB_CONTROL.prepare('DELETE FROM merge_gate_decisions'),
    env.DB_CONTROL.prepare('DELETE FROM merge_gate_evaluations'),
    env.DB_CONTROL.prepare('DELETE FROM github_merge_gate_required_checks'),
    env.DB_CONTROL.prepare('DELETE FROM github_merge_gate_observations'),
    env.DB_CONTROL.prepare('DELETE FROM identity_bound_approvals'),
    env.DB_CONTROL.prepare('DELETE FROM approval_identity_rejections'),
    env.DB_CONTROL.prepare('DELETE FROM approval_source_events'),
    env.DB_CONTROL.prepare('DELETE FROM approval_invalidations'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revisions'),
    env.DB_CONTROL.prepare('DELETE FROM plan_revision_source_facts'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_publications'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_drafts'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_head_updates'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM channel_identities'),
    env.DB_CONTROL.prepare('DELETE FROM identity_mappings'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_effects'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_progress'),
    env.DB_CONTROL.prepare('DELETE FROM plan_items'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plans'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
}

async function readyToMerge(): Promise<void> {
  const result = await new GitHubMergeGateReconciler(env.DB_CONTROL, new FakeClient(), {
    now: () => new Date(NOW),
  }).reconcileRun(RUN_ID);
  expect(result.disposition).toBe('ready_to_merge');
}

async function webhookSignature(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
  );
  return `sha256=${Array.from(signature, (byte) =>
    byte.toString(16).padStart(2, '0')).join('')}`;
}

async function seed(
  mergeApprovalExpiry = '2099-01-01T00:00:00.000Z',
  includeMergeEffect = true,
): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'manual', 'merge-gate', 'merge-gate', 'revision-1', ?,
                 'r2://tasks/merge-gate.json', 'user', 'requester', ?, 'main',
                 'none', 'requirement', 'Merge only after every gate passes', 'p1',
                 1, 1, 0, 0, 1, ?, ?)`,
    ).bind(TASK_ID, TASK_DIGEST, REPOSITORY, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, 'revision-1', ?, ?, ?, 'pull_request_open', 10,
                 ?, 1, ?, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, TASK_DIGEST, BASE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'completed', ?, ?, 1, 1, ?, ?)`,
    ).bind(ANALYSIS_ATTEMPT_ID, RUN_ID, BASE_SHA, REPOSITORY, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, 'revision-1', ?, ?, 'active', ?,
                 'Deliver and merge through verified gates', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, ANALYSIS_ATTEMPT_ID, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES (?, ?, 'delivery', 'Merge delivery', 'Merge only after gates pass', 1, 0)`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (plan_id, item_id, status, version, updated_at)
       VALUES (?, ?, 'passed', 2, ?)`,
    ).bind(PLAN_ID, ITEM_ID, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       SELECT ?, ?, 'repo_write'
       UNION ALL SELECT ?, ?, 'merge' WHERE ? = 1`,
    ).bind(PLAN_ID, ITEM_ID, PLAN_ID, ITEM_ID, includeMergeEffect ? 1 : 0),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         plan_id, plan_version, plan_item_id, head_sha, head_branch,
         version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 2, 'implement', 'completed', ?, ?, ?, 1, ?, ?, ?,
                 2, 2, ?, ?)`,
    ).bind(
      HEAD_ATTEMPT_ID, RUN_ID, BASE_SHA, REPOSITORY, PLAN_ID, ITEM_ID,
      HEAD_SHA, BRANCH, NOW, NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, sha, summary, verification_status, observed_at, created_at
       ) VALUES ('evidence-merge-head', ?, ?, ?, 1, ?, 'commit', 'passed', ?,
                 'Trusted bot head', 'verified', ?, ?)`,
    ).bind(RUN_ID, HEAD_ATTEMPT_ID, PLAN_ID, ITEM_ID, HEAD_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_head_updates (
         update_id, evidence_id, run_id, attempt_id, plan_id, plan_version,
         plan_item_id, lease_generation, parent_sha, head_sha, branch, created_at
       ) VALUES ('head-merge-gate', 'evidence-merge-head', ?, ?, ?, 1, ?, 1,
                 ?, ?, ?, ?)`,
    ).bind(RUN_ID, HEAD_ATTEMPT_ID, PLAN_ID, ITEM_ID, PARENT_SHA, HEAD_SHA, BRANCH, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO pull_request_drafts (
         draft_id, run_id, run_version, task_id, task_revision, task_digest,
         plan_id, plan_version, plan_digest, attempt_id, head_update_id,
         head_sha, branch, body, body_digest, status, created_at
       ) VALUES (?, ?, 9, ?, 'revision-1', ?, ?, 1, ?, ?, 'head-merge-gate',
                 ?, ?, 'Verified delivery', ?, 'prepared', ?)`,
    ).bind(
      DRAFT_ID, RUN_ID, TASK_ID, TASK_DIGEST, PLAN_ID, PLAN_DIGEST,
      HEAD_ATTEMPT_ID, HEAD_SHA, BRANCH, BODY_DIGEST, NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-merge-repo', ?, 'revision-1', ?, 1, ?, ?,
                 'repo_write', 'reviewer:repo', 'approve', ?,
                 '2099-01-01T00:00:00.000Z', ?)`,
    ).bind(RUN_ID, PLAN_ID, PLAN_DIGEST, BASE_SHA, `sha256:${'7'.repeat(64)}`, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-merge-effect', ?, 'revision-1', ?, 1, ?, ?,
                 'merge', 'user:merge-reviewer', 'approve', ?, ?, ?)`,
    ).bind(
      RUN_ID, PLAN_ID, PLAN_DIGEST, BASE_SHA,
      `sha256:${'8'.repeat(64)}`, mergeApprovalExpiry, NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO identity_mappings (principal, roles, created_at, updated_at)
       VALUES ('user:delivery-author', '["human"]', ?, ?),
              ('user:merge-reviewer', '["approve:merge","human"]', ?, ?)`,
    ).bind(NOW, NOW, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO channel_identities (
         channel, channel_user_id, principal, created_at, updated_at
       ) VALUES (?, 'delivery-author', 'user:delivery-author', ?, ?),
                ('feishu:tenant-merge-gate', 'ou_merge_reviewer',
                 'user:merge-reviewer', ?, ?)`,
    ).bind(`github:${REPOSITORY}`, NOW, NOW, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO approval_source_events (
         source_id, provider, tenant_key, external_event_id, event_digest, request_digest,
         channel, channel_user_id, occurred_at, received_at, created_at
       ) VALUES ('approval-source-merge-effect', 'feishu', 'tenant-merge-gate',
                 'event-seeded-merge-approval', ?, ?, 'feishu:tenant-merge-gate',
                 'ou_merge_reviewer', ?, ?, ?)`,
    ).bind(`sha256:${'9'.repeat(64)}`, `sha256:${'b'.repeat(64)}`, NOW, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO identity_bound_approvals (
         approval_id, source_id, approver_principal, approver_channel,
         approver_channel_user_id, pull_request_author_principal,
         pull_request_author_channel, pull_request_author_login, roles_digest,
         separation_verified, created_at
       ) VALUES ('approval-merge-effect', 'approval-source-merge-effect',
                 'user:merge-reviewer', 'feishu:tenant-merge-gate',
                 'ou_merge_reviewer', 'user:delivery-author', ?,
                 'delivery-author', ?, 1, ?)`,
    ).bind(`github:${REPOSITORY}`, `sha256:${'a'.repeat(64)}`, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version,
         kind, status, sha, external_url, summary, verification_status,
         observed_at, created_at
       ) VALUES ('evidence-merge-pr', ?, ?, ?, 1, 'pull_request', 'passed', ?,
                 'https://github.test/example/delivery-target/pull/7',
                 'Verified Draft PR', 'verified', ?, ?)`,
    ).bind(RUN_ID, HEAD_ATTEMPT_ID, PLAN_ID, HEAD_SHA, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO pull_request_publications (
         publication_id, run_id, run_version, draft_id, approval_id,
         repository, base_branch, head_branch, head_sha, title, body_digest,
         status, github_pr_number, github_pr_url, github_external_updated_at,
         github_observation_version, evidence_id, created_at, updated_at
       ) VALUES (?, ?, 9, ?, 'approval-merge-repo', ?, 'main', ?, ?,
                 'Delivery Loop merge gate', ?, 'verified', 7,
                 'https://github.test/example/delivery-target/pull/7', ?, 1,
                 'evidence-merge-pr', ?, ?)`,
    ).bind(PUBLICATION_ID, RUN_ID, DRAFT_ID, REPOSITORY, BRANCH, HEAD_SHA, BODY_DIGEST, NOW, NOW, NOW),
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('GitHub merge eligibility gate', () => {
  it('converges 20 evaluations to one ready-to-merge decision without a merge effect', async () => {
    const client = new FakeClient();
    const reconciler = new GitHubMergeGateReconciler(env.DB_CONTROL, client, {
      now: () => new Date(NOW),
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reconciler.reconcileRun(RUN_ID)),
    );
    expect(results.filter((result) => result.disposition === 'ready_to_merge')).toHaveLength(1);
    expect(results.every((result) =>
      result.disposition === 'ready_to_merge' || result.disposition === 'duplicate')).toBe(true);
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'ready_to_merge', version: 11 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM github_merge_gate_observations',
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM merge_gate_decisions',
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE kind = 'merge'`,
    ).first()).toEqual({ count: 0 });
    expect(await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus(RUN_ID)).toMatchObject({
      run: {
        state: 'ready_to_merge',
        mergeGate: {
          status: 'passed',
          pullRequestNumber: 7,
          headSha: HEAD_SHA,
          baseSha: BASE_SHA,
          requiredCheckCount: 1,
          passedCheckCount: 1,
          requiredApprovals: 1,
          approvedReviewCount: 1,
        },
      },
    });
  });

  it.each([
    ['required_checks_incomplete', fact({
      requiredChecks: [{ context: 'ci', integrationId: 42, state: 'pending' }],
    })],
    ['required_checks_failed', fact({
      requiredChecks: [{ context: 'ci', integrationId: 42, state: 'failed' }],
    })],
    ['review_insufficient', fact({ reviewDecision: 'review_required', approvedReviewCount: 0 })],
    ['review_insufficient', fact({ reviewDecision: 'changes_requested', approvedReviewCount: 1 })],
    ['base_not_latest', fact({ baseSha: 'd'.repeat(40) })],
    ['head_not_latest', fact({ headSha: 'e'.repeat(40) })],
    ['policy_unavailable', fact({ requiredChecks: [] })],
    ['mergeability_unavailable', fact({ draft: true, mergeState: 'draft' })],
    ['mergeability_unavailable', fact({
      mergeability: 'unknown',
      mergeState: 'unknown',
    })],
    ['mergeability_unavailable', fact({
      mergeability: 'conflicting',
      mergeState: 'dirty',
    })],
  ] as const)('rejects %s with zero merge effect', async (reason, observed) => {
    const client = new FakeClient();
    client.current = observed;
    const result = await new GitHubMergeGateReconciler(env.DB_CONTROL, client, {
      now: () => new Date(NOW),
    }).reconcileRun(RUN_ID);
    expect(result).toMatchObject({ disposition: 'rejected', reason });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'pull_request_open', version: 10 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM merge_gate_decisions',
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE kind = 'merge'`,
    ).first()).toEqual({ count: 0 });
    expect(await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus(RUN_ID)).toMatchObject({
      run: {
        state: 'pull_request_open',
        mergeGate: { status: 'rejected', reason },
      },
    });
  });

  it('rejects a pending automated review for the current PR head', async () => {
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, repository,
           version, lease_generation, created_at, updated_at
         ) VALUES ('attempt-pending-auto-review', ?, 3, 'analysis', 'pending', ?, ?, 0, 0, ?, ?)`,
      ).bind(RUN_ID, HEAD_SHA, REPOSITORY, NOW, NOW),
      env.DB_CONTROL.prepare(
        `INSERT INTO automated_reviews (
           review_id, run_id, publication_id, plan_id, plan_version, plan_item_id,
           prior_attempt_id, review_attempt_id, repository, github_pr_number,
           base_branch, branch, source_head_sha, iteration, status, created_at, updated_at
         ) VALUES ('pending-auto-review', ?, ?, ?, 1, ?, ?, 'attempt-pending-auto-review',
                   ?, 7, 'main', ?, ?, 1, 'pending', ?, ?)`,
      ).bind(
        RUN_ID,
        PUBLICATION_ID,
        PLAN_ID,
        ITEM_ID,
        HEAD_ATTEMPT_ID,
        REPOSITORY,
        BRANCH,
        HEAD_SHA,
        NOW,
        NOW,
      ),
    ]);
    const result = await new GitHubMergeGateReconciler(env.DB_CONTROL, new FakeClient(), {
      now: () => new Date(NOW),
    }).reconcileRun(RUN_ID);
    expect(result).toMatchObject({ disposition: 'rejected', reason: 'review_insufficient' });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'pull_request_open', version: 10 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM merge_gate_decisions',
    ).first()).toEqual({ count: 0 });
  });

  it('rejects an expired exact merge approval and persists no merge decision/effect', async () => {
    await reset();
    await seed('2026-07-26T02:59:59.000Z');
    const result = await new GitHubMergeGateReconciler(env.DB_CONTROL, new FakeClient(), {
      now: () => new Date(NOW),
    }).reconcileRun(RUN_ID);
    expect(result).toMatchObject({ disposition: 'rejected', reason: 'approval_required' });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'pull_request_open', version: 10 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM merge_gate_decisions',
    ).first()).toEqual({ count: 0 });
  });

  it('does not fall back to an older approval after the latest exact decision rejects merge', async () => {
    await env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-merge-effect-z-reject', ?, 'revision-1', ?, 1, ?, ?,
                 'merge', 'reviewer:merge', 'reject', ?,
                 '2099-01-01T00:00:00.000Z', ?)`,
    ).bind(
      RUN_ID,
      PLAN_ID,
      PLAN_DIGEST,
      BASE_SHA,
      `sha256:${'9'.repeat(64)}`,
      NOW,
    ).run();
    const result = await new GitHubMergeGateReconciler(env.DB_CONTROL, new FakeClient(), {
      now: () => new Date(NOW),
    }).reconcileRun(RUN_ID);
    expect(result).toMatchObject({ disposition: 'rejected', reason: 'approval_required' });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'pull_request_open', version: 10 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM merge_gate_decisions',
    ).first()).toEqual({ count: 0 });
  });

  it('rejects an invalidated latest approval instead of falling back to an older one', async () => {
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_revision_source_facts (
           source_ref, run_id, expected_run_version, prior_plan_id,
           prior_plan_version, prior_plan_digest, source_kind, source_digest,
           requested_base_sha, observed_at, created_at
         ) VALUES ('d1://merge-gate/invalidation', ?, 10, ?, 1, ?,
                   'supplemental_context', ?, ?, ?, ?)`,
      ).bind(
        RUN_ID,
        PLAN_ID,
        PLAN_DIGEST,
        `sha256:${'a'.repeat(64)}`,
        BASE_SHA,
        NOW,
        NOW,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_revisions (
           revision_id, run_id, expected_run_version, prior_plan_id,
           prior_plan_version, prior_plan_digest, prior_base_sha, source_kind,
           source_ref, source_digest, requested_base_sha, analysis_attempt_id,
           status, created_at, updated_at
         ) VALUES ('revision-merge-gate-invalidation', ?, 10, ?, 1, ?, ?,
                   'supplemental_context', 'd1://merge-gate/invalidation', ?, ?, ?,
                   'rejected', ?, ?)`,
      ).bind(
        RUN_ID,
        PLAN_ID,
        PLAN_DIGEST,
        BASE_SHA,
        `sha256:${'a'.repeat(64)}`,
        BASE_SHA,
        ANALYSIS_ATTEMPT_ID,
        NOW,
        NOW,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO approval_invalidations (
           approval_id, revision_id, reason, invalidated_at
         ) VALUES ('approval-merge-effect', 'revision-merge-gate-invalidation',
                   'plan_revision_started', ?)`,
      ).bind(NOW),
    ]);
    const result = await new GitHubMergeGateReconciler(env.DB_CONTROL, new FakeClient(), {
      now: () => new Date(NOW),
    }).reconcileRun(RUN_ID);
    expect(result).toMatchObject({ disposition: 'rejected', reason: 'approval_required' });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM merge_gate_decisions',
    ).first()).toEqual({ count: 0 });
  });

  it('rejects a Plan that did not declare the merge effect before persisting an observation', async () => {
    await reset();
    await seed('2099-01-01T00:00:00.000Z', false);
    const result = await new GitHubMergeGateReconciler(env.DB_CONTROL, new FakeClient(), {
      now: () => new Date(NOW),
    }).reconcileRun(RUN_ID);
    expect(result).toEqual({ disposition: 'stale' });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM github_merge_gate_observations',
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM merge_gate_decisions',
    ).first()).toEqual({ count: 0 });
  });
});

async function prepareIdentityApprovalSource(): Promise<void> {
  await env.DB_CONTROL.prepare(
    `DELETE FROM approvals WHERE approval_id = 'approval-merge-effect'`,
  ).run();
  const observed = await new GitHubMergeGateReconciler(env.DB_CONTROL, new FakeClient(), {
    now: () => new Date(NOW),
  }).reconcileRun(RUN_ID);
  expect(observed).toMatchObject({ disposition: 'rejected', reason: 'approval_required' });
  const mapper = new IdentityMapper(env.DB_CONTROL);
  await mapper.bind('user:delivery-author', ['human'], NOW);
  await mapper.bindChannelIdentity(
    `github:${REPOSITORY}`,
    'delivery-author',
    'user:delivery-author',
    NOW,
  );
}

function approvalInput(
  externalSubject: string,
  externalEventId: string,
): Record<string, unknown> {
  return {
    runId: RUN_ID,
    expectedRunVersion: 10,
    planVersion: 1,
    effect: 'merge',
    decision: 'approve',
    expiresAt: '2026-07-27T02:59:00.000Z',
    source: {
      schemaVersion: '1',
      provider: 'feishu',
      tenantKey: 'tenant-merge-gate',
      externalEventId,
      externalSubject,
      eventDigest: `sha256:${'f'.repeat(64)}`,
      occurredAt: '2026-07-26T02:59:00.000Z',
    },
  };
}

describe('identity-bound high-risk approval', () => {
  it('creates one GitHub event → control approval lineage under 20 concurrent decisions', async () => {
    await prepareIdentityApprovalSource();
    const mapper = new IdentityMapper(env.DB_CONTROL);
    await mapper.bind('user:github-merge-reviewer', ['approve:merge', 'human'], NOW);
    await mapper.bindChannelIdentity(
      `github:${REPOSITORY}`,
      'merge-reviewer',
      'user:github-merge-reviewer',
      NOW,
    );
    const input = {
      ...approvalInput('merge-reviewer', 'event-github-merge-approved'),
      source: {
        schemaVersion: '1',
        provider: 'github',
        tenantKey: REPOSITORY,
        externalEventId: 'event-github-merge-approved',
        externalSubject: 'merge-reviewer',
        eventDigest: `sha256:${'e'.repeat(64)}`,
        occurredAt: '2026-07-26T02:59:00.000Z',
      },
    };
    const store = new IdentityBoundApprovalStore(env.DB_CONTROL, { now: () => new Date(NOW) });
    const results = await Promise.all(Array.from({ length: 20 }, () => store.decide(input)));
    expect(results.filter((result) => result.status === 'accepted' && result.created)).toHaveLength(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT provider, tenant_key, external_event_id, approver_principal,
              task_id, task_revision, plan_id, plan_version, plan_digest,
              base_sha, effect, decision, source_occurred_at, decision_recorded_at
       FROM approval_lineages WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({
      provider: 'github',
      tenant_key: REPOSITORY,
      external_event_id: 'event-github-merge-approved',
      approver_principal: 'user:github-merge-reviewer',
      task_id: TASK_ID,
      task_revision: 'revision-1',
      plan_id: PLAN_ID,
      plan_version: 1,
      plan_digest: PLAN_DIGEST,
      base_sha: BASE_SHA,
      effect: 'merge',
      decision: 'approve',
      source_occurred_at: '2026-07-26T02:59:00.000Z',
      decision_recorded_at: NOW,
    });
    await expect(env.DB_CONTROL.prepare(
      `UPDATE approval_lineages SET base_sha = ? WHERE run_id = ?`,
    ).bind('0'.repeat(40), RUN_ID).run()).rejects.toThrow(
      'approval_lineage_is_immutable',
    );
  });

  it('accepts only the approval adapter credential and a strict identity-fact body', async () => {
    await prepareIdentityApprovalSource();
    const { runId: _runId, ...fixedBody } = approvalInput(
      'ou_merge_reviewer',
      'event-approval-api',
    );
    void _runId;
    const occurredAt = new Date();
    const body = {
      ...fixedBody,
      expiresAt: new Date(occurredAt.getTime() + 60 * 60_000).toISOString(),
      source: {
        ...fixedBody.source as Record<string, unknown>,
        occurredAt: occurredAt.toISOString(),
      },
    };
    const request = async (token: string, payload: unknown): Promise<Response> =>
      await SELF.fetch(`https://delivery-loop.test/v1/runs/${RUN_ID}/approvals`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

    expect((await request(env.TASK_INTAKE_TOKEN, body)).status).toBe(401);
    expect((await request(env.APPROVAL_ADAPTER_TOKEN, {
      ...body,
      actorId: 'user:forged',
    })).status).toBe(400);
    const accepted = await request(env.APPROVAL_ADAPTER_TOKEN, body);
    expect(accepted.status).toBe(201);
    await expect(accepted.json()).resolves.toMatchObject({
      status: 'accepted',
      principal: 'user:merge-reviewer',
      created: true,
    });
    const replayed = await request(env.APPROVAL_ADAPTER_TOKEN, body);
    expect(replayed.status).toBe(200);
    await expect(replayed.json()).resolves.toMatchObject({
      status: 'accepted',
      principal: 'user:merge-reviewer',
      created: false,
    });
    expect((await request(env.APPROVAL_ADAPTER_TOKEN, {
      ...body,
      decision: 'reject',
    })).status).toBe(409);
  });

  it('maps Feishu to a human principal, converges 20 decisions, and unlocks merge eligibility', async () => {
    await prepareIdentityApprovalSource();
    const mapper = new IdentityMapper(env.DB_CONTROL);
    await mapper.bind('user:merge-reviewer', ['approve:merge', 'human'], NOW);
    await mapper.bindChannelIdentity(
      'feishu:tenant-merge-gate',
      'ou_merge_reviewer',
      'user:merge-reviewer',
      NOW,
    );
    const store = new IdentityBoundApprovalStore(env.DB_CONTROL, { now: () => new Date(NOW) });
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      store.decide(approvalInput('ou_merge_reviewer', 'event-merge-approved'))));
    expect(results.filter((result) => result.status === 'accepted' && result.created)).toHaveLength(1);
    expect(results.every((result) => result.status === 'accepted')).toBe(true);
    expect(await env.DB_CONTROL.prepare(
      `SELECT approvals.actor_id, approvals.effect, approvals.decision,
              identity_bound_approvals.approver_principal,
              identity_bound_approvals.pull_request_author_principal
       FROM approvals
       JOIN identity_bound_approvals
         ON identity_bound_approvals.approval_id = approvals.approval_id
       WHERE approvals.effect = 'merge'`,
    ).first()).toEqual({
      actor_id: 'user:merge-reviewer',
      effect: 'merge',
      decision: 'approve',
      approver_principal: 'user:merge-reviewer',
      pull_request_author_principal: 'user:delivery-author',
    });
    const eligible = await new GitHubMergeGateReconciler(env.DB_CONTROL, new FakeClient(), {
      now: () => new Date(NOW),
    }).reconcileRun(RUN_ID);
    expect(eligible.disposition).toBe('ready_to_merge');
  });

  it('rejects cross-provider self approval when Feishu and GitHub resolve to one principal', async () => {
    await prepareIdentityApprovalSource();
    const mapper = new IdentityMapper(env.DB_CONTROL);
    await mapper.bind('user:delivery-author', ['approve:merge', 'human'], NOW);
    await mapper.bindChannelIdentity(
      'feishu:tenant-merge-gate',
      'ou_delivery_author',
      'user:delivery-author',
      NOW,
    );
    const result = await new IdentityBoundApprovalStore(
      env.DB_CONTROL,
      { now: () => new Date(NOW) },
    ).decide(approvalInput('ou_delivery_author', 'event-self-approval'));
    expect(result).toMatchObject({ status: 'rejected', reason: 'self_approval_denied' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM approvals WHERE effect = 'merge'`,
    ).first()).toEqual({ count: 0 });
  });

  it('requires an exact merge ledger before evaluating a production approval', async () => {
    await prepareIdentityApprovalSource();
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE runs SET state = 'deploying' WHERE run_id = ? AND version = 10`,
      ).bind(RUN_ID),
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_item_effects (plan_id, item_id, effect)
         VALUES (?, ?, 'production_deploy')`,
      ).bind(PLAN_ID, ITEM_ID),
    ]);
    const mapper = new IdentityMapper(env.DB_CONTROL);
    await mapper.bind(
      'user:delivery-author',
      ['approve:production_deploy', 'human'],
      NOW,
    );
    await mapper.bindChannelIdentity(
      'feishu:tenant-merge-gate',
      'ou_delivery_author',
      'user:delivery-author',
      NOW,
    );
    await expect(new IdentityBoundApprovalStore(
      env.DB_CONTROL,
      { now: () => new Date(NOW) },
    ).decide({
      ...approvalInput('ou_delivery_author', 'event-production-self-approval'),
      effect: 'production_deploy',
    })).rejects.toMatchObject({ code: 'state_conflict' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM approvals WHERE effect = 'production_deploy'`,
    ).first()).toEqual({ count: 0 });
  });

  it.each([
    ['agent:codex', ['approve:merge'], 'actor_not_human'],
    ['user:no-role', ['human'], 'actor_not_authorized'],
  ] as const)('rejects principal %s with %s', async (principal, roles, reason) => {
    await prepareIdentityApprovalSource();
    const mapper = new IdentityMapper(env.DB_CONTROL);
    await mapper.bind(principal, [...roles], NOW);
    await mapper.bindChannelIdentity(
      'feishu:tenant-merge-gate',
      'ou_untrusted_approver',
      principal,
      NOW,
    );
    const result = await new IdentityBoundApprovalStore(
      env.DB_CONTROL,
      { now: () => new Date(NOW) },
    ).decide(approvalInput('ou_untrusted_approver', `event-${principal}`));
    expect(result).toMatchObject({ status: 'rejected', reason });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM approvals WHERE effect = 'merge'`,
    ).first()).toEqual({ count: 0 });
  });

  it('rejects an unmapped channel subject and caller-supplied actor fields', async () => {
    await prepareIdentityApprovalSource();
    const store = new IdentityBoundApprovalStore(env.DB_CONTROL, { now: () => new Date(NOW) });
    await expect(store.decide({
      ...approvalInput('ou_unknown', 'event-unmapped'),
      actorId: 'user:forged',
    })).rejects.toMatchObject({ code: 'invalid_request' });
    const result = await store.decide(approvalInput('ou_unknown', 'event-unmapped'));
    expect(result).toMatchObject({ status: 'rejected', reason: 'identity_unresolved' });
  });

  it('revokes effect eligibility when the mapped principal loses its live approval role', async () => {
    await prepareIdentityApprovalSource();
    const mapper = new IdentityMapper(env.DB_CONTROL);
    await mapper.bind('user:merge-reviewer', ['approve:merge', 'human'], NOW);
    await mapper.bindChannelIdentity(
      'feishu:tenant-merge-gate',
      'ou_merge_reviewer',
      'user:merge-reviewer',
      NOW,
    );
    const store = new IdentityBoundApprovalStore(env.DB_CONTROL, { now: () => new Date(NOW) });
    expect(await store.decide(
      approvalInput('ou_merge_reviewer', 'event-role-revocation'),
    )).toMatchObject({ status: 'accepted' });
    await mapper.bind('user:merge-reviewer', ['human'], '2026-07-26T03:00:01.000Z');
    const result = await new GitHubMergeGateReconciler(env.DB_CONTROL, new FakeClient(), {
      now: () => new Date('2026-07-26T03:00:02.000Z'),
    }).reconcileRun(RUN_ID);
    expect(result).toMatchObject({
      disposition: 'rejected',
      reason: 'approval_identity_unresolved',
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'pull_request_open', version: 10 });
  });
});

describe('signed GitHub merge fact projection', () => {
  it('has a production projector separate from merge eligibility', () => {
    expect(new GitHubMergeStatusStore(env.DB_CONTROL)).toBeInstanceOf(
      GitHubMergeStatusStore,
    );
  });

  it('does not accept a merge fact before the exact ready-to-merge decision exists', async () => {
    const observed = mergeFact();
    await expect(new GitHubMergeStatusStore(env.DB_CONTROL).applyApiObservation({
      observationId: 'merge_api_before_gate',
      factDigest: await canonicalSha256(observed),
      fact: observed,
      observedAt: observed.externalUpdatedAt,
    })).resolves.toBe('ignored');
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM github_merges',
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'pull_request_open', version: 10 });
  });

  it('converges 20 signed/API facts to one merge SHA for no-deploy policy', async () => {
    await readyToMerge();
    const observed = mergeFact();
    const factDigest = await canonicalSha256(observed);
    const store = new GitHubMergeStatusStore(env.DB_CONTROL);
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      store.applyApiObservation({
        observationId: 'merge_api_parallel',
        factDigest,
        fact: observed,
        observedAt: observed.externalUpdatedAt,
      })));
    expect(results.every((result) => result === 'applied' || result === 'duplicate')).toBe(true);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM github_merges WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT state, version FROM runs WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ state: 'succeeded', version: 13 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT merge_sha, deployment_disposition FROM github_merges WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({
      merge_sha: MERGE_SHA,
      deployment_disposition: 'none',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM evidence
       WHERE run_id = ? AND sha = ? AND artifact_digest = ?
         AND status = 'passed' AND verification_status = 'verified'`,
    ).bind(RUN_ID, MERGE_SHA, factDigest).first()).toEqual({ count: 1 });
    expect(await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus(RUN_ID)).toMatchObject({
      run: {
        state: 'succeeded',
        merge: {
          pullRequestNumber: 7,
          headSha: HEAD_SHA,
          mergeSha: MERGE_SHA,
          deploymentDisposition: 'none',
        },
      },
    });
  });

  it('closes a test lane after its required deployment/acceptance Items passed before merge', async () => {
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE tasks SET target_environment = 'test', allow_test_deploy = 1
         WHERE task_id = ?`,
      ).bind(TASK_ID),
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_item_effects (plan_id, item_id, effect)
         VALUES (?, ?, 'test_deploy')`,
      ).bind(PLAN_ID, ITEM_ID),
    ]);
    await readyToMerge();
    const observed = mergeFact();
    await expect(new GitHubMergeStatusStore(env.DB_CONTROL).applyApiObservation({
      observationId: 'merge_api_test_deploy',
      factDigest: await canonicalSha256(observed),
      fact: observed,
      observedAt: observed.externalUpdatedAt,
    })).resolves.toBe('applied');
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'succeeded', version: 13 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT deployment_disposition FROM github_merges WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ deployment_disposition: 'test' });
  });

  it('rejects stale head facts and inconsistent no-deploy policy without a merge projection', async () => {
    await readyToMerge();
    const stale = mergeFact({ headSha: 'e'.repeat(40) });
    await expect(new GitHubMergeStatusStore(env.DB_CONTROL).applyApiObservation({
      observationId: 'merge_api_stale_head',
      factDigest: await canonicalSha256(stale),
      fact: stale,
      observedAt: stale.externalUpdatedAt,
    })).resolves.toBe('ignored');
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM github_merges',
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'ready_to_merge' });

    await env.DB_CONTROL.prepare(
      `UPDATE tasks SET allow_test_deploy = 1 WHERE task_id = ?`,
    ).bind(TASK_ID).run();
    const observed = mergeFact();
    await expect(new GitHubMergeStatusStore(env.DB_CONTROL).applyApiObservation({
      observationId: 'merge_api_invalid_policy',
      factDigest: await canonicalSha256(observed),
      fact: observed,
      observedAt: observed.externalUpdatedAt,
    })).resolves.toBe('ignored');
    expect(await env.DB_CONTROL.prepare(
      `SELECT ignore_reason FROM github_merge_observations
       WHERE observation_id = 'merge_api_invalid_policy'`,
    ).first()).toEqual({ ignore_reason: 'deployment_policy_invalid' });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'ready_to_merge' });
  });

  it('projects a signed merged webhook, strips raw canary data, and converges with API replay', async () => {
    await readyToMerge();
    const rawCanary = 'CANARY_GITHUB_MERGE_WEBHOOK_RAW';
    const payload = {
      action: 'closed',
      number: 7,
      pull_request: {
        html_url: `https://github.test/example/delivery-target/pull/7?token=${rawCanary}#raw`,
        state: 'closed',
        merged: true,
        merge_commit_sha: MERGE_SHA,
        merged_at: '2026-07-26T03:01:00.000Z',
        merged_by: { login: 'merge-reviewer' },
        head: { ref: BRANCH, sha: HEAD_SHA, repo: { full_name: REPOSITORY } },
        base: { ref: 'main', sha: BASE_SHA, repo: { full_name: REPOSITORY } },
        updated_at: '2026-07-26T03:01:01.000Z',
        untrusted: rawCanary,
      },
      repository: { full_name: REPOSITORY },
    };
    const body = JSON.stringify(payload);
    const response = await SELF.fetch('https://delivery-loop.test/v1/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': '12345678-1234-1234-1234-1234567890ae',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': await webhookSignature(body),
      },
      body,
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      disposition: 'applied',
    });
    const observed = mergeFact({
      externalUpdatedAt: '2026-07-26T03:02:00.000Z',
    });
    await expect(new GitHubMergeStatusStore(env.DB_CONTROL).applyApiObservation({
      observationId: 'merge_api_after_webhook',
      factDigest: await canonicalSha256(observed),
      fact: observed,
      observedAt: '2026-07-26T03:01:02.000Z',
    })).resolves.toBe('applied');
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM github_merges',
    ).first()).toEqual({ count: 1 });
    const observations = await env.DB_CONTROL.prepare(
      `SELECT observation_id, source_kind, fact_digest, processing_state,
              merge_id, ignore_reason FROM github_merge_observations
       ORDER BY source_kind`,
    ).all<Record<string, unknown>>();
    expect(observations.results).toHaveLength(2);
    expect(JSON.stringify(observations.results)).not.toContain(rawCanary);
    expect(JSON.stringify(await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus(RUN_ID)))
      .not.toContain(rawCanary);
  });

  it('repairs a missed webhook through read-only API reconciliation and leaves unmerged PRs pending', async () => {
    await readyToMerge();
    const getMergeStatus = vi.fn(async () => mergeFact());
    const reconciler = new GitHubMergeStatusReconciler(
      env.DB_CONTROL,
      { getMergeStatus },
      () => new Date('2026-07-26T03:01:02.000Z'),
    );
    await expect(reconciler.reconcileRun(RUN_ID)).resolves.toBe('applied');
    expect(getMergeStatus).toHaveBeenCalledOnce();

    await reset();
    await seed();
    await readyToMerge();
    const pending = new GitHubMergeStatusReconciler(env.DB_CONTROL, {
      async getMergeStatus() {
        return null;
      },
    });
    await expect(pending.reconcileRun(RUN_ID)).resolves.toBe('pending');
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM github_merge_observations',
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'ready_to_merge' });
  });

  it('ignores a signed closed-but-unmerged pull request', async () => {
    await readyToMerge();
    const body = JSON.stringify({
      action: 'closed',
      pull_request: { merged: false },
      repository: { full_name: REPOSITORY },
    });
    const response = await SELF.fetch('https://delivery-loop.test/v1/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': '12345678-1234-1234-1234-1234567890af',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': await webhookSignature(body),
      },
      body,
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      disposition: 'ignored',
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM github_merges',
    ).first()).toEqual({ count: 0 });
  });
});
