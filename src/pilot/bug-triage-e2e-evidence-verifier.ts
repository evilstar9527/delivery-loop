import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';
import {
  BugTriageE2EEvidenceManifestV1Schema,
  type BugTriageE2EEvidenceManifestV1,
} from '../domain/bug-triage-e2e-evidence.js';
import {
  AnalysisActionEvidenceManifestV1Schema,
  type AnalysisActionEvidenceManifestV1,
} from '../domain/analysis-action-evidence.js';
import { verifyAnalysisActionEvidence } from './analysis-action-evidence-verifier.js';
import { SecretScanner } from '../security/redaction.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const CANARY_PATTERN = /^[^\0\r\n]{8,20000}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;

const DiagnosticProjectionSchema = z.object({
  schemaVersion: z.literal('1'),
  runId: z.string(),
  task: z.object({
    id: z.string(), intentKind: z.literal('bug'), revision: z.string(),
    digest: z.string().regex(DIGEST_PATTERN), repository: z.string(),
  }).strict(),
  plan: z.object({
    id: z.string(), version: z.number().int().positive(),
    digest: z.string().regex(DIGEST_PATTERN), status: z.string(),
    diagnosticEvidenceRefs: z.array(z.string()),
  }).strict(),
  evidence: z.array(z.object({
    evidenceId: z.string(), evidenceRef: z.string(), attemptId: z.string(),
    locatorKinds: z.array(z.enum(['uid', 'cid', 'path'])),
    locatorDigest: z.string().regex(DIGEST_PATTERN),
    rootCauseDigest: z.string().regex(DIGEST_PATTERN),
    evidenceDigest: z.string().regex(DIGEST_PATTERN),
    observedAt: z.iso.datetime({ offset: true }),
    sourceTraces: z.array(z.object({
      traceId: z.string(), toolPath: z.enum(['logs/search', 'traces/get']),
      action: z.enum(['logs:read', 'trace:read']), effect: z.literal('read'),
      resultCategory: z.literal('success'), occurredAt: z.iso.datetime({ offset: true }),
    }).strict()),
  }).strict()),
}).strict();

export interface BugTriageE2EEvidenceSources {
  analysisAction: AnalysisActionEvidenceManifestV1;
}

export type BugTriageE2EEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'component_manifest_invalid'
  | 'configuration_invalid'
  | 'component_digest_mismatch'
  | 'analysis_evidence_mismatch'
  | 'lineage_mismatch'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'diagnostic_evidence_mismatch'
  | 'production_write_detected'
  | 'secret_leak_detected';

export class BugTriageE2EEvidenceVerificationError extends Error {
  constructor(readonly code: BugTriageE2EEvidenceVerificationErrorCode) {
    super(`E2E-2 bug triage evidence verification failed: ${code}`);
    this.name = 'BugTriageE2EEvidenceVerificationError';
  }
}

export interface BugTriageE2EEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  controlPlaneToken: string;
  operationsToken: string;
  githubAppJwt: string;
  githubInstallationToken: string;
  expectedRunnerContractDigest: string;
  canarySecret: string;
  githubApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface BugTriageE2EEvidenceVerificationSummary {
  schemaVersion: '1';
  scenario: 'E2E-2';
  evidenceId: string;
  repository: string;
  taskId: string;
  runId: string;
  planId: string;
  actionRunId: string;
  diagnosticEvidence: 1;
  logSearches: number;
  traceReads: number;
  planDiagnosticRefs: 1;
  repositoryWrites: 0;
  deployments: 0;
  plaintextLeaks: 0;
  humanReview: 'required_and_recorded';
}

function safeOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new BugTriageE2EEvidenceVerificationError('configuration_invalid'); }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new BugTriageE2EEvidenceVerificationError('configuration_invalid');
  return url.origin;
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

