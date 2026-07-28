import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  ProductionDeploymentEvidenceManifestV1Schema,
  type ProductionDeploymentEvidenceManifestV1,
} from '../src/domain/production-deployment-evidence.js';
import { verifyProductionDeploymentEvidence } from '../src/pilot/production-deployment-evidence-verifier.js';

const REPOSITORY = 'example/production-deployment';
const CONTROL_TOKEN = 'CANARY_PRODUCTION_DEPLOYMENT_CONTROL_TOKEN';
const GITHUB_TOKEN = 'CANARY_PRODUCTION_DEPLOYMENT_GITHUB_TOKEN';
const WORKFLOW_PATH = '.github/workflows/delivery-production-deploy.yml';
const API_ORIGIN = 'https://api.github.test';

async function manifest(): Promise<ProductionDeploymentEvidenceManifestV1> {
  const states: Array<ProductionDeploymentEvidenceManifestV1['cases'][number]['externalState']> = [
    'in_progress', 'success', 'failure', 'error',
  ];
  const cases = await Promise.all(states.map(async (state, index) => {
    const runVersion = 8;
    const terminal = state !== 'in_progress';
    const actionConclusion = state === 'in_progress' ? null :
      state === 'failure' ? 'success' : state === 'error' ? 'failure' : 'success';
    const deploymentId = `production-deployment-evidence-${state}`;
    const githubDeploymentId = String(7100 + index);
    const actionRunId = String(9100 + index);
    const externalUpdatedAt = `2026-07-26T14:0${index}:00.000Z`;
    const webhookDigest = await canonicalSha256({ state, source: 'webhook' });
    const apiDigest = await canonicalSha256({ state, source: 'api' });
    return {
      caseId: `production-deployment-case-${state}`,
      runId: `run-production-deployment-${state}`,
      runVersion,
      currentRunVersion: terminal ? runVersion + 1 : runVersion,
      runState: state === 'in_progress' ? 'deploying' : state === 'success' ? 'succeeded' : 'failed',
      repository: REPOSITORY,
      taskRevision: `revision-${state}`,
      planId: `plan-production-deployment-${state}`,
      planVersion: 1,
      planDigest: `sha256:${String.fromCharCode(97 + index).repeat(64)}`,
      attemptId: `attempt-production-deployment-${state}`,
      approvalId: `approval-production-deployment-${state}`,
      deploymentId,
      githubDeploymentId,
      mergeId: `merge-production-deployment-${state}`,
      mergeSha: `${String(index + 1).repeat(40)}`,
      baseSha: `${String(index + 5).repeat(40)}`,
      environment: 'production' as const,
      workflowPath: WORKFLOW_PATH,
      oidcAudience: 'delivery-loop-production-deploy' as const,
      roleRef: 'production:delivery-loop-deployer',
      oidcAttestationId: terminal ? `attestation-production-${state}` : null,
      oidcGithubRunId: terminal ? actionRunId : null,
      oidcSubject: terminal ? `repo:${REPOSITORY}:environment:production` : null,
      actionRunId,
      actionStatus: terminal ? 'completed' as const : 'in_progress' as const,
      actionConclusion,
      actionUrl: `https://github.com/${REPOSITORY}/actions/runs/${actionRunId}`,
      externalState: state,
      externalUpdatedAt,
      deploymentStatus: state === 'in_progress' ? 'in_progress' as const :
        state === 'success' ? 'succeeded' as const : 'failed' as const,
      environmentUrl: state === 'error' ? null : 'https://production.example.test/app',
      deploymentEvidenceId: terminal ? `evidence-production-${state}` : null,
      deploymentEvidenceStatus: terminal ? state === 'success' ? 'passed' as const : 'failed' as const : null,
      webhook: {
        id: `webhook-production-${state}`,
        sourceKind: 'webhook' as const,
        digest: webhookDigest,
        state: 'applied' as const,
        observedAt: externalUpdatedAt,
      },
      apiObservation: {
        id: `api-production-${state}`,
        sourceKind: 'api' as const,
        digest: apiDigest,
        state: 'applied' as const,
        observedAt: new Date(Date.parse(externalUpdatedAt) + 1_000).toISOString(),
      },
      noDuplicate: {
        attempts: 1 as const,
        deployments: 1 as const,
        deployOutboxes: 1 as const,
        deploymentEvidence: terminal ? 1 as const : 0 as const,
      },
    } as ProductionDeploymentEvidenceManifestV1['cases'][number];
  }));
  return {
    schemaVersion: '1',
    evidenceId: 'production-deployment-evidence-test',
    repository: REPOSITORY,
    recordedAt: '2026-07-26T14:10:00.000Z',
    cases,
  };
}

