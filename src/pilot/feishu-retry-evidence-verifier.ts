import { z } from 'zod';
import {
  FeishuRetryEvidenceManifestV1Schema,
  type FeishuRetryEvidenceManifestV1,
} from '../domain/feishu-retry-evidence.js';
import {
  FeishuDeliveryCardApiClient,
  FeishuDeliveryCardUnavailableError,
  memoryTokenCache,
} from '../outbox/feishu-delivery-card.js';

const TOKEN_PATTERN = /^[^\0\r\n]{1,2000}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,196}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;

const RetryHistorySchema = z.array(z.object({
  outboxId: z.string().regex(ID_PATTERN),
  presentationId: z.string().regex(ID_PATTERN),
  attemptCount: z.number().int().positive(),
  errorCode: z.enum([
    'feishu_rate_limited', 'feishu_api_timeout', 'feishu_token_invalid',
    'feishu_api_unavailable', 'feishu_token_unavailable', 'feishu_unavailable',
  ]),
  observedAt: z.iso.datetime({ offset: true }),
}).strict()).max(100);

const CardOperationsSchema = z.object({
  schemaVersion: z.literal('1'),
  card: z.object({
    runId: z.string().regex(ID_PATTERN),
    latest: z.object({
      presentationId: z.string().regex(ID_PATTERN),
      revision: z.number().int().positive(),
      digest: z.string().regex(DIGEST_PATTERN),
      renderedDigest: z.string().regex(DIGEST_PATTERN),
      outboxId: z.string().regex(ID_PATTERN),
      deliveryState: z.enum(['pending', 'delivering', 'settled']),
      attemptCount: z.number().int().nonnegative(),
      lastErrorCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(),
    }).strict(),
    delivered: z.object({
      presentationId: z.string().regex(ID_PATTERN),
      revision: z.number().int().positive(),
      digest: z.string().regex(DIGEST_PATTERN),
      messageId: z.string().regex(MESSAGE_ID_PATTERN),
    }).strict().nullable(),
    retryHistory: RetryHistorySchema,
    refresh: z.object({
      requestId: z.string().regex(ID_PATTERN),
      expectedPresentationId: z.string().regex(ID_PATTERN),
      expectedRevision: z.number().int().positive(),
      expectedDigest: z.string().regex(DIGEST_PATTERN),
      nextPresentationId: z.string().regex(ID_PATTERN),
      nextRevision: z.number().int().positive(),
      nextDigest: z.string().regex(DIGEST_PATTERN),
      nextOutboxId: z.string().regex(ID_PATTERN),
      nextDeliveryState: z.enum(['pending', 'delivering', 'settled']),
    }).strict().nullable(),
  }).strict(),
}).strict();

export type FeishuRetryEvidenceVerificationErrorCode =
  | 'manifest_invalid'
  | 'configuration_invalid'
  | 'control_plane_unavailable'
  | 'control_plane_response_invalid'
  | 'retry_history_mismatch'
  | 'refresh_lineage_mismatch'
  | 'card_delivery_mismatch'
  | 'feishu_api_unavailable'
  | 'feishu_message_mismatch';

export class FeishuRetryEvidenceVerificationError extends Error {
  constructor(readonly code: FeishuRetryEvidenceVerificationErrorCode) {
    super(`Feishu retry evidence verification failed: ${code}`);
    this.name = 'FeishuRetryEvidenceVerificationError';
  }
}

export interface FeishuRetryEvidenceVerifierOptions {
  controlPlaneOrigin: string;
  operationsToken: string;
  feishuAccessToken: string;
  feishuApiOrigin?: string;
  fetch?: typeof fetch;
}

export interface FeishuRetryEvidenceVerificationSummary {
  schemaVersion: '1';
  evidenceId: string;
  repository: string;
  runId: string;
  retries: number;
  retryCodes: string[];
  refresh: 'verified';
  finalPresentationId: string;
  finalMessageId: string;
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FeishuRetryEvidenceVerificationError('configuration_invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new FeishuRetryEvidenceVerificationError('configuration_invalid');
  return url.origin;
}

async function readBoundedResponse(response: Response): Promise<string | null> {
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
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      redirect: 'error',
    });
  } catch {
    throw new FeishuRetryEvidenceVerificationError('control_plane_unavailable');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new FeishuRetryEvidenceVerificationError('control_plane_unavailable');
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new FeishuRetryEvidenceVerificationError('control_plane_response_invalid');
  }
  let text: string | null;
  try {
    text = await readBoundedResponse(response);
  } catch {
    throw new FeishuRetryEvidenceVerificationError('control_plane_response_invalid');
  }
  if (text === null) {
    throw new FeishuRetryEvidenceVerificationError('control_plane_response_invalid');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FeishuRetryEvidenceVerificationError('control_plane_response_invalid');
  }
}

