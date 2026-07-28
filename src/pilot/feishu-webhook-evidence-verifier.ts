import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';
import {
  FeishuWebhookEvidenceManifestV1Schema,
  FeishuWebhookObservabilityReportV1Schema,
  type FeishuWebhookEvidenceManifestV1,
  type FeishuWebhookObservabilityReportV1,
} from '../domain/feishu-webhook-evidence.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const EVENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;

const CountsSchema = z.object({
  deliveries: z.number().int().nonnegative(),
  nonces: z.number().int().nonnegative(),
  ingressOutboxes: z.number().int().nonnegative(),
  tasks: z.number().int().nonnegative(),
  runs: z.number().int().nonnegative(),
  outboxEffects: z.number().int().nonnegative(),
}).strict();

const ProjectionSchema = z.object({
  schemaVersion: z.literal('1'),
  tenantKey: z.string().regex(ID_PATTERN),
  eventId: z.string().regex(ID_PATTERN),
  counts: CountsSchema,
  delivery: z.object({
    deliveryId: z.string().regex(ID_PATTERN),
    appId: z.string().regex(ID_PATTERN),
    eventType: z.string().regex(EVENT_TYPE_PATTERN),
    eventCreatedAt: z.iso.datetime({ offset: true }),
    verificationMode: z.enum(['encrypted', 'plaintext']),
    requestTimestamp: z.iso.datetime({ offset: true }).nullable(),
    requestDigest: z.string().regex(DIGEST_PATTERN),
    eventDigest: z.string().regex(DIGEST_PATTERN),
    status: z.literal('accepted'),
    receivedAt: z.iso.datetime({ offset: true }),
  }).strict().nullable(),
  ingress: z.object({
    outboxId: z.string().regex(ID_PATTERN),
    deliveryId: z.string().regex(ID_PATTERN),
    eventType: z.string().regex(EVENT_TYPE_PATTERN),
    eventDigest: z.string().regex(DIGEST_PATTERN),
    deliveryState: z.enum([
      'pending', 'delivering', 'enqueued', 'queued', 'settled', 'dead_lettered',
    ]),
    taskId: z.string().regex(ID_PATTERN).nullable(),
    runId: z.string().regex(ID_PATTERN).nullable(),
    createdAt: z.iso.datetime({ offset: true }),
  }).strict().nullable(),
}).strict();

export type FeishuWebhookEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'observability_unavailable'
  | 'observability_response_invalid'
  | 'observability_digest_mismatch'
  | 'challenge_mismatch'
  | 'event_observation_mismatch'
  | 'rejection_observation_mismatch'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'event_projection_mismatch'
  | 'rejected_business_record_observed';

export class FeishuWebhookEvidenceVerificationError extends Error {
  constructor(readonly code: FeishuWebhookEvidenceVerificationErrorCode) {
    super(`Feishu webhook evidence verification failed: ${code}`);
    this.name = 'FeishuWebhookEvidenceVerificationError';
  }
}

export interface FeishuWebhookEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  operationsToken: string;
  observabilityReportUrl: string;
  observabilityToken: string;
  fetch?: typeof fetch;
}

export interface FeishuWebhookEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  appId: string;
  tenantKey: string;
  challenge: 'verified';
  eventId: string;
  eventType: string;
  deliveryId: string;
  rejectionCases: Array<'expired_timestamp' | 'invalid_signature' | 'wrong_tenant'>;
  rejectedBusinessRecordCount: 0;
  developerConsoleReview: 'required_and_recorded';
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new FeishuWebhookEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new FeishuWebhookEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

function httpsUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new FeishuWebhookEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== ''
  ) throw new FeishuWebhookEvidenceVerificationError('configuration_invalid');
  return url.toString();
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new FeishuWebhookEvidenceVerificationError('control_plane_response_invalid');
  }
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new FeishuWebhookEvidenceVerificationError('control_plane_response_invalid');
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new FeishuWebhookEvidenceVerificationError('control_plane_response_invalid');
  }
}

