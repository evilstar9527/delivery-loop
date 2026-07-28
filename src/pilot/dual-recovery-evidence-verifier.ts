import { canonicalSha256 } from '../domain/digest.js';
import {
  DualRecoveryEvidenceManifestV1Schema,
  type DualRecoveryEvidenceManifestV1,
} from '../domain/dual-recovery-evidence.js';
import {
  RunnerRecoveryEvidenceManifestV1Schema,
  type RunnerRecoveryEvidenceManifestV1,
} from '../domain/runner-recovery-evidence.js';
import {
  WorkflowHibernateEvidenceManifestV1Schema,
  type WorkflowHibernateEvidenceManifestV1,
} from '../domain/workflow-hibernate-evidence.js';
import { SecretScanner } from '../security/redaction.js';
import {
  verifyRunnerRecoveryEvidence,
  type RunnerRecoveryEvidenceVerificationSummary,
} from './runner-recovery-evidence-verifier.js';
import {
  verifyWorkflowHibernateEvidence,
  type WorkflowHibernateEvidenceVerificationSummary,
} from './workflow-hibernate-evidence-verifier.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const CANARY_PATTERN = /^[^\0\r\n]{8,20000}$/;

export type DualRecoveryEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'component_manifest_invalid'
  | 'configuration_invalid'
  | 'component_digest_mismatch'
  | 'composition_mismatch'
  | 'component_verification_failed';

export class DualRecoveryEvidenceVerificationError extends Error {
  constructor(readonly code: DualRecoveryEvidenceVerificationErrorCode) {
    super(`Dual recovery evidence verification failed: ${code}`);
    this.name = 'DualRecoveryEvidenceVerificationError';
  }
}

export interface DualRecoveryEvidenceComponents {
  workflowHibernate: WorkflowHibernateEvidenceManifestV1;
  runnerRecovery: RunnerRecoveryEvidenceManifestV1;
}

export interface DualRecoveryComponentVerifiers {
  workflowHibernate: typeof verifyWorkflowHibernateEvidence;
  runnerRecovery: typeof verifyRunnerRecoveryEvidence;
}

export interface DualRecoveryEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  operationsToken: string;
  githubToken: string;
  cloudflareToken: string;
  cloudflareAccountId: string;
  canary: string;
  githubApiOrigin?: string;
  cloudflareApiOrigin?: string;
  fetch?: typeof fetch;
  /** Test seam only; the named CLI never supplies alternate authorities. */
  componentVerifiers?: DualRecoveryComponentVerifiers;
}

export interface DualRecoveryEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  verifiedScenarioCount: 2;
  distinctRunCount: 2;
  reusedWorkflowSteps: true;
  runnerLeaseAndTokenRevoked: true;
  resumedFromCheckpointAndGit: true;
  duplicateSideEffects: 0;
  controlledReplayCount: 0;
  plaintextLeaks: 0;
}

function inWindow(recordedAt: string, manifest: DualRecoveryEvidenceManifestV1): boolean {
  const timestamp = Date.parse(recordedAt);
  return timestamp >= Date.parse(manifest.observedWindow.startedAt) &&
    timestamp <= Date.parse(manifest.observedWindow.endedAt);
}

function workflowSummaryMatches(
  summary: WorkflowHibernateEvidenceVerificationSummary,
  manifest: DualRecoveryEvidenceManifestV1,
): boolean {
  return summary.evidenceId === manifest.workflowHibernate.evidenceId &&
    summary.runId === manifest.workflowHibernate.runId &&
    summary.repository === manifest.repository && summary.reusedCompletedSteps === true &&
    summary.duplicateDispatches === 0 && summary.controlledReplayCount === 0 &&
    summary.plaintextLeaks === 0;
}

function runnerSummaryMatches(
  summary: RunnerRecoveryEvidenceVerificationSummary,
  manifest: DualRecoveryEvidenceManifestV1,
): boolean {
  return summary.evidenceId === manifest.runnerRecovery.evidenceId &&
    summary.runId === manifest.runnerRecovery.runId && summary.repository === manifest.repository &&
    summary.recovery === 'verified' && summary.oldLeaseGenerationRevoked === true &&
    summary.oldTokenRevoked === true && summary.workflowCancelSettled === true &&
    summary.replacementCommitCount === 1 && summary.gitRelationship === 'fast_forward' &&
    summary.controlledReplayCount === 0 && summary.plaintextLeaks === 0;
}

