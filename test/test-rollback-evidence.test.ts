import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  TestRollbackEvidenceManifestV1Schema,
  type TestRollbackEvidenceManifestV1,
} from '../src/domain/test-rollback-evidence.js';
import { verifyTestRollbackEvidence } from '../src/pilot/test-rollback-evidence-verifier.js';

const REPOSITORY = 'example/test-rollback';
const BASE_BRANCH = 'main';
const CONTROL_TOKEN = 'CANARY_TEST_ROLLBACK_CONTROL_TOKEN';
const GITHUB_TOKEN = 'CANARY_TEST_ROLLBACK_GITHUB_TOKEN';
const CANARY = 'github_pat_ROLLBACK_CANARY_abcdefghijklmnopqrstuvwxyz';
const WORKFLOW_PATH = '.github/workflows/delivery-test-rollback.yml';
const AUDIENCE = 'delivery-loop-test-rollback';

function digest(seed: number): string {
  const hex = seed.toString(16).padStart(2, '0');
  return `sha256:${hex.repeat(32)}`;
}

type SuccessfulRollback = TestRollbackEvidenceManifestV1['successfulRollbacks'][number];
type NegativeCase = TestRollbackEvidenceManifestV1['negativeCases'][number];
type ContractAbsentCase = TestRollbackEvidenceManifestV1['negativeCases'][0];
type ProductionFailureCase = TestRollbackEvidenceManifestV1['negativeCases'][1];

function successfulRollback(
  sourceKind: 'deployment_failure' | 'acceptance_failure',
  position: number,
): SuccessfulRollback {
  const suffix = sourceKind === 'deployment_failure' ? 'deployment' : 'acceptance';
  const refSha = (sourceKind === 'deployment_failure' ? 'a' : 'b').repeat(40);
  const actionRunId = String(9_100 + position);
  const deploymentId = `deployment-${suffix}`;
  const acceptanceId = sourceKind === 'acceptance_failure' ? `acceptance-${suffix}` : undefined;
  const sourceId = acceptanceId ?? deploymentId;
  const sourceEvidenceId = `evidence-source-${suffix}`;
  return {
    caseId: `rollback-case-${suffix}`,
    source: {
      kind: sourceKind,
      id: sourceId,
      evidenceId: sourceEvidenceId,
      failedAttemptId: `attempt-failed-${suffix}`,
      deploymentId,
      deploymentEvidenceId: sourceKind === 'deployment_failure'
        ? sourceEvidenceId
        : `evidence-deployment-${suffix}`,
      ...(acceptanceId === undefined ? {} : { acceptanceId }),
    },
    runId: `run-${suffix}`,
    runVersion: 12,
    currentRunVersion: 12,
    runState: 'executing',
    planId: `plan-${suffix}`,
    planVersion: 2,
    planDigest: digest(10 + position),
    planItemId: 'deploy-test',
    approvalId: `approval-${suffix}`,
    repository: REPOSITORY,
    baseBranch: BASE_BRANCH,
    baseSha: 'f'.repeat(40),
    refSha,
    contractObservationId: `rollback-contract-${suffix}`,
    policyDigest: digest(20 + position),
    contractDigest: digest(30 + position),
    workflowPath: WORKFLOW_PATH,
    environment: 'test',
    oidcAudience: AUDIENCE,
    roleRef: 'test:delivery-loop-rollback',
    rollbackId: `rollback-${suffix}`,
    rollbackAttemptId: `attempt-rollback-${suffix}`,
    rollbackStatus: 'succeeded',
    actionRunId,
    actionUrl: `https://github.com/${REPOSITORY}/actions/runs/${actionRunId}`,
    actionStatus: 'completed',
    actionConclusion: 'success',
    runner: {
      digest: digest(40 + position),
      status: 'passed',
      exitCode: 0,
      durationMs: 20_000 + position,
    },
    rollbackEvidenceId: `evidence-rollback-${suffix}`,
    oidc: {
      attestationId: `oidc-rollback-${suffix}`,
      githubRunId: actionRunId,
      workflowRef: `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/${BASE_BRANCH}`,
      subject: `repo:${REPOSITORY}:environment:test`,
    },
    observations: {
      webhook: {
        id: `webhook-rollback-${suffix}`,
        digest: digest(50 + position),
        state: 'applied',
        observedAt: `2026-07-27T10:0${position}:00.000Z`,
      },
      api: {
        id: `api-rollback-${suffix}`,
        digest: digest(60 + position),
        state: 'applied',
        observedAt: `2026-07-27T10:1${position}:00.000Z`,
      },
    },
    noDuplicate: { contracts: 1, rollbacks: 1, attempts: 1, dispatchOutboxes: 1, evidence: 1 },
    cloudReview: {
      auditUrl: `https://cloud.example.test/audit/rollback-${suffix}`,
      environmentResultUrl: `https://test.example.test/results/rollback-${suffix}`,
      result: 'restored',
      reviewer: `reviewer-${suffix}`,
      reviewedAt: `2026-07-27T10:2${position}:00.000Z`,
      actionAndCloudBindingReviewed: true,
    },
  } as SuccessfulRollback;
}

