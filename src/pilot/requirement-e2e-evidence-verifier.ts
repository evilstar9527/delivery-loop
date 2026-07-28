import { canonicalSha256 } from '../domain/digest.js';
import {
  RequirementE2EEvidenceManifestV1Schema,
  type RequirementE2EEvidenceManifestV1,
} from '../domain/requirement-e2e-evidence.js';
import {
  MeegleWorkItemEvidenceManifestV1Schema,
  type MeegleWorkItemEvidenceManifestV1,
} from '../domain/meegle-work-item-evidence.js';
import {
  AnalysisActionEvidenceManifestV1Schema,
  type AnalysisActionEvidenceManifestV1,
} from '../domain/analysis-action-evidence.js';
import {
  FeishuCardActionEvidenceManifestV1Schema,
  type FeishuCardActionEvidenceManifestV1,
} from '../domain/feishu-card-action-evidence.js';
import {
  verifyMeegleWorkItemEvidence,
} from './meegle-work-item-evidence-verifier.js';
import type { MeegleCommandRunner } from './meegle-work-item-evidence-verifier.js';
import { verifyAnalysisActionEvidence } from './analysis-action-evidence-verifier.js';
import { verifyFeishuCardActionEvidence } from './feishu-card-action-evidence-verifier.js';
import { SecretScanner } from '../security/redaction.js';
import { z } from 'zod';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const CANARY_PATTERN = /^[^\0\r\n]{8,20000}$/;
const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;

const CloudflareInstanceSchema = z.object({
  success: z.literal(true),
  errors: z.array(z.unknown()).length(0),
  messages: z.array(z.unknown()),
  result: z.object({
    status: z.string().min(1).max(64),
    versionId: z.string().uuid(),
    start: z.iso.datetime({ offset: true }),
  }).passthrough(),
}).strict();

export interface RequirementE2EEvidenceSources {
  meegleWorkItem: MeegleWorkItemEvidenceManifestV1;
  analysisAction: AnalysisActionEvidenceManifestV1;
  feishuCardAction: FeishuCardActionEvidenceManifestV1;
}

export type RequirementE2EEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'component_manifest_invalid'
  | 'configuration_invalid'
  | 'component_digest_mismatch'
  | 'lineage_mismatch'
  | 'meegle_evidence_mismatch'
  | 'analysis_evidence_mismatch'
  | 'approval_evidence_mismatch'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'approval_state_mismatch'
  | 'cloudflare_api_unavailable'
  | 'cloudflare_response_invalid'
  | 'workflow_instance_mismatch'
  | 'secret_leak_detected';

export class RequirementE2EEvidenceVerificationError extends Error {
  constructor(readonly code: RequirementE2EEvidenceVerificationErrorCode) {
    super(`E2E-1 requirement evidence verification failed: ${code}`);
    this.name = 'RequirementE2EEvidenceVerificationError';
  }
}

export interface RequirementE2EEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  operationsToken: string;
  meegleProfile: string;
  tenantKey: string;
  projectKey: string;
  workItemTypeKey: string;
  githubAppJwt: string;
  githubInstallationToken: string;
  expectedRunnerContractDigest: string;
  feishuObservabilityReportUrl: string;
  feishuObservabilityToken: string;
  canarySecret: string;
  cloudflareAccountId: string;
  cloudflareToken: string;
  meegleBinary?: string;
  githubApiOrigin?: string;
  cloudflareApiOrigin?: string;
  commandRunner?: MeegleCommandRunner;
  fetch?: typeof fetch;
}

export interface RequirementE2EEvidenceVerificationSummary {
  schemaVersion: '1';
  scenario: 'E2E-1';
  evidenceId: string;
  source: 'meegle';
  repository: string;
  taskId: string;
  runId: string;
  workflowInstanceId: string;
  analysisActionRunId: string;
  planId: string;
  mappedTasks: 1;
  runs: 1;
  workflowInstances: 1;
  analysisActions: 1;
  plans: 1;
  approvalRecords: 1;
  planSnapshotsApproved: 1;
  effectsApproved: 1;
  repositoryWrites: 0;
  duplicateRuns: 0;
  plaintextLeaks: 0;
  humanReview: 'required_and_recorded';
}

function safeOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new RequirementE2EEvidenceVerificationError('configuration_invalid'); }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new RequirementE2EEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

function safeApiBase(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new RequirementE2EEvidenceVerificationError('configuration_invalid'); }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== ''
  ) throw new RequirementE2EEvidenceVerificationError('configuration_invalid');
  return url.toString().replace(/\/$/, '');
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function rows(parent: Record<string, unknown>, key: string): Array<Record<string, unknown>> | null {
  const value = parent[key];
  if (!Array.isArray(value)) return null;
  const result = value.map(record);
  return result.every((item): item is Record<string, unknown> => item !== null) ? result : null;
}

async function boundedText(response: Response): Promise<string | null> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
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
  return new TextDecoder().decode(bytes);
}

async function verifyWorkflowInstance(
  manifest: RequirementE2EEvidenceManifestV1,
  options: RequirementE2EEvidenceVerifierOptions,
  fetcher: typeof fetch,
  scanner: SecretScanner,
): Promise<void> {
  const apiOrigin = safeApiBase(
    options.cloudflareApiOrigin ?? 'https://api.cloudflare.com/client/v4',
  );
  let response: Response;
  try {
    response = await fetcher(
      `${apiOrigin}/accounts/${options.cloudflareAccountId}/workflows/` +
        `${manifest.cloudflare.workflowName}/instances/${manifest.lineage.workflowInstanceId}`,
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${options.cloudflareToken}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    throw new RequirementE2EEvidenceVerificationError('cloudflare_api_unavailable');
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new RequirementE2EEvidenceVerificationError('cloudflare_api_unavailable');
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new RequirementE2EEvidenceVerificationError('cloudflare_response_invalid');
  }
  let text: string | null;
  try { text = await boundedText(response); }
  catch { throw new RequirementE2EEvidenceVerificationError('cloudflare_response_invalid'); }
  if (text === null) {
    throw new RequirementE2EEvidenceVerificationError('cloudflare_response_invalid');
  }
  if (scanner.scanText(text, '$.cloudflare').length > 0) {
    throw new RequirementE2EEvidenceVerificationError('secret_leak_detected');
  }
  let raw: unknown;
  try { raw = JSON.parse(text) as unknown; }
  catch { throw new RequirementE2EEvidenceVerificationError('cloudflare_response_invalid'); }
  const parsed = CloudflareInstanceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RequirementE2EEvidenceVerificationError('cloudflare_response_invalid');
  }
  if (
    parsed.data.result.status !== manifest.cloudflare.instanceStatus ||
    parsed.data.result.versionId !== manifest.cloudflare.instanceVersionId ||
    parsed.data.result.start !== manifest.cloudflare.instanceStartedAt
  ) throw new RequirementE2EEvidenceVerificationError('workflow_instance_mismatch');
}

