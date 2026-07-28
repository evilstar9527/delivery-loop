import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  TestDeploymentEvidenceManifestV1Schema,
  type TestDeploymentEvidenceManifestV1,
} from '../src/domain/test-deployment-evidence.js';
import { verifyTestDeploymentEvidence } from '../src/pilot/test-deployment-evidence-verifier.js';

const REPOSITORY = 'example/test-deployment';
const SHA = 'a'.repeat(40);
const CONTROL_TOKEN = 'CANARY_TEST_DEPLOYMENT_CONTROL_TOKEN';
const GITHUB_TOKEN = 'CANARY_TEST_DEPLOYMENT_GITHUB_TOKEN';
const ENVIRONMENT_URL = 'https://test.example.test/app';

async function manifest(): Promise<TestDeploymentEvidenceManifestV1> {
  const webhookFactDigest = await canonicalSha256({ source: 'webhook', state: 'success' });
  const apiFactDigest = await canonicalSha256({ source: 'api', state: 'success' });
  return {
    schemaVersion: '1',
    evidenceId: 'test-deployment-evidence-test',
    repository: REPOSITORY,
    recordedAt: '2026-07-26T13:20:00.000Z',
    cases: [{
      caseId: 'test-deployment-success-case',
      runId: 'run-test-deployment-evidence',
      runVersion: 8,
      currentRunVersion: 9,
      repository: REPOSITORY,
      planId: 'plan-test-deployment-evidence',
      planVersion: 1,
      planDigest: `sha256:${'b'.repeat(64)}`,
      planItemId: 'deploy-test',
      attemptId: 'attempt-test-deployment-evidence',
      approvalId: 'approval-test-deployment-evidence',
      deploymentId: 'deployment-test-deployment-evidence',
      githubDeploymentId: '7001',
      refSha: SHA,
      environment: 'test',
      workflowPath: '.github/workflows/delivery-test-deploy.yml',
      oidcAudience: 'delivery-loop-test-deploy',
      oidcSubject: `repo:${REPOSITORY}:environment:test`,
      roleRef: 'test:delivery-loop-deployer',
      oidcAttestationId: 'attestation-test-deployment-evidence',
      oidcGithubRunId: '9001',
      actionRunId: '9002',
      actionConclusion: 'success',
      actionUrl: `https://github.com/${REPOSITORY}/actions/runs/9002`,
      deploymentEvidenceId: 'evidence-test-deployment-evidence',
      outcome: 'succeeded',
      externalState: 'success',
      environmentUrl: ENVIRONMENT_URL,
      webhook: {
        id: 'delivery-test-deployment-evidence',
        digest: webhookFactDigest,
        state: 'applied',
        observedAt: '2026-07-26T13:18:00.000Z',
      },
      apiObservation: {
        id: 'api-test-deployment-evidence',
        digest: apiFactDigest,
        state: 'applied',
        observedAt: '2026-07-26T13:19:00.000Z',
      },
      noDuplicate: { attempts: 1, deployments: 1, deployOutboxes: 1, deploymentEvidence: 1 },
      audit: {
        oidcAuditUrl: 'https://audit.example.test/oidc/test-deployment',
        productionSecretIsolationEvidenceUrl: 'https://audit.example.test/isolation/test-only',
      },
    }],
  };
}

function audit(input: TestDeploymentEvidenceManifestV1, drift: 'none' | 'projection' = 'none') {
  const item = input.cases[0]!;
  return {
    schemaVersion: '1',
    run: { id: item.runId, version: item.currentRunVersion, state: 'executing' },
    task: { target: { repository: REPOSITORY } },
    answers: {
      who: { attempts: [{ attemptId: item.attemptId, mode: 'deploy', status: 'running' }] },
      deployments: [{
        kind: 'test', deploymentId: item.deploymentId, runVersion: item.runVersion,
        planId: item.planId,
        planVersion: item.planVersion, planDigest: item.planDigest, itemId: item.planItemId,
        attemptId: item.attemptId, approvalId: item.approvalId, repository: REPOSITORY,
        environment: 'test', roleRef: item.roleRef, status: 'succeeded', sha: SHA,
        githubDeploymentId: item.githubDeploymentId, workflowPath: item.workflowPath,
        oidcAudience: item.oidcAudience, oidcAttestationId: item.oidcAttestationId,
        oidcGithubRunId: item.oidcGithubRunId, oidcSubject: item.oidcSubject,
        evidenceId: item.deploymentEvidenceId, url: ENVIRONMENT_URL,
      }],
      checks: {
        evidence: [{
          evidenceId: item.deploymentEvidenceId, kind: 'deployment', status: 'passed',
          verificationStatus: 'verified', sha: SHA, url: ENVIRONMENT_URL,
        }],
        testDeploymentObservations: [
          {
            observationId: item.webhook.id, sourceKind: 'webhook', factDigest: item.webhook.digest,
            deploymentId: item.deploymentId, processingState: item.webhook.state,
            observedAt: item.webhook.observedAt,
          },
          {
            observationId: item.apiObservation.id, sourceKind: 'api', factDigest: item.apiObservation.digest,
            deploymentId: item.deploymentId, processingState: item.apiObservation.state,
            observedAt: item.apiObservation.observedAt,
          },
        ],
        effectOutboxes: [{ id: 'outbox-test-deployment-evidence', kind: 'test_deploy', state: 'settled' }],
      },
    },
    ...(drift === 'projection' ? { extra: 'ignored' } : {}),
  };
}

