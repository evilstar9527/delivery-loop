/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { importJWK, SignJWT, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDeliveryPolicy } from '../../src/domain/delivery-policy.js';
import { canonicalSha256 } from '../../src/domain/digest.js';
import { testRollbackTargetFromPolicy } from '../../src/domain/test-rollback.js';
import { TestRollbackOutboxProcessor } from '../../src/outbox/github-test-rollback.js';
import {
  GitHubDeliveryPolicyError,
  TestRollbackReconciler,
} from '../../src/reconciliation/test-rollback-reconciler.js';
import { GitHubTestRollbackRunReconciler } from '../../src/reconciliation/github-test-rollback-run-reconciler.js';
import { GitHubTestRollbackStatusStore } from '../../src/storage/github-test-rollback-status-store.js';
import { Case8AuditReportStore } from '../../src/storage/case8-audit-report-store.js';
import { TaskQueryStore } from '../../src/storage/task-query-store.js';
import { TestRollbackRunnerStore } from '../../src/storage/test-rollback-runner-store.js';
import { TestRollbackStore } from '../../src/storage/test-rollback-store.js';

// Keep the fixed test window just behind wall clock so generated OIDC tokens and
// the 30-minute attempt lease remain valid when the suite is rerun later.
const NOW = new Date(Date.now() - 5 * 60_000);
const RUN_ID = 'run-test-rollback';
const PLAN_ID = 'plan-test-rollback';
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const PLAN_DIGEST = `sha256:${'c'.repeat(64)}`;
const BASE_URL = 'https://delivery-loop.test';
let oidcPrivateKey: Awaited<ReturnType<typeof importJWK>>;

beforeAll(async () => {
  oidcPrivateKey = await importJWK(
    JSON.parse(env.TEST_GITHUB_OIDC_PRIVATE_JWK) as JWK,
    'RS256',
  );
});