function contractAbsentCase(): ContractAbsentCase {
  return {
    caseKind: 'contract_absent',
    caseId: 'rollback-negative-contract-absent',
    runId: 'run-contract-absent',
    currentRunVersion: 7,
    runState: 'executing',
    repository: REPOSITORY,
    source: {
      kind: 'deployment_failure',
      id: 'deployment-contract-absent',
      evidenceId: 'evidence-contract-absent',
      failedAttemptId: 'attempt-contract-absent',
      deploymentId: 'deployment-contract-absent',
      deploymentEvidenceId: 'evidence-contract-absent',
    },
    refSha: 'c'.repeat(40),
    contractObservation: {
      id: 'observation-contract-absent',
      disposition: 'not_declared',
      policyDigest: digest(71),
      observedAt: '2026-07-27T10:30:00.000Z',
    },
    actionAbsence: {
      from: '2026-07-27T10:29:00.000Z',
      to: '2026-07-27T10:40:00.000Z',
    },
    noEffect: { contracts: 1, rollbacks: 0, attempts: 0, dispatchOutboxes: 0, actions: 0, evidence: 0 },
  } as ContractAbsentCase;
}

function productionFailureCase(): ProductionFailureCase {
  return {
    caseKind: 'production_failure',
    caseId: 'rollback-negative-production',
    runId: 'run-production-failure',
    currentRunVersion: 22,
    runState: 'failed',
    repository: REPOSITORY,
    failedAttemptId: 'attempt-production-failure',
    deploymentId: 'deployment-production-failure',
    sourceEvidenceId: 'evidence-production-failure',
    refSha: 'd'.repeat(40),
    actionAbsence: {
      from: '2026-07-27T10:49:00.000Z',
      to: '2026-07-27T11:00:00.000Z',
    },
    noEffect: { contracts: 0, rollbacks: 0, attempts: 0, dispatchOutboxes: 0, actions: 0, evidence: 0 },
  } as ProductionFailureCase;
}

async function manifest(): Promise<TestRollbackEvidenceManifestV1> {
  return {
    schemaVersion: '1',
    evidenceId: 'test-rollback-evidence-test',
    repository: REPOSITORY,
    baseBranch: BASE_BRANCH,
    recordedAt: '2026-07-27T11:10:00.000Z',
    successfulRollbacks: [
      successfulRollback('deployment_failure', 1),
      successfulRollback('acceptance_failure', 2),
    ],
    negativeCases: [contractAbsentCase(), productionFailureCase()],
    productionDecision: {
      automaticRollback: 'not_approved',
      decisionEvidenceUrl: 'https://governance.example.test/decisions/production-rollback',
      reviewer: 'production-owner',
      reviewedAt: '2026-07-27T11:05:00.000Z',
    },
    safety: { canaryDigest: await canonicalSha256(CANARY) },
  };
}

