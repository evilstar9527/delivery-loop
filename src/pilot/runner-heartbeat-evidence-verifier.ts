import { canonicalSha256 } from '../domain/digest.js';
import {
  RunnerHeartbeatEvidenceManifestV1Schema,
  type RunnerHeartbeatEvidenceManifestV1,
} from '../domain/runner-heartbeat-evidence.js';
import {
  AnalysisActionEvidenceVerificationError,
  verifyAnalysisActionEvidence,
  type AnalysisActionEvidenceVerifierOptions,
} from './analysis-action-evidence-verifier.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,20000}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;
const MIN_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_HEARTBEAT_INTERVAL_MS = 60_000;
const HEARTBEAT_LEASE_MS = 90_000;

export type RunnerHeartbeatEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'analysis_evidence_mismatch'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'heartbeat_projection_mismatch'
  | 'result_projection_mismatch'
  | 'github_projection_mismatch'
  | 'webhook_observation_mismatch';

export class RunnerHeartbeatEvidenceVerificationError extends Error {
  constructor(readonly code: RunnerHeartbeatEvidenceVerificationErrorCode) {
    super(`Runner heartbeat evidence verification failed: ${code}`);
    this.name = 'RunnerHeartbeatEvidenceVerificationError';
  }
}

export type RunnerHeartbeatEvidenceVerifierOptions = AnalysisActionEvidenceVerifierOptions;

export interface RunnerHeartbeatEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  runId: string;
  actionRunId: string;
  attemptId: string;
  receiptCount: number;
  firstVersion: number;
  lastVersion: number;
  minimumIntervalMs: number;
  maximumIntervalMs: number;
  resultEventId: string;
  planDigest: string;
  githubStatus: 'completed';
  githubConclusion: 'success';
  webhookDeliveryId: string;
  externalUpdatedAt: string;
  cadenceVerified: true;
  resultVerified: true;
  externalStateVerified: true;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function recordArray(value: unknown): RecordValue[] | null {
  if (!Array.isArray(value)) return null;
  const values = value.map(record);
  return values.every((entry): entry is RecordValue => entry !== null) ? values : null;
}

function exactKeys(value: RecordValue, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new RunnerHeartbeatEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new RunnerHeartbeatEvidenceVerificationError('configuration_invalid');
  return url.origin;
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
  return bytes;
}

async function getJson(fetcher: typeof fetch, url: string, token: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
    });
  } catch {
    throw new RunnerHeartbeatEvidenceVerificationError('control_plane_unavailable');
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new RunnerHeartbeatEvidenceVerificationError('control_plane_unavailable');
  }
  if (/\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
    await response.body?.cancel();
    throw new RunnerHeartbeatEvidenceVerificationError('control_plane_response_invalid');
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new RunnerHeartbeatEvidenceVerificationError('control_plane_response_invalid');
  }
  const bytes = await readBounded(response);
  if (bytes === null) {
    throw new RunnerHeartbeatEvidenceVerificationError('control_plane_response_invalid');
  }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new RunnerHeartbeatEvidenceVerificationError('control_plane_response_invalid'); }
}

