/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { importJWK, SignJWT, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import {
  TestAcceptanceOutboxProcessor,
} from '../../src/outbox/github-test-acceptance.js';
import {
  GitHubTestAcceptanceRunReconciler,
} from '../../src/reconciliation/github-test-acceptance-run-reconciler.js';
import { GitHubRunReconciler } from '../../src/reconciliation/github-run-reconciler.js';
import {
  GitHubTestAcceptanceStatusStore,
} from '../../src/storage/github-test-acceptance-status-store.js';
import { TaskQueryStore } from '../../src/storage/task-query-store.js';
import {
  TestAcceptanceRunnerStore,
} from '../../src/storage/test-acceptance-runner-store.js';
import {
  TestAcceptanceStore,
  TestAcceptanceStoreError,
} from '../../src/storage/test-acceptance-store.js';

// Keep the entire fixture on one stable per-process clock while ensuring the
// HTTP route's real clock remains inside the 30-minute Attempt lease.
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const RUN_ID = 'run-test-acceptance';
const PLAN_ID = 'plan-test-acceptance';
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const PLAN_DIGEST = `sha256:${'c'.repeat(64)}`;
const WEBHOOK_SECRET = 'test-github-webhook-secret';
const BASE_URL = 'https://delivery-loop.test';
let oidcPrivateKey: Awaited<ReturnType<typeof importJWK>>;

beforeAll(async () => {
  oidcPrivateKey = await importJWK(
    JSON.parse(env.TEST_GITHUB_OIDC_PRIVATE_JWK) as JWK,
    'RS256',
  );
});

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM github_test_acceptance_observations'),
    env.DB_CONTROL.prepare('DELETE FROM test_acceptance_oidc_attestations'),
    env.DB_CONTROL.prepare('DELETE FROM test_acceptances'),
    env.DB_CONTROL.prepare('DELETE FROM github_test_deployment_webhook_deliveries'),
    env.DB_CONTROL.prepare('DELETE FROM test_deployment_oidc_attestations'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_done_when_evidence'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_verifications'),
    env.DB_CONTROL.prepare('DELETE FROM test_deployments'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_revocations'),
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

async function seed(options: { deploymentEvidence?: 'verified' | 'unverified' } = {}): Promise<void> {
  const now = NOW.toISOString();
  const verificationStatus = options.deploymentEvidence ?? 'verified';
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (
         'task-test-acceptance', 'manual', 'acceptance-test', 'acceptance-test',
         'rev-1', ?, 'r2://tasks/acceptance-test', 'user', 'principal-requester',
         'example/repo', 'main', 'test', 'requirement', 'Accept test deployment',
         'p1', 1, 1, 1, 0, 1, ?, ?
       )`,
    ).bind(`sha256:${'d'.repeat(64)}`, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, 'task-test-acceptance', 'rev-1', ?, ?, ?, 'executing', 5,
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
       ) VALUES ('attempt-analysis-acceptance', ?, 1, 'analysis', 'completed', ?,
                 'example/repo',
                 'example/repo/.github/workflows/delivery-agent.yml@refs/heads/main',
                 1, 0, ?, ?)`,
    ).bind(RUN_ID, BASE_SHA, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, 'rev-1', ?, ?, 'active', 'attempt-analysis-acceptance',
                 'Accept the independently deployed test revision.', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, now, now),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES (?, 'deploy-test', 'delivery', 'Deploy test', 'Deploy exact head.', 1, 0)`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES (?, 'accept-test', 'verification', 'Accept test',
               'Verify the deployed service through its external URL.', 1, 1)`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (plan_id, item_id, status, version, updated_at)
       VALUES (?, 'deploy-test', 'passed', 3, ?)`,
    ).bind(PLAN_ID, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (plan_id, item_id, status, version, updated_at)
       VALUES (?, 'accept-test', 'ready', 1, ?)`,
    ).bind(PLAN_ID, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_dependencies (plan_id, item_id, depends_on_item_id)
       VALUES (?, 'accept-test', 'deploy-test')`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_done_when (plan_id, item_id, position, condition)
       VALUES (?, 'accept-test', 0, 'Signed acceptance workflow and command pass.')`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, 'accept-test', 'repo_read')`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
       VALUES (?, 'accept-test', 'acceptance:smoke')`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_evidence_kinds (plan_id, item_id, evidence_kind)
       VALUES (?, 'accept-test', 'test')`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, head_sha,
         repository, workflow_ref, plan_id, plan_version, plan_item_id,
         claimed_progress_version, version, lease_generation, created_at, updated_at
       ) VALUES ('attempt-test-deploy-passed', ?, 2, 'deploy', 'completed', ?, ?,
                 'example/repo',
                 'example/repo/.github/workflows/delivery-test-deploy.yml@refs/heads/main',
                 ?, 1, 'deploy-test', 1, 3, 2, ?, ?)`,
    ).bind(RUN_ID, BASE_SHA, HEAD_SHA, PLAN_ID, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-test-acceptance-deploy', ?, 'rev-1', ?, 1, ?, ?,
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
       ) VALUES ('evidence-test-deployment-passed', ?, 'attempt-test-deploy-passed',
                 ?, 1, 'deploy-test', 'deployment', 'passed', ?,
                 'https://test.example.test/app', 'Signed deployment passed', ?, ?, ?)`,
    ).bind(RUN_ID, PLAN_ID, HEAD_SHA, verificationStatus, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO test_deployments (
         deployment_id, run_id, run_version, plan_id, plan_version, plan_digest,
         plan_item_id, attempt_id, approval_id, repository, base_branch,
         base_sha, ref_sha, workflow_path, environment, oidc_audience, role_ref,
         status, github_deployment_id, external_state, external_url,
         external_updated_at, evidence_id, created_at, updated_at
       ) VALUES ('deployment-test-acceptance', ?, 5, ?, 1, ?, 'deploy-test',
                 'attempt-test-deploy-passed', 'approval-test-acceptance-deploy',
                 'example/repo', 'main', ?, ?,
                 '.github/workflows/delivery-test-deploy.yml', 'test',
                 'delivery-loop-test-deploy', 'test:delivery-loop-deployer',
                 'succeeded', '7001', 'success', 'https://test.example.test/app',
                 ?, 'evidence-test-deployment-passed', ?, ?)`,
    ).bind(RUN_ID, PLAN_ID, PLAN_DIGEST, BASE_SHA, HEAD_SHA, now, now, now),
  ]);
}