async function getJson(
  fetcher: typeof fetch,
  url: string,
  token: string,
  authority: 'observability' | 'control_plane',
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
    });
  } catch {
    throw new FeishuWebhookEvidenceVerificationError(
      authority === 'observability' ? 'observability_unavailable' : 'control_plane_unavailable',
    );
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new FeishuWebhookEvidenceVerificationError(
      authority === 'observability' ? 'observability_unavailable' : 'control_plane_unavailable',
    );
  }
  try {
    return await readBoundedJson(response);
  } catch (error) {
    if (
      authority === 'observability' &&
      error instanceof FeishuWebhookEvidenceVerificationError
    ) throw new FeishuWebhookEvidenceVerificationError('observability_response_invalid');
    throw error;
  }
}

function observationByCase<C extends FeishuWebhookObservabilityReportV1['requests'][number]['case']>(
  report: FeishuWebhookObservabilityReportV1,
  caseName: C,
): Extract<FeishuWebhookObservabilityReportV1['requests'][number], { case: C }> {
  return report.requests.find((request) => request.case === caseName) as
    Extract<FeishuWebhookObservabilityReportV1['requests'][number], { case: C }>;
}

async function verifyObservability(
  manifest: FeishuWebhookEvidenceManifestV1,
  options: FeishuWebhookEvidenceVerifierOptions,
  fetcher: typeof fetch,
): Promise<FeishuWebhookObservabilityReportV1> {
  const configuredUrl = httpsUrl(options.observabilityReportUrl);
  if (configuredUrl !== manifest.observabilityReportUrl) {
    throw new FeishuWebhookEvidenceVerificationError('configuration_invalid');
  }
  const raw = await getJson(fetcher, configuredUrl, options.observabilityToken, 'observability');
  const parsed = FeishuWebhookObservabilityReportV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw new FeishuWebhookEvidenceVerificationError('observability_response_invalid');
  }
  const { reportDigest, ...body } = parsed.data;
  if (
    reportDigest !== manifest.observabilityReportDigest ||
    await canonicalSha256(body) !== reportDigest ||
    parsed.data.evidenceId !== manifest.evidenceId ||
    parsed.data.callbackUrl !== manifest.application.callbackUrl ||
    Date.parse(parsed.data.generatedAt) > Date.parse(manifest.recordedAt)
  ) throw new FeishuWebhookEvidenceVerificationError('observability_digest_mismatch');
  return parsed.data;
}

function verifyRequestObservations(
  manifest: FeishuWebhookEvidenceManifestV1,
  report: FeishuWebhookObservabilityReportV1,
): void {
  const challenge = observationByCase(report, 'challenge');
  if (
    challenge.requestDigest !== manifest.challenge.requestDigest ||
    challenge.responseDigest !== manifest.challenge.responseDigest ||
    challenge.startedAt !== manifest.challenge.observedAt ||
    challenge.latencyMs !== manifest.challenge.latencyMs || challenge.latencyMs > 1_000
  ) throw new FeishuWebhookEvidenceVerificationError('challenge_mismatch');

  const event = observationByCase(report, 'event');
  if (
    event.requestDigest !== manifest.event.requestDigest ||
    event.responseDigest !== manifest.event.responseDigest ||
    event.startedAt !== manifest.event.observedAt || event.latencyMs > 3_000 ||
    event.eventId !== manifest.event.eventId || event.eventType !== manifest.event.eventType ||
    event.deliveryId !== manifest.event.deliveryId
  ) throw new FeishuWebhookEvidenceVerificationError('event_observation_mismatch');

  for (const rejection of manifest.rejections) {
    const observation = observationByCase(report, rejection.case);
    if (
      observation.requestDigest !== rejection.requestDigest ||
      observation.responseDigest !== rejection.responseDigest ||
      observation.startedAt !== rejection.observedAt ||
      observation.statusCode !== rejection.statusCode || observation.latencyMs > 3_000 ||
      (rejection.case === 'wrong_tenant' &&
        (observation.case !== 'wrong_tenant' || observation.eventId !== rejection.eventId ||
          observation.eventType !== manifest.event.eventType))
    ) throw new FeishuWebhookEvidenceVerificationError('rejection_observation_mismatch');
  }
}

