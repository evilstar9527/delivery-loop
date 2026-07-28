import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';
import {
  FeishuIngressEvidenceManifestV1Schema,
  FeishuIngressObservabilityReportV1Schema,
  type FeishuIngressEvidenceManifestV1,
  type FeishuIngressObservabilityReportV1,
} from '../domain/feishu-ingress-evidence.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const TimestampSchema = z.iso.datetime({ offset: true });
const MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;

const CountsSchema = z.object({
  deliveries: z.number().int().nonnegative().max(100),
  transportReceipts: z.number().int().nonnegative().max(100),
  ingressOutboxes: z.number().int().nonnegative().max(100),
  queueMessageIdentities: z.number().int().nonnegative().max(100),
  queueObservations: z.number().int().nonnegative().max(100),
  tasks: z.number().int().nonnegative().max(100),
  runs: z.number().int().nonnegative().max(100),
  workflowCreateOutboxes: z.number().int().nonnegative().max(100),
}).strict();

const ProjectionSchema = z.object({
  schemaVersion: z.literal('1'),
  tenantKey: z.string().min(1).max(200),
  eventId: z.string().regex(ID_PATTERN),
  counts: CountsSchema,
  delivery: z.object({
    deliveryId: z.string().regex(ID_PATTERN),
    eventType: z.string().min(1).max(200),
    eventDigest: z.string().regex(DIGEST_PATTERN),
    verificationMode: z.enum(['encrypted', 'plaintext']),
    receivedAt: TimestampSchema,
  }).strict().nullable(),
  transportReceipts: z.array(z.object({
    requestTimestamp: TimestampSchema,
    requestDigest: z.string().regex(DIGEST_PATTERN),
    receivedAt: TimestampSchema,
  }).strict()).max(100),
  ingress: z.object({
    outboxId: z.string().regex(ID_PATTERN),
    deliveryId: z.string().regex(ID_PATTERN),
    eventType: z.string().min(1).max(200),
    eventDigest: z.string().regex(DIGEST_PATTERN),
    deliveryState: z.enum([
      'pending', 'delivering', 'enqueued', 'queued', 'settled', 'dead_lettered',
    ]),
    relayAttemptCount: z.number().int().nonnegative().max(100),
    enqueuedAt: TimestampSchema.nullable(),
    queueObservedAt: TimestampSchema.nullable(),
    taskId: z.string().regex(ID_PATTERN).nullable(),
    runId: z.string().regex(ID_PATTERN).nullable(),
    taskDigest: z.string().regex(DIGEST_PATTERN).nullable(),
    settledAt: TimestampSchema.nullable(),
  }).strict().nullable(),
  queueObservations: z.array(z.object({
    queueName: z.literal('delivery-loop-feishu-ingress'),
    queueMessageIdDigest: z.string().regex(DIGEST_PATTERN),
    deliveryAttempt: z.number().int().positive().max(100),
    messageTimestamp: TimestampSchema,
    observedAt: TimestampSchema,
  }).strict()).max(100),
  task: z.object({
    sourceSystem: z.enum(['feishu', 'meego']),
    tenantKey: z.string().min(1).max(200),
    sourceTaskKey: z.string().min(1).max(255),
    taskRevision: z.string().min(1).max(255),
    taskDigest: z.string().regex(DIGEST_PATTERN),
    taskId: z.string().regex(ID_PATTERN),
    runId: z.string().regex(ID_PATTERN),
    workflowInstanceId: z.string().regex(ID_PATTERN),
    runState: z.enum([
      'received', 'triaging', 'awaiting_approval', 'queued', 'planning', 'executing',
      'verifying', 'pull_request_open', 'awaiting_review', 'ready_to_merge', 'merging',
      'deploying', 'succeeded', 'blocked', 'failed', 'cancelled',
    ]),
    workflowCreateOutboxId: z.string().regex(ID_PATTERN),
    workflowCreateState: z.enum(['pending', 'delivering', 'settled']),
  }).strict().nullable(),
}).strict();

const CloudflareInstanceSchema = z.object({
  success: z.literal(true),
  errors: z.array(z.unknown()),
  messages: z.array(z.unknown()),
  result: z.object({
    status: z.string().min(1).max(64),
    versionId: z.string().uuid(),
    start: TimestampSchema,
  }).passthrough(),
}).strict();

type Projection = z.infer<typeof ProjectionSchema>;