function scheduleInput(): Record<string, unknown> {
  return {
    runId: RUN_ID,
    expectedRunVersion: 5,
    planVersion: 1,
    planItemId: 'accept-test',
    expectedProgressVersion: 1,
  };
}

async function scheduleAndDispatch(): Promise<{
  acceptanceId: string;
  attemptId: string;
}> {
  const scheduled = await new TestAcceptanceStore(env.DB_CONTROL).schedule(
    scheduleInput(),
    NOW,
  );
  const processor = new TestAcceptanceOutboxProcessor(env.DB_CONTROL, {
    async ensureDispatch(request) {
      expect(request).toMatchObject({
        repository: 'example/repo',
        workflowFile: '.github/workflows/delivery-test-acceptance.yml',
        ref: 'refs/heads/main',
        inputs: {
          schema_version: '1',
          acceptance_id: scheduled.acceptanceId,
          ref_sha: HEAD_SHA,
          control_plane_url: BASE_URL,
        },
      });
      return { disposition: 'created', githubRunId: '9004' };
    },
  }, {
    allowedRepositories: ['example/repo'],
    controlPlaneUrl: BASE_URL,
    now: () => NOW,
    generateLeaseToken: () => 'acceptance-outbox-lease',
  });
  await expect(processor.deliver(scheduled.outboxId)).resolves.toBe('settled');
  return { acceptanceId: scheduled.acceptanceId, attemptId: scheduled.attemptId };
}

function claims(overrides: Record<string, string | null> = {}) {
  return {
    repository: 'example/repo',
    workflowRef:
      'example/repo/.github/workflows/delivery-test-acceptance.yml@refs/heads/main',
    sha: HEAD_SHA,
    runId: '9004',
    subject: 'repo:example/repo:environment:test',
    environment: 'test',
    ...overrides,
  };
}

async function attestAndReport(
  acceptanceId: string,
  exitCode: number,
): Promise<TestAcceptanceRunnerStore> {
  const store = new TestAcceptanceRunnerStore(env.DB_CONTROL);
  await store.attest(
    acceptanceId,
    'CANARY_ACCEPTANCE_OIDC_TOKEN',
    claims(),
    new Date(NOW.getTime() + 60_000),
  );
  await store.report(
    acceptanceId,
    'CANARY_ACCEPTANCE_OIDC_TOKEN',
    claims(),
    { exitCode, durationMs: 1_234 },
    new Date(NOW.getTime() + 120_000),
  );
  return store;
}