async function projection(
  fetcher: typeof fetch,
  origin: string,
  token: string,
  tenantKey: string,
  eventId: string,
): Promise<z.infer<typeof ProjectionSchema>> {
  const raw = await getJson(
    fetcher,
    `${origin}/v1/operations/feishu-webhook/evidence` +
      `?tenantKey=${encodeURIComponent(tenantKey)}&eventId=${encodeURIComponent(eventId)}`,
    token,
    'control_plane',
  );
  const parsed = ProjectionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FeishuWebhookEvidenceVerificationError('control_plane_response_invalid');
  }
  if (parsed.data.tenantKey !== tenantKey || parsed.data.eventId !== eventId) {
    throw new FeishuWebhookEvidenceVerificationError('control_plane_response_invalid');
  }
  return parsed.data;
}

export async function verifyFeishuWebhookEvidence(
  input: FeishuWebhookEvidenceManifestV1,
  options: FeishuWebhookEvidenceVerifierOptions,
): Promise<FeishuWebhookEvidenceVerificationSummary> {
  const parsed = FeishuWebhookEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) throw new FeishuWebhookEvidenceVerificationError('manifest_invalid');
  if (
    !TOKEN_PATTERN.test(options.operationsToken) ||
    !TOKEN_PATTERN.test(options.observabilityToken)
  ) throw new FeishuWebhookEvidenceVerificationError('configuration_invalid');
  const controlPlaneOrigin = httpsOrigin(options.controlPlaneOrigin);
  if (
    new URL(input.application.callbackUrl).origin !== controlPlaneOrigin ||
    new URL(input.application.callbackUrl).pathname !== '/v1/webhooks/feishu'
  ) throw new FeishuWebhookEvidenceVerificationError('configuration_invalid');
  const fetcher = options.fetch ?? fetch;
  const report = await verifyObservability(input, options, fetcher);
  verifyRequestObservations(input, report);

  const accepted = await projection(
    fetcher,
    controlPlaneOrigin,
    options.operationsToken,
    input.event.tenantKey,
    input.event.eventId,
  );
  const delivery = accepted.delivery;
  const ingress = accepted.ingress;
  if (
    accepted.counts.deliveries !== 1 || accepted.counts.nonces < 1 ||
    accepted.counts.ingressOutboxes !== 1 || delivery === null || ingress === null ||
    delivery.deliveryId !== input.event.deliveryId || delivery.appId !== input.application.appId ||
    delivery.eventType !== input.event.eventType || delivery.verificationMode !== 'encrypted' ||
    delivery.requestTimestamp === null || delivery.requestDigest !== input.event.requestDigest ||
    delivery.eventDigest !== input.event.eventDigest ||
    ingress.deliveryId !== input.event.deliveryId || ingress.eventType !== input.event.eventType ||
    ingress.eventDigest !== input.event.eventDigest
  ) throw new FeishuWebhookEvidenceVerificationError('event_projection_mismatch');

  for (const rejection of input.rejections) {
    const rejected = await projection(
      fetcher,
      controlPlaneOrigin,
      options.operationsToken,
      rejection.tenantKey,
      rejection.eventId,
    );
    if (
      rejected.delivery !== null || rejected.ingress !== null ||
      Object.values(rejected.counts).some((count) => count !== 0)
    ) throw new FeishuWebhookEvidenceVerificationError('rejected_business_record_observed');
  }

  return {
    schemaVersion: '1',
    evidenceId: input.evidenceId,
    appId: input.application.appId,
    tenantKey: input.application.tenantKey,
    challenge: 'verified',
    eventId: input.event.eventId,
    eventType: input.event.eventType,
    deliveryId: input.event.deliveryId,
    rejectionCases: ['expired_timestamp', 'invalid_signature', 'wrong_tenant'],
    rejectedBusinessRecordCount: 0,
    developerConsoleReview: 'required_and_recorded',
  };
}
