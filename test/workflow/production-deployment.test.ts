/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { importJWK, SignJWT, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityMapper } from '../../src/auth/identity-mapper.js';
import { canonicalSha256, sha256Bytes } from '../../src/domain/digest.js';
import type { ProductionDeploymentTarget } from '../../src/domain/production-deployment.js';
import type { GitHubProductionDeploymentStatusFact } from '../../src/domain/production-deployment-status.js';
import {
  ProductionDeploymentOutboxProcessor,
  type GitHubProductionDeploymentRequest,
} from '../../src/outbox/github-production-deployment.js';
import {
  IdentityBoundApprovalError,
  IdentityBoundApprovalStore,
} from '../../src/storage/identity-bound-approval-store.js';
import { ProductionDeploymentOidcStore } from '../../src/storage/production-deployment-oidc-store.js';
import { GitHubProductionDeploymentStatusStore } from '../../src/storage/github-production-deployment-status-store.js';
import {
  GitHubProductionDeploymentStatusReconciler,
} from '../../src/reconciliation/github-production-deployment-status-reconciler.js';
import {
  ProductionDeploymentStore,
  ProductionDeploymentStoreError,
} from '../../src/storage/production-deployment-store.js';
import { CorrelationQueryStore } from '../../src/storage/correlation-query-store.js';
import { TaskQueryStore } from '../../src/storage/task-query-store.js';

const NOW = new Date(Date.now() - 5 * 60_000);
const RUN_ID = 'run-production-deployment';
const TASK_ID = 'task-production-deployment';
const PLAN_ID = 'plan-production-deployment';
const ITEM_ID = 'release-production';
const REPOSITORY = 'example/repo';
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);
const PLAN_DIGEST = `sha256:${'d'.repeat(64)}`;
const TASK_DIGEST = `sha256:${'e'.repeat(64)}`;
const MERGE_ID = 'github-merge-production';
const TARGET: ProductionDeploymentTarget = {
  repository: REPOSITORY,
  environment: 'production',
  workflowPath: '.github/workflows/delivery-production-deploy.yml',
  oidcAudience: 'delivery-loop-production-deploy',
  roleRef: 'production:delivery-loop-deployer',
};
let oidcPrivateKey: Awaited<ReturnType<typeof importJWK>>;

beforeAll(async () => {
  oidcPrivateKey = await importJWK(
    JSON.parse(env.TEST_GITHUB_OIDC_PRIVATE_JWK) as JWK,
    'RS256',
  );
});

