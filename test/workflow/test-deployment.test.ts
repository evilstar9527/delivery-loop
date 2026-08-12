/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { importJWK, SignJWT, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256, sha256Bytes } from '../../src/domain/digest.js';
import type { TestDeploymentTarget } from '../../src/domain/test-deployment.js';
import {
  TestDeploymentOutboxProcessor,
  type GitHubTestDeploymentRequest,
} from '../../src/outbox/github-test-deployment.js';
import {
  GitHubTestDeploymentStatusError,
  GitHubTestDeploymentStatusStore,
} from '../../src/storage/github-test-deployment-status-store.js';
import { GitHubTestDeploymentStatusReconciler } from '../../src/reconciliation/github-test-deployment-status-reconciler.js';
import { TestDeploymentOidcStore } from '../../src/storage/test-deployment-oidc-store.js';
import { TestDeploymentStore } from '../../src/storage/test-deployment-store.js';
import { TaskQueryStore } from '../../src/storage/task-query-store.js';
import { CorrelationQueryStore } from '../../src/storage/correlation-query-store.js';

const NOW = new Date('2026-07-26T01:00:00.000Z');
const RUN_ID = 'run-test-deployment';
const PLAN_ID = 'plan-test-deployment';
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const PLAN_DIGEST = `sha256:${'c'.repeat(64)}`;
const TARGET: TestDeploymentTarget = {
  repository: 'example/repo',
  provider: 'github_actions',
  environment: 'test',
  workflowPath: '.github/workflows/delivery-test-deploy.yml',
  oidcAudience: 'delivery-loop-test-deploy',
  roleRef: 'test:delivery-loop-deployer',
};
const BASE_URL = 'https://delivery-loop.test';
const WEBHOOK_SECRET = 'test-github-webhook-secret';
let oidcPrivateKey: Awaited<ReturnType<typeof importJWK>>;

beforeAll(async () => {
  oidcPrivateKey = await importJWK(
    JSON.parse(env.TEST_GITHUB_OIDC_PRIVATE_JWK) as JWK,
    'RS256',
  );
});

async function oidcToken(overrides: Record<string, unknown> = {}, audience =
'delivery-loop-test-deploy'): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const repository = String(overrides.repository ?? 'example/repo');
  const environment = String(overrides.environment ?? 'test');
  return await new SignJWT({
    repository,
    job_workflow_ref:
      'example/repo/.github/workflows/delivery-test-deploy.yml@refs/heads/main',
    sha: HEAD_SHA,
    run_id: '9003',
    environment,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'delivery-loop-test-github-oidc' })
    .setIssuer('https://token.actions.githubusercontent.com')
    .setAudience(audience)
    .setSubject(String(
      overrides.sub ?? `repo:${repository}:environment:${environment}`,
    ))
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

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
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

