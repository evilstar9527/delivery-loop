import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import type { FeishuCardCompletionEvidenceManifestV1 } from '../src/domain/feishu-card-completion-evidence.js';
import {
  MergeDeploymentE2EEvidenceManifestV1Schema,
  type MergeDeploymentE2EEvidenceManifestV1,
} from '../src/domain/merge-deployment-e2e-evidence.js';
import type { MergeEvidenceManifestV1 } from '../src/domain/merge-evidence.js';
import type { MergeGateEvidenceManifestV1 } from '../src/domain/merge-gate-evidence.js';
import type { ProductionApprovalEvidenceManifestV1 } from '../src/domain/production-approval-evidence.js';
import type { ProductionDeploymentEvidenceManifestV1 } from '../src/domain/production-deployment-evidence.js';
import type { TestAcceptanceEvidenceManifestV1 } from '../src/domain/test-acceptance-evidence.js';
import type { TestDeploymentEvidenceManifestV1 } from '../src/domain/test-deployment-evidence.js';

vi.mock('../src/pilot/merge-gate-evidence-verifier.js', () => ({
  verifyMergeGateEvidence: vi.fn(),
}));
vi.mock('../src/pilot/merge-evidence-verifier.js', () => ({
  verifyMergeEvidence: vi.fn(),
}));
vi.mock('../src/pilot/test-deployment-evidence-verifier.js', () => ({
  verifyTestDeploymentEvidence: vi.fn(),
}));
vi.mock('../src/pilot/test-acceptance-evidence-verifier.js', () => ({
  verifyTestAcceptanceEvidence: vi.fn(),
}));
vi.mock('../src/pilot/production-approval-evidence-verifier.js', () => ({
  verifyProductionApprovalEvidence: vi.fn(),
}));
vi.mock('../src/pilot/production-deployment-evidence-verifier.js', () => ({
  verifyProductionDeploymentEvidence: vi.fn(),
}));
vi.mock('../src/pilot/feishu-card-completion-evidence-verifier.js', () => ({
  verifyFeishuCardCompletionEvidence: vi.fn(),
}));

import { verifyFeishuCardCompletionEvidence } from '../src/pilot/feishu-card-completion-evidence-verifier.js';
import {
  verifyMergeDeploymentE2EEvidence,
} from '../src/pilot/merge-deployment-e2e-evidence-verifier.js';
import { verifyMergeEvidence } from '../src/pilot/merge-evidence-verifier.js';
import { verifyMergeGateEvidence } from '../src/pilot/merge-gate-evidence-verifier.js';
import { verifyProductionApprovalEvidence } from '../src/pilot/production-approval-evidence-verifier.js';
import { verifyProductionDeploymentEvidence } from '../src/pilot/production-deployment-evidence-verifier.js';
import { verifyTestAcceptanceEvidence } from '../src/pilot/test-acceptance-evidence-verifier.js';
import { verifyTestDeploymentEvidence } from '../src/pilot/test-deployment-evidence-verifier.js';

const REPOSITORY = 'example/delivery-pilot';
const CANARY = `ghp_${'M'.repeat(32)}`;
type MergedCase = Exclude<MergeEvidenceManifestV1['cases'][number], { outcome: 'not_merged' }>;

function example<T>(file: string): T {
  return JSON.parse(readFileSync(resolve('schemas', file), 'utf8')) as T;
}

function normalizeGate(
  manifest: MergeGateEvidenceManifestV1,
  lane: 'test' | 'production',
  merge: MergedCase,
): MergeGateEvidenceManifestV1 {
  manifest.evidenceId = `merge-gate-${lane}-evidence-e2e`;
  manifest.repository = REPOSITORY;
  for (const item of manifest.cases) {
    item.repository = REPOSITORY;
    item.fact.repository = REPOSITORY;
  }
  const ready = manifest.cases.find((item) => item.outcome === 'ready_to_merge')!;
  ready.caseId = `ready-${lane}-e2e`;
  ready.runId = merge.runId;
  ready.pullRequestNumber = merge.pullRequest.number;
  ready.decisionId = merge.decisionId;
  ready.fact.number = merge.pullRequest.number;
  ready.fact.headBranch = merge.pullRequest.headBranch;
  ready.fact.headSha = merge.pullRequest.headSha;
  ready.fact.baseBranch = merge.pullRequest.baseBranch;
  ready.fact.baseSha = merge.baseSha;
  ready.fact.pullRequestBaseSha = merge.baseSha;
  ready.evaluation.createdAt = lane === 'test'
    ? '2026-07-26T10:45:00.000Z' : '2026-07-26T11:45:00.000Z';
  ready.approval!.expiresAt = '2026-07-27T12:00:00.000Z';
  return manifest;
}