async function oidcToken(
  overrides: Record<string, unknown> = {},
  audience = 'delivery-loop-production-deploy',
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const environment = String(overrides.environment ?? 'production');
  return await new SignJWT({
    repository: REPOSITORY,
    job_workflow_ref:
      `${REPOSITORY}/.github/workflows/delivery-production-deploy.yml@refs/heads/main`,
    sha: MERGE_SHA,
    run_id: '9902',
    environment,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'delivery-loop-test-github-oidc' })
    .setIssuer('https://token.actions.githubusercontent.com')
    .setAudience(audience)
    .setSubject(String(
      overrides.sub ?? `repo:${REPOSITORY}:environment:${environment}`,
    ))
    .setJti(crypto.randomUUID())
    .setIssuedAt(now)
    .setNotBefore(now - 5)
    .setExpirationTime(now + 300)
    .sign(oidcPrivateKey);
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM production_deployment_status_observations'),
    env.DB_CONTROL.prepare('DELETE FROM production_deployment_oidc_attestations'),
    env.DB_CONTROL.prepare('DELETE FROM production_deployments'),
    env.DB_CONTROL.prepare('DELETE FROM production_release_approval_bindings'),
    env.DB_CONTROL.prepare('DELETE FROM identity_bound_approvals'),
    env.DB_CONTROL.prepare('DELETE FROM approval_identity_rejections'),
    env.DB_CONTROL.prepare('DELETE FROM approval_source_events'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM github_merge_observations'),
    env.DB_CONTROL.prepare('DELETE FROM github_merges'),
    env.DB_CONTROL.prepare('DELETE FROM merge_gate_decisions'),
    env.DB_CONTROL.prepare('DELETE FROM merge_gate_evaluations'),
    env.DB_CONTROL.prepare('DELETE FROM github_merge_gate_required_checks'),
    env.DB_CONTROL.prepare('DELETE FROM github_merge_gate_observations'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_publications'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_draft_unfinished_items'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_draft_evidence'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_draft_criteria'),
    env.DB_CONTROL.prepare('DELETE FROM pull_request_drafts'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_head_updates'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM channel_identities'),
    env.DB_CONTROL.prepare('DELETE FROM identity_mappings'),
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
}

async function seed(includeMerge = true): Promise<void> {
  const now = NOW.toISOString();
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'manual', 'production', 'production', 'revision-production', ?,
                 'r2://tasks/production.json', 'user', 'user:requester', ?, 'main',
                 'production', 'requirement', 'Release exact merge', 'p1',
                 1, 1, 0, 1, 1, ?, ?)`,
    ).bind(TASK_ID, TASK_DIGEST, REPOSITORY, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, ?, 'revision-production', ?, ?, ?, 'deploying', 13,
                 ?, 1, ?, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, TASK_DIGEST, BASE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, head_sha,
         repository, version, lease_generation, created_at, updated_at
       ) VALUES ('attempt-analysis-production', ?, 1, 'analysis', 'completed', ?, NULL,
                 ?, 1, 1, ?, ?)`,
    ).bind(RUN_ID, BASE_SHA, REPOSITORY, now, now),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, 'revision-production', ?, ?, 'active',
                 'attempt-analysis-production', 'Release through protected production.', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES (?, ?, 'delivery', 'Production release', 'Bind merge and approval.', 1, 0)`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (plan_id, item_id, status, version, updated_at)
       VALUES (?, ?, 'passed', 2, ?)`,
    ).bind(PLAN_ID, ITEM_ID, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, ?, 'merge'), (?, ?, 'production_deploy')`,
    ).bind(PLAN_ID, ITEM_ID, PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_done_when (plan_id, item_id, position, condition)
       VALUES (?, ?, 0, 'Verified PR gates passed before release.')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, head_sha,
         repository, plan_id, plan_version, plan_item_id,
         version, lease_generation, created_at, updated_at
       ) VALUES ('attempt-head-production', ?, 2, 'implement', 'completed', ?, ?, ?,
                 ?, 1, ?, 2, 1, ?, ?)`,
    ).bind(RUN_ID, BASE_SHA, HEAD_SHA, REPOSITORY, PLAN_ID, ITEM_ID, now, now),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, sha, summary, verification_status, observed_at, created_at
       ) VALUES ('evidence-head-production', ?, 'attempt-head-production', ?, 1, ?,
                 'commit', 'passed', ?, 'Verified head', 'verified', ?, ?)`,
    ).bind(RUN_ID, PLAN_ID, ITEM_ID, HEAD_SHA, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_head_updates (
         update_id, evidence_id, run_id, attempt_id, plan_id, plan_version,
         plan_item_id, lease_generation, parent_sha, head_sha, branch, created_at
       ) VALUES ('head-update-production', 'evidence-head-production', ?,
                 'attempt-head-production', ?, 1, ?, 1, ?, ?,
                 'delivery-loop/production', ?)`,
    ).bind(RUN_ID, PLAN_ID, ITEM_ID, BASE_SHA, HEAD_SHA, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO pull_request_drafts (
         draft_id, run_id, run_version, task_id, task_revision, task_digest,
         plan_id, plan_version, plan_digest, attempt_id, head_update_id,
         head_sha, branch, body, body_digest, status, created_at
       ) VALUES ('draft-production', ?, 9, ?, 'revision-production', ?, ?, 1, ?,
                 'attempt-head-production', 'head-update-production', ?,
                 'delivery-loop/production', 'Verified production change', ?,
                 'prepared', ?)`,
    ).bind(
      RUN_ID,
      TASK_ID,
      TASK_DIGEST,
      PLAN_ID,
      PLAN_DIGEST,
      HEAD_SHA,
      `sha256:${'f'.repeat(64)}`,
      now,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-publication-production', ?, 'revision-production', ?, 1, ?, ?,
                 'repo_write', 'user:publisher', 'approve', ?,
                 '2099-01-01T00:00:00.000Z', ?)`,
    ).bind(RUN_ID, PLAN_ID, PLAN_DIGEST, BASE_SHA, `sha256:${'1'.repeat(64)}`, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-merge-production', ?, 'revision-production', ?, 1, ?, ?,
                 'merge', 'user:merge-reviewer', 'approve', ?,
                 '2099-01-01T00:00:00.000Z', ?)`,
    ).bind(RUN_ID, PLAN_ID, PLAN_DIGEST, BASE_SHA, `sha256:${'2'.repeat(64)}`, now),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO pull_request_publications (
         publication_id, run_id, run_version, draft_id, approval_id, repository,
         base_branch, head_branch, head_sha, title, body_digest, status,
         github_pr_number, github_pr_url, github_external_updated_at,
         github_observation_version, created_at, updated_at
       ) VALUES ('publication-production', ?, 9, 'draft-production',
                 'approval-publication-production', ?, 'main',
                 'delivery-loop/production', ?, 'Verified production change', ?,
                 'verified', 42, 'https://github.com/example/repo/pull/42', ?, 1, ?, ?)`,
    ).bind(RUN_ID, REPOSITORY, HEAD_SHA, `sha256:${'f'.repeat(64)}`, now, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO github_merge_gate_observations (
         observation_id, run_id, run_version, publication_id, fact_digest,
         repository, github_pr_number, head_branch, head_sha, base_branch,
         base_sha, pull_request_base_sha, pull_request_state, is_draft,
         mergeability, merge_state, review_decision, required_approval_count,
         approved_review_count, required_check_count, passed_check_count,
         pending_check_count, failed_check_count, missing_check_count,
         policy_digest, checks_digest, reviews_digest, external_updated_at,
         observed_at, created_at, pull_request_author_login
       ) VALUES ('observation-production', ?, 10, 'publication-production', ?, ?, 42,
                 'delivery-loop/production', ?, 'main', ?, ?, 'open', 0,
                 'mergeable', 'clean', 'approved', 1, 1, 1, 1, 0, 0, 0,
                 ?, ?, ?, ?, ?, ?, 'delivery-author')`,
    ).bind(
      RUN_ID,
      `sha256:${'3'.repeat(64)}`,
      REPOSITORY,
      HEAD_SHA,
      BASE_SHA,
      BASE_SHA,
      `sha256:${'4'.repeat(64)}`,
      `sha256:${'5'.repeat(64)}`,
      `sha256:${'6'.repeat(64)}`,
      now,
      now,
      now,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO merge_gate_evaluations (
         evaluation_id, run_id, run_version, publication_id, observation_id,
         plan_id, plan_version, plan_digest, approval_id, status, created_at
       ) VALUES ('evaluation-production', ?, 10, 'publication-production',
                 'observation-production', ?, 1, ?, 'approval-merge-production',
                 'passed', ?)`,
    ).bind(RUN_ID, PLAN_ID, PLAN_DIGEST, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO merge_gate_decisions (
         decision_id, run_id, run_version, publication_id, observation_id,
         evaluation_id, plan_id, plan_version, plan_digest, approval_id,
         head_sha, base_sha, status, created_at
       ) VALUES ('decision-production', ?, 10, 'publication-production',
                 'observation-production', 'evaluation-production', ?, 1, ?,
                 'approval-merge-production', ?, ?, 'passed', ?)`,
    ).bind(RUN_ID, PLAN_ID, PLAN_DIGEST, HEAD_SHA, BASE_SHA, now),
  ]);
  if (includeMerge) {
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO evidence (
           evidence_id, run_id, plan_id, plan_version, kind, status, sha,
           external_url, artifact_digest, summary, verification_status,
           observed_at, created_at
         ) VALUES ('evidence-merge-production', ?, ?, 1, 'pull_request', 'passed', ?,
                   'https://github.com/example/repo/pull/42', ?,
                   'Signed GitHub pull request merge', 'verified', ?, ?)`,
      ).bind(RUN_ID, PLAN_ID, MERGE_SHA, `sha256:${'7'.repeat(64)}`, now, now),
      env.DB_CONTROL.prepare(
        `INSERT INTO github_merges (
           merge_id, run_id, run_version, decision_id, publication_id,
           plan_id, plan_version, plan_digest, repository, github_pr_number,
           head_branch, head_sha, base_branch, base_sha, merge_sha,
           merged_by_login, merged_at, external_updated_at,
           deployment_disposition, evidence_id, created_at
         ) VALUES (?, ?, 11, 'decision-production', 'publication-production',
                   ?, 1, ?, ?, 42, 'delivery-loop/production', ?, 'main', ?, ?,
                   'merge-reviewer', ?, ?, 'production',
                   'evidence-merge-production', ?)`,
      ).bind(
        MERGE_ID,
        RUN_ID,
        PLAN_ID,
        PLAN_DIGEST,
        REPOSITORY,
        HEAD_SHA,
        BASE_SHA,
        MERGE_SHA,
        now,
        now,
        now,
      ),
    ]);
  }
  const mapper = new IdentityMapper(env.DB_CONTROL);
  await mapper.bind('user:delivery-author', ['human'], now);
  await mapper.bindChannelIdentity(
    `github:${REPOSITORY}`,
    'delivery-author',
    'user:delivery-author',
    now,
  );
  await mapper.bind(
    'user:production-reviewer',
    ['approve:production_deploy', 'human'],
    now,
  );
  await mapper.bindChannelIdentity(
    'feishu:tenant-production',
    'ou_production_reviewer',
    'user:production-reviewer',
    now,
  );
}

function approvalInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: RUN_ID,
    expectedRunVersion: 13,
    planVersion: 1,
    effect: 'production_deploy',
    decision: 'approve',
    expiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    source: {
      schemaVersion: '1',
      provider: 'feishu',
      tenantKey: 'tenant-production',
      externalEventId: 'event-production-approval',
      externalSubject: 'ou_production_reviewer',
      eventDigest: `sha256:${'8'.repeat(64)}`,
      occurredAt: NOW.toISOString(),
    },
    ...overrides,
  };
}

async function approve(): Promise<string> {
  const result = await new IdentityBoundApprovalStore(
    env.DB_CONTROL,
    { now: () => NOW },
  ).decide(approvalInput());
  if (result.status !== 'accepted') throw new Error('production approval was rejected');
  return result.approvalId;
}

function scheduleInput(): Record<string, unknown> {
  return { runId: RUN_ID, expectedRunVersion: 13, planVersion: 1 };
}

async function scheduleAndCreate(githubDeploymentId = '8801'): Promise<{
  deploymentId: string;
  attemptId: string;
  outboxId: string;
}> {
  await approve();
  const scheduled = await new ProductionDeploymentStore(env.DB_CONTROL).schedule(
    scheduleInput(),
    TARGET,
    NOW,
  );
  await new ProductionDeploymentOutboxProcessor(
    env.DB_CONTROL,
    {
      ensureProductionDeployment: async () => ({
        disposition: 'created',
        githubDeploymentId,
      }),
    },
    { now: () => NOW, generateLeaseToken: () => 'production-status-outbox-lease' },
  ).deliver(scheduled.outboxId);
  return {
    deploymentId: scheduled.deploymentId,
    attemptId: scheduled.attemptId,
    outboxId: scheduled.outboxId,
  };
}