export type FeishuIngressEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'observability_report_unavailable'
  | 'observability_response_invalid'
  | 'observability_digest_mismatch'
  | 'transport_replay_mismatch'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'queue_lineage_mismatch'
  | 'task_revision_mismatch'
  | 'workflow_identity_mismatch'
  | 'cloudflare_api_unavailable'
  | 'cloudflare_response_invalid'
  | 'cloudflare_instance_mismatch';

export class FeishuIngressEvidenceVerificationError extends Error {
  constructor(readonly code: FeishuIngressEvidenceVerificationErrorCode) {
    super(`Feishu ingress evidence verification failed: ${code}`);
    this.name = 'FeishuIngressEvidenceVerificationError';
  }
}

export interface FeishuIngressEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  operationsToken: string;
  observabilityReportUrl: string;
  observabilityToken: string;
  cloudflareAccountId: string;
  cloudflareToken: string;
  cloudflareApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface FeishuIngressEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  tenantKey: string;
  replayedEventId: string;
  replayTransportReceiptCount: 3;
  logicalIngressOutboxCount: 2;
  distinctQueueMessageCount: 2;
  queueObservationCount: number;
  sameRevisionEventCount: 2;
  taskId: string;
  runId: string;
  workflowInstanceId: string;
  workflowCreateOutboxCount: 1;
  duplicateTasks: 0;
  duplicateRuns: 0;
}

type Source = 'observability' | 'control_plane' | 'cloudflare';

function safeOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new FeishuIngressEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new FeishuIngressEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

function safeBoundUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new FeishuIngressEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== ''
  ) throw new FeishuIngressEvidenceVerificationError('configuration_invalid');
  return url.toString();
}

function cloudflareBaseUrl(raw: string): string {
  const url = safeBoundUrl(raw);
  return url.replace(/\/$/, '');
}

function unavailable(source: Source): FeishuIngressEvidenceVerificationErrorCode {
  return source === 'observability' ? 'observability_report_unavailable' :
    source === 'control_plane' ? 'control_plane_unavailable' : 'cloudflare_api_unavailable';
}

function invalidResponse(source: Source): FeishuIngressEvidenceVerificationErrorCode {
  return source === 'observability' ? 'observability_response_invalid' :
    source === 'control_plane' ? 'control_plane_response_invalid' : 'cloudflare_response_invalid';
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

async function getJson(
  fetcher: typeof fetch,
  url: string,
  token: string,
  source: Source,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
    });
  } catch { throw new FeishuIngressEvidenceVerificationError(unavailable(source)); }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new FeishuIngressEvidenceVerificationError(unavailable(source));
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new FeishuIngressEvidenceVerificationError(invalidResponse(source));
  }
  const bytes = await readBounded(response);
  if (bytes === null) throw new FeishuIngressEvidenceVerificationError(invalidResponse(source));
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new FeishuIngressEvidenceVerificationError(invalidResponse(source)); }
}

async function observabilityReport(
  manifest: FeishuIngressEvidenceManifestV1,
  options: FeishuIngressEvidenceVerifierOptions,
  fetcher: typeof fetch,
): Promise<FeishuIngressObservabilityReportV1> {
  const raw = await getJson(
    fetcher,
    manifest.observabilityReportUrl,
    options.observabilityToken,
    'observability',
  );
  const parsed = FeishuIngressObservabilityReportV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw new FeishuIngressEvidenceVerificationError('observability_response_invalid');
  }
  const { reportDigest, ...body } = parsed.data;
  if (
    reportDigest !== manifest.observabilityReportDigest ||
    await canonicalSha256(body) !== reportDigest ||
    parsed.data.evidenceId !== manifest.evidenceId
  ) throw new FeishuIngressEvidenceVerificationError('observability_digest_mismatch');
  return parsed.data;
}

