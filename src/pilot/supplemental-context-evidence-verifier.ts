import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';
import {
  SupplementalContextEvidenceManifestV1Schema,
  SupplementalContextObservabilityReportV1Schema,
  type SupplementalContextEvidenceManifestV1,
  type SupplementalContextObservabilityReportV1,
} from '../domain/supplemental-context-evidence.js';
import { SecretScanner } from '../security/redaction.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const CANARY_PATTERN = /^[^\0\r\n]{8,20000}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,196}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;

const IdSchema = z.string().regex(ID_PATTERN);
const DigestSchema = z.string().regex(DIGEST_PATTERN);
const TimestampSchema = z.iso.datetime({ offset: true });
const RunStateSchema = z.enum([
  'queued', 'planning', 'awaiting_approval', 'executing', 'verifying',
  'pull_request_open', 'awaiting_review', 'ready_to_merge', 'deploying',
  'succeeded', 'failed', 'cancelled', 'blocked',
]);
const DeliveryStateSchema = z.enum(['pending', 'delivering', 'settled']);
const AttemptStatusSchema = z.enum([
  'pending', 'starting', 'running', 'cancel_requested',
  'completed', 'failed', 'cancelled', 'lost',
]);

const RunSnapshotSchema = z.object({
  runId: IdSchema,
  state: RunStateSchema,
  version: z.number().int().nonnegative(),
  baseSha: z.string().regex(SHA_PATTERN).nullable(),
  activePlanId: IdSchema.nullable(),
  activePlanVersion: z.number().int().positive().nullable(),
  activePlanDigest: DigestSchema.nullable(),
  updatedAt: TimestampSchema,
}).strict();

const AttemptSchema = z.object({
  attemptId: IdSchema,
  mode: z.enum(['analysis', 'implement', 'review_fix', 'deploy']),
  status: AttemptStatusSchema,
  planId: IdSchema.nullable(),
  planVersion: z.number().int().positive().nullable(),
  version: z.number().int().nonnegative(),
  leaseGeneration: z.number().int().nonnegative(),
  updatedAt: TimestampSchema,
  tokenCount: z.number().int().nonnegative(),
  revokedTokenCount: z.number().int().nonnegative(),
}).strict();

const FeishuActionSchema = z.object({
  actionReceiptId: IdSchema,
  deliveryId: IdSchema,
  tenantKey: z.string().min(1).max(500),
  eventId: IdSchema,
  eventDigest: DigestSchema,
  operatorDigest: DigestSchema,
  messageId: z.string().regex(MESSAGE_ID_PATTERN),
  cardId: IdSchema,
  presentationId: IdSchema,
  sourceRunId: IdSchema,
  sourceRunVersion: z.number().int().nonnegative(),
  planId: IdSchema,
  planVersion: z.number().int().positive(),
  planDigest: DigestSchema,
  baseSha: z.string().regex(SHA_PATTERN),
  contextMode: z.enum(['new_run', 'apply_current']),
  outcomeId: IdSchema,
  resultId: IdSchema,
  receivedAt: TimestampSchema,
  completedAt: TimestampSchema,
  currentSourceRun: RunSnapshotSchema,
  priorPlanAttempts: z.array(AttemptSchema).max(100),
  priorApprovalCount: z.number().int().nonnegative(),
  approvalInvalidationCount: z.number().int().nonnegative(),
  planRevisionCount: z.number().int().nonnegative(),
}).strict();

const MeegleMappingSchema = z.object({
  ingressOutboxId: IdSchema,
  eventId: IdSchema,
  tenantKey: z.string().min(1).max(500),
  projectKey: z.string().min(1).max(500),
  workItemTypeKey: z.string().min(1).max(500),
  workItemId: z.string().min(1).max(500),
  externalRevision: z.string().min(1).max(500).nullable(),
  exactSnapshotDigest: DigestSchema,
  mappingSnapshotDigest: DigestSchema,
  mappingProfileVersion: z.number().int().positive(),
  mappingProfileDigest: DigestSchema,
  taskId: IdSchema,
  runId: IdSchema,
  createdAt: TimestampSchema,
}).strict();