export async function verifyFeishuRetryEvidence(
  input: FeishuRetryEvidenceManifestV1,
  options: FeishuRetryEvidenceVerifierOptions,
): Promise<FeishuRetryEvidenceVerificationSummary> {
  const parsed = FeishuRetryEvidenceManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new FeishuRetryEvidenceVerificationError('manifest_invalid');
  }
  if (
    !TOKEN_PATTERN.test(options.operationsToken) ||
    !TOKEN_PATTERN.test(options.feishuAccessToken)
  ) throw new FeishuRetryEvidenceVerificationError('configuration_invalid');
  const controlPlaneOrigin = httpsOrigin(options.controlPlaneOrigin);
  const feishuApiOrigin = httpsOrigin(options.feishuApiOrigin ?? 'https://open.feishu.cn');
  const fetcher = options.fetch ?? fetch;
  const raw = await getJson(
    fetcher,
    `${controlPlaneOrigin}/v1/runs/${input.runId}/feishu-card`,
    options.operationsToken,
  );
  const operations = CardOperationsSchema.safeParse(raw);
  if (!operations.success) {
    throw new FeishuRetryEvidenceVerificationError('control_plane_response_invalid');
  }
  const card = operations.data.card;
  const expectedHistory = input.first.retryHistory.map((retry) => ({
    outboxId: input.first.outboxId,
    presentationId: input.first.presentationId,
    attemptCount: retry.attemptCount,
    errorCode: retry.errorCode,
    observedAt: retry.observedAt,
  }));
  if (
    card.runId !== input.runId ||
    JSON.stringify(card.retryHistory) !== JSON.stringify(expectedHistory)
  ) throw new FeishuRetryEvidenceVerificationError('retry_history_mismatch');
  const refresh = card.refresh;
  if (
    refresh === null ||
    refresh.requestId !== input.refresh.requestId ||
    refresh.expectedPresentationId !== input.refresh.expectedPresentationId ||
    refresh.expectedRevision !== input.refresh.expectedRevision ||
    refresh.expectedDigest !== input.refresh.expectedDigest ||
    refresh.nextPresentationId !== input.refresh.nextPresentationId ||
    refresh.nextRevision !== input.refresh.nextRevision ||
    refresh.nextDigest !== input.refresh.nextDigest ||
    refresh.nextOutboxId !== input.refresh.nextOutboxId ||
    refresh.nextDeliveryState !== 'settled'
  ) throw new FeishuRetryEvidenceVerificationError('refresh_lineage_mismatch');
  const latest = card.latest;
  const delivered = card.delivered;
  if (
    latest.presentationId !== input.refresh.nextPresentationId ||
    latest.revision !== input.refresh.nextRevision ||
    latest.digest !== input.refresh.nextDigest ||
    latest.outboxId !== input.refresh.nextOutboxId ||
    latest.deliveryState !== 'settled' || latest.lastErrorCode !== null ||
    latest.attemptCount < 1 || delivered === null ||
    delivered.presentationId !== latest.presentationId ||
    delivered.revision !== latest.revision || delivered.digest !== latest.digest ||
    delivered.messageId !== input.refresh.finalMessageId
  ) throw new FeishuRetryEvidenceVerificationError('card_delivery_mismatch');

  const cache = memoryTokenCache();
  await cache.put('feishu:tenant_access_token', options.feishuAccessToken, 60);
  const client = new FeishuDeliveryCardApiClient({
    baseUrl: feishuApiOrigin,
    cache,
    fetch: fetcher,
  });
  let fact;
  try {
    fact = await client.getCardMessage(input.refresh.finalMessageId);
  } catch (error) {
    if (error instanceof FeishuDeliveryCardUnavailableError) {
      throw new FeishuRetryEvidenceVerificationError('feishu_api_unavailable');
    }
    throw new FeishuRetryEvidenceVerificationError('feishu_api_unavailable');
  }
  if (
    fact === null || fact.messageId !== input.refresh.finalMessageId ||
    fact.appId !== input.card.appId || fact.tenantKey !== input.card.tenantKey ||
    fact.chatId !== input.card.chatId || fact.cardDigest !== input.card.finalRenderedDigest ||
    fact.cardDigest !== latest.renderedDigest || fact.createdAt !== input.card.finalCreatedAt ||
    fact.updatedAt !== input.card.finalUpdatedAt
  ) throw new FeishuRetryEvidenceVerificationError('feishu_message_mismatch');

  return {
    schemaVersion: '1',
    evidenceId: input.evidenceId,
    repository: input.repository,
    runId: input.runId,
    retries: input.first.retryHistory.length,
    retryCodes: [...new Set(input.first.retryHistory.map((retry) => retry.errorCode))],
    refresh: 'verified',
    finalPresentationId: input.refresh.nextPresentationId,
    finalMessageId: input.refresh.finalMessageId,
  };
}