function verifyTransport(
  manifest: FeishuIngressEvidenceManifestV1,
  report: FeishuIngressObservabilityReportV1,
  projections: [Projection, Projection],
): void {
  const expectedEvents = [manifest.events.replayed, manifest.events.sameRevisionPeer] as const;
  expectedEvents.forEach((expected, eventIndex) => {
    const projection = projections[eventIndex]!;
    const observations = report.requests.filter((request) => request.eventId === expected.eventId);
    const expectedDigests = [...expected.requestDigests];
    if (
      observations.length !== expectedDigests.length ||
      observations.some((observation) =>
        observation.case !== 'event' || observation.outcome !== 'event_accepted' ||
        observation.statusCode !== 200 || observation.deliveryId !== expected.deliveryId ||
        observation.eventType !== manifest.eventType) ||
      JSON.stringify(observations.map((observation) => observation.requestDigest).sort()) !==
        JSON.stringify([...expectedDigests].sort()) ||
      projection.tenantKey !== manifest.tenantKey || projection.eventId !== expected.eventId ||
      projection.counts.deliveries !== 1 ||
      projection.counts.transportReceipts !== expectedDigests.length ||
      projection.delivery === null || projection.delivery.deliveryId !== expected.deliveryId ||
      projection.delivery.eventType !== manifest.eventType ||
      projection.delivery.eventDigest !== expected.eventDigest ||
      projection.delivery.verificationMode !== 'encrypted' ||
      projection.transportReceipts.length !== expectedDigests.length ||
      JSON.stringify(projection.transportReceipts.map((receipt) => receipt.requestDigest).sort()) !==
        JSON.stringify([...expectedDigests].sort()) ||
      projection.transportReceipts.some((receipt) =>
        Date.parse(receipt.requestTimestamp) > Date.parse(receipt.receivedAt))
    ) throw new FeishuIngressEvidenceVerificationError('transport_replay_mismatch');
  });
}

function verifyQueue(
  manifest: FeishuIngressEvidenceManifestV1,
  projections: [Projection, Projection],
): void {
  const expectedEvents = [manifest.events.replayed, manifest.events.sameRevisionPeer] as const;
  expectedEvents.forEach((expected, eventIndex) => {
    const projection = projections[eventIndex]!;
    const ingress = projection.ingress;
    const attempts = projection.queueObservations.map((observation) => observation.deliveryAttempt);
    if (
      projection.counts.ingressOutboxes !== 1 ||
      projection.counts.queueMessageIdentities !== 1 ||
      projection.counts.queueObservations !== expected.queueObservationCount ||
      ingress === null || ingress.outboxId !== expected.ingressOutboxId ||
      ingress.deliveryId !== expected.deliveryId || ingress.eventType !== manifest.eventType ||
      ingress.eventDigest !== expected.eventDigest || ingress.deliveryState !== 'settled' ||
      ingress.relayAttemptCount !== expected.relayAttemptCount ||
      ingress.enqueuedAt !== expected.enqueuedAt ||
      ingress.queueObservedAt !== expected.queueObservedAt ||
      ingress.settledAt !== expected.settledAt ||
      projection.queueObservations.length !== expected.queueObservationCount ||
      new Set(projection.queueObservations.map((entry) => entry.queueMessageIdDigest)).size !== 1 ||
      projection.queueObservations.some((entry) =>
        entry.queueName !== manifest.cloudflare.queueName ||
        entry.queueMessageIdDigest !== expected.queueMessageIdDigest ||
        Date.parse(entry.messageTimestamp) > Date.parse(entry.observedAt) ||
        Date.parse(entry.observedAt) > Date.parse(expected.settledAt)) ||
      Math.max(...attempts) !== expected.maximumQueueDeliveryAttempt ||
      attempts.some((attempt, index) => attempt !== index + 1)
    ) throw new FeishuIngressEvidenceVerificationError('queue_lineage_mismatch');
  });
}

function verifyTask(
  manifest: FeishuIngressEvidenceManifestV1,
  projections: [Projection, Projection],
): void {
  for (const projection of projections) {
    const ingress = projection.ingress;
    const task = projection.task;
    if (
      projection.counts.tasks !== 1 || projection.counts.runs !== 1 ||
      ingress === null || task === null ||
      ingress.taskId !== manifest.task.taskId || ingress.runId !== manifest.task.runId ||
      ingress.taskDigest !== manifest.task.taskDigest ||
      task.sourceSystem !== manifest.task.sourceSystem || task.tenantKey !== manifest.tenantKey ||
      task.sourceTaskKey !== manifest.task.sourceTaskKey ||
      task.taskRevision !== manifest.task.taskRevision ||
      task.taskDigest !== manifest.task.taskDigest || task.taskId !== manifest.task.taskId ||
      task.runId !== manifest.task.runId
    ) throw new FeishuIngressEvidenceVerificationError('task_revision_mismatch');
  }
}

function verifyWorkflowIdentity(
  manifest: FeishuIngressEvidenceManifestV1,
  projections: [Projection, Projection],
): void {
  for (const projection of projections) {
    const task = projection.task;
    if (
      projection.counts.workflowCreateOutboxes !== 1 || task === null ||
      task.workflowInstanceId !== manifest.task.workflowInstanceId ||
      task.workflowInstanceId !== task.runId ||
      task.workflowCreateOutboxId !== manifest.task.workflowCreateOutboxId ||
      task.workflowCreateState !== 'settled'
    ) throw new FeishuIngressEvidenceVerificationError('workflow_identity_mismatch');
  }
}