async function fixtures(): Promise<{
  manifest: MergeDeploymentE2EEvidenceManifestV1;
  components: {
    testMergeGate: MergeGateEvidenceManifestV1;
    productionMergeGate: MergeGateEvidenceManifestV1;
    merge: MergeEvidenceManifestV1;
    testDeployment: TestDeploymentEvidenceManifestV1;
    testAcceptance: TestAcceptanceEvidenceManifestV1;
    productionApproval: ProductionApprovalEvidenceManifestV1;
    productionDeployment: ProductionDeploymentEvidenceManifestV1;
    feishuCompletion: FeishuCardCompletionEvidenceManifestV1;
  };
}> {
  const merge = example<MergeEvidenceManifestV1>('merge-evidence-v1.example.json');
  merge.repository = REPOSITORY;
  for (const item of merge.cases) {
    item.repository = REPOSITORY;
    item.pullRequest.repository = REPOSITORY;
    item.pullRequest.url = `https://github.com/${REPOSITORY}/pull/${item.pullRequest.number}`;
    if (item.outcome !== 'not_merged') {
      item.merge.repository = REPOSITORY;
      item.merge.url = item.pullRequest.url;
    }
  }
  const testMerge = merge.cases.find(
    (item): item is MergedCase => item.outcome === 'merged_test',
  )!;
  const productionMerge = merge.cases.find(
    (item): item is MergedCase => item.outcome === 'merged_production',
  )!;
  testMerge.pullRequest.number = 501;
  testMerge.pullRequest.url = `https://github.com/${REPOSITORY}/pull/501`;
  testMerge.merge.number = 501;
  testMerge.merge.url = testMerge.pullRequest.url;
  productionMerge.pullRequest.number = 502;
  productionMerge.pullRequest.url = `https://github.com/${REPOSITORY}/pull/502`;
  productionMerge.merge.number = 502;
  productionMerge.merge.url = productionMerge.pullRequest.url;
  testMerge.merge.mergedAt = '2026-07-26T11:00:00.000Z';
  productionMerge.merge.mergedAt = '2026-07-26T12:00:00.000Z';
  const testMergeGate = normalizeGate(
    example<MergeGateEvidenceManifestV1>('merge-gate-evidence-v1.example.json'),
    'test', testMerge,
  );
  const productionMergeGate = normalizeGate(
    example<MergeGateEvidenceManifestV1>('merge-gate-evidence-v1.example.json'),
    'production', productionMerge,
  );

  const testDeployment = example<TestDeploymentEvidenceManifestV1>(
    'test-deployment-evidence-v1.example.json',
  );
  testDeployment.repository = REPOSITORY;
  for (const item of testDeployment.cases) {
    item.repository = REPOSITORY;
    item.oidcSubject = `repo:${REPOSITORY}:environment:test`;
    item.actionUrl = `https://github.com/${REPOSITORY}/actions/runs/${item.actionRunId}`;
  }
  const deployed = testDeployment.cases.find((item) => item.outcome === 'succeeded')!;
  deployed.runId = testMerge.runId;
  deployed.planId = testMerge.planId;
  deployed.planVersion = testMerge.planVersion;
  deployed.planDigest = testMerge.planDigest;
  deployed.refSha = testMerge.pullRequest.headSha;
  deployed.webhook.observedAt = '2026-07-26T10:00:00.000Z';

  const testAcceptance = example<TestAcceptanceEvidenceManifestV1>(
    'test-acceptance-evidence-v1.example.json',
  );
  testAcceptance.repository = REPOSITORY;
  for (const item of testAcceptance.cases) {
    item.repository = REPOSITORY;
    item.oidcSubject = `repo:${REPOSITORY}:environment:test`;
    item.actionUrl = `https://github.com/${REPOSITORY}/actions/runs/${item.actionRunId}`;
  }
  const accepted = testAcceptance.cases.find((item) => item.outcome === 'passed')!;
  accepted.runId = testMerge.runId;
  accepted.planId = testMerge.planId;
  accepted.planVersion = testMerge.planVersion;
  accepted.planDigest = testMerge.planDigest;
  accepted.deploymentId = deployed.deploymentId;
  accepted.deploymentEvidenceId = deployed.deploymentEvidenceId;
  accepted.refSha = deployed.refSha;
  accepted.environmentUrl = deployed.environmentUrl!;
  accepted.webhook.observedAt = '2026-07-26T10:30:00.000Z';

  const productionApproval = example<ProductionApprovalEvidenceManifestV1>(
    'production-approval-evidence-v1.example.json',
  );
  productionApproval.repository = REPOSITORY;
  for (const item of productionApproval.cases) {
    item.repository = REPOSITORY;
    item.mergeFact.repository = REPOSITORY;
    item.mergeFact.url = `https://github.com/${REPOSITORY}/pull/${item.mergeFact.number}`;
  }
  const release = productionApproval.cases.find((item) => item.outcome === 'accepted')!;
  release.runId = productionMerge.runId;
  release.runVersion = productionMerge.currentRunVersion;
  release.currentRunVersion = productionMerge.currentRunVersion;
  release.planId = productionMerge.planId;
  release.planVersion = productionMerge.planVersion;
  release.planDigest = productionMerge.planDigest;
  release.baseSha = productionMerge.baseSha;
  release.mergeId = productionMerge.mergeId;
  release.mergeSha = productionMerge.merge.mergeSha;
  release.mergeFact = structuredClone(productionMerge.merge);
  release.source.occurredAt = '2026-07-26T12:10:00.000Z';
  release.binding = {
    ...release.binding,
    approvalId: release.approvalId,
    taskRevision: release.taskRevision,
    planId: release.planId,
    planVersion: release.planVersion,
    planDigest: release.planDigest,
    baseSha: release.baseSha,
    mergeId: release.mergeId,
    mergeSha: release.mergeSha,
    environment: 'production',
    createdAt: '2026-07-26T12:11:00.000Z',
  };
  release.expiresAt = '2026-07-27T12:00:00.000Z';

  const productionDeployment = example<ProductionDeploymentEvidenceManifestV1>(
    'production-deployment-evidence-v1.example.json',
  );
  productionDeployment.repository = REPOSITORY;
  for (const item of productionDeployment.cases) {
    item.repository = REPOSITORY;
    if (item.oidcSubject !== null) item.oidcSubject = `repo:${REPOSITORY}:environment:production`;
    item.actionUrl = `https://github.com/${REPOSITORY}/actions/runs/${item.actionRunId}`;
  }
  const production = productionDeployment.cases.find((item) => item.externalState === 'success')!;
  production.runId = productionMerge.runId;
  production.runVersion = release.currentRunVersion;
  production.currentRunVersion = release.currentRunVersion + 1;
  production.taskRevision = release.taskRevision;
  production.planId = productionMerge.planId;
  production.planVersion = productionMerge.planVersion;
  production.planDigest = productionMerge.planDigest;
  production.baseSha = productionMerge.baseSha;
  production.mergeId = productionMerge.mergeId;
  production.mergeSha = productionMerge.merge.mergeSha;
  production.approvalId = release.approvalId;
  production.externalUpdatedAt = '2026-07-26T12:20:00.000Z';

  const feishuCompletion = example<FeishuCardCompletionEvidenceManifestV1>(
    'feishu-card-completion-evidence-v1.example.json',
  );
  feishuCompletion.repository = REPOSITORY;
  feishuCompletion.safety.canaryDigest = await canonicalSha256(CANARY);
  const testCard = feishuCompletion.cases.find((item) => item.lane === 'test')!;
  testCard.runId = testMerge.runId;
  testCard.repository = REPOSITORY;
  testCard.runVersion = testMerge.currentRunVersion;
  testCard.baseSha = testMerge.baseSha;
  testCard.planVersion = testMerge.planVersion;
  testCard.planDigest = testMerge.planDigest;
  testCard.pullRequestUrl = testMerge.pullRequest.url;
  testCard.mergeUrl = testMerge.pullRequest.url;
  testCard.deploymentUrl = deployed.environmentUrl!;
  const productionCard = feishuCompletion.cases.find((item) => item.lane === 'production')!;
  productionCard.runId = productionMerge.runId;
  productionCard.repository = REPOSITORY;
  productionCard.runVersion = production.currentRunVersion;
  productionCard.baseSha = productionMerge.baseSha;
  productionCard.planVersion = productionMerge.planVersion;
  productionCard.planDigest = productionMerge.planDigest;
  productionCard.pullRequestUrl = productionMerge.pullRequest.url;
  productionCard.mergeUrl = productionMerge.pullRequest.url;
  productionCard.deploymentUrl = production.environmentUrl!;

  const components = {
    testMergeGate, productionMergeGate, merge, testDeployment, testAcceptance,
    productionApproval, productionDeployment, feishuCompletion,
  };
  const manifest: MergeDeploymentE2EEvidenceManifestV1 = {
    schemaVersion: '1', evidenceId: 'merge-deployment-e2e-evidence-test',
    repository: REPOSITORY, recordedAt: '2026-07-27T09:00:00.000Z',
    observedWindow: {
      startedAt: '2026-07-26T00:00:00.000Z', endedAt: '2026-07-27T08:30:00.000Z',
    },
    components: {
      testMergeGate: {
        manifestDigest: await canonicalSha256(testMergeGate),
        evidenceId: testMergeGate.evidenceId, caseId: testGateCase(testMergeGate).caseId,
      },
      productionMergeGate: {
        manifestDigest: await canonicalSha256(productionMergeGate),
        evidenceId: productionMergeGate.evidenceId,
        caseId: testGateCase(productionMergeGate).caseId,
      },
      merge: {
        manifestDigest: await canonicalSha256(merge), evidenceId: merge.evidenceId,
        testCaseId: testMerge.caseId, productionCaseId: productionMerge.caseId,
      },
      testDeployment: {
        manifestDigest: await canonicalSha256(testDeployment),
        evidenceId: testDeployment.evidenceId, caseId: deployed.caseId,
      },
      testAcceptance: {
        manifestDigest: await canonicalSha256(testAcceptance),
        evidenceId: testAcceptance.evidenceId, caseId: accepted.caseId,
      },
      productionApproval: {
        manifestDigest: await canonicalSha256(productionApproval),
        evidenceId: productionApproval.evidenceId, caseId: release.caseId,
      },
      productionDeployment: {
        manifestDigest: await canonicalSha256(productionDeployment),
        evidenceId: productionDeployment.evidenceId, caseId: production.caseId,
      },
      feishuCompletion: {
        manifestDigest: await canonicalSha256(feishuCompletion),
        evidenceId: feishuCompletion.evidenceId,
        testCaseId: testCard.caseId, productionCaseId: productionCard.caseId,
      },
    },
    safety: { canaryDigest: await canonicalSha256(CANARY) },
  };
  return { manifest, components };
}