/** Composes two independent live recovery scenarios without duplicating either authority parser. */
export async function verifyDualRecoveryEvidence(
  rawManifest: unknown,
  rawComponents: DualRecoveryEvidenceComponents,
  options: DualRecoveryEvidenceVerifierOptions,
): Promise<DualRecoveryEvidenceVerificationSummary> {
  const parsedManifest = DualRecoveryEvidenceManifestV1Schema.safeParse(rawManifest);
  if (!parsedManifest.success) throw new DualRecoveryEvidenceVerificationError('manifest_invalid');
  const workflow = WorkflowHibernateEvidenceManifestV1Schema.safeParse(
    rawComponents.workflowHibernate,
  );
  const runner = RunnerRecoveryEvidenceManifestV1Schema.safeParse(rawComponents.runnerRecovery);
  if (!workflow.success || !runner.success) {
    throw new DualRecoveryEvidenceVerificationError('component_manifest_invalid');
  }
  const manifest = parsedManifest.data;
  if (
    !TOKEN_PATTERN.test(options.controlPlaneToken) ||
    !TOKEN_PATTERN.test(options.operationsToken) || !TOKEN_PATTERN.test(options.githubToken) ||
    !TOKEN_PATTERN.test(options.cloudflareToken) ||
    !ACCOUNT_ID_PATTERN.test(options.cloudflareAccountId) ||
    !CANARY_PATTERN.test(options.canary) ||
    new SecretScanner().scanText(options.canary, '$.canary').length === 0 ||
    await canonicalSha256(options.canary) !== manifest.safety.canaryDigest
  ) throw new DualRecoveryEvidenceVerificationError('configuration_invalid');

  if (
    await canonicalSha256(workflow.data) !== manifest.workflowHibernate.manifestDigest ||
    await canonicalSha256(runner.data) !== manifest.runnerRecovery.manifestDigest
  ) throw new DualRecoveryEvidenceVerificationError('component_digest_mismatch');
  if (
    workflow.data.repository !== manifest.repository || runner.data.repository !== manifest.repository ||
    workflow.data.evidenceId !== manifest.workflowHibernate.evidenceId ||
    workflow.data.run.runId !== manifest.workflowHibernate.runId ||
    workflow.data.analysis.actionRunId !== manifest.workflowHibernate.actionRunId ||
    runner.data.evidenceId !== manifest.runnerRecovery.evidenceId ||
    runner.data.runId !== manifest.runnerRecovery.runId ||
    runner.data.lost.actionRunId !== manifest.runnerRecovery.lostActionRunId ||
    runner.data.replacement.actionRunId !== manifest.runnerRecovery.replacementActionRunId ||
    workflow.data.safety.canaryDigest !== manifest.safety.canaryDigest ||
    runner.data.safety.canaryDigest !== manifest.safety.canaryDigest ||
    !inWindow(workflow.data.recordedAt, manifest) || !inWindow(runner.data.recordedAt, manifest)
  ) throw new DualRecoveryEvidenceVerificationError('composition_mismatch');

  const verifiers = options.componentVerifiers ?? {
    workflowHibernate: verifyWorkflowHibernateEvidence,
    runnerRecovery: verifyRunnerRecoveryEvidence,
  };
  let workflowSummary: WorkflowHibernateEvidenceVerificationSummary;
  let runnerSummary: RunnerRecoveryEvidenceVerificationSummary;
  try {
    [workflowSummary, runnerSummary] = await Promise.all([
      verifiers.workflowHibernate(workflow.data, {
        controlPlaneOrigin: options.controlPlaneOrigin,
        controlPlaneToken: options.controlPlaneToken,
        operationsToken: options.operationsToken,
        githubToken: options.githubToken,
        cloudflareToken: options.cloudflareToken,
        cloudflareAccountId: options.cloudflareAccountId,
        canary: options.canary,
        ...(options.githubApiOrigin === undefined
          ? {} : { githubApiOrigin: options.githubApiOrigin }),
        ...(options.cloudflareApiOrigin === undefined
          ? {} : { cloudflareApiOrigin: options.cloudflareApiOrigin }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
      verifiers.runnerRecovery(runner.data, {
        controlPlaneOrigin: options.controlPlaneOrigin,
        controlPlaneToken: options.controlPlaneToken,
        operationsToken: options.operationsToken,
        githubToken: options.githubToken,
        canary: options.canary,
        ...(options.githubApiOrigin === undefined
          ? {} : { githubApiOrigin: options.githubApiOrigin }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
    ]);
  } catch {
    throw new DualRecoveryEvidenceVerificationError('component_verification_failed');
  }
  if (!workflowSummaryMatches(workflowSummary, manifest) ||
    !runnerSummaryMatches(runnerSummary, manifest)) {
    throw new DualRecoveryEvidenceVerificationError('component_verification_failed');
  }
  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    repository: manifest.repository,
    verifiedScenarioCount: 2,
    distinctRunCount: 2,
    reusedWorkflowSteps: true,
    runnerLeaseAndTokenRevoked: true,
    resumedFromCheckpointAndGit: true,
    duplicateSideEffects: 0,
    controlledReplayCount: 0,
    plaintextLeaks: 0,
  };
}