async function verifyHeartbeatProjection(
  planRaw: unknown,
  manifest: RunnerHeartbeatEvidenceManifestV1,
): Promise<void> {
  const root = record(planRaw);
  const run = root === null ? null : record(root.run);
  const plan = root === null ? null : record(root.plan);
  const attempts = root === null ? null : recordArray(root.attempts);
  const allReceipts = root === null ? null : recordArray(root.heartbeats);
  const dispatch = manifest.analysisActionEvidence.dispatchEvidence.dispatch;
  if (
    root === null || run === null || plan === null || attempts === null || allReceipts === null ||
    run.id !== dispatch.runId || run.state !== dispatch.runState ||
    run.version !== dispatch.runVersion || plan.id !== dispatch.planId ||
    plan.version !== dispatch.planVersion || plan.digest !== dispatch.planDigest ||
    plan.status !== 'active' || plan.createdByAttemptId !== dispatch.attemptId
  ) throw new RunnerHeartbeatEvidenceVerificationError('heartbeat_projection_mismatch');

  const matchingAttempts = attempts.filter((attempt) => attempt.id === dispatch.attemptId);
  if (matchingAttempts.length !== 1) {
    throw new RunnerHeartbeatEvidenceVerificationError('heartbeat_projection_mismatch');
  }
  const attempt = matchingAttempts[0]!;
  if (!exactKeys(attempt, [
    'id', 'ordinal', 'mode', 'status', 'baseSha', 'version', 'leaseGeneration',
    'leaseExpiresAt', 'heartbeatAt', 'result', 'githubRunId', 'githubStatus',
    'githubConclusion', 'githubObservedAt', 'githubExternalUpdatedAt',
    'githubObservationVersion', 'createdAt', 'updatedAt',
  ])) throw new RunnerHeartbeatEvidenceVerificationError('heartbeat_projection_mismatch');

  const result = record(attempt.result);
  if (result === null || !exactKeys(result, [
    'eventId', 'sequence', 'payloadRef', 'digest', 'reportedAt',
  ])) throw new RunnerHeartbeatEvidenceVerificationError('result_projection_mismatch');

  const receipts = allReceipts.filter((receipt) => receipt.attemptId === dispatch.attemptId);
  if (receipts.length !== manifest.heartbeat.receiptCount) {
    throw new RunnerHeartbeatEvidenceVerificationError('heartbeat_projection_mismatch');
  }
  const receiptIds = new Set<string>();
  const intervals: number[] = [];
  for (const [index, receipt] of receipts.entries()) {
    if (!exactKeys(receipt, [
      'id', 'attemptId', 'leaseGeneration', 'previousVersion', 'version',
      'previousHeartbeatAt', 'heartbeatAt', 'leaseExpiresAt',
    ])) throw new RunnerHeartbeatEvidenceVerificationError('heartbeat_projection_mismatch');
    const previousHeartbeatAt = timestamp(receipt.previousHeartbeatAt);
    const heartbeatAt = timestamp(receipt.heartbeatAt);
    const leaseExpiresAt = timestamp(receipt.leaseExpiresAt);
    const expectedVersion = manifest.heartbeat.firstVersion + index;
    if (
      typeof receipt.id !== 'string' || !ID_PATTERN.test(receipt.id) ||
      receiptIds.has(receipt.id) || receipt.attemptId !== dispatch.attemptId ||
      receipt.leaseGeneration !== manifest.heartbeat.leaseGeneration ||
      receipt.version !== expectedVersion || receipt.previousVersion !== expectedVersion - 1 ||
      previousHeartbeatAt === null || heartbeatAt === null || leaseExpiresAt === null ||
      heartbeatAt <= previousHeartbeatAt || leaseExpiresAt - heartbeatAt !== HEARTBEAT_LEASE_MS ||
      (index > 0 && receipt.previousHeartbeatAt !== receipts[index - 1]!.heartbeatAt)
    ) throw new RunnerHeartbeatEvidenceVerificationError('heartbeat_projection_mismatch');
    const interval = heartbeatAt - previousHeartbeatAt;
    if (interval < MIN_HEARTBEAT_INTERVAL_MS || interval > MAX_HEARTBEAT_INTERVAL_MS) {
      throw new RunnerHeartbeatEvidenceVerificationError('heartbeat_projection_mismatch');
    }
    receiptIds.add(receipt.id);
    intervals.push(interval);
  }

  const first = receipts[0]!;
  const last = receipts.at(-1)!;
  const minimumIntervalMs = Math.min(...intervals);
  const maximumIntervalMs = Math.max(...intervals);
  if (
    first.version !== manifest.heartbeat.firstVersion ||
    last.version !== manifest.heartbeat.lastVersion ||
    first.heartbeatAt !== manifest.heartbeat.firstHeartbeatAt ||
    last.heartbeatAt !== manifest.heartbeat.lastHeartbeatAt ||
    minimumIntervalMs !== manifest.heartbeat.minimumIntervalMs ||
    maximumIntervalMs !== manifest.heartbeat.maximumIntervalMs ||
    await canonicalSha256(receipts) !== manifest.heartbeat.receiptsDigest ||
    attempt.mode !== 'analysis' || attempt.status !== 'completed' ||
    attempt.baseSha !== dispatch.baseSha ||
    attempt.version !== manifest.heartbeat.lastVersion + 1 ||
    attempt.leaseGeneration !== manifest.heartbeat.leaseGeneration ||
    attempt.heartbeatAt !== manifest.heartbeat.lastHeartbeatAt ||
    attempt.leaseExpiresAt !== last.leaseExpiresAt
  ) throw new RunnerHeartbeatEvidenceVerificationError('heartbeat_projection_mismatch');

  if (
    result.eventId !== manifest.result.eventId || result.sequence !== manifest.result.sequence ||
    result.payloadRef !== `d1://execution-plans/${dispatch.planId}` ||
    result.digest !== manifest.result.digest || result.digest !== dispatch.planDigest ||
    result.reportedAt !== manifest.result.reportedAt ||
    timestamp(result.reportedAt) === null ||
    timestamp(result.reportedAt)! < timestamp(last.heartbeatAt)!
  ) throw new RunnerHeartbeatEvidenceVerificationError('result_projection_mismatch');

  const githubObservedAt = timestamp(attempt.githubObservedAt);
  const recordedAt = timestamp(manifest.recordedAt)!;
  if (
    attempt.githubRunId !== dispatch.actionRunId || attempt.githubStatus !== 'completed' ||
    attempt.githubConclusion !== 'success' ||
    attempt.githubExternalUpdatedAt !== dispatch.actionUpdatedAt ||
    !Number.isSafeInteger(attempt.githubObservationVersion) ||
    Number(attempt.githubObservationVersion) <= 0 || githubObservedAt === null ||
    githubObservedAt < timestamp(dispatch.actionUpdatedAt)! || githubObservedAt > recordedAt
  ) throw new RunnerHeartbeatEvidenceVerificationError('github_projection_mismatch');
}