function testGateCase(manifest: MergeGateEvidenceManifestV1) {
  return manifest.cases.find((item) => item.outcome === 'ready_to_merge')!;
}

function configureMocks(): void {
  vi.mocked(verifyMergeGateEvidence).mockImplementation(async (input) => ({
    schemaVersion: '1', evidenceId: input.evidenceId, repository: REPOSITORY,
    caseCount: input.cases.length, readyToMergeCases: 1,
    rejectedCases: input.cases.length - 1,
    rejectionReasons: [
      'required_checks_incomplete', 'required_checks_failed', 'review_insufficient',
      'base_not_latest', 'approval_required',
    ],
    mergeEffects: 0,
  }));
  vi.mocked(verifyMergeEvidence).mockImplementation(async (input) => ({
    schemaVersion: '1', evidenceId: input.evidenceId, repository: REPOSITORY,
    caseCount: input.cases.length, mergedCases: 3, noDeploySucceededCases: 1,
    completedAtMergeCases: 2, deploymentPendingCases: 1, notMergedCases: 1,
    verifiedMergeCount: 3, duplicateMergeEffects: 0,
  }));
  vi.mocked(verifyTestDeploymentEvidence).mockImplementation(async (input) => ({
    schemaVersion: '1', evidenceId: input.evidenceId, repository: REPOSITORY,
    caseCount: input.cases.length, succeededCases: 1, failedCases: 0,
    verifiedActionCount: 1, verifiedDeploymentCount: 1, verifiedEvidenceCount: 1,
    duplicateDeployments: 0,
  }));
  vi.mocked(verifyTestAcceptanceEvidence).mockImplementation(async (input) => ({
    schemaVersion: '1', evidenceId: input.evidenceId, repository: REPOSITORY,
    caseCount: input.cases.length, runningCases: 1, passedCases: 1, failedCases: 1,
    verifiedActionCount: 3, verifiedEvidenceCount: 2, prematureSucceededRuns: 0,
    duplicateAcceptances: 0,
  }));
  vi.mocked(verifyProductionApprovalEvidence).mockImplementation(async (input) => ({
    schemaVersion: '1', evidenceId: input.evidenceId, repository: REPOSITORY,
    caseCount: input.cases.length, acceptedCases: 1, rejectedCases: input.cases.length - 1,
    verifiedMergeFacts: input.cases.length, productionEffects: 0,
  }));
  vi.mocked(verifyProductionDeploymentEvidence).mockImplementation(async (input) => ({
    schemaVersion: '1', evidenceId: input.evidenceId, repository: REPOSITORY,
    caseCount: input.cases.length, inProgressCases: 1, succeededCases: 1, failedCases: 2,
    verifiedActionCount: 4, verifiedDeploymentCount: 4, verifiedEvidenceCount: 3,
    duplicateDeployments: 0,
  }));
  vi.mocked(verifyFeishuCardCompletionEvidence).mockImplementation(async (input) => ({
    schemaVersion: '1', evidenceId: input.evidenceId, repository: REPOSITORY,
    testRunId: input.cases.find((item) => item.lane === 'test')!.runId,
    productionRunId: input.cases.find((item) => item.lane === 'production')!.runId,
    completedCards: 2, settledPresentations: 2, liveCards: 2,
    activeActions: 0, activeApprovals: 0, plaintextLeaks: 0,
  }));
}