const ProjectionSchema = z.object({
  schemaVersion: z.literal('1'),
  contextId: IdSchema,
  lineage: z.object({
    eventDigest: DigestSchema,
    priorTaskId: IdSchema,
    priorTaskRevisionDigest: DigestSchema,
    newTaskId: IdSchema,
    newTaskRevisionDigest: DigestSchema,
    newTaskDigest: DigestSchema,
    newRunId: IdSchema,
    contextDigest: DigestSchema,
    mode: z.enum(['new_run', 'apply_current']),
    createdAt: TimestampSchema,
  }).strict(),
  source: z.object({
    system: z.enum(['feishu', 'meego', 'github', 'monitor', 'manual']),
    tenantKey: z.string().min(1).max(500),
    taskKey: z.string().min(1).max(500),
    revision: z.string().min(1).max(500),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    baseBranch: z.string().min(1).max(240),
    environment: z.enum(['none', 'test', 'production']),
    intentKind: z.enum(['requirement', 'bug']),
  }).strict(),
  objects: z.object({
    contextVerified: z.boolean(),
    newTaskVerified: z.boolean(),
  }).strict(),
  newRun: z.object({
    runId: IdSchema,
    state: RunStateSchema,
    version: z.number().int().nonnegative(),
    workflowInstanceId: IdSchema,
    updatedAt: TimestampSchema,
  }).strict(),
  workflowCreate: z.object({
    outboxId: IdSchema,
    deliveryState: DeliveryStateSchema,
    lastErrorCode: z.string().min(1).max(200).nullable(),
    attemptCount: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  }).strict(),
  feishuActions: z.array(FeishuActionSchema).max(20),
  meegleMappings: z.array(MeegleMappingSchema).max(20),
  currentRunSnapshot: RunSnapshotSchema.nullable(),
  planRevision: z.object({
    revisionId: IdSchema,
    expectedRunVersion: z.number().int().nonnegative(),
    priorPlanId: IdSchema,
    priorPlanVersion: z.number().int().positive(),
    priorPlanDigest: DigestSchema,
    sourceDigest: DigestSchema,
    requestedBaseSha: z.string().regex(SHA_PATTERN),
    analysisAttemptId: IdSchema,
    status: z.enum(['analyzing', 'activated', 'rejected']),
    createdAt: TimestampSchema,
    analysisAttemptStatus: AttemptStatusSchema,
    analysisAttemptVersion: z.number().int().nonnegative(),
    analysisAttemptLeaseGeneration: z.number().int().nonnegative(),
    analysisOutboxId: IdSchema,
    analysisOutboxDeliveryState: DeliveryStateSchema,
    analysisOutboxAttemptCount: z.number().int().nonnegative(),
    priorApprovalCount: z.number().int().nonnegative(),
    approvalInvalidationCount: z.number().int().nonnegative(),
  }).strict().nullable(),
  attempts: z.array(AttemptSchema).max(100),
  counts: z.object({
    contextRevisions: z.literal(1),
    newTasks: z.literal(1),
    newRuns: z.literal(1),
    workflowCreates: z.literal(1),
    planRevisions: z.number().int().nonnegative(),
    feishuActions: z.number().int().nonnegative(),
    meegleMappings: z.number().int().nonnegative(),
  }).strict(),
}).strict();

type Projection = z.infer<typeof ProjectionSchema>;

export type SupplementalContextEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'observability_unavailable'
  | 'observability_response_invalid'
  | 'observability_mismatch'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'object_integrity_mismatch'
  | 'new_run_mismatch'
  | 'apply_current_mismatch'
  | 'meegle_convergence_mismatch'
  | 'feishu_api_unavailable'
  | 'feishu_response_invalid'
  | 'card_binding_mismatch'
  | 'card_actions_mismatch'
  | 'secret_leak_detected';

export class SupplementalContextEvidenceVerificationError extends Error {
  constructor(readonly code: SupplementalContextEvidenceVerificationErrorCode) {
    super(`Supplemental context evidence verification failed: ${code}`);
    this.name = 'SupplementalContextEvidenceVerificationError';
  }
}

export interface SupplementalContextEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  operationsToken: string;
  observabilityReportUrl: string;
  observabilityToken: string;
  feishuApiOrigin: string;
  feishuAccessToken: string;
  canary: string;
  fetcher?: typeof fetch;
}

