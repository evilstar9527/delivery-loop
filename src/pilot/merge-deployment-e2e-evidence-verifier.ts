import { canonicalSha256 } from '../domain/digest.js';
import {
  FeishuCardCompletionEvidenceManifestV1Schema,
  type FeishuCardCompletionEvidenceManifestV1,
} from '../domain/feishu-card-completion-evidence.js';
import {
  MergeDeploymentE2EEvidenceManifestV1Schema,
  type MergeDeploymentE2EEvidenceManifestV1,
} from '../domain/merge-deployment-e2e-evidence.js';
import {
  MergeEvidenceManifestV1Schema,
  type MergeEvidenceManifestV1,
} from '../domain/merge-evidence.js';
import {
  MergeGateEvidenceManifestV1Schema,
  type MergeGateEvidenceManifestV1,
} from '../domain/merge-gate-evidence.js';
import {
  ProductionApprovalEvidenceManifestV1Schema,
  type ProductionApprovalEvidenceManifestV1,
} from '../domain/production-approval-evidence.js';
import {
  ProductionDeploymentEvidenceManifestV1Schema,
  type ProductionDeploymentEvidenceManifestV1,
} from '../domain/production-deployment-evidence.js';
import {
  TestAcceptanceEvidenceManifestV1Schema,
  type TestAcceptanceEvidenceManifestV1,
} from '../domain/test-acceptance-evidence.js';
import {
  TestDeploymentEvidenceManifestV1Schema,
  type TestDeploymentEvidenceManifestV1,
} from '../domain/test-deployment-evidence.js';
import { SecretScanner } from '../security/redaction.js';
import {
  verifyFeishuCardCompletionEvidence,
} from './feishu-card-completion-evidence-verifier.js';
import { verifyMergeEvidence } from './merge-evidence-verifier.js';
import { verifyMergeGateEvidence } from './merge-gate-evidence-verifier.js';
import { verifyProductionApprovalEvidence } from './production-approval-evidence-verifier.js';
import { verifyProductionDeploymentEvidence } from './production-deployment-evidence-verifier.js';
import { verifyTestAcceptanceEvidence } from './test-acceptance-evidence-verifier.js';
import { verifyTestDeploymentEvidence } from './test-deployment-evidence-verifier.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,20000}$/;
const CANARY_PATTERN = /^[^\0\r\n]{8,20000}$/;
const MAX_TOTAL_SCAN_BYTES = 32 * 1024 * 1024;

export type MergeDeploymentE2EEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'component_manifest_invalid'
  | 'configuration_invalid'
  | 'component_digest_mismatch'
  | 'composition_mismatch'
  | 'component_verification_failed'
  | 'external_response_invalid'
  | 'secret_leak_detected';

export class MergeDeploymentE2EEvidenceVerificationError extends Error {
  constructor(readonly code: MergeDeploymentE2EEvidenceVerificationErrorCode) {
    super(`merge/deployment E2E evidence verification failed: ${code}`);
    this.name = 'MergeDeploymentE2EEvidenceVerificationError';
  }
}

export interface MergeDeploymentE2EEvidenceComponents {
  testMergeGate: MergeGateEvidenceManifestV1;
  productionMergeGate: MergeGateEvidenceManifestV1;
  merge: MergeEvidenceManifestV1;
  testDeployment: TestDeploymentEvidenceManifestV1;
  testAcceptance: TestAcceptanceEvidenceManifestV1;
  productionApproval: ProductionApprovalEvidenceManifestV1;
  productionDeployment: ProductionDeploymentEvidenceManifestV1;
  feishuCompletion: FeishuCardCompletionEvidenceManifestV1;
}

export interface MergeDeploymentE2EEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  operationsToken: string;
  githubToken: string;
  feishuAccessToken: string;
  canary: string;
  githubApiOrigin?: string;
  feishuApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface MergeDeploymentE2EEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  testRunId: string;
  productionRunId: string;
  verifiedComponentCount: 8;
  readyMergeGates: 2;
  verifiedMerges: 2;
  verifiedDeployments: 2;
  verifiedAcceptanceGates: 1;
  verifiedProductionApprovals: 1;
  completedFeishuCards: 2;
  duplicateSideEffects: 0;
  plaintextLeaks: 0;
}