function verifyWebhookObservation(
  auditRaw: unknown,
  manifest: RunnerHeartbeatEvidenceManifestV1,
): void {
  const root = record(auditRaw);
  const answers = root === null ? null : record(root.answers);
  const checks = answers === null ? null : record(answers.checks);
  const observations = checks === null ? null : recordArray(checks.githubRunObservations);
  const dispatch = manifest.analysisActionEvidence.dispatchEvidence.dispatch;
  if (
    root === null || answers === null || checks === null || observations === null ||
    root.schemaVersion !== '1' || root.runId !== dispatch.runId
  ) throw new RunnerHeartbeatEvidenceVerificationError('webhook_observation_mismatch');
  const matches = observations.filter((observation) =>
    observation.sourceKind === 'webhook' &&
    observation.sourceId === manifest.webhookObservation.sourceId);
  if (matches.length !== 1) {
    throw new RunnerHeartbeatEvidenceVerificationError('webhook_observation_mismatch');
  }
  const observation = matches[0]!;
  if (!exactKeys(observation, [
    'sourceKind', 'sourceId', 'sourceDigest', 'repository', 'githubRunId', 'attemptId',
    'processingState', 'ignoreReason', 'externalUpdatedAt', 'observedAt', 'processedAt',
  ])) throw new RunnerHeartbeatEvidenceVerificationError('webhook_observation_mismatch');
  const externalUpdatedAt = timestamp(observation.externalUpdatedAt);
  const observedAt = timestamp(observation.observedAt);
  const processedAt = timestamp(observation.processedAt);
  if (
    observation.sourceDigest !== manifest.webhookObservation.sourceDigest ||
    typeof observation.sourceDigest !== 'string' ||
    !DIGEST_PATTERN.test(observation.sourceDigest) ||
    observation.repository !== manifest.analysisActionEvidence.dispatchEvidence.repository.fullName ||
    observation.githubRunId !== dispatch.actionRunId ||
    observation.attemptId !== dispatch.attemptId ||
    observation.processingState !== 'applied' || observation.ignoreReason !== null ||
    observation.externalUpdatedAt !== manifest.webhookObservation.externalUpdatedAt ||
    observation.observedAt !== manifest.webhookObservation.observedAt ||
    observation.processedAt !== manifest.webhookObservation.processedAt ||
    externalUpdatedAt === null || observedAt === null || processedAt === null ||
    externalUpdatedAt > observedAt || observedAt > processedAt ||
    processedAt > timestamp(manifest.recordedAt)!
  ) throw new RunnerHeartbeatEvidenceVerificationError('webhook_observation_mismatch');
}