function evidenceRow(id: string, status: 'passed' | 'failed', sha: string, url: string) {
  return {
    evidenceId: id,
    kind: 'deployment',
    status,
    verificationStatus: 'verified',
    sha,
    url,
  };
}

function positiveAudit(item: SuccessfulRollback) {
  const deploymentFailed = item.source.kind === 'deployment_failure';
  const sourceUrl = `https://github.com/${REPOSITORY}/actions/runs/${Number(item.actionRunId) - 100}`;
  return {
    schemaVersion: '1',
    run: { id: item.runId, version: item.currentRunVersion, state: item.runState },
    task: { target: { repository: REPOSITORY } },
    answers: {
      who: { attempts: [
        { attemptId: item.source.failedAttemptId, mode: 'deploy', status: 'failed' },
        {
          attemptId: item.rollbackAttemptId, mode: 'deploy', status: 'completed',
          githubRunId: item.actionRunId, workflowRef: item.oidc.workflowRef,
        },
      ] },
      deployments: [{
        kind: 'test', deploymentId: item.source.deploymentId,
        status: deploymentFailed ? 'failed' : 'succeeded', sha: item.refSha,
        evidenceId: item.source.deploymentEvidenceId,
        url: 'https://test.example.test/environment',
      }],
      checks: {
        testAcceptances: item.source.acceptanceId === undefined ? [] : [{
          acceptanceId: item.source.acceptanceId, deploymentId: item.source.deploymentId,
          attemptId: item.source.failedAttemptId, status: 'failed', refSha: item.refSha,
          evidenceId: item.source.evidenceId,
        }],
        evidence: [
          evidenceRow(item.source.evidenceId, 'failed', item.refSha, sourceUrl),
          evidenceRow(item.rollbackEvidenceId, 'passed', item.refSha, item.actionUrl),
        ],
        testRollbackContracts: [{
          observationId: item.contractObservationId, sourceKind: item.source.kind,
          sourceId: item.source.id, sourceEvidenceId: item.source.evidenceId,
          repository: REPOSITORY, refSha: item.refSha, disposition: 'declared',
          policyDigest: item.policyDigest, contractDigest: item.contractDigest,
          workflowPath: item.workflowPath, environment: 'test',
          oidcAudience: item.oidcAudience, roleRef: item.roleRef,
          observedAt: '2026-07-27T10:00:00.000Z',
        }],
        testRollbacks: [{
          rollbackId: item.rollbackId, sourceKind: item.source.kind, sourceId: item.source.id,
          sourceEvidenceId: item.source.evidenceId, failedAttemptId: item.source.failedAttemptId,
          deploymentId: item.source.deploymentId, approvalId: item.approvalId,
          contractObservationId: item.contractObservationId, runVersion: item.runVersion,
          planId: item.planId, planVersion: item.planVersion, planDigest: item.planDigest,
          itemId: item.planItemId, attemptId: item.rollbackAttemptId,
          repository: REPOSITORY, baseBranch: BASE_BRANCH, baseSha: item.baseSha,
          refSha: item.refSha, policyDigest: item.policyDigest,
          contractDigest: item.contractDigest, workflowPath: item.workflowPath,
          environment: 'test', oidcAudience: item.oidcAudience, roleRef: item.roleRef,
          status: item.rollbackStatus, githubRunId: item.actionRunId,
          runnerResultDigest: item.runner.digest, runnerStatus: item.runner.status,
          runnerExitCode: item.runner.exitCode, runnerDurationMs: item.runner.durationMs,
          externalState: item.actionStatus, externalConclusion: item.actionConclusion,
          externalUpdatedAt: '2026-07-27T10:20:00.000Z', evidenceId: item.rollbackEvidenceId,
          oidcAttestationId: item.oidc.attestationId,
          oidcGithubRunId: item.oidc.githubRunId,
          oidcWorkflowRef: item.oidc.workflowRef,
          oidcSubject: item.oidc.subject,
        }],
        testRollbackObservations: [
          {
            observationId: item.observations.webhook.id, sourceKind: 'webhook',
            factDigest: item.observations.webhook.digest, rollbackId: item.rollbackId,
            githubRunId: item.actionRunId, processingState: item.observations.webhook.state,
            observedAt: item.observations.webhook.observedAt,
          },
          {
            observationId: item.observations.api.id, sourceKind: 'api',
            factDigest: item.observations.api.digest, rollbackId: item.rollbackId,
            githubRunId: item.actionRunId, processingState: item.observations.api.state,
            observedAt: item.observations.api.observedAt,
          },
        ],
        effectOutboxes: [{ id: `outbox-${item.rollbackId}`, kind: 'test_rollback_dispatch', state: 'settled' }],
      },
    },
  };
}