function statusFact(
  deploymentId: string,
  state: GitHubProductionDeploymentStatusFact['state'],
  externalUpdatedAt = new Date(NOW.getTime() + 60_000).toISOString(),
  overrides: Partial<GitHubProductionDeploymentStatusFact> = {},
): GitHubProductionDeploymentStatusFact {
  return {
    schemaVersion: '1',
    repository: REPOSITORY,
    githubDeploymentId: '8801',
    deploymentId,
    sha: MERGE_SHA,
    task: 'delivery-loop:production',
    environment: 'production',
    state,
    environmentUrl: 'https://production.example.test/app',
    externalUpdatedAt,
    ...overrides,
  };
}

async function webhookSignature(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('test-github-webhook-secret'),
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

beforeEach(async () => {
  await reset();
  await seed();
});

describe('production deployment approval binding', () => {
  it('binds external reviewer approval to revision, immutable merge SHA, and production', async () => {
    const approvalId = await approve();
    expect(await env.DB_CONTROL.prepare(
      `SELECT release.task_revision, release.merge_id, release.merge_sha,
              release.environment, approvals.effect
       FROM production_release_approval_bindings AS release
       JOIN trusted_effect_approvals AS approvals
         ON approvals.approval_id = release.approval_id
       WHERE release.approval_id = ?`,
    ).bind(approvalId).first()).toEqual({
      task_revision: 'revision-production',
      merge_id: MERGE_ID,
      merge_sha: MERGE_SHA,
      environment: 'production',
      effect: 'production_deploy',
    });
    await expect(new IdentityBoundApprovalStore(
      env.DB_CONTROL,
      { now: () => NOW },
    ).decide(approvalInput({
      source: {
        ...(approvalInput().source as Record<string, unknown>),
        externalEventId: 'event-caller-merge-sha',
      },
      mergeSha: 'f'.repeat(40),
    }))).rejects.toMatchObject({
      name: IdentityBoundApprovalError.name,
      code: 'invalid_request',
    });
  });

  it('rejects the PR author approving production through another provider', async () => {
    const mapper = new IdentityMapper(env.DB_CONTROL);
    await mapper.bind(
      'user:delivery-author',
      ['approve:production_deploy', 'human'],
      NOW.toISOString(),
    );
    await mapper.bindChannelIdentity(
      'feishu:tenant-production',
      'ou_delivery_author',
      'user:delivery-author',
      NOW.toISOString(),
    );
    const input = approvalInput({
      source: {
        ...(approvalInput().source as Record<string, unknown>),
        externalEventId: 'event-production-self-approval',
        externalSubject: 'ou_delivery_author',
      },
    });
    await expect(new IdentityBoundApprovalStore(
      env.DB_CONTROL,
      { now: () => NOW },
    ).decide(input)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'self_approval_denied',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM approvals WHERE effect = 'production_deploy'`,
    ).first()).toEqual({ count: 0 });
  });

  it('creates zero production effect before an exact merge-bound approval', async () => {
    await expect(new ProductionDeploymentStore(env.DB_CONTROL).schedule(
      scheduleInput(),
      TARGET,
      NOW,
    )).rejects.toMatchObject({
      name: ProductionDeploymentStoreError.name,
      code: 'approval_required',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox
       WHERE destination = 'github_production_deployments'`,
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM production_deployments',
    ).first()).toEqual({ count: 0 });
  });

  it('rejects production approval when the external merge ledger is absent', async () => {
    await reset();
    await seed(false);
    await expect(new IdentityBoundApprovalStore(
      env.DB_CONTROL,
      { now: () => NOW },
    ).decide(approvalInput())).rejects.toMatchObject({
      name: IdentityBoundApprovalError.name,
      code: 'state_conflict',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM approvals WHERE effect = 'production_deploy'`,
    ).first()).toEqual({ count: 0 });
  });

  it('does not retroactively bind a decision that occurred before the merge', async () => {
    const source = approvalInput().source as Record<string, unknown>;
    await expect(new IdentityBoundApprovalStore(
      env.DB_CONTROL,
      { now: () => NOW },
    ).decide(approvalInput({
      source: {
        ...source,
        externalEventId: 'event-before-production-merge',
        occurredAt: new Date(NOW.getTime() - 1_000).toISOString(),
      },
    }))).rejects.toMatchObject({
      name: IdentityBoundApprovalError.name,
      code: 'state_conflict',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM approvals WHERE effect = 'production_deploy'`,
    ).first()).toEqual({ count: 0 });
  });

  it('converges 20 schedulers and deliveries to one exact-merge GitHub effect', async () => {
    const approvalId = await approve();
    const store = new ProductionDeploymentStore(env.DB_CONTROL);
    const scheduled = await Promise.all(
      Array.from({ length: 20 }, () => store.schedule(scheduleInput(), TARGET, NOW)),
    );
    expect(new Set(scheduled.map((result) => result.deploymentId))).toHaveLength(1);
    expect(scheduled.filter((result) => result.created)).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      approvalId,
      mergeId: MERGE_ID,
      mergeSha: MERGE_SHA,
      environment: 'production',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox
       WHERE run_id = ? AND destination = 'github_production_deployments'`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
    const ensure = vi.fn(async (request: GitHubProductionDeploymentRequest) => {
      expect(request).toEqual({
        deploymentId: scheduled[0]!.deploymentId,
        repository: REPOSITORY,
        mergeSha: MERGE_SHA,
        environment: 'production',
      });
      return { disposition: 'created' as const, githubDeploymentId: '8801' };
    });
    const processor = new ProductionDeploymentOutboxProcessor(
      env.DB_CONTROL,
      { ensureProductionDeployment: ensure },
      { now: () => NOW, generateLeaseToken: () => 'production-outbox-lease' },
    );
    const deliveries = await Promise.all(
      Array.from({ length: 20 }, () => processor.deliver(scheduled[0]!.outboxId)),
    );
    expect(deliveries.every((result) => result === 'settled' || result === 'busy')).toBe(true);
    expect(ensure).toHaveBeenCalledOnce();
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, merge_sha, environment, github_deployment_id, evidence_id
       FROM production_deployments WHERE deployment_id = ?`,
    ).bind(scheduled[0]!.deploymentId).first()).toEqual({
      status: 'created_unverified',
      merge_sha: MERGE_SHA,
      environment: 'production',
      github_deployment_id: '8801',
      evidence_id: null,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'deploying' });
    const projection = await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus(RUN_ID);
    expect(projection?.run).toMatchObject({
      productionDeployments: [{
        id: scheduled[0]!.deploymentId,
        approvalId,
        approverPrincipal: 'user:production-reviewer',
        taskRevision: 'revision-production',
        mergeId: MERGE_ID,
        mergeSha: MERGE_SHA,
        environment: 'production',
        status: 'created_unverified',
        githubDeploymentId: '8801',
      }],
    });
    expect(JSON.stringify(projection)).not.toMatch(/oidc_token_digest|RAW_PRODUCTION/);
  });

  it('rechecks live reviewer authorization before GitHub I/O', async () => {
    await approve();
    const scheduled = await new ProductionDeploymentStore(env.DB_CONTROL).schedule(
      scheduleInput(),
      TARGET,
      NOW,
    );
    await new IdentityMapper(env.DB_CONTROL).bind(
      'user:production-reviewer',
      ['human'],
      new Date(NOW.getTime() + 1_000).toISOString(),
    );
    const ensure = vi.fn(async () => ({
      disposition: 'created' as const,
      githubDeploymentId: '8801',
    }));
    const processor = new ProductionDeploymentOutboxProcessor(
      env.DB_CONTROL,
      { ensureProductionDeployment: ensure },
      { now: () => NOW, generateLeaseToken: () => 'production-stale-lease' },
    );
    await expect(processor.deliver(scheduled.outboxId)).resolves.toBe('retry');
    expect(ensure).not.toHaveBeenCalled();
  });

  it('attests only the production workflow subject and exact merge SHA', async () => {
    await approve();
    const scheduled = await new ProductionDeploymentStore(env.DB_CONTROL).schedule(
      scheduleInput(),
      TARGET,
      NOW,
    );
    await new ProductionDeploymentOutboxProcessor(
      env.DB_CONTROL,
      {
        ensureProductionDeployment: async () => ({
          disposition: 'created',
          githubDeploymentId: '8801',
        }),
      },
      { now: () => NOW, generateLeaseToken: () => 'production-oidc-lease' },
    ).deliver(scheduled.outboxId);
    const store = new ProductionDeploymentOidcStore(env.DB_CONTROL);
    await expect(store.attest(scheduled.deploymentId, 'RAW_PRODUCTION_OIDC', {
      repository: REPOSITORY,
      workflowRef:
        `${REPOSITORY}/.github/workflows/delivery-production-deploy.yml@refs/heads/main`,
      sha: HEAD_SHA,
      runId: '9901',
      subject: `repo:${REPOSITORY}:environment:production`,
      environment: 'production',
    }, NOW)).rejects.toMatchObject({ code: 'binding_mismatch' });
    await expect(store.attest(scheduled.deploymentId, 'RAW_PRODUCTION_OIDC', {
      repository: REPOSITORY,
      workflowRef:
        `${REPOSITORY}/.github/workflows/delivery-production-deploy.yml@refs/heads/main`,
      sha: MERGE_SHA,
      runId: '9901',
      subject: `repo:${REPOSITORY}:environment:production`,
      environment: 'production',
    }, NOW)).resolves.toMatchObject({ accepted: true, disposition: 'created' });
    const stored = await env.DB_CONTROL.prepare(
      `SELECT environment, audience, sha, oidc_token_digest
       FROM production_deployment_oidc_attestations`,
    ).first<Record<string, unknown>>();
    expect(stored).toMatchObject({
      environment: 'production',
      audience: 'delivery-loop-production-deploy',
      sha: MERGE_SHA,
    });
    expect(JSON.stringify(stored)).not.toContain('RAW_PRODUCTION_OIDC');
  });

  it('cryptographically rejects test audience/subject at the production endpoint', async () => {
    await approve();
    const scheduled = await new ProductionDeploymentStore(env.DB_CONTROL).schedule(
      scheduleInput(),
      TARGET,
      NOW,
    );
    await new ProductionDeploymentOutboxProcessor(
      env.DB_CONTROL,
      {
        ensureProductionDeployment: async () => ({
          disposition: 'created',
          githubDeploymentId: '8802',
        }),
      },
      { now: () => NOW, generateLeaseToken: () => 'production-http-oidc-lease' },
    ).deliver(scheduled.outboxId);
    const endpoint =
      `https://delivery-loop.test/v1/production-deployments/${scheduled.deploymentId}` +
      '/oidc-attestation';
    const invalid = [
      await oidcToken({}, 'delivery-loop-test-deploy'),
      await oidcToken({ environment: 'test', sub: `repo:${REPOSITORY}:environment:test` }),
      await oidcToken({ sha: HEAD_SHA }),
    ];
    const invalidResponses = await Promise.all(invalid.map(async (token) =>
      await SELF.fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })));
    expect(invalidResponses.map((response) => response.status)).toEqual([401, 403, 403]);
    const valid = await SELF.fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${await oidcToken()}` },
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({ accepted: true, disposition: 'created' });
  });
});

describe('production deployment platform status', () => {
  it('has a projector separate from the Runner status reporter', () => {
    expect(new GitHubProductionDeploymentStatusStore(env.DB_CONTROL)).toBeInstanceOf(
      GitHubProductionDeploymentStatusStore,
    );
  });

  it('keeps create, in-progress, OIDC, and final platform success as separate facts', async () => {
    const { deploymentId, attemptId } = await scheduleAndCreate();
    const inProgress = statusFact(deploymentId, 'in_progress');
    await expect(new GitHubProductionDeploymentStatusStore(env.DB_CONTROL).applyWebhook({
      deliveryId: '10000000-0000-0000-0000-000000000001',
      payloadDigest: `sha256:${'1'.repeat(64)}`,
      fact: inProgress,
      receivedAt: inProgress.externalUpdatedAt,
    })).resolves.toBe('applied');
    expect(await env.DB_CONTROL.prepare(
      'SELECT state FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'deploying' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM evidence
       WHERE run_id = ? AND kind = 'deployment'`,
    ).bind(RUN_ID).first()).toEqual({ count: 0 });

    await new ProductionDeploymentOidcStore(env.DB_CONTROL).attest(
      deploymentId,
      'PRODUCTION_STATUS_OIDC',
      {
        repository: REPOSITORY,
        workflowRef:
          `${REPOSITORY}/.github/workflows/delivery-production-deploy.yml@refs/heads/main`,
        sha: MERGE_SHA,
        runId: '9910',
        subject: `repo:${REPOSITORY}:environment:production`,
        environment: 'production',
      },
      NOW,
    );
    expect(await env.DB_CONTROL.prepare(
      'SELECT state FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'deploying' });

    const success = statusFact(
      deploymentId,
      'success',
      new Date(NOW.getTime() + 120_000).toISOString(),
    );
    const delivery = {
      deliveryId: '10000000-0000-0000-0000-000000000002',
      payloadDigest: `sha256:${'2'.repeat(64)}`,
      fact: success,
      receivedAt: success.externalUpdatedAt,
    };
    const store = new GitHubProductionDeploymentStatusStore(env.DB_CONTROL);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.applyWebhook(delivery)),
    );
    expect(results.every((result) => result === 'applied' || result === 'duplicate')).toBe(true);
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, external_state, external_url, evidence_id
       FROM production_deployments WHERE deployment_id = ?`,
    ).bind(deploymentId).first()).toMatchObject({
      status: 'succeeded',
      external_state: 'success',
      external_url: 'https://production.example.test/app',
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'succeeded', version: 14 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT status FROM execution_plans WHERE plan_id = ?',
    ).bind(PLAN_ID).first()).toEqual({ status: 'completed' });
    expect(await env.DB_CONTROL.prepare(
      'SELECT status FROM attempts WHERE attempt_id = ?',
    ).bind(attemptId).first()).toEqual({ status: 'completed' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM evidence
       WHERE run_id = ? AND kind = 'deployment' AND status = 'passed'
         AND verification_status = 'verified' AND sha = ?`,
    ).bind(RUN_ID, MERGE_SHA).first()).toEqual({ count: 1 });
    const projection = await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus(RUN_ID);
    expect(projection?.run).toMatchObject({
      state: 'succeeded',
      productionDeployments: [{
        id: deploymentId,
        status: 'succeeded',
        externalState: 'success',
        url: 'https://production.example.test/app',
      }],
    });
    await expect(new CorrelationQueryStore(env.DB_CONTROL).resolve({
      kind: 'github_deployment',
      id: '8801',
      repository: REPOSITORY,
    })).resolves.toMatchObject({
      correlationId: RUN_ID,
      deployments: [{ kind: 'production', id: deploymentId, status: 'succeeded' }],
      githubRuns: [{ kind: 'production_deployment', id: '9910', deploymentId }],
    });
  });

  it('holds a signed success in received until production OIDC exists', async () => {
    const { deploymentId } = await scheduleAndCreate();
    const success = statusFact(deploymentId, 'success');
    const delivery = {
      deliveryId: '10000000-0000-0000-0000-000000000003',
      payloadDigest: `sha256:${'3'.repeat(64)}`,
      fact: success,
      receivedAt: success.externalUpdatedAt,
    };
    const store = new GitHubProductionDeploymentStatusStore(env.DB_CONTROL);
    await expect(store.applyWebhook(delivery)).rejects.toMatchObject({
      code: 'attestation_required',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT processing_state FROM production_deployment_status_observations
       WHERE observation_id = ?`,
    ).bind(`webhook_${delivery.deliveryId}`).first()).toEqual({
      processing_state: 'received',
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'deploying' });
    await new ProductionDeploymentOidcStore(env.DB_CONTROL).attest(
      deploymentId,
      'PRODUCTION_STATUS_RETRY_OIDC',
      {
        repository: REPOSITORY,
        workflowRef:
          `${REPOSITORY}/.github/workflows/delivery-production-deploy.yml@refs/heads/main`,
        sha: MERGE_SHA,
        runId: '9911',
        subject: `repo:${REPOSITORY}:environment:production`,
        environment: 'production',
      },
      NOW,
    );
    await expect(store.applyWebhook(delivery)).resolves.toBe('applied');
  });

  it('projects platform failure without OIDC and never resurrects it with later success', async () => {
    const { deploymentId, attemptId } = await scheduleAndCreate();
    const failure = statusFact(deploymentId, 'failure');
    const store = new GitHubProductionDeploymentStatusStore(env.DB_CONTROL);
    await expect(store.applyApiObservation({
      observationId: 'production_api_failure_1',
      factDigest: await canonicalSha256(failure),
      fact: failure,
      observedAt: failure.externalUpdatedAt,
    })).resolves.toBe('applied');
    expect(await env.DB_CONTROL.prepare(
      'SELECT state, version FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'failed', version: 14 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT status FROM attempts WHERE attempt_id = ?',
    ).bind(attemptId).first()).toEqual({ status: 'failed' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, verification_status FROM evidence
       WHERE run_id = ? AND kind = 'deployment'`,
    ).bind(RUN_ID).first()).toEqual({ status: 'failed', verification_status: 'verified' });

    const lateSuccess = statusFact(
      deploymentId,
      'success',
      new Date(NOW.getTime() + 120_000).toISOString(),
    );
    await expect(store.applyApiObservation({
      observationId: 'production_api_late_success_1',
      factDigest: await canonicalSha256(lateSuccess),
      fact: lateSuccess,
      observedAt: lateSuccess.externalUpdatedAt,
    })).resolves.toBe('ignored');
    expect(await env.DB_CONTROL.prepare(
      'SELECT state FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'failed' });
  });

  it('ignores wrong binding and stale facts without changing deployment state', async () => {
    const { deploymentId } = await scheduleAndCreate();
    const store = new GitHubProductionDeploymentStatusStore(env.DB_CONTROL);
    const wrongSha = statusFact(deploymentId, 'success', undefined, { sha: HEAD_SHA });
    await expect(store.applyApiObservation({
      observationId: 'production_api_wrong_sha_1',
      factDigest: await canonicalSha256(wrongSha),
      fact: wrongSha,
      observedAt: wrongSha.externalUpdatedAt,
    })).resolves.toBe('ignored');
    const current = statusFact(
      deploymentId,
      'in_progress',
      new Date(NOW.getTime() + 120_000).toISOString(),
    );
    await store.applyApiObservation({
      observationId: 'production_api_progress_1',
      factDigest: await canonicalSha256(current),
      fact: current,
      observedAt: current.externalUpdatedAt,
    });
    const stale = statusFact(
      deploymentId,
      'failure',
      new Date(NOW.getTime() + 60_000).toISOString(),
    );
    await expect(store.applyApiObservation({
      observationId: 'production_api_stale_1',
      factDigest: await canonicalSha256(stale),
      fact: stale,
      observedAt: stale.externalUpdatedAt,
    })).resolves.toBe('ignored');
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, external_state FROM production_deployments
       WHERE deployment_id = ?`,
    ).bind(deploymentId).first()).toEqual({
      status: 'in_progress',
      external_state: 'in_progress',
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'deploying' });
  });

  it('uses the same projector for scheduled API reconciliation', async () => {
    const { deploymentId } = await scheduleAndCreate();
    await new ProductionDeploymentOidcStore(env.DB_CONTROL).attest(
      deploymentId,
      'PRODUCTION_API_RECONCILIATION_OIDC',
      {
        repository: REPOSITORY,
        workflowRef:
          `${REPOSITORY}/.github/workflows/delivery-production-deploy.yml@refs/heads/main`,
        sha: MERGE_SHA,
        runId: '9912',
        subject: `repo:${REPOSITORY}:environment:production`,
        environment: 'production',
      },
      NOW,
    );
    const fact = statusFact(deploymentId, 'success');
    const client = {
      getProductionDeploymentStatus: vi.fn(async () => fact),
    };
    const reconciler = new GitHubProductionDeploymentStatusReconciler(
      env.DB_CONTROL,
      client,
      () => new Date(fact.externalUpdatedAt),
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reconciler.reconcileDeployment(deploymentId)),
    );
    expect(results.some((result) => result === 'applied')).toBe(true);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM production_deployment_status_observations
       WHERE source_kind = 'api'`,
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'succeeded' });
  });

  it('converges concurrent webhook and API facts to one terminal Evidence', async () => {
    const { deploymentId } = await scheduleAndCreate();
    await new ProductionDeploymentOidcStore(env.DB_CONTROL).attest(
      deploymentId,
      'PRODUCTION_DUAL_SOURCE_OIDC',
      {
        repository: REPOSITORY,
        workflowRef:
          `${REPOSITORY}/.github/workflows/delivery-production-deploy.yml@refs/heads/main`,
        sha: MERGE_SHA,
        runId: '9914',
        subject: `repo:${REPOSITORY}:environment:production`,
        environment: 'production',
      },
      NOW,
    );
    const fact = statusFact(deploymentId, 'success');
    const store = new GitHubProductionDeploymentStatusStore(env.DB_CONTROL);
    const factDigest = await canonicalSha256(fact);
    const results = await Promise.all([
      ...Array.from({ length: 10 }, () => store.applyWebhook({
        deliveryId: '10000000-0000-0000-0000-000000000005',
        payloadDigest: `sha256:${'5'.repeat(64)}`,
        fact,
        receivedAt: fact.externalUpdatedAt,
      })),
      ...Array.from({ length: 10 }, () => store.applyApiObservation({
        observationId: 'production_api_dual_source_1',
        factDigest,
        fact,
        observedAt: fact.externalUpdatedAt,
      })),
    ]);
    expect(results.every((result) => result === 'applied' || result === 'duplicate')).toBe(true);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM production_deployment_status_observations
       WHERE deployment_id = ? AND processing_state = 'applied'`,
    ).bind(deploymentId).first()).toEqual({ count: 2 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM evidence
       WHERE run_id = ? AND kind = 'deployment' AND status = 'passed'`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
  });

  it('accepts signed production webhook, sanitizes URL, and retains no raw canary', async () => {
    const { deploymentId } = await scheduleAndCreate();
    await new ProductionDeploymentOidcStore(env.DB_CONTROL).attest(
      deploymentId,
      'PRODUCTION_WEBHOOK_OIDC',
      {
        repository: REPOSITORY,
        workflowRef:
          `${REPOSITORY}/.github/workflows/delivery-production-deploy.yml@refs/heads/main`,
        sha: MERGE_SHA,
        runId: '9913',
        subject: `repo:${REPOSITORY}:environment:production`,
        environment: 'production',
      },
      NOW,
    );
    const rawCanary = 'CANARY_PRODUCTION_DEPLOYMENT_RAW_PAYLOAD';
    const updatedAt = new Date(NOW.getTime() + 60_000).toISOString();
    const payload = {
      deployment_status: {
        state: 'success',
        environment: 'production',
        environment_url: `https://production.example.test/app?token=${rawCanary}#fragment`,
        updated_at: updatedAt,
      },
      deployment: {
        id: 8801,
        sha: MERGE_SHA,
        task: 'delivery-loop:production',
        environment: 'production',
        payload: {
          schema_version: '1',
          delivery_production_deployment_id: deploymentId,
        },
      },
      repository: { full_name: REPOSITORY },
      sender: { login: rawCanary },
    };
    const body = JSON.stringify(payload);
    const response = await SELF.fetch('https://delivery-loop.test/v1/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': '10000000-0000-0000-0000-000000000004',
        'x-github-event': 'deployment_status',
        'x-hub-signature-256': await webhookSignature(body),
      },
      body,
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, disposition: 'applied' });
    const stored = await env.DB_CONTROL.prepare(
      `SELECT deployments.external_url, observations.fact_digest,
              observations.processing_state
       FROM production_deployments AS deployments
       JOIN production_deployment_status_observations AS observations
         ON observations.deployment_id = deployments.deployment_id
       WHERE deployments.deployment_id = ?`,
    ).bind(deploymentId).first();
    expect(stored).toEqual({
      external_url: 'https://production.example.test/app',
      fact_digest: await sha256Bytes(new TextEncoder().encode(body)),
      processing_state: 'applied',
    });
    expect(JSON.stringify(stored)).not.toContain(rawCanary);
  });
});