async function readBounded(response: Response): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_TOTAL_SCAN_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Watt-derived bounded, pagination-fail-closed, parse-before-secret-scan fetch boundary. */
function secureFetch(base: typeof fetch, scanner: SecretScanner): typeof fetch {
  return (async (input, init) => {
    const response = await base(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(10_000),
    });
    if (/\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
      await response.body?.cancel();
      throw new MergeDeploymentE2EEvidenceVerificationError('external_response_invalid');
    }
    const clone = response.clone();
    const bytes = await readBounded(clone);
    if (bytes === null) {
      await response.body?.cancel();
      throw new MergeDeploymentE2EEvidenceVerificationError('external_response_invalid');
    }
    if (scanner.scanText(new TextDecoder().decode(bytes), '$.externalResponse').length > 0) {
      await response.body?.cancel();
      throw new MergeDeploymentE2EEvidenceVerificationError('secret_leak_detected');
    }
    return response;
  }) as typeof fetch;
}

function inWindow(timestamp: string, manifest: MergeDeploymentE2EEvidenceManifestV1): boolean {
  const value = Date.parse(timestamp);
  return value >= Date.parse(manifest.observedWindow.startedAt) &&
    value <= Date.parse(manifest.observedWindow.endedAt);
}

function gateMatchesMerge(
  gate: MergeGateEvidenceManifestV1['cases'][number],
  merge: MergeEvidenceManifestV1['cases'][number],
): boolean {
  return gate.outcome === 'ready_to_merge' && merge.outcome !== 'not_merged' &&
    gate.runId === merge.runId && gate.repository === merge.repository &&
    gate.pullRequestNumber === merge.pullRequest.number && gate.decisionId === merge.decisionId &&
    gate.fact.repository === merge.repository && gate.fact.number === merge.pullRequest.number &&
    gate.fact.headBranch === merge.pullRequest.headBranch &&
    gate.fact.headSha === merge.pullRequest.headSha &&
    gate.fact.baseBranch === merge.pullRequest.baseBranch && gate.fact.baseSha === merge.baseSha &&
    gate.fact.state === 'open' && gate.fact.draft === false &&
    gate.fact.reviewDecision === 'approved' && gate.fact.requiredApprovals > 0 &&
    gate.fact.approvedReviewCount >= gate.fact.requiredApprovals &&
    gate.fact.requiredChecks.length > 0 &&
    gate.fact.requiredChecks.every((check) => check.state === 'passed') &&
    gate.approval !== null && Date.parse(gate.approval.expiresAt) > Date.parse(merge.merge.mergedAt) &&
    Date.parse(gate.evaluation.createdAt) <= Date.parse(merge.merge.mergedAt);
}

function selected<T extends { caseId: string }>(rows: T[], caseId: string): T | undefined {
  return rows.find((item) => item.caseId === caseId);
}