function negativeAudit(item: NegativeCase) {
  if (item.caseKind === 'contract_absent') {
    return {
      schemaVersion: '1',
      run: { id: item.runId, version: item.currentRunVersion, state: item.runState },
      task: { target: { repository: REPOSITORY } },
      answers: {
        who: { attempts: [{ attemptId: item.source.failedAttemptId, mode: 'deploy', status: 'failed' }] },
        deployments: [{
          kind: 'test', deploymentId: item.source.deploymentId, status: 'failed',
          sha: item.refSha, evidenceId: item.source.evidenceId,
        }],
        checks: {
          evidence: [evidenceRow(item.source.evidenceId, 'failed', item.refSha,
            'https://github.com/example/test-rollback/actions/runs/8001')],
          testRollbackContracts: [{
            observationId: item.contractObservation.id, sourceKind: item.source.kind,
            sourceId: item.source.id, sourceEvidenceId: item.source.evidenceId,
            repository: REPOSITORY, refSha: item.refSha,
            disposition: item.contractObservation.disposition,
            policyDigest: item.contractObservation.policyDigest,
            observedAt: item.contractObservation.observedAt,
          }],
          testRollbacks: [], testRollbackObservations: [], effectOutboxes: [],
        },
      },
    };
  }
  return {
    schemaVersion: '1',
    run: { id: item.runId, version: item.currentRunVersion, state: item.runState },
    task: { target: { repository: REPOSITORY } },
    answers: {
      who: { attempts: [{ attemptId: item.failedAttemptId, mode: 'deploy', status: 'failed' }] },
      deployments: [{
        kind: 'production', deploymentId: item.deploymentId, status: 'failed',
        sha: item.refSha, evidenceId: item.sourceEvidenceId,
      }],
      checks: {
        evidence: [evidenceRow(item.sourceEvidenceId, 'failed', item.refSha,
          'https://github.com/example/test-rollback/actions/runs/8002')],
        testRollbackContracts: [], testRollbacks: [], testRollbackObservations: [], effectOutboxes: [],
      },
    },
  };
}