export async function verifyRunnerHeartbeatEvidence(
  input: RunnerHeartbeatEvidenceManifestV1,
  options: RunnerHeartbeatEvidenceVerifierOptions,
): Promise<RunnerHeartbeatEvidenceVerificationSummary> {
  const parsed = RunnerHeartbeatEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new RunnerHeartbeatEvidenceVerificationError('manifest_invalid');
  if (
    !TOKEN_PATTERN.test(options.controlPlaneToken) ||
    !TOKEN_PATTERN.test(options.operationsToken) ||
    !TOKEN_PATTERN.test(options.githubAppJwt) ||
    !TOKEN_PATTERN.test(options.githubInstallationToken) ||
    !DIGEST_PATTERN.test(options.expectedRunnerContractDigest)
  ) throw new RunnerHeartbeatEvidenceVerificationError('configuration_invalid');
  const manifest = parsed.data;
  const controlOrigin = safeOrigin(options.controlPlaneOrigin);
  const githubOrigin = safeOrigin(options.githubApiOrigin ?? 'https://api.github.com');
  const fetcher = options.fetch ?? fetch;

  try {
    await verifyAnalysisActionEvidence(manifest.analysisActionEvidence, {
      controlPlaneOrigin: controlOrigin,
      controlPlaneToken: options.controlPlaneToken,
      operationsToken: options.operationsToken,
      githubAppJwt: options.githubAppJwt,
      githubInstallationToken: options.githubInstallationToken,
      githubApiOrigin: githubOrigin,
      expectedRunnerContractDigest: options.expectedRunnerContractDigest,
      fetch: fetcher,
    });
  } catch (error) {
    if (error instanceof AnalysisActionEvidenceVerificationError) {
      throw new RunnerHeartbeatEvidenceVerificationError('analysis_evidence_mismatch');
    }
    throw error;
  }

  const dispatch = manifest.analysisActionEvidence.dispatchEvidence.dispatch;
  const [planRaw, auditRaw] = await Promise.all([
    getJson(
      fetcher,
      `${controlOrigin}/v1/runs/${encodeURIComponent(dispatch.runId)}/plan`,
      options.controlPlaneToken,
    ),
    getJson(
      fetcher,
      `${controlOrigin}/v1/runs/${encodeURIComponent(dispatch.runId)}/audit`,
      options.operationsToken,
    ),
  ]);
  await verifyHeartbeatProjection(planRaw, manifest);
  verifyWebhookObservation(auditRaw, manifest);

  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    repository: manifest.analysisActionEvidence.dispatchEvidence.repository.fullName,
    runId: dispatch.runId,
    actionRunId: dispatch.actionRunId,
    attemptId: dispatch.attemptId,
    receiptCount: manifest.heartbeat.receiptCount,
    firstVersion: manifest.heartbeat.firstVersion,
    lastVersion: manifest.heartbeat.lastVersion,
    minimumIntervalMs: manifest.heartbeat.minimumIntervalMs,
    maximumIntervalMs: manifest.heartbeat.maximumIntervalMs,
    resultEventId: manifest.result.eventId,
    planDigest: manifest.result.digest,
    githubStatus: 'completed',
    githubConclusion: 'success',
    webhookDeliveryId: manifest.webhookObservation.sourceId,
    externalUpdatedAt: manifest.webhookObservation.externalUpdatedAt,
    cadenceVerified: true,
    resultVerified: true,
    externalStateVerified: true,
  };
}
