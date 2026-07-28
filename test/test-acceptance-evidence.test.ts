import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TestAcceptanceEvidenceManifestV1Schema,
  type TestAcceptanceEvidenceManifestV1,
} from '../src/domain/test-acceptance-evidence.js';
import { verifyTestAcceptanceEvidence } from '../src/pilot/test-acceptance-evidence-verifier.js';

const REPOSITORY = 'example/test-acceptance';
const SHA_BY_KIND = {
  running: 'a'.repeat(40),
  passed: 'b'.repeat(40),
  failed: 'c'.repeat(40),
} as const;
const CONTROL_TOKEN = 'CANARY_TEST_ACCEPTANCE_CONTROL_TOKEN';
const GITHUB_TOKEN = 'CANARY_TEST_ACCEPTANCE_GITHUB_TOKEN';
const ENVIRONMENT_URL = 'https://test.example.test/app';

function digest(seed: number): string {
  const hex = seed.toString(16).padStart(2, '0');
  return `sha256:${hex.repeat(32)}`;
}

type AcceptanceCase = TestAcceptanceEvidenceManifestV1['cases'][number];

function makeCase(outcome: 'running' | 'passed' | 'failed', position: number): AcceptanceCase {
  const sha = SHA_BY_KIND[outcome];
  const actionRunId = String(9_000 + position);
  const acceptanceId = `acceptance-evidence-${outcome}`;
  const runner = outcome === 'running'
    ? { digest: null, status: null, exitCode: null, durationMs: null }
    : {
        digest: digest(position),
        status: outcome === 'passed' ? 'passed' as const : 'failed' as const,
        exitCode: outcome === 'passed' ? 0 : 1,
        durationMs: 1_000 + position,
      };
  return {
    caseId: `case-${outcome}`,
    runId: `run-${outcome}`,
    runVersion: 10,
    currentRunVersion: outcome === 'running' ? 10 : 11,
    runState: 'executing',
    repository: REPOSITORY,
    planId: `plan-${outcome}`,
    planVersion: 1,
    planDigest: digest(position + 10),
    planItemId: 'accept-test',
    attemptId: `attempt-${outcome}`,
    deploymentId: `deployment-${outcome}`,
    deploymentEvidenceId: `deployment-evidence-${outcome}`,
    acceptanceId,
    approvalId: `approval-${outcome}`,
    refSha: sha,
    environment: 'test',
    workflowPath: '.github/workflows/delivery-test-acceptance.yml',
    oidcAudience: 'delivery-loop-test-acceptance',
    oidcSubject: `repo:${REPOSITORY}:environment:test`,
    commandRef: 'acceptance:smoke',
    oidcAttestationId: `oidc-attestation-${outcome}`,
    oidcGithubRunId: actionRunId,
    actionRunId,
    actionUrl: `https://github.com/${REPOSITORY}/actions/runs/${actionRunId}`,
    actionStatus: outcome === 'running' ? 'in_progress' : 'completed',
    actionConclusion: outcome === 'running' ? null : outcome === 'passed' ? 'success' : 'failure',
    environmentUrl: ENVIRONMENT_URL,
    acceptanceStatus: outcome === 'running' ? 'running' : outcome,
    outcome,
    runner,
    acceptanceEvidenceId: outcome === 'running' ? null : `acceptance-evidence-${outcome}`,
    acceptanceEvidenceStatus: outcome === 'running' ? null : outcome,
    webhook: {
      id: `webhook-${outcome}`,
      digest: digest(position + 20),
      state: 'applied',
      observedAt: `2026-07-26T14:5${position}:00.000Z`,
    },
    apiObservation: {
      id: `api-${outcome}`,
      digest: digest(position + 30),
      state: 'applied',
      observedAt: `2026-07-26T14:5${position + 1}:00.000Z`,
    },
    noDuplicate: {
      attempts: 1,
      acceptances: 1,
      dispatchOutboxes: 1,
      evidence: outcome === 'running' ? 0 : 1,
    },
  } as AcceptanceCase;
}

function makeManifest(): TestAcceptanceEvidenceManifestV1 {
  return {
    schemaVersion: '1',
    evidenceId: 'test-acceptance-evidence-test',
    repository: REPOSITORY,
    recordedAt: '2026-07-26T15:10:00.000Z',
    cases: [makeCase('running', 1), makeCase('passed', 2), makeCase('failed', 3)],
  };
}