function workflowFact(
  status: 'requested' | 'in_progress' | 'completed',
  conclusion: string | null,
  offsetMs: number,
) {
  return {
    repository: 'example/repo',
    githubRunId: '9004',
    event: 'workflow_dispatch' as const,
    status,
    conclusion,
    headSha: HEAD_SHA,
    headBranch: 'main',
    workflowPath: '.github/workflows/delivery-test-acceptance.yml',
    displayTitle: 'unbound-acceptance-title',
    runAttempt: 1,
    externalUpdatedAt: new Date(NOW.getTime() + offsetMs).toISOString(),
  };
}

function boundWorkflowFact(
  acceptanceId: string,
  status: 'requested' | 'in_progress' | 'completed',
  conclusion: string | null,
  offsetMs: number,
) {
  return {
    ...workflowFact(status, conclusion, offsetMs),
    displayTitle: `delivery-loop/acceptance/${acceptanceId}`,
  };
}

async function oidcToken(overrides: Record<string, unknown> = {}, audience =
'delivery-loop-test-acceptance'): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const repository = String(overrides.repository ?? 'example/repo');
  const environment = String(overrides.environment ?? 'test');
  return await new SignJWT({
    repository,
    job_workflow_ref:
      'example/repo/.github/workflows/delivery-test-acceptance.yml@refs/heads/main',
    sha: HEAD_SHA,
    run_id: '9004',
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

async function webhookSignature(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(WEBHOOK_SECRET),
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

beforeEach(async () => {
  await reset();
  await seed();
});

describe('post-deployment acceptance control-plane contract', () => {
  it('converges 20 schedulers and outbox deliveries to one independent acceptance Attempt', async () => {
    const store = new TestAcceptanceStore(env.DB_CONTROL);
    const scheduled = await Promise.all(
      Array.from({ length: 20 }, () => store.schedule(scheduleInput(), NOW)),
    );
    expect(new Set(scheduled.map((entry) => entry.acceptanceId))).toHaveLength(1);
    expect(scheduled.filter((entry) => entry.created)).toHaveLength(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts
       WHERE run_id = ? AND plan_item_id = 'accept-test'`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM test_acceptances WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox
       WHERE run_id = ? AND destination = 'github_acceptance'`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });

    const ensureDispatch = vi.fn(async () => ({
      disposition: 'created' as const,
      githubRunId: '9004',
    }));
    const processor = new TestAcceptanceOutboxProcessor(env.DB_CONTROL, {
      ensureDispatch,
    }, {
      allowedRepositories: ['example/repo'],
      controlPlaneUrl: BASE_URL,
      now: () => NOW,
      generateLeaseToken: () => 'acceptance-outbox-lease',
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => processor.deliver(scheduled[0]!.outboxId)),
    );
    expect(results.every((result) => result === 'settled' || result === 'busy')).toBe(true);
    expect(ensureDispatch).toHaveBeenCalledOnce();
  });

  it('requires verified deployment Evidence and an acceptance-only read effect', async () => {
    await reset();
    await seed({ deploymentEvidence: 'unverified' });
    await expect(
      new TestAcceptanceStore(env.DB_CONTROL).schedule(scheduleInput(), NOW),
    ).rejects.toMatchObject({
      name: TestAcceptanceStoreError.name,
      code: 'policy_denied',
    });

    await reset();
    await seed();
    await env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, 'accept-test', 'repo_write')`,
    ).bind(PLAN_ID).run();
    await expect(
      new TestAcceptanceStore(env.DB_CONTROL).schedule(scheduleInput(), NOW),
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('does not treat deployment success, dispatch, OIDC, or Runner result as acceptance success', async () => {
    expect(await env.DB_CONTROL.prepare(
      'SELECT state FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'executing' });
    const { acceptanceId } = await scheduleAndDispatch();
    const projector = new GitHubTestAcceptanceStatusStore(env.DB_CONTROL);
    const requested = boundWorkflowFact(acceptanceId, 'requested', null, 30_000);
    await projector.applyApiObservation({
      observationId: 'api_acceptance_requested',
      factDigest: await canonicalSha256(requested),
      fact: requested,
      observedAt: requested.externalUpdatedAt,
    });
    await attestAndReport(acceptanceId, 0);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM evidence
       WHERE run_id = ? AND plan_item_id = 'accept-test'`,
    ).bind(RUN_ID).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status FROM plan_item_progress
       WHERE plan_id = ? AND item_id = 'accept-test'`,
    ).bind(PLAN_ID).first()).toEqual({ status: 'in_progress' });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'executing' });
  });

  it('keeps acceptance runs out of the generic Agent workflow projector', async () => {
    const { attemptId } = await scheduleAndDispatch();
    const client = { getWorkflowRun: vi.fn() };
    await expect(
      new GitHubRunReconciler(env.DB_CONTROL, client).reconcileAttempt(attemptId),
    ).resolves.toBe('not_found');
    expect(client.getWorkflowRun).not.toHaveBeenCalled();
  });

  it('creates one verified test Evidence only after Runner pass and signed workflow success', async () => {
    const { acceptanceId } = await scheduleAndDispatch();
    await attestAndReport(acceptanceId, 0);
    const fact = boundWorkflowFact(acceptanceId, 'completed', 'success', 180_000);
    const store = new GitHubTestAcceptanceStatusStore(env.DB_CONTROL);
    const factDigest = await canonicalSha256(fact);
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      store.applyApiObservation({
        observationId: `api_acceptance_success_${index}`,
        factDigest,
        fact,
        observedAt: fact.externalUpdatedAt,
      })));
    expect(results).toHaveLength(20);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM evidence
       WHERE run_id = ? AND plan_item_id = 'accept-test'
         AND kind = 'test' AND status = 'passed' AND verification_status = 'verified'`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, active_attempt_id FROM plan_item_progress
       WHERE plan_id = ? AND item_id = 'accept-test'`,
    ).bind(PLAN_ID).first()).toEqual({ status: 'passed', active_attempt_id: null });
    expect(await env.DB_CONTROL.prepare(
      'SELECT status, external_state, external_conclusion FROM test_acceptances',
    ).first()).toEqual({
      status: 'passed',
      external_state: 'completed',
      external_conclusion: 'success',
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'executing' });
  });

  it('keeps a signed success retryable until the independent Runner result arrives', async () => {
    const { acceptanceId } = await scheduleAndDispatch();
    const fact = boundWorkflowFact(acceptanceId, 'completed', 'success', 180_000);
    await expect(new GitHubTestAcceptanceStatusStore(env.DB_CONTROL).applyApiObservation({
      observationId: 'api_acceptance_result_pending',
      factDigest: await canonicalSha256(fact),
      fact,
      observedAt: fact.externalUpdatedAt,
    })).rejects.toMatchObject({ code: 'runner_result_required' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, external_state, evidence_id FROM test_acceptances`,
    ).first()).toEqual({
      status: 'dispatched',
      external_state: 'completed',
      evidence_id: null,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT processing_state FROM github_test_acceptance_observations
       WHERE observation_id = 'api_acceptance_result_pending'`,
    ).first()).toEqual({ processing_state: 'received' });
  });

  it('records failed acceptance Evidence and leaves the Run executing', async () => {
    const { acceptanceId } = await scheduleAndDispatch();
    await attestAndReport(acceptanceId, 1);
    const fact = boundWorkflowFact(acceptanceId, 'completed', 'failure', 180_000);
    await expect(new GitHubTestAcceptanceStatusStore(env.DB_CONTROL).applyApiObservation({
      observationId: 'api_acceptance_failure',
      factDigest: await canonicalSha256(fact),
      fact,
      observedAt: fact.externalUpdatedAt,
    })).resolves.toBe('applied');
    expect(await env.DB_CONTROL.prepare(
      `SELECT kind, status, verification_status, command_ref, exit_code
       FROM evidence WHERE plan_item_id = 'accept-test'`,
    ).first()).toEqual({
      kind: 'test',
      status: 'failed',
      verification_status: 'verified',
      command_ref: 'acceptance:smoke',
      exit_code: 1,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status FROM plan_item_progress
       WHERE plan_id = ? AND item_id = 'accept-test'`,
    ).bind(PLAN_ID).first()).toEqual({ status: 'failed' });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'executing' });
  });

  it('fails closed when Runner result conflicts with workflow conclusion', async () => {
    const { acceptanceId } = await scheduleAndDispatch();
    await attestAndReport(acceptanceId, 1);
    const fact = boundWorkflowFact(acceptanceId, 'completed', 'success', 180_000);
    await new GitHubTestAcceptanceStatusStore(env.DB_CONTROL).applyApiObservation({
      observationId: 'api_acceptance_conflict',
      factDigest: await canonicalSha256(fact),
      fact,
      observedAt: fact.externalUpdatedAt,
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT status FROM test_acceptances',
    ).first()).toEqual({ status: 'failed' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM evidence
       WHERE plan_item_id = 'accept-test' AND status = 'passed'`,
    ).first()).toEqual({ count: 0 });
  });

  it('cryptographically rejects wrong acceptance identity and never stores the raw OIDC token', async () => {
    const { acceptanceId } = await scheduleAndDispatch();
    const endpoint = `${BASE_URL}/v1/test-acceptances/${acceptanceId}/oidc-attestation`;
    const invalidTokens = [
      await oidcToken({}, 'delivery-loop-control-plane'),
      await oidcToken({ sub: 'repo:example/repo:ref:refs/heads/main' }),
      await oidcToken({ environment: 'production' }),
      await oidcToken({
        job_workflow_ref:
          'example/repo/.github/workflows/delivery-test-deploy.yml@refs/heads/main',
      }),
      await oidcToken({ sha: 'f'.repeat(40) }),
    ];
    const invalidResponses = await Promise.all(invalidTokens.map(async (token) =>
      await SELF.fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })));
    expect(invalidResponses.map((response) => response.status)).toEqual([401, 403, 403, 403, 403]);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM test_acceptance_oidc_attestations',
    ).first()).toEqual({ count: 0 });

    const rawToken = await oidcToken();
    const valid = await SELF.fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${rawToken}` },
    });
    expect(valid.status).toBe(200);
    const stored = await env.DB_CONTROL.prepare(
      `SELECT oidc_token_digest, repository, environment, audience
       FROM test_acceptance_oidc_attestations`,
    ).first();
    expect(stored).toEqual({
      oidc_token_digest: await canonicalSha256(rawToken),
      repository: 'example/repo',
      environment: 'test',
      audience: 'delivery-loop-test-acceptance',
    });
    expect(JSON.stringify(stored)).not.toContain(rawToken);
  });

  it('converges signed webhook and API reconciliation without persisting raw payload', async () => {
    const { acceptanceId } = await scheduleAndDispatch();
    const token = await oidcToken();
    const attest = await SELF.fetch(
      `${BASE_URL}/v1/test-acceptances/${acceptanceId}/oidc-attestation`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
    );
    expect(attest.status).toBe(200);
    const report = await SELF.fetch(`${BASE_URL}/v1/test-acceptances/${acceptanceId}/result`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ exitCode: 0, durationMs: 456 }),
    });
    expect(report.status).toBe(200);

    const rawCanary = 'CANARY_ACCEPTANCE_WEBHOOK_RAW_PAYLOAD';
    const updatedAt = new Date(NOW.getTime() + 180_000).toISOString();
    const payload = {
      action: 'completed',
      workflow_run: {
        id: 9004,
        event: 'workflow_dispatch',
        status: 'completed',
        conclusion: 'success',
        head_sha: HEAD_SHA,
        head_branch: 'main',
        path: '.github/workflows/delivery-test-acceptance.yml',
        display_title: `delivery-loop/acceptance/${acceptanceId}`,
        run_attempt: 1,
        updated_at: updatedAt,
        untrusted: rawCanary,
      },
      repository: { full_name: 'example/repo' },
    };
    const body = JSON.stringify(payload);
    const response = await SELF.fetch(`${BASE_URL}/v1/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': '12345678-1234-1234-1234-1234567890ad',
        'x-github-event': 'workflow_run',
        'x-hub-signature-256': await webhookSignature(body),
      },
      body,
    });
    expect(response.status).toBe(202);

    const fact = boundWorkflowFact(acceptanceId, 'completed', 'success', 180_000);
    const reconciler = new GitHubTestAcceptanceRunReconciler(env.DB_CONTROL, {
      async getWorkflowRun() {
        return fact;
      },
    }, () => new Date(NOW.getTime() + 190_000));
    await expect(reconciler.reconcileAcceptance(acceptanceId)).resolves.toBe('applied');
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM evidence
       WHERE plan_item_id = 'accept-test' AND status = 'passed'`,
    ).first()).toEqual({ count: 1 });
    const observations = await env.DB_CONTROL.prepare(
      `SELECT observation_id, source_kind, fact_digest, processing_state,
              acceptance_id, ignore_reason
       FROM github_test_acceptance_observations ORDER BY source_kind`,
    ).all<Record<string, unknown>>();
    expect(observations.results).toHaveLength(2);
    expect(JSON.stringify(observations.results)).not.toContain(rawCanary);
    const projection = await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus(RUN_ID);
    expect(projection?.run).toMatchObject({
      state: 'executing',
      testAcceptances: [{
        id: acceptanceId,
        deploymentId: 'deployment-test-acceptance',
        status: 'passed',
        commandRef: 'acceptance:smoke',
        githubRunId: '9004',
      }],
    });
    expect(JSON.stringify(projection)).not.toContain('runner_result_digest');
    expect(JSON.stringify(projection)).not.toContain('oidc_token_digest');
    expect(JSON.stringify(projection)).not.toContain(rawCanary);
  });
});