function options() {
  return {
    controlPlaneOrigin: 'https://control.example',
    operationsToken: 'CANARY_MERGE_DEPLOYMENT_OPERATIONS_TOKEN',
    githubToken: 'CANARY_MERGE_DEPLOYMENT_GITHUB_TOKEN',
    feishuAccessToken: 'CANARY_MERGE_DEPLOYMENT_FEISHU_TOKEN',
    canary: CANARY,
    githubApiOrigin: 'https://api.github.test',
    feishuApiOrigin: 'https://open.feishu.test',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  configureMocks();
});

describe('E2E-7 merge/deployment evidence', () => {
  it('strictly composes separate test and production lanes from existing live authorities', async () => {
    const fixture = await fixtures();
    expect(MergeDeploymentE2EEvidenceManifestV1Schema.safeParse(fixture.manifest).success).toBe(true);
    const exampleManifest = JSON.parse(readFileSync(
      resolve('schemas/merge-deployment-e2e-evidence-v1.example.json'), 'utf8',
    )) as unknown;
    expect(MergeDeploymentE2EEvidenceManifestV1Schema.safeParse(exampleManifest).success).toBe(true);
    await expect(verifyMergeDeploymentE2EEvidence(
      fixture.manifest, fixture.components, options(),
    )).resolves.toEqual({
      schemaVersion: '1', evidenceId: fixture.manifest.evidenceId, repository: REPOSITORY,
      testRunId: 'run-merge-test-example', productionRunId: 'run-merge-production-example',
      verifiedComponentCount: 8, readyMergeGates: 2, verifiedMerges: 2,
      verifiedDeployments: 2, verifiedAcceptanceGates: 1,
      verifiedProductionApprovals: 1, completedFeishuCards: 2,
      duplicateSideEffects: 0, plaintextLeaks: 0,
    });
    expect(verifyMergeGateEvidence).toHaveBeenCalledTimes(2);
    for (const verifier of [
      verifyMergeEvidence, verifyTestDeploymentEvidence, verifyTestAcceptanceEvidence,
      verifyProductionApprovalEvidence, verifyProductionDeploymentEvidence,
      verifyFeishuCardCompletionEvidence,
    ]) expect(verifier).toHaveBeenCalledOnce();
  });

  it('rejects component digest drift and cross-lane identity drift before delegation', async () => {
    const fixture = await fixtures();
    fixture.manifest.components.merge.manifestDigest = `sha256:${'0'.repeat(64)}`;
    await expect(verifyMergeDeploymentE2EEvidence(
      fixture.manifest, fixture.components, options(),
    )).rejects.toMatchObject({ code: 'component_digest_mismatch' });
    expect(verifyMergeEvidence).not.toHaveBeenCalled();

    const drift = await fixtures();
    const passed = drift.components.testAcceptance.cases.find((item) => item.outcome === 'passed')!;
    passed.deploymentId = 'different-test-deployment';
    drift.manifest.components.testAcceptance.manifestDigest =
      await canonicalSha256(drift.components.testAcceptance);
    await expect(verifyMergeDeploymentE2EEvidence(
      drift.manifest, drift.components, options(),
    )).rejects.toMatchObject({ code: 'composition_mismatch' });
    expect(verifyMergeEvidence).not.toHaveBeenCalled();
  });

  it('scans component responses before parsing and rejects pagination fail-closed', async () => {
    const leaked = await fixtures();
    vi.mocked(verifyMergeEvidence).mockImplementationOnce(async (input, verifierOptions) => {
      await verifierOptions.fetch!('https://control.example/leak');
      return {
        schemaVersion: '1', evidenceId: input.evidenceId, repository: REPOSITORY,
        caseCount: 4, mergedCases: 3, noDeploySucceededCases: 1,
        completedAtMergeCases: 2, deploymentPendingCases: 1, notMergedCases: 1,
        verifiedMergeCount: 3, duplicateMergeEffects: 0,
      };
    });
    await expect(verifyMergeDeploymentE2EEvidence(
      leaked.manifest,
      leaked.components,
      {
        ...options(),
        fetch: async () => Response.json({ raw: 'CANARY_MERGE_DEPLOYMENT_GITHUB_TOKEN' }),
      },
    )).rejects.toMatchObject({ code: 'secret_leak_detected' });

    const paginated = await fixtures();
    vi.mocked(verifyMergeEvidence).mockImplementationOnce(async (input, verifierOptions) => {
      await verifierOptions.fetch!('https://api.github.test/paginated');
      return {
        schemaVersion: '1', evidenceId: input.evidenceId, repository: REPOSITORY,
        caseCount: 4, mergedCases: 3, noDeploySucceededCases: 1,
        completedAtMergeCases: 2, deploymentPendingCases: 1, notMergedCases: 1,
        verifiedMergeCount: 3, duplicateMergeEffects: 0,
      };
    });
    await expect(verifyMergeDeploymentE2EEvidence(
      paginated.manifest,
      paginated.components,
      {
        ...options(),
        fetch: async () => new Response('{}', { headers: { link: '<next>; rel="next"' } }),
      },
    )).rejects.toMatchObject({ code: 'external_response_invalid' });
  });

  it('keeps the named command behind explicit Watt-derived opt-in', () => {
    const result = spawnSync(
      resolve('node_modules/.bin/tsx'),
      ['scripts/verify-merge-deployment-e2e-evidence.ts'],
      {
        cwd: resolve('.'),
        env: { ...process.env, DELIVERY_LOOP_MERGE_DEPLOYMENT_E2E: undefined },
        encoding: 'utf8', timeout: 30_000,
      },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('merge-deployment-e2e: opt-in missing');
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['e2e:merge-deployment'])
      .toBe('tsx scripts/verify-merge-deployment-e2e-evidence.ts');
  });
});