function auditFor(item: AcceptanceCase) {
  const evidence = item.acceptanceEvidenceId === null ? [] : [{
    evidenceId: item.acceptanceEvidenceId,
    kind: 'test',
    status: item.acceptanceEvidenceStatus,
    verificationStatus: 'verified',
    sha: item.refSha,
    url: item.actionUrl,
  }];
  return {
    schemaVersion: '1',
    run: { id: item.runId, version: item.currentRunVersion, state: item.runState },
    task: { target: { repository: REPOSITORY } },
    answers: {
      who: { attempts: [{
        attemptId: item.attemptId, mode: 'deploy', status: item.outcome === 'running' ? 'running' : 'completed',
        githubRunId: item.actionRunId,
      }] },
      deployments: [{
        kind: 'test', deploymentId: item.deploymentId, status: 'succeeded', sha: item.refSha,
        evidenceId: item.deploymentEvidenceId, url: ENVIRONMENT_URL,
      }],
      checks: {
        testAcceptances: [{
          acceptanceId: item.acceptanceId, deploymentId: item.deploymentId,
          runVersion: item.runVersion, planId: item.planId, planVersion: item.planVersion,
          planDigest: item.planDigest, itemId: item.planItemId, attemptId: item.attemptId,
          approvalId: item.approvalId, repository: REPOSITORY, environment: 'test',
          workflowPath: item.workflowPath, oidcAudience: item.oidcAudience,
          commandRef: item.commandRef, environmentUrl: ENVIRONMENT_URL,
          status: item.acceptanceStatus, refSha: item.refSha, githubRunId: item.actionRunId,
          runnerResultDigest: item.runner.digest, runnerStatus: item.runner.status,
          runnerExitCode: item.runner.exitCode, runnerDurationMs: item.runner.durationMs,
          externalState: item.actionStatus, externalConclusion: item.actionConclusion,
          evidenceId: item.acceptanceEvidenceId,
          oidcAttestationId: item.oidcAttestationId, oidcGithubRunId: item.oidcGithubRunId,
          oidcSubject: item.oidcSubject,
        }],
        testAcceptanceObservations: [
          {
            observationId: item.webhook.id, sourceKind: 'webhook', factDigest: item.webhook.digest,
            acceptanceId: item.acceptanceId, githubRunId: item.actionRunId,
            processingState: item.webhook.state, observedAt: item.webhook.observedAt,
          },
          {
            observationId: item.apiObservation.id, sourceKind: 'api', factDigest: item.apiObservation.digest,
            acceptanceId: item.acceptanceId, githubRunId: item.actionRunId,
            processingState: item.apiObservation.state, observedAt: item.apiObservation.observedAt,
          },
        ],
        evidence,
        effectOutboxes: [{ id: `outbox-${item.outcome}`, kind: 'test_acceptance_dispatch', state: 'settled' }],
      },
    },
  };
}

function fakeFetch(manifest: TestAcceptanceEvidenceManifestV1, drift: 'none' | 'action' | 'projection' = 'none'): typeof fetch {
  return (async (request) => {
    const url = new URL(String(request));
    const item = manifest.cases.find((candidate) => candidate.actionRunId === url.pathname.split('/').at(-1));
    if (url.origin === 'https://control.example') {
      const runId = url.pathname.split('/').at(-2);
      const found = manifest.cases.find((candidate) => candidate.runId === runId);
      return found === undefined
        ? new Response('missing', { status: 404 })
        : Response.json(drift === 'projection' ? { ...auditFor(found), run: { ...auditFor(found).run, state: 'succeeded' } } : auditFor(found));
    }
    if (item === undefined) return new Response('missing', { status: 404 });
    return Response.json({
      id: Number(item.actionRunId),
      event: 'workflow_dispatch',
      status: item.actionStatus,
      conclusion: drift === 'action' && item.actionConclusion !== null
        ? (item.actionConclusion === 'success' ? 'failure' : 'success')
        : item.actionConclusion,
      head_sha: item.refSha,
      head_branch: 'main',
      path: item.workflowPath,
      display_title: `delivery-loop/acceptance/${item.acceptanceId}`,
      run_attempt: 1,
      updated_at: '2026-07-26T15:00:00.000Z',
      repository: { full_name: REPOSITORY },
    });
  }) as typeof fetch;
}

describe('test acceptance external evidence', () => {
  it('requires running/passed/failed cases and verifies Action, Runner and Evidence facts', async () => {
    const input = makeManifest();
    expect(TestAcceptanceEvidenceManifestV1Schema.safeParse(input).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/test-acceptance-evidence-v1.example.json', import.meta.url), 'utf8',
    )) as unknown;
    expect(TestAcceptanceEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(TestAcceptanceEvidenceManifestV1Schema.safeParse({ ...input, raw: 'SECRET' }).success).toBe(false);
    await expect(verifyTestAcceptanceEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(input),
    })).resolves.toEqual({
      schemaVersion: '1', evidenceId: input.evidenceId, repository: REPOSITORY,
      caseCount: 3, runningCases: 1, passedCases: 1, failedCases: 1,
      verifiedActionCount: 3, verifiedEvidenceCount: 2,
      prematureSucceededRuns: 0, duplicateAcceptances: 0,
    });
  });

  it('rejects projection/action drift and does not expose raw response or tokens', async () => {
    const input = makeManifest();
    await expect(verifyTestAcceptanceEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(input, 'projection'),
    })).rejects.toMatchObject({ code: 'control_plane_projection_mismatch' });
    await expect(verifyTestAcceptanceEvidence(input, {
      controlPlaneOrigin: 'https://control.example', controlPlaneToken: CONTROL_TOKEN,
      githubToken: GITHUB_TOKEN, githubApiOrigin: 'https://api.github.test',
      fetch: fakeFetch(input, 'action'),
    })).rejects.toMatchObject({ code: 'github_action_mismatch' });
    const raw = 'CANARY_TEST_ACCEPTANCE_RAW_RESPONSE';
    const error = await verifyTestAcceptanceEvidence(input, {
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
    delete environment.DELIVERY_LOOP_TEST_ACCEPTANCE_E2E;
    const result = spawnSync(
      'pnpm', ['exec', 'tsx', 'scripts/verify-test-acceptance-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('test-acceptance-e2e: opt-in missing');
  });
});