function audit(input: ProductionDeploymentEvidenceManifestV1, index: number) {
  const item = input.cases[index]!;
  const terminal = item.externalState !== 'in_progress';
  return {
    schemaVersion: '1',
    run: { id: item.runId, version: item.currentRunVersion, state: item.runState },
    task: { repository: REPOSITORY, revision: item.taskRevision },
    answers: {
      who: {
        attempts: [{
          attemptId: item.attemptId, mode: 'deploy',
          status: terminal ? item.externalState === 'success' ? 'completed' : 'failed' : 'running',
        }],
      },
      deployments: [{
        kind: 'production', deploymentId: item.deploymentId, runVersion: item.runVersion,
        planId: item.planId, planVersion: item.planVersion, planDigest: item.planDigest,
        attemptId: item.attemptId, approvalId: item.approvalId, repository: REPOSITORY,
        environment: 'production', roleRef: item.roleRef,
        status: item.deploymentStatus, sha: item.mergeSha,
        githubDeploymentId: item.githubDeploymentId, workflowPath: item.workflowPath,
        oidcAudience: item.oidcAudience, oidcAttestationId: item.oidcAttestationId,
        oidcGithubRunId: item.oidcGithubRunId, oidcSubject: item.oidcSubject,
        evidenceId: item.deploymentEvidenceId, externalState: item.externalState,
        externalUpdatedAt: item.externalUpdatedAt, url: item.environmentUrl,
      }],
      checks: {
        evidence: terminal ? [{
          evidenceId: item.deploymentEvidenceId, kind: 'deployment',
          status: item.deploymentEvidenceStatus, verificationStatus: 'verified',
          sha: item.mergeSha, url: item.environmentUrl,
        }] : [],
        productionDeploymentObservations: [item.webhook, item.apiObservation].map((observation) => ({
          observationId: observation.id, sourceKind: observation.sourceKind,
          factDigest: observation.digest, deploymentId: item.deploymentId,
          processingState: observation.state, observedAt: observation.observedAt,
        })),
        effectOutboxes: [{ id: `outbox-${item.deploymentId}`, kind: 'production_deploy', state: 'settled' }],
      },
    },
  };
}

function githubFetch(
  input: ProductionDeploymentEvidenceManifestV1,
  drift: 'none' | 'status' | 'action' = 'none',
): typeof fetch {
  return (async (request) => {
    const url = new URL(String(request));
    if (url.origin === 'https://control.example') {
      const runId = url.pathname.split('/').at(-2);
      const index = input.cases.findIndex((item) => item.runId === runId);
      if (index < 0) return new Response('missing', { status: 404 });
      return Response.json(audit(input, index));
    }
    const index = input.cases.findIndex((item) => url.pathname.endsWith(`/runs/${item.actionRunId}`));
    const item = index < 0
      ? input.cases.find((candidate) => url.pathname.includes(`/deployments/${candidate.githubDeploymentId}`))!
      : input.cases[index]!;
    if (url.pathname.includes('/actions/runs/')) {
      return Response.json({
        id: Number(item.actionRunId), event: drift === 'action' ? 'workflow_dispatch' : 'deployment',
        status: item.actionStatus, conclusion: item.actionConclusion, head_sha: item.mergeSha,
        head_branch: 'main', path: WORKFLOW_PATH,
        display_title: `delivery-loop/production/${item.githubDeploymentId}`,
        run_attempt: 1, updated_at: item.externalUpdatedAt, repository: { full_name: REPOSITORY },
      });
    }
    if (url.pathname.endsWith('/statuses')) {
      return Response.json([{
        state: drift === 'status' && item.externalState === 'success' ? 'failure' : item.externalState,
        environment: 'production', environment_url: item.environmentUrl,
        deployment_url: `${API_ORIGIN}/repos/${REPOSITORY}/deployments/${item.githubDeploymentId}`,
        updated_at: item.externalUpdatedAt,
      }]);
    }
    return Response.json({
      id: Number(item.githubDeploymentId), sha: item.mergeSha,
      task: 'delivery-loop:production', environment: 'production',
      payload: { schema_version: '1', delivery_production_deployment_id: item.deploymentId },
    });
  }) as typeof fetch;
}

describe('production deployment external evidence', () => {
  it('verifies all four platform states and keeps Action output subordinate to status', async () => {
    const input = await manifest();
    expect(ProductionDeploymentEvidenceManifestV1Schema.safeParse(input).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/production-deployment-evidence-v1.example.json', import.meta.url), 'utf8',
    )) as unknown;
    expect(ProductionDeploymentEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(ProductionDeploymentEvidenceManifestV1Schema.safeParse({ ...input, raw: 'SECRET' }).success).toBe(false);
    await expect(verifyProductionDeploymentEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: API_ORIGIN, fetch: githubFetch(input),
    })).resolves.toEqual({
      schemaVersion: '1', evidenceId: input.evidenceId, repository: REPOSITORY,
      caseCount: 4, inProgressCases: 1, succeededCases: 1, failedCases: 2,
      verifiedActionCount: 4, verifiedDeploymentCount: 4, verifiedEvidenceCount: 3,
      duplicateDeployments: 0,
    });
  });

  it('rejects platform status/action drift and never exposes raw response or tokens', async () => {
    const input = await manifest();
    await expect(verifyProductionDeploymentEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: API_ORIGIN, fetch: githubFetch(input, 'status'),
    })).rejects.toMatchObject({ code: 'github_deployment_mismatch' });
    await expect(verifyProductionDeploymentEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: API_ORIGIN, fetch: githubFetch(input, 'action'),
    })).rejects.toMatchObject({ code: 'github_api_unavailable' });
    const raw = 'CANARY_PRODUCTION_DEPLOYMENT_RAW_RESPONSE';
    const error = await verifyProductionDeploymentEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: API_ORIGIN,
      fetch: async () => new Response(raw, { status: 503 }),
    }).catch((value: unknown) => value);
    expect(String(error)).not.toContain(raw);
    expect(String(error)).not.toContain(CONTROL_TOKEN);
    expect(String(error)).not.toContain(GITHUB_TOKEN);
  });

  it('keeps the Watt-derived CLI opt-in before manifest or network access', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_PRODUCTION_DEPLOYMENT_E2E;
    const result = spawnSync(
      'pnpm', ['exec', 'tsx', 'scripts/verify-production-deployment-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('production-deployment-e2e: opt-in missing');
  });
});