function githubFetch(input: TestDeploymentEvidenceManifestV1, drift: 'none' | 'status' | 'action' = 'none'): typeof fetch {
  const item = input.cases[0]!;
  return (async (request) => {
    const url = new URL(String(request));
    if (url.origin === 'https://control.example') return Response.json(audit(input));
    if (url.pathname.endsWith('/actions/runs/9002')) {
      return Response.json({
        id: 9002, event: drift === 'action' ? 'workflow_dispatch' : 'deployment',
        status: 'completed', conclusion: 'success', head_sha: SHA, head_branch: 'main',
        path: '.github/workflows/delivery-test-deploy.yml',
        display_title: `delivery-loop/test/${item.githubDeploymentId}`,
        run_attempt: 1, updated_at: '2026-07-26T13:17:00.000Z',
        repository: { full_name: REPOSITORY },
      });
    }
    if (url.pathname.endsWith('/statuses')) {
      return Response.json([{
        state: drift === 'status' ? 'failure' : 'success', environment: 'test',
        environment_url: ENVIRONMENT_URL,
        deployment_url: 'https://api.github.test/repos/example/test-deployment/deployments/7001',
        updated_at: '2026-07-26T13:16:00.000Z',
      }]);
    }
    return Response.json({
      id: 7001, sha: SHA, task: 'delivery-loop:test', environment: 'test',
      payload: { schema_version: '1', delivery_deployment_id: item.deploymentId },
    });
  }) as typeof fetch;
}

describe('test deployment external evidence', () => {
  it('keeps strict manifest/example boundary and verifies OIDC, URL, Action and dual facts', async () => {
    const input = await manifest();
    expect(TestDeploymentEvidenceManifestV1Schema.safeParse(input).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/test-deployment-evidence-v1.example.json', import.meta.url), 'utf8',
    )) as unknown;
    expect(TestDeploymentEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(TestDeploymentEvidenceManifestV1Schema.safeParse({ ...input, raw: 'SECRET' }).success).toBe(false);
    await expect(verifyTestDeploymentEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: githubFetch(input),
    })).resolves.toEqual({
      schemaVersion: '1', evidenceId: input.evidenceId, repository: REPOSITORY,
      caseCount: 1, succeededCases: 1, failedCases: 0, verifiedActionCount: 1,
      verifiedDeploymentCount: 1, verifiedEvidenceCount: 1, duplicateDeployments: 0,
    });
  });

  it('rejects status/action drift and never exposes raw response or tokens', async () => {
    const input = await manifest();
    await expect(verifyTestDeploymentEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: githubFetch(input, 'status'),
    })).rejects.toMatchObject({ code: 'github_deployment_mismatch' });
    await expect(verifyTestDeploymentEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: githubFetch(input, 'action'),
    })).rejects.toMatchObject({ code: 'github_api_unavailable' });
    const raw = 'CANARY_TEST_DEPLOYMENT_RAW_RESPONSE';
    const error = await verifyTestDeploymentEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: async () => new Response(raw, { status: 503 }),
    }).catch((value: unknown) => value);
    expect(String(error)).not.toContain(raw);
    expect(String(error)).not.toContain(CONTROL_TOKEN);
    expect(String(error)).not.toContain(GITHUB_TOKEN);
  });

  it('keeps the Watt-derived CLI opt-in before manifest or network access', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_TEST_DEPLOYMENT_E2E;
    const result = spawnSync(
      'pnpm', ['exec', 'tsx', 'scripts/verify-test-deployment-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('test-deployment-e2e: opt-in missing');
  });
});