export async function verifyMergeDeploymentE2EEvidence(
  rawManifest: unknown,
  rawComponents: MergeDeploymentE2EEvidenceComponents,
  options: MergeDeploymentE2EEvidenceVerifierOptions,
): Promise<MergeDeploymentE2EEvidenceVerificationSummary> {
  const parsedManifest = MergeDeploymentE2EEvidenceManifestV1Schema.safeParse(rawManifest);
  if (!parsedManifest.success) {
    throw new MergeDeploymentE2EEvidenceVerificationError('manifest_invalid');
  }
  const parsed = {
    testGate: MergeGateEvidenceManifestV1Schema.safeParse(rawComponents.testMergeGate),
    productionGate: MergeGateEvidenceManifestV1Schema.safeParse(rawComponents.productionMergeGate),
    merge: MergeEvidenceManifestV1Schema.safeParse(rawComponents.merge),
    testDeployment: TestDeploymentEvidenceManifestV1Schema.safeParse(rawComponents.testDeployment),
    testAcceptance: TestAcceptanceEvidenceManifestV1Schema.safeParse(rawComponents.testAcceptance),
    productionApproval: ProductionApprovalEvidenceManifestV1Schema.safeParse(
      rawComponents.productionApproval,
    ),
    productionDeployment: ProductionDeploymentEvidenceManifestV1Schema.safeParse(
      rawComponents.productionDeployment,
    ),
    completion: FeishuCardCompletionEvidenceManifestV1Schema.safeParse(
      rawComponents.feishuCompletion,
    ),
  };
  if (Object.values(parsed).some((item) => !item.success)) {
    throw new MergeDeploymentE2EEvidenceVerificationError('component_manifest_invalid');
  }
  const manifest = parsedManifest.data;
  const components = {
    testGate: parsed.testGate.data!, productionGate: parsed.productionGate.data!,
    merge: parsed.merge.data!, testDeployment: parsed.testDeployment.data!,
    testAcceptance: parsed.testAcceptance.data!,
    productionApproval: parsed.productionApproval.data!,
    productionDeployment: parsed.productionDeployment.data!, completion: parsed.completion.data!,
  };
  const tokens = [options.operationsToken, options.githubToken, options.feishuAccessToken];
  if (
    tokens.some((token) => !TOKEN_PATTERN.test(token)) || !CANARY_PATTERN.test(options.canary) ||
    new SecretScanner().scanText(options.canary, '$.canary').length === 0 ||
    await canonicalSha256(options.canary) !== manifest.safety.canaryDigest
  ) throw new MergeDeploymentE2EEvidenceVerificationError('configuration_invalid');

  const componentPairs = [
    [components.testGate, manifest.components.testMergeGate],
    [components.productionGate, manifest.components.productionMergeGate],
    [components.merge, manifest.components.merge],
    [components.testDeployment, manifest.components.testDeployment],
    [components.testAcceptance, manifest.components.testAcceptance],
    [components.productionApproval, manifest.components.productionApproval],
    [components.productionDeployment, manifest.components.productionDeployment],
    [components.completion, manifest.components.feishuCompletion],
  ] as const;
  for (const [component, identity] of componentPairs) {
    if (
      component.evidenceId !== identity.evidenceId ||
      await canonicalSha256(component) !== identity.manifestDigest
    ) throw new MergeDeploymentE2EEvidenceVerificationError('component_digest_mismatch');
  }

  const testGate = selected(components.testGate.cases, manifest.components.testMergeGate.caseId);
  const productionGate = selected(
    components.productionGate.cases,
    manifest.components.productionMergeGate.caseId,
  );
  const testMerge = selected(components.merge.cases, manifest.components.merge.testCaseId);
  const productionMerge = selected(
    components.merge.cases,
    manifest.components.merge.productionCaseId,
  );
  const testDeployment = selected(
    components.testDeployment.cases,
    manifest.components.testDeployment.caseId,
  );
  const testAcceptance = selected(
    components.testAcceptance.cases,
    manifest.components.testAcceptance.caseId,
  );
  const productionApproval = selected(
    components.productionApproval.cases,
    manifest.components.productionApproval.caseId,
  );
  const productionDeployment = selected(
    components.productionDeployment.cases,
    manifest.components.productionDeployment.caseId,
  );
  const testCompletion = selected(
    components.completion.cases,
    manifest.components.feishuCompletion.testCaseId,
  );
  const productionCompletion = selected(
    components.completion.cases,
    manifest.components.feishuCompletion.productionCaseId,
  );
  if (
    testGate === undefined || productionGate === undefined || testMerge === undefined ||
    productionMerge === undefined || testDeployment === undefined ||
    testAcceptance === undefined || productionApproval === undefined ||
    productionDeployment === undefined || testCompletion === undefined ||
    productionCompletion === undefined || testMerge.outcome !== 'merged_test' ||
    productionMerge.outcome !== 'merged_production' || testDeployment.outcome !== 'succeeded' ||
    testAcceptance.outcome !== 'passed' || productionApproval.outcome !== 'accepted' ||
    productionDeployment.externalState !== 'success' || testCompletion.lane !== 'test' ||
    productionCompletion.lane !== 'production'
  ) throw new MergeDeploymentE2EEvidenceVerificationError('composition_mismatch');

  const repositoryMatches = [
    components.testGate, components.productionGate, components.merge,
    components.testDeployment, components.testAcceptance, components.productionApproval,
    components.productionDeployment, components.completion,
  ].every((component) => component.repository === manifest.repository);
  const recordedInWindow = [
    components.testGate.recordedAt, components.productionGate.recordedAt,
    components.merge.recordedAt, components.testDeployment.recordedAt,
    components.testAcceptance.recordedAt, components.productionApproval.recordedAt,
    components.productionDeployment.recordedAt, components.completion.recordedAt,
  ].every((timestamp) => inWindow(timestamp, manifest));
  const testBound = gateMatchesMerge(testGate, testMerge) &&
    testMerge.runState === 'succeeded' && testDeployment.runId === testMerge.runId &&
    testDeployment.planId === testMerge.planId &&
    testDeployment.planVersion === testMerge.planVersion &&
    testDeployment.planDigest === testMerge.planDigest &&
    testDeployment.refSha === testMerge.pullRequest.headSha &&
    testAcceptance.runId === testMerge.runId && testAcceptance.planId === testMerge.planId &&
    testAcceptance.planVersion === testMerge.planVersion &&
    testAcceptance.planDigest === testMerge.planDigest &&
    testAcceptance.deploymentId === testDeployment.deploymentId &&
    testAcceptance.deploymentEvidenceId === testDeployment.deploymentEvidenceId &&
    testAcceptance.refSha === testDeployment.refSha &&
    testCompletion.runId === testMerge.runId && testCompletion.planVersion === testMerge.planVersion &&
    testCompletion.planDigest === testMerge.planDigest && testCompletion.baseSha === testMerge.baseSha &&
    testCompletion.runVersion === testMerge.currentRunVersion &&
    testCompletion.pullRequestUrl === testMerge.pullRequest.url &&
    testCompletion.deploymentUrl === testDeployment.environmentUrl &&
    Date.parse(testDeployment.webhook.observedAt) <= Date.parse(testAcceptance.webhook.observedAt) &&
    Date.parse(testAcceptance.webhook.observedAt) <= Date.parse(testMerge.merge.mergedAt) &&
    Date.parse(testMerge.merge.mergedAt) <= Date.parse(testCompletion.completion.deliveredAt);
  const productionBound = gateMatchesMerge(productionGate, productionMerge) &&
    productionMerge.runState === 'deploying' &&
    productionApproval.runId === productionMerge.runId &&
    productionApproval.planId === productionMerge.planId &&
    productionApproval.planVersion === productionMerge.planVersion &&
    productionApproval.planDigest === productionMerge.planDigest &&
    productionApproval.baseSha === productionMerge.baseSha &&
    productionApproval.mergeId === productionMerge.mergeId &&
    productionApproval.mergeSha === productionMerge.merge.mergeSha &&
    productionDeployment.runId === productionMerge.runId &&
    productionDeployment.planId === productionMerge.planId &&
    productionDeployment.planVersion === productionMerge.planVersion &&
    productionDeployment.planDigest === productionMerge.planDigest &&
    productionDeployment.baseSha === productionMerge.baseSha &&
    productionDeployment.mergeId === productionMerge.mergeId &&
    productionDeployment.mergeSha === productionMerge.merge.mergeSha &&
    productionDeployment.approvalId === productionApproval.approvalId &&
    productionDeployment.runVersion === productionApproval.currentRunVersion &&
    productionCompletion.runId === productionMerge.runId &&
    productionCompletion.planVersion === productionMerge.planVersion &&
    productionCompletion.planDigest === productionMerge.planDigest &&
    productionCompletion.baseSha === productionMerge.baseSha &&
    productionCompletion.runVersion === productionDeployment.currentRunVersion &&
    productionCompletion.pullRequestUrl === productionMerge.pullRequest.url &&
    productionCompletion.deploymentUrl === productionDeployment.environmentUrl &&
    Date.parse(productionMerge.merge.mergedAt) <= Date.parse(productionApproval.source.occurredAt) &&
    Date.parse(productionApproval.binding.createdAt) <=
      Date.parse(productionDeployment.externalUpdatedAt) &&
    Date.parse(productionDeployment.externalUpdatedAt) <=
      Date.parse(productionCompletion.completion.deliveredAt);
  if (
    !repositoryMatches || !recordedInWindow || !testBound || !productionBound ||
    testMerge.runId === productionMerge.runId ||
    components.completion.safety.canaryDigest !== manifest.safety.canaryDigest
  ) throw new MergeDeploymentE2EEvidenceVerificationError('composition_mismatch');

  const scanner = new SecretScanner({ secrets: [...tokens, options.canary] });
  const fetcher = secureFetch(options.fetch ?? fetch, scanner);
  const common = {
    controlPlaneOrigin: options.controlPlaneOrigin,
    controlPlaneToken: options.operationsToken,
    githubToken: options.githubToken,
    ...(options.githubApiOrigin === undefined ? {} : { githubApiOrigin: options.githubApiOrigin }),
    fetch: fetcher,
  };
  try {
    const summaries = await Promise.all([
      verifyMergeGateEvidence(components.testGate, common),
      verifyMergeGateEvidence(components.productionGate, common),
      verifyMergeEvidence(components.merge, common),
      verifyTestDeploymentEvidence(components.testDeployment, common),
      verifyTestAcceptanceEvidence(components.testAcceptance, common),
      verifyProductionApprovalEvidence(components.productionApproval, common),
      verifyProductionDeploymentEvidence(components.productionDeployment, common),
      verifyFeishuCardCompletionEvidence(components.completion, {
        controlPlaneOrigin: options.controlPlaneOrigin,
        operationsToken: options.operationsToken,
        feishuAccessToken: options.feishuAccessToken,
        canarySecret: options.canary,
        ...(options.feishuApiOrigin === undefined ? {} : { feishuApiOrigin: options.feishuApiOrigin }),
        fetch: fetcher,
      }),
    ]);
    if (
      summaries.some((summary, index) =>
        summary.evidenceId !== componentPairs[index]![1].evidenceId ||
        summary.repository !== manifest.repository) ||
      summaries[0].readyToMergeCases !== 1 || summaries[1].readyToMergeCases !== 1 ||
      summaries[2].verifiedMergeCount < 2 || summaries[3].succeededCases < 1 ||
      summaries[4].passedCases < 1 || summaries[5].acceptedCases < 1 ||
      summaries[6].succeededCases < 1 || summaries[7].completedCards !== 2 ||
      summaries[2].duplicateMergeEffects !== 0 || summaries[3].duplicateDeployments !== 0 ||
      summaries[4].duplicateAcceptances !== 0 || summaries[5].productionEffects !== 0 ||
      summaries[6].duplicateDeployments !== 0 || summaries[7].activeActions !== 0 ||
      summaries[7].plaintextLeaks !== 0
    ) throw new MergeDeploymentE2EEvidenceVerificationError('component_verification_failed');
  } catch (error) {
    if (error instanceof MergeDeploymentE2EEvidenceVerificationError) throw error;
    throw new MergeDeploymentE2EEvidenceVerificationError('component_verification_failed');
  }
  return {
    schemaVersion: '1', evidenceId: manifest.evidenceId, repository: manifest.repository,
    testRunId: testMerge.runId, productionRunId: productionMerge.runId,
    verifiedComponentCount: 8, readyMergeGates: 2, verifiedMerges: 2,
    verifiedDeployments: 2, verifiedAcceptanceGates: 1, verifiedProductionApprovals: 1,
    completedFeishuCards: 2, duplicateSideEffects: 0, plaintextLeaks: 0,
  };
}