function fakeFetch(
  input: TestRollbackEvidenceManifestV1,
  drift: 'none' | 'projection' | 'action' | 'unexpected_action' | 'leak' = 'none',
): typeof fetch {
  return (async (request) => {
    const url = new URL(String(request));
    if (drift === 'leak') return new Response(CANARY, { status: 200 });
    if (url.origin === 'https://control.example') {
      const runId = url.pathname.split('/').at(-2);
      const positive = input.successfulRollbacks.find((item) => item.runId === runId);
      const negative = input.negativeCases.find((item) => item.runId === runId);
      const audit = positive === undefined
        ? negative === undefined ? undefined : negativeAudit(negative)
        : positiveAudit(positive);
      if (audit === undefined) return new Response('missing', { status: 404 });
      return Response.json(drift === 'projection'
        ? { ...audit, run: { ...audit.run, state: 'succeeded' } }
        : audit);
    }
    if (url.pathname.includes('/actions/workflows/') && url.pathname.endsWith('/runs')) {
      return Response.json({
        total_count: drift === 'unexpected_action' ? 1 : 0,
        workflow_runs: drift === 'unexpected_action' ? [{
          id: 9999, event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
          head_sha: url.searchParams.get('head_sha'), head_branch: BASE_BRANCH,
          path: WORKFLOW_PATH, display_title: 'delivery-loop/rollback/unexpected', run_attempt: 1,
          created_at: url.searchParams.get('created')?.split('..')[0],
          updated_at: url.searchParams.get('created')?.split('..')[1],
          repository: { full_name: REPOSITORY },
        }] : [],
      });
    }
    const actionRunId = url.pathname.split('/').at(-1);
    const item = input.successfulRollbacks.find((candidate) => candidate.actionRunId === actionRunId);
    if (item === undefined) return new Response('missing', { status: 404 });
    return Response.json({
      id: Number(item.actionRunId), repository: { full_name: REPOSITORY },
      event: 'workflow_dispatch', status: item.actionStatus,
      conclusion: drift === 'action' ? 'failure' : item.actionConclusion,
      head_sha: item.refSha, head_branch: BASE_BRANCH, path: WORKFLOW_PATH,
      display_title: `delivery-loop/rollback/${item.rollbackId}`,
      run_attempt: 1, updated_at: '2026-07-27T10:20:00.000Z',
    });
  }) as typeof fetch;
}

describe('test rollback external evidence', () => {
  it('requires two successful failure-trigger rollbacks and two zero-effect boundaries', async () => {
    const input = await manifest();
    expect(TestRollbackEvidenceManifestV1Schema.safeParse(input).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/test-rollback-evidence-v1.example.json', import.meta.url), 'utf8',
    )) as unknown;
    expect(TestRollbackEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(TestRollbackEvidenceManifestV1Schema.safeParse({ ...input, rawPolicy: 'SECRET' }).success)
      .toBe(false);

    await expect(verifyTestRollbackEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      canary: CANARY, fetcher: fakeFetch(input),
    })).resolves.toEqual({
      schemaVersion: '1', evidenceId: input.evidenceId, repository: REPOSITORY,
      successfulRollbackCases: 2, deploymentFailureRollbacks: 1,
      acceptanceFailureRollbacks: 1, negativeCases: 2, verifiedActions: 2,
      zeroUnexpectedActions: 2, verifiedEvidence: 2, duplicateRollbacks: 0,
      plaintextLeaks: 0, humanReview: 'required_and_recorded',
    });
  });

  it('rejects control-plane, Action and zero-action inventory drift', async () => {
    const input = await manifest();
    for (const [drift, code] of [
      ['projection', 'control_plane_projection_mismatch'],
      ['action', 'github_action_mismatch'],
      ['unexpected_action', 'unexpected_rollback_action'],
    ] as const) {
      await expect(verifyTestRollbackEvidence(input, {
        controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
        githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
        canary: CANARY, fetcher: fakeFetch(input, drift),
      })).rejects.toMatchObject({ code });
    }
  });

  it('scans every external body before parsing without exposing credentials', async () => {
    const input = await manifest();
    await expect(verifyTestRollbackEvidence({
      ...input,
      productionDecision: {
        ...input.productionDecision,
        decisionEvidenceUrl: `https://governance.example.test/decisions/${CANARY}`,
      },
    }, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      canary: CANARY, fetcher: fakeFetch(input),
    })).rejects.toMatchObject({ code: 'secret_leak_detected' });
    const error = await verifyTestRollbackEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      canary: CANARY, fetcher: fakeFetch(input, 'leak'),
    }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'secret_leak_detected' });
    expect(String(error)).not.toContain(CANARY);
    expect(String(error)).not.toContain(CONTROL_TOKEN);
    expect(String(error)).not.toContain(GITHUB_TOKEN);
  });

  it('keeps the Watt-derived CLI opt-in before manifest and network access', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_TEST_ROLLBACK_E2E;
    const result = spawnSync(
      'pnpm', ['exec', 'tsx', 'scripts/verify-test-rollback-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('test-rollback-e2e: opt-in missing');
  });
});