export interface SupplementalContextEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  contextCount: 3;
  feishuModes: 2;
  meegleEvents: 2;
  objectIntegrity: 'verified';
  currentRunIsolation: 'verified';
  applyCurrentFencing: 'verified';
  liveCardActions: 'verified';
  plaintextLeaks: 0;
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new SupplementalContextEvidenceVerificationError('configuration_invalid'); }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new SupplementalContextEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

function safeHttpsUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new SupplementalContextEvidenceVerificationError('configuration_invalid'); }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== ''
  ) throw new SupplementalContextEvidenceVerificationError('configuration_invalid');
  return url.toString();
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

async function getJson(
  fetcher: typeof fetch,
  url: string,
  token: string,
  source: 'observability' | 'control_plane' | 'feishu',
  scanner: SecretScanner,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    const code = source === 'observability'
      ? 'observability_unavailable'
      : source === 'control_plane' ? 'control_plane_unavailable' : 'feishu_api_unavailable';
    throw new SupplementalContextEvidenceVerificationError(code);
  }
  if (!response.ok) {
    await response.body?.cancel();
    const code = source === 'observability'
      ? 'observability_unavailable'
      : source === 'control_plane' ? 'control_plane_unavailable' : 'feishu_api_unavailable';
    throw new SupplementalContextEvidenceVerificationError(code);
  }
  const invalidCode = source === 'observability'
    ? 'observability_response_invalid'
    : source === 'control_plane' ? 'control_plane_response_invalid' : 'feishu_response_invalid';
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new SupplementalContextEvidenceVerificationError(invalidCode);
  }
  let text: string | null;
  try { text = await boundedText(response); }
  catch { throw new SupplementalContextEvidenceVerificationError(invalidCode); }
  if (text === null) throw new SupplementalContextEvidenceVerificationError(invalidCode);
  if (scanner.scanText(text, `$.${source}`).length > 0) {
    throw new SupplementalContextEvidenceVerificationError('secret_leak_detected');
  }
  try { return JSON.parse(text) as unknown; }
  catch { throw new SupplementalContextEvidenceVerificationError(invalidCode); }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function messageTime(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^[1-9][0-9]{9,15}$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function validateShared(
  actual: Projection,
  expected: {
    mode: 'new_run' | 'apply_current'; contextId: string; priorTaskId: string;
    newTaskId: string; newRunId: string; contextDigest: string; newTaskDigest: string;
  },
): void {
  if (
    actual.contextId !== expected.contextId || actual.lineage.mode !== expected.mode ||
    actual.lineage.priorTaskId !== expected.priorTaskId ||
    actual.lineage.newTaskId !== expected.newTaskId ||
    actual.lineage.newRunId !== expected.newRunId ||
    actual.lineage.contextDigest !== expected.contextDigest ||
    actual.lineage.newTaskDigest !== expected.newTaskDigest ||
    actual.newRun.runId !== expected.newRunId || actual.newRun.workflowInstanceId !== expected.newRunId ||
    !actual.objects.contextVerified || !actual.objects.newTaskVerified ||
    actual.counts.contextRevisions !== 1 || actual.counts.newTasks !== 1 ||
    actual.counts.newRuns !== 1 || actual.counts.workflowCreates !== 1 ||
    actual.counts.feishuActions !== actual.feishuActions.length ||
    actual.counts.meegleMappings !== actual.meegleMappings.length
  ) throw new SupplementalContextEvidenceVerificationError('object_integrity_mismatch');
}

function validateFeishu(
  actual: Projection,
  expected: SupplementalContextEvidenceManifestV1['feishuCases'][number],
): void {
  validateShared(actual, expected);
  const action = actual.feishuActions.length === 1 ? actual.feishuActions[0] : undefined;
  const priorAttempt = action?.priorPlanAttempts.find(
    (attempt) => attempt.attemptId === expected.priorAttemptId,
  );
  if (
    actual.source.system !== 'feishu' || actual.source.tenantKey !== expected.tenantKey ||
    actual.meegleMappings.length !== 0 || action === undefined || priorAttempt === undefined ||
    action.actionReceiptId !== expected.actionReceiptId || action.deliveryId !== expected.deliveryId ||
    action.eventId !== expected.eventId || action.operatorDigest !== expected.operatorDigest ||
    action.outcomeId !== expected.outcomeId || action.resultId !== expected.newTaskId ||
    action.sourceRunId !== expected.sourceRunId ||
    action.sourceRunVersion !== expected.expectedRunVersion ||
    action.contextMode !== expected.mode || priorAttempt.version < expected.priorAttemptVersion ||
    priorAttempt.leaseGeneration < expected.priorAttemptLeaseGeneration ||
    action.messageId.length < 1
  ) throw new SupplementalContextEvidenceVerificationError(
    expected.mode === 'new_run' ? 'new_run_mismatch' : 'apply_current_mismatch',
  );

  if (expected.mode === 'new_run') {
    if (
      expected.planRevisionId !== null || expected.analysisAttemptId !== null ||
      actual.newRun.state !== 'queued' || actual.newRun.version !== 0 ||
      actual.workflowCreate.deliveryState !== 'pending' ||
      actual.workflowCreate.lastErrorCode !== null || actual.currentRunSnapshot !== null ||
      actual.planRevision !== null || actual.attempts.length !== 0 || actual.counts.planRevisions !== 0 ||
      action.currentSourceRun.runId !== expected.sourceRunId ||
      action.currentSourceRun.version !== expected.expectedRunVersion ||
      priorAttempt.status !== 'running' || priorAttempt.version !== expected.priorAttemptVersion ||
      priorAttempt.leaseGeneration !== expected.priorAttemptLeaseGeneration ||
      priorAttempt.tokenCount < 1 || priorAttempt.revokedTokenCount !== 0 ||
      action.approvalInvalidationCount !== 0 || action.planRevisionCount !== 0 ||
      Date.parse(priorAttempt.updatedAt) > Date.parse(actual.lineage.createdAt)
    ) throw new SupplementalContextEvidenceVerificationError('new_run_mismatch');
    return;
  }

  const revision = actual.planRevision;
  if (
    revision === null || actual.currentRunSnapshot === null ||
    expected.planRevisionId === null || expected.analysisAttemptId === null ||
    actual.newRun.state !== 'cancelled' || actual.newRun.version !== 1 ||
    actual.workflowCreate.deliveryState !== 'settled' ||
    actual.workflowCreate.lastErrorCode !== 'supplemental_context_absorbed' ||
    actual.currentRunSnapshot.runId !== expected.sourceRunId ||
    actual.currentRunSnapshot.state !== 'planning' ||
    actual.currentRunSnapshot.version !== expected.expectedRunVersion + 1 ||
    revision.revisionId !== expected.planRevisionId ||
    revision.expectedRunVersion !== expected.expectedRunVersion ||
    revision.analysisAttemptId !== expected.analysisAttemptId || revision.status !== 'analyzing' ||
    revision.analysisAttemptStatus !== 'pending' ||
    revision.analysisOutboxDeliveryState !== 'pending' ||
    revision.priorApprovalCount < 1 ||
    revision.approvalInvalidationCount !== revision.priorApprovalCount ||
    actual.counts.planRevisions !== 1 || priorAttempt.status !== 'cancelled' ||
    priorAttempt.version !== expected.priorAttemptVersion + 1 ||
    priorAttempt.leaseGeneration !== expected.priorAttemptLeaseGeneration + 1 ||
    priorAttempt.tokenCount < 1 || priorAttempt.revokedTokenCount !== priorAttempt.tokenCount ||
    priorAttempt.updatedAt !== revision.createdAt
  ) throw new SupplementalContextEvidenceVerificationError('apply_current_mismatch');
}

function validateMeegle(
  actual: Projection,
  expected: SupplementalContextEvidenceManifestV1['meegleConvergence'],
): void {
  validateShared(actual, { ...expected, mode: 'new_run' });
  const rows = [...actual.meegleMappings].sort((left, right) =>
    left.eventId.localeCompare(right.eventId));
  const eventIds = [...expected.eventIds].sort();
  const ingressIds = [...expected.ingressOutboxIds].sort();
  const snapshotDigests = [...expected.exactSnapshotDigests].sort();
  if (
    actual.source.system !== 'meego' || actual.source.tenantKey !== expected.tenantKey ||
    actual.feishuActions.length !== 0 || actual.meegleMappings.length !== 2 ||
    actual.newRun.state !== 'queued' || actual.newRun.version !== 0 ||
    actual.workflowCreate.deliveryState !== 'pending' ||
    actual.workflowCreate.lastErrorCode !== null || actual.currentRunSnapshot !== null ||
    actual.planRevision !== null || actual.counts.planRevisions !== 0 ||
    JSON.stringify(rows.map((row) => row.eventId).sort()) !== JSON.stringify(eventIds) ||
    JSON.stringify(rows.map((row) => row.ingressOutboxId).sort()) !== JSON.stringify(ingressIds) ||
    JSON.stringify(rows.map((row) => row.exactSnapshotDigest).sort()) !== JSON.stringify(snapshotDigests) ||
    rows.some((row) =>
      row.tenantKey !== expected.tenantKey || row.projectKey !== expected.projectKey ||
      row.workItemTypeKey !== expected.workItemTypeKey || row.workItemId !== expected.workItemId ||
      row.externalRevision !== expected.externalRevision ||
      row.mappingSnapshotDigest !== expected.mappingSnapshotDigest ||
      row.mappingProfileDigest !== expected.mappingProfileDigest ||
      row.taskId !== expected.newTaskId || row.runId !== expected.newRunId)
  ) throw new SupplementalContextEvidenceVerificationError('meegle_convergence_mismatch');
}

async function validateReport(
  report: SupplementalContextObservabilityReportV1,
  manifest: SupplementalContextEvidenceManifestV1,
): Promise<void> {
  const { reportDigest, ...body } = report;
  const expectedEvents = new Map([
    ['feishu_new_run', manifest.feishuCases.find((item) => item.mode === 'new_run')?.eventId],
    ['feishu_apply_current', manifest.feishuCases.find((item) => item.mode === 'apply_current')?.eventId],
    ['meegle_primary', manifest.meegleConvergence.eventIds[0]],
    ['meegle_primary_retry', manifest.meegleConvergence.eventIds[0]],
    ['meegle_peer', manifest.meegleConvergence.eventIds[1]],
  ]);
  if (
    report.evidenceId !== manifest.evidenceId ||
    reportDigest !== manifest.observabilityReportDigest ||
    await canonicalSha256(body) !== reportDigest ||
    report.requests.some((item) => expectedEvents.get(item.scenario) !== item.eventId)
  ) throw new SupplementalContextEvidenceVerificationError('observability_mismatch');
}

async function validateLiveCard(
  raw: unknown,
  manifest: SupplementalContextEvidenceManifestV1,
): Promise<void> {
  const response = record(raw);
  const data = response === null ? null : record(response.data);
  const items = data === null || !Array.isArray(data.items) ? null : data.items;
  const item = items?.length === 1 ? record(items[0]) : null;
  const sender = item === null ? null : record(item.sender);
  const body = item === null ? null : record(item.body);
  const createdAt = item === null ? null : messageTime(item.create_time);
  const updatedAt = item === null ? null : messageTime(item.update_time);
  if (
    response?.code !== 0 || item === null || sender === null || body === null ||
    typeof body.content !== 'string' || body.content.length > MAX_RESPONSE_BYTES ||
    createdAt === null || updatedAt === null
  ) throw new SupplementalContextEvidenceVerificationError('feishu_response_invalid');
  if (
    item.message_id !== manifest.card.messageId || item.msg_type !== 'interactive' ||
    item.deleted !== false || item.chat_id !== manifest.application.chatId ||
    sender.sender_type !== 'app' || sender.id !== manifest.application.appId ||
    sender.tenant_key !== manifest.application.tenantKey ||
    createdAt !== manifest.card.createdAt || updatedAt !== manifest.card.updatedAt
  ) throw new SupplementalContextEvidenceVerificationError('card_binding_mismatch');
  let card: unknown;
  try { card = JSON.parse(body.content) as unknown; }
  catch { throw new SupplementalContextEvidenceVerificationError('feishu_response_invalid'); }
  const rendered = JSON.stringify(card);
  if (
    await canonicalSha256(card) !== manifest.card.cardDigest ||
    !rendered.includes('补充上下文·新 Run') || !rendered.includes('补充上下文·当前 Run')
  ) throw new SupplementalContextEvidenceVerificationError('card_actions_mismatch');
}

export async function verifySupplementalContextEvidence(
  rawManifest: unknown,
  options: SupplementalContextEvidenceVerifierOptions,
): Promise<SupplementalContextEvidenceVerificationSummary> {
  const parsed = SupplementalContextEvidenceManifestV1Schema.safeParse(rawManifest);
  if (!parsed.success) throw new SupplementalContextEvidenceVerificationError('manifest_invalid');
  const manifest = parsed.data;
  if (
    !TOKEN_PATTERN.test(options.operationsToken) ||
    !TOKEN_PATTERN.test(options.observabilityToken) ||
    !TOKEN_PATTERN.test(options.feishuAccessToken) || !CANARY_PATTERN.test(options.canary) ||
    manifest.safety.canaryDigest !== await canonicalSha256(options.canary)
  ) throw new SupplementalContextEvidenceVerificationError('configuration_invalid');
  const controlPlaneOrigin = httpsOrigin(options.controlPlaneOrigin);
  const feishuApiOrigin = httpsOrigin(options.feishuApiOrigin);
  const reportUrl = safeHttpsUrl(options.observabilityReportUrl);
  if (
    httpsOrigin(manifest.controlPlaneOrigin) !== controlPlaneOrigin ||
    safeHttpsUrl(manifest.observabilityReportUrl) !== reportUrl
  ) throw new SupplementalContextEvidenceVerificationError('configuration_invalid');
  const fetcher = options.fetcher ?? fetch;
  const scanner = new SecretScanner({
    secrets: [
      options.operationsToken,
      options.observabilityToken,
      options.feishuAccessToken,
      options.canary,
    ],
  });

  const reportRaw = await getJson(
    fetcher, reportUrl, options.observabilityToken, 'observability', scanner,
  );
  const report = SupplementalContextObservabilityReportV1Schema.safeParse(reportRaw);
  if (!report.success) {
    throw new SupplementalContextEvidenceVerificationError('observability_response_invalid');
  }
  await validateReport(report.data, manifest);

  const contexts = [
    ...manifest.feishuCases.map((item) => item.contextId),
    manifest.meegleConvergence.contextId,
  ];
  const projections = new Map<string, Projection>();
  for (const contextId of contexts) {
    const raw = await getJson(
      fetcher,
      `${controlPlaneOrigin}/v1/operations/supplemental-context/evidence` +
        `?contextId=${encodeURIComponent(contextId)}`,
      options.operationsToken,
      'control_plane',
      scanner,
    );
    const projection = ProjectionSchema.safeParse(raw);
    if (!projection.success) {
      throw new SupplementalContextEvidenceVerificationError('control_plane_response_invalid');
    }
    projections.set(contextId, projection.data);
  }
  for (const expected of manifest.feishuCases) {
    const actual = projections.get(expected.contextId);
    if (actual === undefined) {
      throw new SupplementalContextEvidenceVerificationError('control_plane_response_invalid');
    }
    validateFeishu(actual, expected);
  }
  const meegle = projections.get(manifest.meegleConvergence.contextId);
  if (meegle === undefined) {
    throw new SupplementalContextEvidenceVerificationError('control_plane_response_invalid');
  }
  validateMeegle(meegle, manifest.meegleConvergence);

  const messageRaw = await getJson(
    fetcher,
    `${feishuApiOrigin}/open-apis/im/v1/messages/${manifest.card.messageId}` +
      '?card_msg_content_type=user_card_content',
    options.feishuAccessToken,
    'feishu',
    scanner,
  );
  await validateLiveCard(messageRaw, manifest);

  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    contextCount: 3,
    feishuModes: 2,
    meegleEvents: 2,
    objectIntegrity: 'verified',
    currentRunIsolation: 'verified',
    applyCurrentFencing: 'verified',
    liveCardActions: 'verified',
    plaintextLeaks: 0,
  };
}