async function verifyCurrentApprovalState(
  manifest: RequirementE2EEvidenceManifestV1,
  sources: RequirementE2EEvidenceSources,
  options: RequirementE2EEvidenceVerifierOptions,
  fetcher: typeof fetch,
  scanner: SecretScanner,
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(
      `${safeOrigin(options.controlPlaneOrigin)}/v1/runs/${manifest.lineage.runId}/audit`,
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${options.operationsToken}`,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    throw new RequirementE2EEvidenceVerificationError('control_plane_unavailable');
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new RequirementE2EEvidenceVerificationError('control_plane_unavailable');
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new RequirementE2EEvidenceVerificationError('control_plane_response_invalid');
  }
  let text: string | null;
  try { text = await boundedText(response); }
  catch { throw new RequirementE2EEvidenceVerificationError('control_plane_response_invalid'); }
  if (text === null) {
    throw new RequirementE2EEvidenceVerificationError('control_plane_response_invalid');
  }
  if (scanner.scanText(text, '$.control_plane').length > 0) {
    throw new RequirementE2EEvidenceVerificationError('secret_leak_detected');
  }
  let raw: unknown;
  try { raw = JSON.parse(text) as unknown; }
  catch { throw new RequirementE2EEvidenceVerificationError('control_plane_response_invalid'); }
  const root = record(raw);
  const run = root === null ? null : record(root.run);
  const answers = root === null ? null : record(root.answers);
  const permissions = answers === null ? null : record(answers.permissions);
  const checks = answers === null ? null : record(answers.checks);
  const approvals = answers === null ? null : rows(answers, 'approvals');
  const credentials = permissions === null ? null : rows(permissions, 'repositoryWriteCredentials');
  const outboxes = checks === null ? null : rows(checks, 'effectOutboxes');
  const changes = answers === null ? null : rows(answers, 'changes');
  const deployments = answers === null ? null : rows(answers, 'deployments');
  if (
    root === null || run === null || answers === null || permissions === null || checks === null ||
    approvals === null || credentials === null || outboxes === null || changes === null ||
    deployments === null || root.schemaVersion !== '1' || root.runId !== manifest.lineage.runId ||
    run.state !== 'awaiting_approval' || run.version !== manifest.lineage.runVersion ||
    run.baseSha !== manifest.lineage.baseSha || credentials.length !== 0 ||
    changes.length !== 0 || deployments.length !== 0 || approvals.length !== 1 ||
    outboxes.length !== 1
  ) throw new RequirementE2EEvidenceVerificationError('approval_state_mismatch');
  const approval = approvals[0]!;
  const analysisOutbox = outboxes[0]!;
  if (
    approval.approvalId !== manifest.approval.approvalId ||
    approval.effect !== manifest.approval.effect || approval.decision !== manifest.approval.decision ||
    approval.planId !== manifest.lineage.planId ||
    approval.planVersion !== manifest.lineage.planVersion ||
    approval.planDigest !== manifest.lineage.planDigest ||
    approval.baseSha !== manifest.lineage.baseSha || approval.invalidated !== false ||
    analysisOutbox.id !== sources.analysisAction.dispatchEvidence.dispatch.dispatchOutboxId ||
    analysisOutbox.kind !== 'analysis_dispatch' || analysisOutbox.state !== 'settled'
  ) throw new RequirementE2EEvidenceVerificationError('approval_state_mismatch');
}

async function verifyDigestsAndLineage(
  manifest: RequirementE2EEvidenceManifestV1,
  sources: RequirementE2EEvidenceSources,
): Promise<void> {
  const componentPairs = [
    [manifest.components.meegleWorkItem, sources.meegleWorkItem],
    [manifest.components.analysisAction, sources.analysisAction],
    [manifest.components.feishuCardAction, sources.feishuCardAction],
  ] as const;
  for (const [reference, source] of componentPairs) {
    if (
      reference.evidenceId !== source.evidenceId ||
      reference.manifestDigest !== await canonicalSha256(source)
    ) throw new RequirementE2EEvidenceVerificationError('component_digest_mismatch');
  }

  const meegle = sources.meegleWorkItem;
  const analysis = sources.analysisAction;
  const dispatch = analysis.dispatchEvidence.dispatch;
  const approvalCases = sources.feishuCardAction.successes.filter(
    (item) => item.scenario === 'approve',
  );
  const approval = approvalCases[0];
  const actor = sources.feishuCardAction.actors.find(
    (item) => item.actorKey === manifest.approval.actorKey,
  );
  const taskRevisionDigest = await canonicalSha256(manifest.lineage.taskRevision);
  const reviewedAfter = Math.max(
    Date.parse(meegle.recordedAt),
    Date.parse(analysis.recordedAt),
    Date.parse(sources.feishuCardAction.recordedAt),
  );
  if (
    approvalCases.length !== 1 || approval === undefined || actor === undefined ||
    manifest.lineage.repository !== analysis.dispatchEvidence.repository.fullName ||
    !meegle.mappingProfile.allowedRepositories.includes(manifest.lineage.repository) ||
    manifest.lineage.sourceEventId !== meegle.cases.mapped.eventId ||
    manifest.lineage.sourceWorkItemId !== meegle.cases.mapped.workItemId ||
    manifest.lineage.taskId !== meegle.mappedResult.taskId ||
    manifest.lineage.taskId !== analysis.task.taskId ||
    manifest.lineage.taskRevision !== meegle.mappedResult.taskRevision ||
    manifest.lineage.taskRevision !== dispatch.taskRevision ||
    manifest.lineage.taskDigest !== meegle.mappedResult.taskDigest ||
    manifest.lineage.taskDigest !== dispatch.taskDigest ||
    manifest.lineage.runId !== meegle.mappedResult.runId ||
    manifest.lineage.runId !== dispatch.runId ||
    manifest.lineage.runVersion !== dispatch.runVersion ||
    manifest.lineage.workflowInstanceId !== meegle.mappedResult.workflowInstanceId ||
    manifest.lineage.planId !== dispatch.planId ||
    manifest.lineage.planVersion !== dispatch.planVersion ||
    manifest.lineage.planDigest !== dispatch.planDigest ||
    manifest.lineage.baseSha !== dispatch.baseSha ||
    manifest.lineage.analysisAttemptId !== dispatch.attemptId ||
    manifest.lineage.analysisActionRunId !== dispatch.actionRunId ||
    analysis.task.inputClass !== 'prd' || analysis.task.intentKind !== 'requirement' ||
    manifest.approval.eventId !== approval.eventId ||
    manifest.approval.actionReceiptId !== approval.actionReceiptId ||
    manifest.approval.approvalId !== approval.resultId ||
    manifest.approval.actorKey !== approval.actorKey ||
    approval.command !== manifest.approval.decision ||
    approval.effect !== manifest.approval.effect || approval.resultKind !== 'approval' ||
    approval.taskId !== manifest.lineage.taskId || approval.runId !== manifest.lineage.runId ||
    approval.runVersion !== manifest.lineage.runVersion ||
    approval.planId !== manifest.lineage.planId ||
    approval.planVersion !== manifest.lineage.planVersion ||
    approval.planDigest !== manifest.lineage.planDigest ||
    approval.baseSha !== manifest.lineage.baseSha ||
    approval.taskRevisionDigest !== taskRevisionDigest ||
    actor.mappingStatus !== 'mapped_human' || actor.principalDigest === null ||
    actor.rolesDigest === null ||
    manifest.safety.canaryDigest !== sources.feishuCardAction.safety.canaryDigest ||
    Date.parse(manifest.cloudflare.instanceStartedAt) > Date.parse(dispatch.actionUpdatedAt) ||
    Date.parse(approval.startedAt) < Date.parse(dispatch.actionUpdatedAt) ||
    Date.parse(manifest.review.reviewedAt) < reviewedAfter
  ) throw new RequirementE2EEvidenceVerificationError('lineage_mismatch');
}

async function component(
  code: 'meegle_evidence_mismatch' | 'analysis_evidence_mismatch' |
    'approval_evidence_mismatch',
  verification: () => Promise<unknown>,
): Promise<void> {
  try { await verification(); }
  catch { throw new RequirementE2EEvidenceVerificationError(code); }
}

export async function verifyRequirementE2EEvidence(
  input: RequirementE2EEvidenceManifestV1,
  rawSources: RequirementE2EEvidenceSources,
  options: RequirementE2EEvidenceVerifierOptions,
): Promise<RequirementE2EEvidenceVerificationSummary> {
  const parsed = RequirementE2EEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new RequirementE2EEvidenceVerificationError('manifest_invalid');
  const parsedMeegle = MeegleWorkItemEvidenceManifestV1Schema.safeParse(rawSources.meegleWorkItem);
  const parsedAnalysis = AnalysisActionEvidenceManifestV1Schema.safeParse(rawSources.analysisAction);
  const parsedCard = FeishuCardActionEvidenceManifestV1Schema.safeParse(rawSources.feishuCardAction);
  if (!parsedMeegle.success || !parsedAnalysis.success || !parsedCard.success) {
    throw new RequirementE2EEvidenceVerificationError('component_manifest_invalid');
  }
  const sources: RequirementE2EEvidenceSources = {
    meegleWorkItem: parsedMeegle.data,
    analysisAction: parsedAnalysis.data,
    feishuCardAction: parsedCard.data,
  };
  const tokens = [
    options.controlPlaneToken, options.operationsToken, options.githubAppJwt,
    options.githubInstallationToken, options.feishuObservabilityToken,
    options.cloudflareToken,
  ];
  const controlPlaneOrigin = safeOrigin(options.controlPlaneOrigin);
  if (
    tokens.some((token) => !TOKEN_PATTERN.test(token)) ||
    !CANARY_PATTERN.test(options.canarySecret) ||
    !ACCOUNT_ID_PATTERN.test(options.cloudflareAccountId) ||
    await canonicalSha256(options.cloudflareAccountId) !== parsed.data.cloudflare.accountIdDigest ||
    await canonicalSha256(options.canarySecret) !== parsed.data.safety.canaryDigest ||
    new SecretScanner().scanText(options.canarySecret, '$.canary').length === 0
  ) throw new RequirementE2EEvidenceVerificationError('configuration_invalid');

  await verifyDigestsAndLineage(parsed.data, sources);
  const fetcher = options.fetch ?? fetch;
  const scanner = new SecretScanner({ secrets: [...tokens, options.canarySecret] });
  await Promise.all([
    component('meegle_evidence_mismatch', async () =>
      await verifyMeegleWorkItemEvidence(sources.meegleWorkItem, {
        controlPlaneOrigin,
        operationsToken: options.operationsToken,
        meegleProfile: options.meegleProfile,
        tenantKey: options.tenantKey,
        projectKey: options.projectKey,
        workItemTypeKey: options.workItemTypeKey,
        ...(options.meegleBinary === undefined ? {} : { meegleBinary: options.meegleBinary }),
        ...(options.commandRunner === undefined ? {} : { commandRunner: options.commandRunner }),
        fetch: fetcher,
      })),
    component('analysis_evidence_mismatch', async () =>
      await verifyAnalysisActionEvidence(sources.analysisAction, {
        controlPlaneOrigin,
        controlPlaneToken: options.controlPlaneToken,
        operationsToken: options.operationsToken,
        githubAppJwt: options.githubAppJwt,
        githubInstallationToken: options.githubInstallationToken,
        expectedRunnerContractDigest: options.expectedRunnerContractDigest,
        ...(options.githubApiOrigin === undefined ? {} : {
          githubApiOrigin: options.githubApiOrigin,
        }),
        fetch: fetcher,
      })),
    component('approval_evidence_mismatch', async () =>
      await verifyFeishuCardActionEvidence(sources.feishuCardAction, {
        controlPlaneOrigin,
        operationsToken: options.operationsToken,
        observabilityReportUrl: options.feishuObservabilityReportUrl,
        observabilityToken: options.feishuObservabilityToken,
        canarySecret: options.canarySecret,
        fetch: fetcher,
      })),
    verifyCurrentApprovalState(parsed.data, sources, options, fetcher, scanner),
    verifyWorkflowInstance(parsed.data, options, fetcher, scanner),
  ]);

  return {
    schemaVersion: '1',
    scenario: 'E2E-1',
    evidenceId: parsed.data.evidenceId,
    source: 'meegle',
    repository: parsed.data.lineage.repository,
    taskId: parsed.data.lineage.taskId,
    runId: parsed.data.lineage.runId,
    workflowInstanceId: parsed.data.lineage.workflowInstanceId,
    analysisActionRunId: parsed.data.lineage.analysisActionRunId,
    planId: parsed.data.lineage.planId,
    mappedTasks: 1,
    runs: 1,
    workflowInstances: 1,
    analysisActions: 1,
    plans: 1,
    approvalRecords: 1,
    planSnapshotsApproved: 1,
    effectsApproved: 1,
    repositoryWrites: 0,
    duplicateRuns: 0,
    plaintextLeaks: 0,
    humanReview: 'required_and_recorded',
  };
}