async function getControlPlaneJson(
  fetcher: typeof fetch,
  origin: string,
  path: string,
  token: string,
  scanner: SecretScanner,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(`${origin}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new BugTriageE2EEvidenceVerificationError('control_plane_unavailable');
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new BugTriageE2EEvidenceVerificationError('control_plane_unavailable');
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new BugTriageE2EEvidenceVerificationError('control_plane_response_invalid');
  }
  let text: string | null;
  try { text = await boundedText(response); }
  catch { throw new BugTriageE2EEvidenceVerificationError('control_plane_response_invalid'); }
  if (text === null) {
    throw new BugTriageE2EEvidenceVerificationError('control_plane_response_invalid');
  }
  if (scanner.scanText(text, '$.control_plane').length > 0) {
    throw new BugTriageE2EEvidenceVerificationError('secret_leak_detected');
  }
  try { return JSON.parse(text) as unknown; }
  catch { throw new BugTriageE2EEvidenceVerificationError('control_plane_response_invalid'); }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function records(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  const values = value.map(record);
  return values.every((item): item is Record<string, unknown> => item !== null) ? values : null;
}

function verifyNoProductionWrite(
  raw: unknown,
  manifest: BugTriageE2EEvidenceManifestV1,
): void {
  const root = record(raw);
  const run = root === null ? null : record(root.run);
  const answers = root === null ? null : record(root.answers);
  const permissions = answers === null ? null : record(answers.permissions);
  const checks = answers === null ? null : record(answers.checks);
  const credentials = permissions === null ? null : records(permissions.repositoryWriteCredentials);
  const effects = permissions === null ? null : records(permissions.planEffects);
  const changes = answers === null ? null : records(answers.changes);
  const deployments = answers === null ? null : records(answers.deployments);
  const outboxes = checks === null ? null : records(checks.effectOutboxes);
  if (
    root === null || run === null || answers === null || permissions === null || checks === null ||
    credentials === null || effects === null || changes === null || deployments === null ||
    outboxes === null || root.schemaVersion !== '1' || root.runId !== manifest.lineage.runId ||
    run.state !== 'awaiting_approval' || run.version !== manifest.lineage.runVersion ||
    run.baseSha !== manifest.lineage.baseSha || credentials.length !== 0 ||
    changes.length !== 0 || deployments.length !== 0 ||
    effects.some((effect) =>
      !['repo_read', 'logs_read', 'database_diagnostic'].includes(String(effect.effect))) ||
    outboxes.some((outbox) => outbox.kind !== 'analysis_dispatch')
  ) throw new BugTriageE2EEvidenceVerificationError('production_write_detected');
}

function verifyDiagnosticProjection(
  raw: unknown,
  manifest: BugTriageE2EEvidenceManifestV1,
): { logSearches: number; traceReads: number } {
  const parsed = DiagnosticProjectionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BugTriageE2EEvidenceVerificationError('control_plane_response_invalid');
  }
  const projection = parsed.data;
  const diagnosis = manifest.diagnosis;
  if (
    projection.runId !== manifest.lineage.runId ||
    projection.task.id !== manifest.lineage.taskId ||
    projection.task.revision !== manifest.lineage.taskRevision ||
    projection.task.digest !== manifest.lineage.taskDigest ||
    projection.task.repository !== manifest.lineage.repository ||
    projection.plan.id !== manifest.lineage.planId ||
    projection.plan.version !== manifest.lineage.planVersion ||
    projection.plan.digest !== manifest.lineage.planDigest ||
    !['active', 'approved'].includes(projection.plan.status) ||
    projection.plan.diagnosticEvidenceRefs.length !== 1 ||
    projection.plan.diagnosticEvidenceRefs[0] !== diagnosis.evidenceRef ||
    projection.evidence.length !== 1
  ) throw new BugTriageE2EEvidenceVerificationError('diagnostic_evidence_mismatch');
  const evidence = projection.evidence[0]!;
  const logSources = evidence.sourceTraces.filter((trace) => trace.toolPath === 'logs/search');
  const traceSources = evidence.sourceTraces.filter((trace) => trace.toolPath === 'traces/get');
  if (
    evidence.evidenceId !== diagnosis.evidenceId || evidence.evidenceRef !== diagnosis.evidenceRef ||
    evidence.attemptId !== manifest.lineage.analysisAttemptId ||
    evidence.locatorKinds.length !== diagnosis.locatorKinds.length ||
    evidence.locatorKinds.some((kind, index) => kind !== diagnosis.locatorKinds[index]) ||
    evidence.locatorDigest !== diagnosis.locatorDigest ||
    evidence.rootCauseDigest !== diagnosis.rootCauseDigest ||
    evidence.evidenceDigest !== diagnosis.evidenceDigest ||
    evidence.observedAt !== diagnosis.observedAt ||
    logSources.length < 1 || traceSources.length < 1 ||
    !logSources.some((trace) => trace.traceId === diagnosis.logsTraceId) ||
    !traceSources.some((trace) => trace.traceId === diagnosis.requestTraceId)
  ) throw new BugTriageE2EEvidenceVerificationError('diagnostic_evidence_mismatch');
  return { logSearches: logSources.length, traceReads: traceSources.length };
}

export async function verifyBugTriageE2EEvidence(
  input: BugTriageE2EEvidenceManifestV1,
  sources: BugTriageE2EEvidenceSources,
  options: BugTriageE2EEvidenceVerifierOptions,
): Promise<BugTriageE2EEvidenceVerificationSummary> {
  const parsed = BugTriageE2EEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new BugTriageE2EEvidenceVerificationError('manifest_invalid');
  const analysisParsed = AnalysisActionEvidenceManifestV1Schema.safeParse(sources.analysisAction);
  if (!analysisParsed.success) {
    throw new BugTriageE2EEvidenceVerificationError('component_manifest_invalid');
  }
  if (
    !TOKEN_PATTERN.test(options.controlPlaneToken) ||
    !TOKEN_PATTERN.test(options.operationsToken) ||
    !TOKEN_PATTERN.test(options.githubAppJwt) ||
    !TOKEN_PATTERN.test(options.githubInstallationToken) ||
    !DIGEST_PATTERN.test(options.expectedRunnerContractDigest) ||
    !CANARY_PATTERN.test(options.canarySecret)
  ) throw new BugTriageE2EEvidenceVerificationError('configuration_invalid');
  const manifest = parsed.data;
  const analysis = analysisParsed.data;
  if (
    manifest.components.analysisAction.evidenceId !== analysis.evidenceId ||
    manifest.components.analysisAction.manifestDigest !== await canonicalSha256(analysis)
  ) throw new BugTriageE2EEvidenceVerificationError('component_digest_mismatch');
  const origin = safeOrigin(options.controlPlaneOrigin);
  const fetcher = options.fetch ?? fetch;
  const scanner = new SecretScanner({ secrets: [
    options.controlPlaneToken, options.operationsToken, options.githubAppJwt,
    options.githubInstallationToken, options.canarySecret,
  ] });
  try {
    await verifyAnalysisActionEvidence(analysis, {
      controlPlaneOrigin: origin,
      controlPlaneToken: options.controlPlaneToken,
      operationsToken: options.operationsToken,
      githubAppJwt: options.githubAppJwt,
      githubInstallationToken: options.githubInstallationToken,
      expectedRunnerContractDigest: options.expectedRunnerContractDigest,
      ...(options.githubApiOrigin === undefined ? {} : { githubApiOrigin: options.githubApiOrigin }),
      fetch: fetcher,
    });
  } catch {
    throw new BugTriageE2EEvidenceVerificationError('analysis_evidence_mismatch');
  }
  const dispatch = analysis.dispatchEvidence.dispatch;
  if (
    analysis.task.inputClass !== 'user_feedback' || analysis.task.intentKind !== 'bug' ||
    !analysis.context.categories.includes('logs') ||
    !analysis.context.categories.includes('traces') ||
    manifest.lineage.repository !== analysis.dispatchEvidence.repository.fullName ||
    manifest.lineage.taskId !== analysis.task.taskId ||
    manifest.lineage.taskRevision !== dispatch.taskRevision ||
    manifest.lineage.taskDigest !== dispatch.taskDigest ||
    manifest.lineage.runId !== dispatch.runId || manifest.lineage.runVersion !== dispatch.runVersion ||
    manifest.lineage.planId !== dispatch.planId ||
    manifest.lineage.planVersion !== dispatch.planVersion ||
    manifest.lineage.planDigest !== dispatch.planDigest ||
    manifest.lineage.baseSha !== dispatch.baseSha ||
    manifest.lineage.analysisAttemptId !== dispatch.attemptId ||
    manifest.lineage.analysisActionRunId !== dispatch.actionRunId ||
    Date.parse(manifest.diagnosis.observedAt) > Date.parse(dispatch.actionUpdatedAt) ||
    Date.parse(manifest.review.reviewedAt) < Date.parse(analysis.recordedAt) ||
    manifest.safety.canaryDigest !== await canonicalSha256(options.canarySecret)
  ) throw new BugTriageE2EEvidenceVerificationError('lineage_mismatch');

  const [diagnosticRaw, auditRaw] = await Promise.all([
    getControlPlaneJson(
      fetcher, origin, `/v1/runs/${manifest.lineage.runId}/diagnostic-evidence`,
      options.operationsToken, scanner,
    ),
    getControlPlaneJson(
      fetcher, origin, `/v1/runs/${manifest.lineage.runId}/audit`,
      options.operationsToken, scanner,
    ),
  ]);
  const counts = verifyDiagnosticProjection(diagnosticRaw, manifest);
  verifyNoProductionWrite(auditRaw, manifest);
  return {
    schemaVersion: '1', scenario: 'E2E-2', evidenceId: manifest.evidenceId,
    repository: manifest.lineage.repository, taskId: manifest.lineage.taskId,
    runId: manifest.lineage.runId, planId: manifest.lineage.planId,
    actionRunId: manifest.lineage.analysisActionRunId,
    diagnosticEvidence: 1, ...counts, planDiagnosticRefs: 1,
    repositoryWrites: 0, deployments: 0, plaintextLeaks: 0,
    humanReview: 'required_and_recorded',
  };
}