async function seed(): Promise<void> {
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
         'task-test-deployment', 'manual', 'deploy-test', 'deploy-test', 'rev-1', ?,
         'r2://tasks/deploy-test', 'user', 'principal-requester', 'example/repo',
         'main', 'test', 'requirement', 'Deploy to test', 'p1', 1, 1, 1, 0, 1, ?, ?
       )`,
    ).bind(`sha256:${'d'.repeat(64)}`, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, 'task-test-deployment', 'rev-1', ?, ?, ?, 'executing', 5,
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
       ) VALUES ('attempt-analysis-deploy', ?, 1, 'analysis', 'completed', ?,
                 'example/repo',
                 'example/repo/.github/workflows/delivery-agent.yml@refs/heads/main',
                 1, 0, ?, ?)`,
    ).bind(RUN_ID, BASE_SHA, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, 'rev-1', ?, ?, 'active', 'attempt-analysis-deploy',
                 'Ship the verified head to the isolated test Environment.', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, now, now),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES (?, 'change', 'change', 'Change', 'Produce a verified head.', 1, 0)`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES (?, 'deploy-test', 'delivery', 'Deploy test', 'Deploy exact head.', 1, 1)`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (plan_id, item_id, status, version, updated_at)
       VALUES (?, 'change', 'passed', 2, ?)`,
    ).bind(PLAN_ID, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (plan_id, item_id, status, version, updated_at)
       VALUES (?, 'deploy-test', 'ready', 1, ?)`,
    ).bind(PLAN_ID, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_dependencies (plan_id, item_id, depends_on_item_id)
       VALUES (?, 'deploy-test', 'change')`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_done_when (plan_id, item_id, position, condition)
       VALUES (?, 'deploy-test', 0, 'Signed test deployment status is successful.')`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, 'deploy-test', 'test_deploy')`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_evidence_kinds (plan_id, item_id, evidence_kind)
       VALUES (?, 'deploy-test', 'deployment')`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_external_facts (plan_id, item_id, external_fact)
       VALUES (?, 'deploy-test', 'deployment')`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, head_sha,
         repository, workflow_ref, plan_id, plan_version, plan_item_id,
         claimed_progress_version, version, lease_generation, created_at, updated_at
       ) VALUES ('attempt-implemented-head', ?, 2, 'implement', 'completed', ?, ?,
                 'example/repo',
                 'example/repo/.github/workflows/delivery-agent.yml@refs/heads/main',
                 ?, 1, 'change', 1, 3, 2, ?, ?)`,
    ).bind(RUN_ID, BASE_SHA, HEAD_SHA, PLAN_ID, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_verifications (
         verification_id, run_id, plan_id, plan_version, plan_item_id,
         attempt_id, head_sha, progress_version, evidence_set_digest, status, created_at
       ) VALUES ('verification-implemented-head', ?, ?, 1, 'change',
                 'attempt-implemented-head', ?, 1, ?, 'passed', ?)`,
    ).bind(RUN_ID, PLAN_ID, HEAD_SHA, `sha256:${'e'.repeat(64)}`, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-test-deploy', ?, 'rev-1', ?, 1, ?, ?, 'test_deploy',
                 'principal-approver', 'approve', ?, ?, ?)`,
    ).bind(
      RUN_ID,
      PLAN_ID,
      PLAN_DIGEST,
      BASE_SHA,
      `sha256:${'f'.repeat(64)}`,
      new Date(NOW.getTime() + 24 * 60 * 60_000).toISOString(),
      now,
    ),
  ]);
}

function scheduleInput(): Record<string, unknown> {
  return {
    runId: RUN_ID,
    expectedRunVersion: 5,
    planVersion: 1,
    planItemId: 'deploy-test',
    expectedProgressVersion: 1,
  };
}