async function projection(
  fetcher: typeof fetch,
  controlPlaneOrigin: string,
  operationsToken: string,
  tenantKey: string,
  eventId: string,
): Promise<Projection> {
  const query = new URLSearchParams({ tenantKey, eventId });
  const raw = await getJson(
    fetcher,
    `${controlPlaneOrigin}/v1/operations/feishu-ingress/evidence?${query}`,
    operationsToken,
    'control_plane',
  );
  const parsed = ProjectionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FeishuIngressEvidenceVerificationError('control_plane_response_invalid');
  }
  return parsed.data;
}

export async function verifyFeishuIngressEvidence(
  input: FeishuIngressEvidenceManifestV1,
  options: FeishuIngressEvidenceVerifierOptions,
): Promise<FeishuIngressEvidenceVerificationSummary> {
  const parsed = FeishuIngressEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new FeishuIngressEvidenceVerificationError('manifest_invalid');
  const manifest = parsed.data;
  const controlPlaneOrigin = safeOrigin(options.controlPlaneOrigin);
  const configuredObservabilityUrl = safeBoundUrl(options.observabilityReportUrl);
  const cloudflareApiOrigin = cloudflareBaseUrl(
    options.cloudflareApiOrigin ?? 'https://api.cloudflare.com/client/v4',
  );
  if (
    !TOKEN_PATTERN.test(options.operationsToken) ||
    !TOKEN_PATTERN.test(options.observabilityToken) ||
    !TOKEN_PATTERN.test(options.cloudflareToken) ||
    !ACCOUNT_ID_PATTERN.test(options.cloudflareAccountId) ||
    configuredObservabilityUrl !== manifest.observabilityReportUrl ||
    await canonicalSha256(options.cloudflareAccountId) !== manifest.cloudflare.accountIdDigest
  ) throw new FeishuIngressEvidenceVerificationError('configuration_invalid');
  const fetcher = options.fetch ?? fetch;
  const report = await observabilityReport(manifest, options, fetcher);
  const projections = await Promise.all([
    projection(
      fetcher,
      controlPlaneOrigin,
      options.operationsToken,
      manifest.tenantKey,
      manifest.events.replayed.eventId,
    ),
    projection(
      fetcher,
      controlPlaneOrigin,
      options.operationsToken,
      manifest.tenantKey,
      manifest.events.sameRevisionPeer.eventId,
    ),
  ]) as [Projection, Projection];
  verifyTransport(manifest, report, projections);
  verifyQueue(manifest, projections);
  verifyTask(manifest, projections);
  verifyWorkflowIdentity(manifest, projections);

  const cloudflareRaw = await getJson(
    fetcher,
    `${cloudflareApiOrigin}/accounts/${options.cloudflareAccountId}/workflows/` +
      `${manifest.cloudflare.workflowName}/instances/${manifest.task.workflowInstanceId}`,
    options.cloudflareToken,
    'cloudflare',
  );
  const instance = CloudflareInstanceSchema.safeParse(cloudflareRaw);
  if (!instance.success) {
    throw new FeishuIngressEvidenceVerificationError('cloudflare_response_invalid');
  }
  if (
    instance.data.result.status !== manifest.cloudflare.workflowInstanceStatus ||
    instance.data.result.versionId !== manifest.cloudflare.workflowInstanceVersionId ||
    instance.data.result.start !== manifest.cloudflare.workflowInstanceStartedAt
  ) throw new FeishuIngressEvidenceVerificationError('cloudflare_instance_mismatch');

  return {
    schemaVersion: '1',
    evidenceId: manifest.evidenceId,
    tenantKey: manifest.tenantKey,
    replayedEventId: manifest.events.replayed.eventId,
    replayTransportReceiptCount: 3,
    logicalIngressOutboxCount: 2,
    distinctQueueMessageCount: 2,
    queueObservationCount: projections[0].counts.queueObservations +
      projections[1].counts.queueObservations,
    sameRevisionEventCount: 2,
    taskId: manifest.task.taskId,
    runId: manifest.task.runId,
    workflowInstanceId: manifest.task.workflowInstanceId,
    workflowCreateOutboxCount: 1,
    duplicateTasks: 0,
    duplicateRuns: 0,
  };
}