function policySource(options: {
  rollback?: boolean;
  triggers?: Array<'deployment_failure' | 'acceptance_failure'>;
} = {}): string {
  const triggers = options.triggers ?? ['deployment_failure', 'acceptance_failure'];
  return `schemaVersion: '1'
commands:
  setup:
    install: { argv: [pnpm, install], timeoutSeconds: 600 }
  targeted:
    unit: { argv: [pnpm, test], timeoutSeconds: 300 }
  verify:
    all: { argv: [pnpm, run, verify], timeoutSeconds: 1200 }
  acceptance:
    smoke: { argv: [pnpm, run, acceptance], timeoutSeconds: 300 }
protectedPaths: [delivery.yaml, .github/workflows/**, CODEOWNERS]
deployment:
  mode: github_actions
  test:
    workflowPath: .github/workflows/delivery-test-deploy.yml
    environment: test
    oidcAudience: delivery-loop-test-deploy
    roleRef: test:delivery-loop-deployer
    command: { argv: [pnpm, run, deploy:test], timeoutSeconds: 900 }
    verifyCommandRef: verify:all
    acceptanceCommandRef: acceptance:smoke
${options.rollback === false ? '' : `    rollback:
      workflowPath: .github/workflows/delivery-test-rollback.yml
      environment: test
      oidcAudience: delivery-loop-test-rollback
      roleRef: test:delivery-loop-rollback
      automaticOn: [${triggers.join(', ')}]
      command: { argv: [pnpm, run, rollback:test], timeoutSeconds: 600 }
`}`;
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM github_test_rollback_observations'),
    env.DB_CONTROL.prepare('DELETE FROM test_rollback_oidc_attestations'),
    env.DB_CONTROL.prepare('DELETE FROM test_rollbacks'),
    env.DB_CONTROL.prepare('DELETE FROM test_rollback_contract_observations'),
    env.DB_CONTROL.prepare('DELETE FROM github_test_acceptance_observations'),
    env.DB_CONTROL.prepare('DELETE FROM test_acceptance_oidc_attestations'),
    env.DB_CONTROL.prepare('DELETE FROM test_acceptances'),
    env.DB_CONTROL.prepare('DELETE FROM github_test_deployment_webhook_deliveries'),
    env.DB_CONTROL.prepare('DELETE FROM test_deployment_oidc_attestations'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_done_when_evidence'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_verifications'),
    env.DB_CONTROL.prepare('DELETE FROM test_deployments'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
    env.DB_CONTROL.prepare('DELETE FROM approval_invalidations'),
    env.DB_CONTROL.prepare('DELETE FROM identity_bound_approvals'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
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
}

async function seed(
  sourceKind: 'deployment_failure' | 'acceptance_failure' = 'deployment_failure',
  verified = true,
): Promise<void> {
  const now = NOW.toISOString();
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (
         'task-test-rollback', 'manual', 'rollback-test', 'rollback-test', 'rev-1',
         ?, 'r2://tasks/rollback-test', 'user', 'principal-requester',
         'example/repo', 'main', 'test', 'bug', 'Rollback failed test release',
         'p1', 1, 1, 1, 0, 1, ?, ?
       )`,
    ).bind(`sha256:${'d'.repeat(64)}`, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, 'task-test-rollback', 'rev-1', ?, ?, ?, 'executing', 5,
                 ?, 1, ?, ?, ?)`,
    ).bind(
      RUN_ID,
      `sha256:${'d'.repeat(64)}`,
      BASE_SHA,
      RUN_ID,
      PLAN_ID,
      PLAN_DIGEST,
      now,
      now,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES ('attempt-analysis-rollback', ?, 1, 'analysis', 'completed', ?,
                 'example/repo',
                 'example/repo/.github/workflows/delivery-agent.yml@refs/heads/main',
                 1, 0, ?, ?)`,
    ).bind(RUN_ID, BASE_SHA, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, 'rev-1', ?, ?, 'active', 'attempt-analysis-rollback',
                 'Deploy and verify the test revision.', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, now, now),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES (?, 'deploy-test', 'delivery', 'Deploy test', 'Deploy exact head.', 1, 0)`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (plan_id, item_id, status, version, updated_at)
       VALUES (?, 'deploy-test', ?, 2, ?)`,
    ).bind(PLAN_ID, sourceKind === 'deployment_failure' ? 'failed' : 'passed', now),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, head_sha,
         repository, workflow_ref, plan_id, plan_version, plan_item_id,
         claimed_progress_version, version, lease_generation, created_at, updated_at
       ) VALUES ('attempt-test-deploy-source', ?, 2, 'deploy', ?, ?, ?,
                 'example/repo',
                 'example/repo/.github/workflows/delivery-test-deploy.yml@refs/heads/main',
                 ?, 1, 'deploy-test', 1, 3, 2, ?, ?)`,
    ).bind(
      RUN_ID,
      sourceKind === 'deployment_failure' ? 'failed' : 'completed',
      BASE_SHA,
      HEAD_SHA,
      PLAN_ID,
      now,
      now,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-test-rollback-deploy', ?, 'rev-1', ?, 1, ?, ?,
                 'test_deploy', 'principal-approver', 'approve', ?, ?, ?)`,
    ).bind(
      RUN_ID,
      PLAN_ID,
      PLAN_DIGEST,
      BASE_SHA,
      `sha256:${'e'.repeat(64)}`,
      new Date(NOW.getTime() + 24 * 60 * 60_000).toISOString(),
      now,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, sha, external_url, summary, verification_status,
         observed_at, created_at
       ) VALUES ('evidence-test-deployment-source', ?, 'attempt-test-deploy-source',
                 ?, 1, 'deploy-test', 'deployment', ?, ?,
                 'https://test.example.test/app', 'Signed deployment fact',
                 ?, ?, ?)`,
    ).bind(
      RUN_ID,
      PLAN_ID,
      sourceKind === 'deployment_failure' ? 'failed' : 'passed',
      HEAD_SHA,
      verified ? 'verified' : 'unverified',
      now,
      now,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO test_deployments (
         deployment_id, run_id, run_version, plan_id, plan_version, plan_digest,
         plan_item_id, attempt_id, approval_id, repository, base_branch,
         base_sha, ref_sha, workflow_path, environment, oidc_audience, role_ref,
         status, github_deployment_id, external_state, external_url,
         external_updated_at, evidence_id, created_at, updated_at
       ) VALUES ('deployment-test-rollback-source', ?, 5, ?, 1, ?, 'deploy-test',
                 'attempt-test-deploy-source', 'approval-test-rollback-deploy',
                 'example/repo', 'main', ?, ?,
                 '.github/workflows/delivery-test-deploy.yml', 'test',
                 'delivery-loop-test-deploy', 'test:delivery-loop-deployer',
                 ?, '7001', ?, 'https://test.example.test/app', ?,
                 'evidence-test-deployment-source', ?, ?)`,
    ).bind(
      RUN_ID,
      PLAN_ID,
      PLAN_DIGEST,
      BASE_SHA,
      HEAD_SHA,
      sourceKind === 'deployment_failure' ? 'failed' : 'succeeded',
      sourceKind === 'deployment_failure' ? 'failure' : 'success',
      now,
      now,
      now,
    ),
  ]);
  if (sourceKind === 'acceptance_failure') {
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
         VALUES (?, 'accept-test', 'verification', 'Accept test',
                 'Verify deployed service.', 1, 1)`,
      ).bind(PLAN_ID),
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_item_progress (plan_id, item_id, status, version, updated_at)
         VALUES (?, 'accept-test', 'failed', 3, ?)`,
      ).bind(PLAN_ID, now),
      env.DB_CONTROL.prepare(
        `INSERT INTO attempts (
           attempt_id, run_id, ordinal, mode, status, base_sha, head_sha,
           repository, workflow_ref, plan_id, plan_version, plan_item_id,
           claimed_progress_version, version, lease_generation, created_at, updated_at
         ) VALUES ('attempt-test-acceptance-source', ?, 3, 'deploy', 'failed', ?, ?,
                   'example/repo',
                   'example/repo/.github/workflows/delivery-test-acceptance.yml@refs/heads/main',
                   ?, 1, 'accept-test', 1, 3, 2, ?, ?)`,
      ).bind(RUN_ID, BASE_SHA, HEAD_SHA, PLAN_ID, now, now),
      env.DB_CONTROL.prepare(
        `INSERT INTO evidence (
           evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           kind, status, command_ref, exit_code, duration_ms, sha, external_url,
           summary, verification_status, observed_at, created_at
         ) VALUES ('evidence-test-acceptance-source', ?, 'attempt-test-acceptance-source',
                   ?, 1, 'accept-test', 'test', 'failed', 'acceptance:smoke', 1,
                   123, ?, 'https://github.com/example/repo/actions/runs/9001',
                   'Signed acceptance failed', 'verified', ?, ?)`,
      ).bind(RUN_ID, PLAN_ID, HEAD_SHA, now, now),
      env.DB_CONTROL.prepare(
        `INSERT INTO test_acceptances (
           acceptance_id, deployment_id, run_id, run_version, plan_id,
           plan_version, plan_digest, plan_item_id, attempt_id, repository,
           base_branch, base_sha, ref_sha, workflow_path, environment,
           oidc_audience, command_ref, environment_url, status, github_run_id,
           runner_result_digest, runner_status, runner_exit_code,
           runner_duration_ms, external_state, external_conclusion,
           external_updated_at, evidence_id, created_at, updated_at
         ) VALUES ('acceptance-test-rollback-source', 'deployment-test-rollback-source',
                   ?, 5, ?, 1, ?, 'accept-test', 'attempt-test-acceptance-source',
                   'example/repo', 'main', ?, ?,
                   '.github/workflows/delivery-test-acceptance.yml', 'test',
                   'delivery-loop-test-acceptance', 'acceptance:smoke',
                   'https://test.example.test/app', 'failed', '9001', ?, 'failed',
                   1, 123, 'completed', 'failure', ?,
                   'evidence-test-acceptance-source', ?, ?)`,
      ).bind(
        RUN_ID,
        PLAN_ID,
        PLAN_DIGEST,
        BASE_SHA,
        HEAD_SHA,
        `sha256:${'f'.repeat(64)}`,
        now,
        now,
        now,
      ),
    ]);
  }
}

async function declaredTarget(sourceKind: 'deployment_failure' | 'acceptance_failure') {
  const parsed = await parseDeliveryPolicy(policySource());
  const target = await testRollbackTargetFromPolicy('example/repo', sourceKind, parsed);
  if (target === null) throw new Error('rollback fixture is missing');
  return { parsed, target };
}

async function schedule(
  sourceKind: 'deployment_failure' | 'acceptance_failure' = 'deployment_failure',
) {
  const candidates = await new TestRollbackStore(env.DB_CONTROL).candidates();
  const candidate = candidates.find((entry) => entry.sourceKind === sourceKind);
  if (candidate === undefined) throw new Error('rollback candidate is missing');
  const { target } = await declaredTarget(sourceKind);
  return await new TestRollbackStore(env.DB_CONTROL).schedule({
    sourceKind,
    sourceId: candidate.sourceId,
    sourceEvidenceId: candidate.sourceEvidenceId,
    expectedRunVersion: candidate.runVersion,
  }, target, NOW);
}

async function scheduleAndDispatch(
  sourceKind: 'deployment_failure' | 'acceptance_failure' = 'deployment_failure',
) {
  const scheduled = await schedule(sourceKind);
  const ensureDispatch = vi.fn(async (request) => {
    expect(request).toMatchObject({
      repository: 'example/repo',
      workflowFile: '.github/workflows/delivery-test-rollback.yml',
      ref: 'refs/heads/main',
      inputs: {
        schema_version: '1',
        rollback_id: scheduled.rollbackId,
        source_kind: sourceKind,
        ref_sha: HEAD_SHA,
        control_plane_url: BASE_URL,
      },
    });
    return {
      disposition: 'created' as const,
      githubRunId: '9010',
      githubHeadSha: HEAD_SHA,
    };
  });
  const processor = new TestRollbackOutboxProcessor(env.DB_CONTROL, {
    ensureDispatch,
  }, {
    allowedRepositories: ['example/repo'],
    controlPlaneUrl: BASE_URL,
    now: () => NOW,
    generateLeaseToken: () => 'rollback-outbox-lease',
  });
  await expect(processor.deliver(scheduled.outboxId)).resolves.toBe('settled');
  return { ...scheduled, ensureDispatch, processor };
}

function claims(overrides: Record<string, string | null> = {}) {
  return {
    repository: 'example/repo',
    workflowRef:
      'example/repo/.github/workflows/delivery-test-rollback.yml@refs/heads/main',
    sha: HEAD_SHA,
    runId: '9010',
    subject: 'repo:example/repo:environment:test',
    environment: 'test',
    ...overrides,
  };
}

async function attestAndReport(rollbackId: string, exitCode: number): Promise<void> {
  const store = new TestRollbackRunnerStore(env.DB_CONTROL);
  await store.attest(
    rollbackId,
    'CANARY_TEST_ROLLBACK_OIDC_TOKEN',
    claims(),
    new Date(NOW.getTime() + 60_000),
  );
  await store.report(
    rollbackId,
    'CANARY_TEST_ROLLBACK_OIDC_TOKEN',
    claims(),
    { exitCode, durationMs: 1_234 },
    new Date(NOW.getTime() + 120_000),
  );
}

function workflowFact(
  rollbackId: string,
  status: 'requested' | 'in_progress' | 'completed',
  conclusion: string | null,
  offsetMs: number,
) {
  return {
    repository: 'example/repo',
    githubRunId: '9010',
    event: 'workflow_dispatch' as const,
    status,
    conclusion,
    headSha: HEAD_SHA,
    headBranch: 'main',
    workflowPath: '.github/workflows/delivery-test-rollback.yml',
    displayTitle: `delivery-loop/rollback/${rollbackId}`,
    runAttempt: 1,
    externalUpdatedAt: new Date(NOW.getTime() + offsetMs).toISOString(),
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
  const digest = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
  );
  return `sha256=${Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, '0')).join('')}`;
}

async function oidcToken(
  overrides: Record<string, unknown> = {},
  audience = 'delivery-loop-test-rollback',
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const repository = String(overrides.repository ?? 'example/repo');
  const environment = String(overrides.environment ?? 'test');
  return await new SignJWT({
    repository,
    job_workflow_ref:
      'example/repo/.github/workflows/delivery-test-rollback.yml@refs/heads/main',
    sha: HEAD_SHA,
    run_id: '9010',
    environment,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'delivery-loop-test-github-oidc' })
    .setIssuer('https://token.actions.githubusercontent.com')
    .setAudience(audience)
    .setSubject(String(overrides.sub ?? `repo:${repository}:environment:${environment}`))
    .setJti(crypto.randomUUID())
    .setIssuedAt(now)
    .setNotBefore(now - 5)
    .setExpirationTime(now + 300)
    .sign(oidcPrivateKey);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('automatic test rollback durable contract', () => {
  it('records an exact-SHA negative observation and creates zero effect when no contract exists', async () => {
    const parsed = await parseDeliveryPolicy(policySource({ rollback: false }));
    const client = { getDeliveryPolicy: vi.fn(async () => parsed) };
    const reconciler = new TestRollbackReconciler(
      env.DB_CONTROL,
      client,
      new Set(['example/repo']),
      () => NOW,
    );
    await expect(reconciler.reconcileBatch(25)).resolves.toEqual([{
      sourceKind: 'deployment_failure',
      sourceId: 'deployment-test-rollback-source',
      disposition: 'not_declared',
    }]);
    expect(await env.DB_CONTROL.prepare(
      `SELECT disposition, policy_digest, contract_digest
       FROM test_rollback_contract_observations`,
    ).first()).toEqual({
      disposition: 'not_declared',
      policy_digest: parsed.digest,
      contract_digest: null,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM test_rollbacks',
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE destination = 'github_test_rollback'`,
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts WHERE attempt_id LIKE 'attempt_test_rollback_%'`,
    ).first()).toEqual({ count: 0 });
    const report = await new Case8AuditReportStore(env.DB_CONTROL).generate(RUN_ID);
    expect(report.answers.checks).toMatchObject({
      testRollbackContracts: [{
        sourceKind: 'deployment_failure', sourceId: 'deployment-test-rollback-source',
        sourceEvidenceId: 'evidence-test-deployment-source', disposition: 'not_declared',
        policyDigest: parsed.digest,
      }],
      testRollbacks: [],
      testRollbackObservations: [],
    });
    expect((report.answers.checks.effectOutboxes as Array<Record<string, unknown>>)
      .filter((outbox) => outbox.kind === 'test_rollback_dispatch')).toEqual([]);
    await expect(reconciler.reconcileBatch(25)).resolves.toEqual([]);
    expect(client.getDeliveryPolicy).toHaveBeenCalledOnce();
  });

  it('fails closed for missing/invalid policy and for an unverified failure source', async () => {
    const missing = new TestRollbackReconciler(
      env.DB_CONTROL,
      { getDeliveryPolicy: async () => null },
      new Set(['example/repo']),
      () => NOW,
    );
    await expect(missing.reconcileBatch()).resolves.toMatchObject([{
      disposition: 'policy_missing',
    }]);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE destination = 'github_test_rollback'`,
    ).first()).toEqual({ count: 0 });

    await reset();
    await seed();
    const invalid = new TestRollbackReconciler(
      env.DB_CONTROL,
      {
        async getDeliveryPolicy() {
          throw new GitHubDeliveryPolicyError('invalid_policy');
        },
      },
      new Set(['example/repo']),
      () => NOW,
    );
    await expect(invalid.reconcileBatch()).resolves.toMatchObject([{
      disposition: 'policy_invalid',
    }]);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE destination = 'github_test_rollback'`,
    ).first()).toEqual({ count: 0 });

    await reset();
    await seed('deployment_failure', false);
    expect(await new TestRollbackStore(env.DB_CONTROL).candidates()).toEqual([]);
  });

  it('converges 20 policy observations, schedulers, and outbox deliveries to one effect', async () => {
    const parsed = await parseDeliveryPolicy(policySource());
    const reconciler = new TestRollbackReconciler(
      env.DB_CONTROL,
      { getDeliveryPolicy: vi.fn(async () => parsed) },
      new Set(['example/repo']),
      () => NOW,
    );
    const batches = await Promise.all(
      Array.from({ length: 20 }, () => reconciler.reconcileBatch(25)),
    );
    expect(batches.flat()).toHaveLength(20);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM test_rollbacks',
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE destination = 'github_test_rollback'`,
    ).first()).toEqual({ count: 1 });
    const rollback = await env.DB_CONTROL.prepare(
      'SELECT rollback_id, attempt_id FROM test_rollbacks',
    ).first<{ rollback_id: string; attempt_id: string }>();
    if (rollback === null) throw new Error('rollback was not scheduled');
    const ensureDispatch = vi.fn(async () => ({
      disposition: 'created' as const,
      githubRunId: '9010',
      githubHeadSha: HEAD_SHA,
    }));
    const processor = new TestRollbackOutboxProcessor(env.DB_CONTROL, { ensureDispatch }, {
      allowedRepositories: ['example/repo'],
      controlPlaneUrl: BASE_URL,
      now: () => NOW,
      generateLeaseToken: () => 'rollback-outbox-lease',
    });
    const outbox = await env.DB_CONTROL.prepare(
      `SELECT outbox_id FROM outbox WHERE destination = 'github_test_rollback'`,
    ).first<{ outbox_id: string }>();
    if (outbox === null) throw new Error('rollback outbox is missing');
    const deliveries = await Promise.all(
      Array.from({ length: 20 }, () => processor.deliver(outbox.outbox_id)),
    );
    expect(deliveries.every((entry) => entry === 'settled' || entry === 'busy')).toBe(true);
    expect(ensureDispatch).toHaveBeenCalledOnce();
    expect(await env.DB_CONTROL.prepare(
      'SELECT status, github_run_id FROM test_rollbacks',
    ).first()).toEqual({ status: 'dispatched', github_run_id: '9010' });
  });

  it('supports verified acceptance failure but never treats a production target as test rollback', async () => {
    await reset();
    await seed('acceptance_failure');
    const scheduled = await schedule('acceptance_failure');
    expect(scheduled).toMatchObject({
      sourceKind: 'acceptance_failure',
      sourceId: 'acceptance-test-rollback-source',
      sourceEvidenceId: 'evidence-test-acceptance-source',
      deploymentId: 'deployment-test-rollback-source',
      refSha: HEAD_SHA,
    });

    await reset();
    await seed();
    await env.DB_CONTROL.prepare(
      `UPDATE tasks SET target_environment = 'production',
                        allow_test_deploy = 0, allow_production_deploy = 1
       WHERE task_id = 'task-test-rollback'`,
    ).run();
    expect(await new TestRollbackStore(env.DB_CONTROL).candidates()).toEqual([]);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE destination = 'github_test_rollback'`,
    ).first()).toEqual({ count: 0 });
  });

  it('requires both Runner pass and exact GitHub success, preserving the original failed Item and Run', async () => {
    const { rollbackId } = await scheduleAndDispatch();
    const projector = new GitHubTestRollbackStatusStore(env.DB_CONTROL);
    const requested = workflowFact(rollbackId, 'requested', null, 30_000);
    await projector.applyApiObservation({
      observationId: 'api_test_rollback_requested',
      factDigest: await canonicalSha256(requested),
      fact: requested,
      observedAt: requested.externalUpdatedAt,
    });
    await attestAndReport(rollbackId, 0);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM evidence
       WHERE attempt_id LIKE 'attempt_test_rollback_%'`,
    ).first()).toEqual({ count: 0 });

    const completed = workflowFact(rollbackId, 'completed', 'success', 180_000);
    const digest = await canonicalSha256(completed);
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      projector.applyApiObservation({
        observationId: `api_test_rollback_success_${index}`,
        factDigest: digest,
        fact: completed,
        observedAt: completed.externalUpdatedAt,
      })));
    expect(results).toHaveLength(20);
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, external_state, external_conclusion, evidence_id
       FROM test_rollbacks`,
    ).first()).toMatchObject({
      status: 'succeeded',
      external_state: 'completed',
      external_conclusion: 'success',
      evidence_id: expect.stringMatching(/^evidence_test_rollback_/),
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM evidence
       WHERE attempt_id LIKE 'attempt_test_rollback_%'
         AND kind = 'deployment' AND status = 'passed'
         AND verification_status = 'verified'`,
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, active_attempt_id FROM plan_item_progress
       WHERE plan_id = ? AND item_id = 'deploy-test'`,
    ).bind(PLAN_ID).first()).toEqual({ status: 'failed', active_attempt_id: null });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'executing' });

    const projection = await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus(RUN_ID);
    expect(projection?.run).toMatchObject({
      state: 'executing',
      testRollbacks: [{
        id: rollbackId,
        sourceKind: 'deployment_failure',
        status: 'succeeded',
        roleRef: 'test:delivery-loop-rollback',
        githubRunId: '9010',
      }],
    });
    expect(JSON.stringify(projection)).not.toContain('CANARY_TEST_ROLLBACK_OIDC_TOKEN');
    expect(JSON.stringify(projection)).not.toContain('oidc_token_digest');
    expect(JSON.stringify(projection)).not.toContain('runner_result_digest');
  });

  it('keeps GitHub success retryable without Runner result and freezes a verified rollback failure', async () => {
    const { rollbackId } = await scheduleAndDispatch();
    const success = workflowFact(rollbackId, 'completed', 'success', 180_000);
    await expect(new GitHubTestRollbackStatusStore(env.DB_CONTROL).applyApiObservation({
      observationId: 'api_test_rollback_result_pending',
      factDigest: await canonicalSha256(success),
      fact: success,
      observedAt: success.externalUpdatedAt,
    })).rejects.toMatchObject({ code: 'runner_result_required' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT processing_state FROM github_test_rollback_observations
       WHERE observation_id = 'api_test_rollback_result_pending'`,
    ).first()).toEqual({ processing_state: 'received' });

    await attestAndReport(rollbackId, 1);
    // Retry the same signed fact after the independent Runner result arrives.
    await expect(new GitHubTestRollbackStatusStore(env.DB_CONTROL).applyApiObservation({
      observationId: 'api_test_rollback_result_pending',
      factDigest: await canonicalSha256(success),
      fact: success,
      observedAt: success.externalUpdatedAt,
    })).resolves.toBe('applied');
    expect(await env.DB_CONTROL.prepare(
      'SELECT status, evidence_id FROM test_rollbacks',
    ).first()).toMatchObject({
      status: 'failed',
      evidence_id: expect.stringMatching(/^evidence_test_rollback_/),
    });
    const lateConflict = workflowFact(rollbackId, 'completed', 'failure', 200_000);
    await expect(new GitHubTestRollbackStatusStore(env.DB_CONTROL).applyApiObservation({
      observationId: 'api_test_rollback_late_conflict',
      factDigest: await canonicalSha256(lateConflict),
      fact: lateConflict,
      observedAt: lateConflict.externalUpdatedAt,
    })).resolves.toBe('ignored');
    expect(await env.DB_CONTROL.prepare(
      'SELECT status FROM test_rollbacks',
    ).first()).toEqual({ status: 'failed' });
  });

  it('rejects wrong OIDC bindings and persists only a token digest', async () => {
    const { rollbackId } = await scheduleAndDispatch();
    const store = new TestRollbackRunnerStore(env.DB_CONTROL);
    for (const invalid of [
      claims({ environment: 'production' }),
      claims({ sha: 'f'.repeat(40) }),
      claims({
        workflowRef:
          'example/repo/.github/workflows/delivery-test-acceptance.yml@refs/heads/main',
      }),
    ]) {
      await expect(store.attest(
        rollbackId,
        'CANARY_INVALID_TEST_ROLLBACK_TOKEN',
        invalid,
        new Date(NOW.getTime() + 60_000),
      )).rejects.toMatchObject({ code: 'binding_mismatch' });
    }
    const rawToken = 'CANARY_VALID_TEST_ROLLBACK_OIDC_TOKEN';
    await store.attest(
      rollbackId,
      rawToken,
      claims(),
      new Date(NOW.getTime() + 60_000),
    );
    const persisted = await env.DB_CONTROL.prepare(
      `SELECT oidc_token_digest, repository, environment, audience
       FROM test_rollback_oidc_attestations`,
    ).first();
    expect(persisted).toEqual({
      oidc_token_digest: await canonicalSha256(rawToken),
      repository: 'example/repo',
      environment: 'test',
      audience: 'delivery-loop-test-rollback',
    });
    expect(JSON.stringify(persisted)).not.toContain(rawToken);
  });

  it('cryptographically enforces the dedicated rollback audience and test Environment API', async () => {
    const { rollbackId } = await scheduleAndDispatch();
    const endpoint = `${BASE_URL}/v1/test-rollbacks/${rollbackId}/oidc-attestation`;
    const invalid = [
      await oidcToken({}, 'delivery-loop-test-acceptance'),
      await oidcToken({ environment: 'production' }),
      await oidcToken({ sha: 'f'.repeat(40) }),
      await oidcToken({
        job_workflow_ref:
          'example/repo/.github/workflows/delivery-test-acceptance.yml@refs/heads/main',
      }),
    ];
    const responses = await Promise.all(invalid.map(async (token) =>
      await SELF.fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })));
    expect(responses.map((response) => response.status)).toEqual([401, 403, 403, 403]);
    const token = await oidcToken();
    const attested = await SELF.fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(attested.status).toBe(200);
    const result = await SELF.fetch(`${BASE_URL}/v1/test-rollbacks/${rollbackId}/result`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ exitCode: 0, durationMs: 456 }),
    });
    expect(result.status).toBe(200);
    const stored = await env.DB_CONTROL.prepare(
      'SELECT oidc_token_digest, audience, environment FROM test_rollback_oidc_attestations',
    ).first();
    expect(stored).toEqual({
      oidc_token_digest: await canonicalSha256(token),
      audience: 'delivery-loop-test-rollback',
      environment: 'test',
    });
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it('converges signed webhook and API compensation without storing the raw payload', async () => {
    const { rollbackId } = await scheduleAndDispatch();
    await attestAndReport(rollbackId, 0);
    const rawCanary = 'CANARY_TEST_ROLLBACK_WEBHOOK_RAW_PAYLOAD';
    const fact = workflowFact(rollbackId, 'completed', 'success', 180_000);
    const payload = {
      action: 'completed',
      workflow_run: {
        id: 9010,
        event: 'workflow_dispatch',
        status: 'completed',
        conclusion: 'success',
        head_sha: HEAD_SHA,
        head_branch: 'main',
        path: '.github/workflows/delivery-test-rollback.yml',
        display_title: `delivery-loop/rollback/${rollbackId}`,
        run_attempt: 1,
        updated_at: fact.externalUpdatedAt,
        untrusted: rawCanary,
      },
      repository: { full_name: 'example/repo' },
    };
    const body = JSON.stringify(payload);
    const response = await SELF.fetch(`${BASE_URL}/v1/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': '12345678-1234-1234-1234-1234567890ae',
        'x-github-event': 'workflow_run',
        'x-hub-signature-256': await webhookSignature(body),
      },
      body,
    });
    expect(response.status).toBe(202);
    const reconciler = new GitHubTestRollbackRunReconciler(env.DB_CONTROL, {
      async getRollbackWorkflowRun() {
        return fact;
      },
    }, () => new Date(NOW.getTime() + 190_000));
    await expect(reconciler.reconcileRollback(rollbackId)).resolves.toBe('applied');
    const observations = await env.DB_CONTROL.prepare(
      `SELECT source_kind, fact_digest, processing_state, rollback_id, ignore_reason
       FROM github_test_rollback_observations ORDER BY source_kind`,
    ).all<Record<string, unknown>>();
    expect(observations.results).toHaveLength(2);
    expect(JSON.stringify(observations.results)).not.toContain(rawCanary);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM evidence
       WHERE attempt_id LIKE 'attempt_test_rollback_%' AND status = 'passed'`,
    ).first()).toEqual({ count: 1 });
    const report = await new Case8AuditReportStore(env.DB_CONTROL).generate(RUN_ID);
    expect(report.answers.checks).toMatchObject({
      testRollbackContracts: [{
        sourceKind: 'deployment_failure', disposition: 'declared',
        workflowPath: '.github/workflows/delivery-test-rollback.yml',
        environment: 'test', oidcAudience: 'delivery-loop-test-rollback',
        roleRef: 'test:delivery-loop-rollback',
      }],
      testRollbacks: [{
        rollbackId, sourceKind: 'deployment_failure',
        sourceEvidenceId: 'evidence-test-deployment-source',
        failedAttemptId: 'attempt-test-deploy-source',
        deploymentId: 'deployment-test-rollback-source',
        attemptId: expect.stringMatching(/^attempt_test_rollback_/),
        status: 'succeeded', githubRunId: '9010',
        runnerStatus: 'passed', runnerExitCode: 0,
        externalState: 'completed', externalConclusion: 'success',
        evidenceId: expect.stringMatching(/^evidence_test_rollback_/),
        oidcAttestationId: expect.stringMatching(/^test_rollback_attestation_/),
        oidcGithubRunId: '9010',
        oidcWorkflowRef:
          'example/repo/.github/workflows/delivery-test-rollback.yml@refs/heads/main',
        oidcSubject: 'repo:example/repo:environment:test',
      }],
      testRollbackObservations: expect.arrayContaining([
        expect.objectContaining({
          sourceKind: 'webhook', rollbackId, githubRunId: '9010',
          processingState: 'applied',
        }),
        expect.objectContaining({
          sourceKind: 'api', rollbackId, githubRunId: '9010',
          processingState: 'applied',
        }),
      ]),
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('oidc_token_digest');
    expect(serialized).not.toContain('CANARY_TEST_ROLLBACK_OIDC_TOKEN');
    expect(serialized).not.toContain(rawCanary);
  });
});