async function scheduleAndCreate(): Promise<{
  deploymentId: string;
  attemptId: string;
}> {
  const scheduled = await new TestDeploymentStore(env.DB_CONTROL).schedule(
    scheduleInput(),
    TARGET,
    NOW,
  );
  const ensure = vi.fn(async (request: GitHubTestDeploymentRequest) => {
    expect(request).toEqual({
      deploymentId: scheduled.deploymentId,
      repository: 'example/repo',
      refSha: HEAD_SHA,
      environment: 'test',
    });
    return { disposition: 'created' as const, githubDeploymentId: '7001' };
  });
  const processor = new TestDeploymentOutboxProcessor(env.DB_CONTROL, {
    ensureTestDeployment: ensure,
  }, { now: () => NOW, generateLeaseToken: () => 'deployment-outbox-lease' });
  await expect(processor.deliver(scheduled.outboxId)).resolves.toBe('settled');
  expect(ensure).toHaveBeenCalledOnce();
  return { deploymentId: scheduled.deploymentId, attemptId: scheduled.attemptId };
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('test deployment control-plane contract', () => {
  it('converges 20 schedulers and outbox deliveries to one deploy Attempt and one GitHub effect', async () => {
    const store = new TestDeploymentStore(env.DB_CONTROL);
    const scheduled = await Promise.all(
      Array.from({ length: 20 }, () => store.schedule(scheduleInput(), TARGET, NOW)),
    );
    expect(new Set(scheduled.map((result) => result.deploymentId))).toHaveLength(1);
    expect(scheduled.filter((result) => result.created)).toHaveLength(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts WHERE run_id = ? AND mode = 'deploy'`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM test_deployments WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox
       WHERE run_id = ? AND destination = 'github_deployments'`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });

    const ensure = vi.fn(async () => ({
      disposition: 'created' as const,
      githubDeploymentId: '7001',
    }));
    const processor = new TestDeploymentOutboxProcessor(env.DB_CONTROL, {
      ensureTestDeployment: ensure,
    }, { now: () => NOW, generateLeaseToken: () => 'deployment-outbox-lease' });
    const deliveries = await Promise.all(
      Array.from({ length: 20 }, () => processor.deliver(scheduled[0]!.outboxId)),
    );
    expect(deliveries.every((result) => result === 'settled' || result === 'busy')).toBe(true);
    expect(ensure).toHaveBeenCalledOnce();
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, github_deployment_id, evidence_id
       FROM test_deployments WHERE deployment_id = ?`,
    ).bind(scheduled[0]!.deploymentId).first()).toEqual({
      status: 'created_unverified',
      github_deployment_id: '7001',
      evidence_id: null,
    });
  });

  it('requires exact test Environment OIDC before success and stores only its digest', async () => {
    const { deploymentId } = await scheduleAndCreate();
    const fact = {
      repository: 'example/repo',
      githubDeploymentId: '7001',
      deploymentId,
      sha: HEAD_SHA,
      task: 'delivery-loop:test' as const,
      environment: 'test' as const,
      state: 'success' as const,
      environmentUrl: 'https://test.example.test/app',
      externalUpdatedAt: new Date(NOW.getTime() + 60_000).toISOString(),
    };
    const statusStore = new GitHubTestDeploymentStatusStore(env.DB_CONTROL);
    await expect(statusStore.apply({
      deliveryId: '12345678-1234-1234-1234-1234567890aa',
      payloadDigest: `sha256:${'1'.repeat(64)}`,
      fact,
      receivedAt: fact.externalUpdatedAt,
    })).rejects.toMatchObject({
      name: GitHubTestDeploymentStatusError.name,
      code: 'attestation_required',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM evidence WHERE kind = 'deployment'`,
    ).first()).toEqual({ count: 0 });

    const rawOidc = 'CANARY_RAW_TEST_DEPLOYMENT_OIDC';
    const oidc = new TestDeploymentOidcStore(env.DB_CONTROL);
    await expect(oidc.attest(deploymentId, rawOidc, {
      repository: 'example/repo',
      workflowRef:
        'example/repo/.github/workflows/delivery-test-deploy.yml@refs/heads/main',
      sha: HEAD_SHA,
      runId: '9001',
      subject: 'repo:example/repo:environment:test',
      environment: 'test',
    }, NOW)).resolves.toMatchObject({ accepted: true, disposition: 'created' });
    const stored = await env.DB_CONTROL.prepare(
      `SELECT oidc_token_digest, repository, environment, audience
       FROM test_deployment_oidc_attestations WHERE deployment_id = ?`,
    ).bind(deploymentId).first();
    expect(stored).toEqual({
      oidc_token_digest: await canonicalSha256(rawOidc),
      repository: 'example/repo',
      environment: 'test',
      audience: 'delivery-loop-test-deploy',
    });
    expect(JSON.stringify(stored)).not.toContain(rawOidc);
  });

  it('revalidates the latest approval before GitHub I/O and blocks a delayed reject', async () => {
    const scheduled = await new TestDeploymentStore(env.DB_CONTROL).schedule(
      scheduleInput(),
      TARGET,
      NOW,
    );
    await env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-test-deploy-reject', ?, 'rev-1', ?, 1, ?, ?,
                 'test_deploy', 'principal-approver', 'reject', ?, ?, ?)`,
    ).bind(
      RUN_ID,
      PLAN_ID,
      PLAN_DIGEST,
      BASE_SHA,
      `sha256:${'9'.repeat(64)}`,
      new Date(NOW.getTime() + 24 * 60 * 60_000).toISOString(),
      new Date(NOW.getTime() + 1_000).toISOString(),
    ).run();
    const ensure = vi.fn(async () => ({
      disposition: 'created' as const,
      githubDeploymentId: '7001',
    }));
    const processor = new TestDeploymentOutboxProcessor(env.DB_CONTROL, {
      ensureTestDeployment: ensure,
    }, { now: () => NOW, generateLeaseToken: () => 'deployment-reject-lease' });
    await expect(processor.deliver(scheduled.outboxId)).resolves.toBe('retry');
    expect(ensure).not.toHaveBeenCalled();
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, github_deployment_id FROM test_deployments
       WHERE deployment_id = ?`,
    ).bind(scheduled.deploymentId).first()).toEqual({
      status: 'scheduled',
      github_deployment_id: null,
    });
  });

  it('projects one signed success Evidence under 20 replays and closes only the deployment Item', async () => {
    const { deploymentId } = await scheduleAndCreate();
    await new TestDeploymentOidcStore(env.DB_CONTROL).attest(deploymentId, 'oidc-success', {
      repository: 'example/repo',
      workflowRef:
        'example/repo/.github/workflows/delivery-test-deploy.yml@refs/heads/main',
      sha: HEAD_SHA,
      runId: '9002',
      subject: 'repo:example/repo:environment:test',
      environment: 'test',
    }, NOW);
    const externalUpdatedAt = new Date(NOW.getTime() + 60_000).toISOString();
    const delivery = {
      deliveryId: '12345678-1234-1234-1234-1234567890bb',
      payloadDigest: `sha256:${'2'.repeat(64)}`,
      fact: {
        repository: 'example/repo',
        githubDeploymentId: '7001',
        deploymentId,
        sha: HEAD_SHA,
        task: 'delivery-loop:test' as const,
        environment: 'test' as const,
        state: 'success' as const,
        environmentUrl: 'https://test.example.test/app',
        externalUpdatedAt,
      },
      receivedAt: externalUpdatedAt,
    };
    const store = new GitHubTestDeploymentStatusStore(env.DB_CONTROL);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.apply(delivery)),
    );
    expect(results.filter((result) => result === 'applied').length).toBeGreaterThan(0);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM evidence
       WHERE run_id = ? AND kind = 'deployment' AND status = 'passed'`,
    ).bind(RUN_ID).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, external_url, evidence_id
       FROM test_deployments WHERE deployment_id = ?`,
    ).bind(deploymentId).first()).toMatchObject({
      status: 'succeeded',
      external_url: 'https://test.example.test/app',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, active_attempt_id FROM plan_item_progress
       WHERE plan_id = ? AND item_id = 'deploy-test'`,
    ).bind(PLAN_ID).first()).toEqual({ status: 'passed', active_attempt_id: null });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'executing' });
    const projection = await new TaskQueryStore(env.DB_CONTROL).getRunPlanStatus(RUN_ID);
    expect(projection?.run).toMatchObject({
      testDeployments: [{
        id: deploymentId,
        environment: 'test',
        status: 'succeeded',
        refSha: HEAD_SHA,
        roleRef: 'test:delivery-loop-deployer',
        githubDeploymentId: '7001',
        url: 'https://test.example.test/app',
      }],
    });
    expect(JSON.stringify(projection)).not.toContain('oidc_token_digest');
    await expect(new CorrelationQueryStore(env.DB_CONTROL).resolve({
      kind: 'github_deployment',
      id: '7001',
      repository: 'example/repo',
    })).resolves.toMatchObject({
      correlationId: RUN_ID,
      deployments: [{ kind: 'test', id: deploymentId, status: 'succeeded' }],
      githubRuns: [{ kind: 'test_deployment', id: '9002', deploymentId }],
    });
  });

  it('records failed deployment Evidence without marking the Run successful', async () => {
    const { deploymentId } = await scheduleAndCreate();
    const externalUpdatedAt = new Date(NOW.getTime() + 60_000).toISOString();
    await expect(new GitHubTestDeploymentStatusStore(env.DB_CONTROL).apply({
      deliveryId: '12345678-1234-1234-1234-1234567890cc',
      payloadDigest: `sha256:${'3'.repeat(64)}`,
      fact: {
        repository: 'example/repo',
        githubDeploymentId: '7001',
        deploymentId,
        sha: HEAD_SHA,
        task: 'delivery-loop:test',
        environment: 'test',
        state: 'failure',
        environmentUrl: null,
        externalUpdatedAt,
      },
      receivedAt: externalUpdatedAt,
    })).resolves.toBe('applied');
    expect(await env.DB_CONTROL.prepare(
      `SELECT status FROM evidence WHERE run_id = ? AND kind = 'deployment'`,
    ).bind(RUN_ID).first()).toEqual({ status: 'failed' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status FROM plan_item_progress
       WHERE plan_id = ? AND item_id = 'deploy-test'`,
    ).bind(PLAN_ID).first()).toEqual({ status: 'failed' });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'executing' });
  });

  it('cryptographically accepts only the dedicated audience and exact test Environment subject', async () => {
    const { deploymentId } = await scheduleAndCreate();
    const endpoint = `${BASE_URL}/v1/test-deployments/${deploymentId}/oidc-attestation`;
    const invalidTokens = [
      await oidcToken({}, 'delivery-loop-control-plane'),
      await oidcToken({ sub: 'repo:example/repo:ref:refs/heads/main' }),
      await oidcToken({ environment: 'production' }),
      await oidcToken({
        job_workflow_ref:
          'example/repo/.github/workflows/delivery-production-deploy.yml@refs/heads/main',
      }),
    ];
    const invalidResponses = await Promise.all(invalidTokens.map(async (token) =>
      await SELF.fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })));
    expect(invalidResponses.map((response) => response.status)).toEqual([401, 403, 403, 403]);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM test_deployment_oidc_attestations',
    ).first()).toEqual({ count: 0 });

    const valid = await SELF.fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${await oidcToken()}` },
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({ accepted: true, disposition: 'created' });
    expect(valid.headers.get('cache-control')).toBe('no-store');
  });

  it('turns a signed deployment_status into sanitized URL Evidence without retaining raw payload', async () => {
    const { deploymentId } = await scheduleAndCreate();
    const attestation = await SELF.fetch(
      `${BASE_URL}/v1/test-deployments/${deploymentId}/oidc-attestation`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${await oidcToken()}` },
      },
    );
    expect(attestation.status).toBe(200);
    const rawCanary = 'CANARY_DEPLOYMENT_WEBHOOK_RAW_PAYLOAD';
    const payload = {
      deployment_status: {
        state: 'success',
        environment: 'test',
        environment_url: `https://test.example.test/app?token=${rawCanary}#fragment`,
        updated_at: new Date(NOW.getTime() + 60_000).toISOString(),
      },
      deployment: {
        id: 7001,
        sha: HEAD_SHA,
        task: 'delivery-loop:test',
        environment: 'test',
        payload: { schema_version: '1', delivery_deployment_id: deploymentId },
      },
      repository: { full_name: 'example/repo' },
      sender: { login: rawCanary },
    };
    const body = JSON.stringify(payload);
    const response = await SELF.fetch(`${BASE_URL}/v1/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': '12345678-1234-1234-1234-1234567890dd',
        'x-github-event': 'deployment_status',
        'x-hub-signature-256': await webhookSignature(body),
      },
      body,
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, disposition: 'applied' });
    const rows = await env.DB_CONTROL.prepare(
      `SELECT deployments.external_url, evidence.external_url AS evidence_url,
              deliveries.payload_digest, deliveries.processing_state
       FROM test_deployments AS deployments
       JOIN evidence ON evidence.evidence_id = deployments.evidence_id
       JOIN github_test_deployment_webhook_deliveries AS deliveries
         ON deliveries.deployment_id = deployments.deployment_id
       WHERE deployments.deployment_id = ?`,
    ).bind(deploymentId).first();
    expect(rows).toEqual({
      external_url: 'https://test.example.test/app',
      evidence_url: 'https://test.example.test/app',
      payload_digest: await sha256Bytes(new TextEncoder().encode(body)),
      processing_state: 'applied',
    });
    expect(JSON.stringify(rows)).not.toContain(rawCanary);
  });

  it('repairs a missed deployment_status webhook from the read-only GitHub fact', async () => {
    const { deploymentId } = await scheduleAndCreate();
    await new TestDeploymentOidcStore(env.DB_CONTROL).attest(deploymentId, 'api-oidc', {
      repository: 'example/repo',
      workflowRef:
        'example/repo/.github/workflows/delivery-test-deploy.yml@refs/heads/main',
      sha: HEAD_SHA,
      runId: '9003',
      subject: 'repo:example/repo:environment:test',
      environment: 'test',
    }, NOW);
    const externalUpdatedAt = new Date(NOW.getTime() + 60_000).toISOString();
    const fact = {
      repository: 'example/repo',
      githubDeploymentId: '7001',
      deploymentId,
      sha: HEAD_SHA,
      task: 'delivery-loop:test' as const,
      environment: 'test' as const,
      state: 'success' as const,
      environmentUrl: 'https://test.example.test/app',
      externalUpdatedAt,
    };
    const getTestDeploymentStatus = vi.fn(async () => fact);
    const reconciler = new GitHubTestDeploymentStatusReconciler(
      env.DB_CONTROL,
      { getTestDeploymentStatus },
      () => new Date(externalUpdatedAt),
    );

    const results = await Promise.all(
      Array.from({ length: 20 }, () => reconciler.reconcileDeployment(deploymentId)),
    );
    expect(results.some((result) => result === 'applied')).toBe(true);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM github_test_deployment_status_observations
       WHERE source_kind = 'api' AND processing_state = 'applied'`,
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT status FROM test_deployments WHERE deployment_id = ?',
    ).bind(deploymentId).first()).toEqual({ status: 'succeeded' });
    expect(await env.DB_CONTROL.prepare(
      'SELECT state FROM runs WHERE run_id = ?',
    ).bind(RUN_ID).first()).toEqual({ state: 'executing' });
    expect(getTestDeploymentStatus).toHaveBeenCalled();
  });
});
