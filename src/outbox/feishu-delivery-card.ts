import {
  renderFeishuDeliveryCard,
  type FeishuDeliveryCardJson,
} from '../domain/feishu-delivery-card.js';
import { canonicalSha256 } from '../domain/digest.js';
import {
  feishuDeliveryCardPresentationFromRow,
  type StoredFeishuDeliveryCardPresentationRow,
} from '../storage/feishu-delivery-card-presentation.js';
import {
  FencedOutboxProcessor,
  OutboxEffectError,
  type FencedOutboxProcessorOptions,
  type FencedOutboxRecord,
  type OutboxDeliveryResult,
  type OutboxEffectOutcome,
} from './fenced-outbox.js';

// Directly derived from Watt
// packages/plugin-feishu/src/adapter/send.ts@476e3cd.
const TOKEN_CACHE_KEY = 'feishu:tenant_access_token';
const TOKEN_TTL_MARGIN_SEC = 60;
const TOKEN_INVALID_CODES = new Set([99991661, 99991663, 99991665]);
const RETRYABLE_CODES = new Set([230020, 230049]);
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,196}$/;
const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const DEDUPE_ID_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;
const MAX_CARD_BYTES = 30 * 1_024;
// Copied directly from Watt
// packages/gateway/src/event/plugin-sender.ts@476e3cd.
const FEISHU_SEND_TIMEOUT_MS = 10_000;

export interface TokenCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSec: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Watt's isolate-local expiring token cache, copied without semantic changes. */
export function memoryTokenCache(now: () => number = Date.now): TokenCache {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key) {
      const hit = store.get(key);
      if (hit === undefined) return null;
      if (hit.expiresAt <= now()) {
        store.delete(key);
        return null;
      }
      return hit.value;
    },
    async put(key, value, ttlSec) {
      store.set(key, { value, expiresAt: now() + ttlSec * 1_000 });
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

export type FeishuDeliveryCardUnavailableCode =
  | 'feishu_token_unavailable'
  | 'feishu_token_invalid'
  | 'feishu_rate_limited'
  | 'feishu_api_timeout'
  | 'feishu_api_unavailable';

export class FeishuDeliveryCardUnavailableError extends Error {
  constructor(readonly code: FeishuDeliveryCardUnavailableCode) {
    super(`Feishu delivery card unavailable: ${code}`);
    this.name = 'FeishuDeliveryCardUnavailableError';
  }
}

export interface FeishuDeliveryCardApiClientOptions {
  appId?: string;
  appSecret?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  cache?: TokenCache;
  /** Production stays at Watt's 10s bound; tests may inject a shorter bound. */
  timeoutMs?: number;
}

export interface CreateFeishuDeliveryCardRequest {
  chatId: string;
  dedupeId: string;
  card: FeishuDeliveryCardJson;
}

export interface UpdateFeishuDeliveryCardRequest {
  messageId: string;
  card: FeishuDeliveryCardJson;
}

export type CreateFeishuDeliveryCardResult =
  | { disposition: 'created'; messageId: string }
  | { disposition: 'rejected'; errorCode: 'feishu_request_rejected' };

export type UpdateFeishuDeliveryCardResult =
  | { disposition: 'updated' }
  | { disposition: 'expired' }
  | { disposition: 'rejected'; errorCode: 'feishu_request_rejected' };

interface TenantTokenResponse {
  code?: number;
  tenant_access_token?: string;
  expire?: number;
}

interface FeishuApiResponse {
  code?: number;
  data?: { message_id?: string; items?: unknown[] };
}

export interface FeishuDeliveryCardMessageFact {
  messageId: string;
  chatId: string;
  appId: string;
  tenantKey: string;
  msgType: 'interactive';
  deleted: false;
  cardDigest: string;
  createdAt: string;
  updatedAt: string;
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Feishu API URL is invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new Error('Feishu API URL is invalid');
  return url.origin;
}

function assertCard(card: FeishuDeliveryCardJson): string {
  if (card.config.update_multi !== true || card.config.wide_screen_mode !== true) {
    throw new Error('Feishu delivery card is invalid');
  }
  const content = JSON.stringify(card);
  if (new TextEncoder().encode(content).byteLength > MAX_CARD_BYTES) {
    throw new Error('Feishu delivery card is too large');
  }
  return content;
}

async function safeJson(response: Response): Promise<FeishuApiResponse | null> {
  try {
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null ? body as FeishuApiResponse : null;
  } catch {
    return null;
  }
}

/**
 * Feishu create/update adapter. Unlike Watt's generic sender, it intentionally
 * never includes upstream `msg`, response bodies, tokens, or fetch errors in a
 * returned error.
 */
export class FeishuDeliveryCardApiClient {
  private readonly appId: string | undefined;
  private readonly appSecret: string | undefined;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly cache: TokenCache;
  private readonly timeoutMs: number;

  constructor(options: FeishuDeliveryCardApiClientOptions = {}) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.baseUrl = httpsOrigin(options.baseUrl ?? 'https://open.feishu.cn');
    this.fetcher = options.fetch ?? fetch;
    this.cache = options.cache ?? memoryTokenCache();
    this.timeoutMs = options.timeoutMs ?? FEISHU_SEND_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new Error('Feishu API timeout is invalid');
    }
  }

  async createCard(
    request: CreateFeishuDeliveryCardRequest,
  ): Promise<CreateFeishuDeliveryCardResult> {
    if (!TARGET_ID_PATTERN.test(request.chatId) || !DEDUPE_ID_PATTERN.test(request.dedupeId)) {
      throw new Error('Feishu delivery card create request is invalid');
    }
    const content = assertCard(request.card);
    const result = await this.call(
      `${this.baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`,
      {
        method: 'POST',
        body: JSON.stringify({
          receive_id: request.chatId,
          msg_type: 'interactive',
          content,
          uuid: request.dedupeId,
        }),
      },
    );
    if (result.code !== 0) {
      return { disposition: 'rejected', errorCode: 'feishu_request_rejected' };
    }
    const messageId = result.data?.message_id;
    if (typeof messageId !== 'string' || !MESSAGE_ID_PATTERN.test(messageId)) {
      throw new FeishuDeliveryCardUnavailableError('feishu_api_unavailable');
    }
    return { disposition: 'created', messageId };
  }

  async updateCard(
    request: UpdateFeishuDeliveryCardRequest,
  ): Promise<UpdateFeishuDeliveryCardResult> {
    if (!MESSAGE_ID_PATTERN.test(request.messageId)) {
      throw new Error('Feishu delivery card update request is invalid');
    }
    const content = assertCard(request.card);
    const result = await this.call(
      `${this.baseUrl}/open-apis/im/v1/messages/${request.messageId}`,
      { method: 'PATCH', body: JSON.stringify({ content }) },
      true,
    );
    if (result.code === 230031) return { disposition: 'expired' };
    if (result.code !== 0) {
      return { disposition: 'rejected', errorCode: 'feishu_request_rejected' };
    }
    return { disposition: 'updated' };
  }

  /** Returns only allowlisted identity/timestamps plus a canonical card digest. */
  async getCardMessage(messageId: string): Promise<FeishuDeliveryCardMessageFact | null> {
    if (!MESSAGE_ID_PATTERN.test(messageId)) {
      throw new Error('Feishu delivery card message request is invalid');
    }
    const result = await this.call(
      `${this.baseUrl}/open-apis/im/v1/messages/${messageId}` +
        '?card_msg_content_type=user_card_content',
      { method: 'GET' },
    );
    if (result.code === 230110) return null;
    if (result.code !== 0 || !Array.isArray(result.data?.items) || result.data.items.length !== 1) {
      throw new FeishuDeliveryCardUnavailableError('feishu_api_unavailable');
    }
    const raw = result.data.items[0];
    if (typeof raw !== 'object' || raw === null) {
      throw new FeishuDeliveryCardUnavailableError('feishu_api_unavailable');
    }
    const item = raw as Record<string, unknown>;
    const sender = typeof item.sender === 'object' && item.sender !== null
      ? item.sender as Record<string, unknown>
      : null;
    const body = typeof item.body === 'object' && item.body !== null
      ? item.body as Record<string, unknown>
      : null;
    const createdAt = this.messageTime(item.create_time);
    const updatedAt = this.messageTime(item.update_time);
    if (
      item.message_id !== messageId || item.msg_type !== 'interactive' ||
      item.deleted !== false || typeof item.chat_id !== 'string' ||
      !TARGET_ID_PATTERN.test(item.chat_id) || sender?.sender_type !== 'app' ||
      typeof sender.id !== 'string' || !TARGET_ID_PATTERN.test(sender.id) ||
      typeof sender.tenant_key !== 'string' || !TARGET_ID_PATTERN.test(sender.tenant_key) ||
      typeof body?.content !== 'string' || body.content.length > MAX_CARD_BYTES * 2 ||
      createdAt === null || updatedAt === null || Date.parse(updatedAt) < Date.parse(createdAt)
    ) throw new FeishuDeliveryCardUnavailableError('feishu_api_unavailable');
    let card: unknown;
    try {
      card = JSON.parse(body.content) as unknown;
    } catch {
      throw new FeishuDeliveryCardUnavailableError('feishu_api_unavailable');
    }
    if (typeof card !== 'object' || card === null) {
      throw new FeishuDeliveryCardUnavailableError('feishu_api_unavailable');
    }
    try {
      assertCard(card as FeishuDeliveryCardJson);
    } catch {
      throw new FeishuDeliveryCardUnavailableError('feishu_api_unavailable');
    }
    return {
      messageId,
      chatId: item.chat_id,
      appId: sender.id,
      tenantKey: sender.tenant_key,
      msgType: 'interactive',
      deleted: false,
      cardDigest: await canonicalSha256(card),
      createdAt,
      updatedAt,
    };
  }

  private messageTime(raw: unknown): string | null {
    if (typeof raw !== 'string' || !/^[1-9][0-9]{9,15}$/.test(raw)) return null;
    const milliseconds = Number(raw);
    if (!Number.isSafeInteger(milliseconds)) return null;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  private async tenantToken(): Promise<string> {
    const cached = await this.cache.get(TOKEN_CACHE_KEY);
    if (cached !== null) return cached;
    if (
      this.appId === undefined || this.appSecret === undefined ||
      this.appId.length < 1 || this.appSecret.length < 1 ||
      /[\0\r\n]/.test(this.appId) || /[\0\r\n]/.test(this.appSecret)
    ) throw new FeishuDeliveryCardUnavailableError('feishu_token_unavailable');
    let response: Response;
    // Watt bounds every external send with AbortSignal.timeout; token fetch is
    // part of the same delivery dependency and gets the identical boundary.
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      response = await this.fetcher(
        `${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
          signal,
        },
      );
    } catch (error) {
      if (this.timedOut(signal, error)) {
        throw new FeishuDeliveryCardUnavailableError('feishu_api_timeout');
      }
      throw new FeishuDeliveryCardUnavailableError('feishu_token_unavailable');
    }
    const body = await safeJson(response) as TenantTokenResponse | null;
    if (
      !response.ok || body?.code !== 0 ||
      typeof body.tenant_access_token !== 'string' || body.tenant_access_token.length < 1 ||
      body.tenant_access_token.length > 2_000 || /[\0\r\n]/.test(body.tenant_access_token)
    ) throw new FeishuDeliveryCardUnavailableError('feishu_token_unavailable');
    const expire = typeof body.expire === 'number' && Number.isFinite(body.expire)
      ? body.expire
      : 7_200;
    const ttl = Math.floor(expire) - TOKEN_TTL_MARGIN_SEC;
    await this.cache.put(TOKEN_CACHE_KEY, body.tenant_access_token, ttl > 0 ? ttl : 60);
    return body.tenant_access_token;
  }

  private async call(
    url: string,
    init: Pick<RequestInit, 'method' | 'body'>,
    allowExpired = false,
  ): Promise<FeishuApiResponse> {
    const token = await this.tenantToken();
    let response: Response;
    // Direct Watt plugin-sender semantics: one bounded AbortSignal per send.
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      response = await this.fetcher(url, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        signal,
      });
    } catch (error) {
      if (this.timedOut(signal, error)) {
        throw new FeishuDeliveryCardUnavailableError('feishu_api_timeout');
      }
      throw new FeishuDeliveryCardUnavailableError('feishu_api_unavailable');
    }
    const body = await safeJson(response);
    if (body?.code !== undefined && TOKEN_INVALID_CODES.has(body.code)) {
      await this.cache.delete(TOKEN_CACHE_KEY).catch(() => {});
      throw new FeishuDeliveryCardUnavailableError('feishu_token_invalid');
    }
    if (body?.code !== undefined && RETRYABLE_CODES.has(body.code)) {
      throw new FeishuDeliveryCardUnavailableError('feishu_rate_limited');
    }
    if (response.status === 429) {
      throw new FeishuDeliveryCardUnavailableError('feishu_rate_limited');
    }
    if (response.status >= 500 || body === null) {
      throw new FeishuDeliveryCardUnavailableError('feishu_api_unavailable');
    }
    if (allowExpired && body.code === 230031) return body;
    return body;
  }

  private timedOut(signal: AbortSignal, error: unknown): boolean {
    if (signal.aborted) return true;
    return error instanceof DOMException &&
      (error.name === 'TimeoutError' || error.name === 'AbortError');
  }
}

export interface FeishuDeliveryCardEffects {
  createCard(
    request: CreateFeishuDeliveryCardRequest,
  ): Promise<CreateFeishuDeliveryCardResult>;
  updateCard(
    request: UpdateFeishuDeliveryCardRequest,
  ): Promise<UpdateFeishuDeliveryCardResult>;
}

export type FeishuDeliveryCardOutboxProcessorOptions = Omit<
  FencedOutboxProcessorOptions,
  'unavailableErrorCode'
>;

interface DeliveryCardRow extends StoredFeishuDeliveryCardPresentationRow {
  revision: number;
  digest: string;
  chat_id: string;
  latest_presentation_id: string | null;
  delivered_presentation_id: string | null;
  delivered_digest: string | null;
  active_message_id: string | null;
  active_message_created_at: string | null;
  prior_delivery_disposition: 'created' | 'updated' | 'rejected' | null;
}

const CARD_MESSAGE_MAX_AGE_MS = 14 * 24 * 60 * 60_000 - 5 * 60_000;

/** D1-fenced create-or-PATCH delivery of one immutable presentation. */
export class FeishuDeliveryCardOutboxProcessor {
  private readonly fenced: FencedOutboxProcessor;
  private readonly now: () => Date;

  constructor(
    private readonly db: D1Database,
    private readonly effects: FeishuDeliveryCardEffects,
    options: FeishuDeliveryCardOutboxProcessorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.fenced = new FencedOutboxProcessor(
      db,
      'feishu_cards',
      async (outbox) => {
        try {
          return await this.perform(outbox);
        } catch (error) {
          // Preserve Watt's retryable classification in the durable outbox;
          // never persist the upstream exception or response body.
          if (error instanceof FeishuDeliveryCardUnavailableError) {
            throw new OutboxEffectError(error.code);
          }
          throw error;
        }
      },
      {
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.generateLeaseToken === undefined
          ? {}
          : { generateLeaseToken: options.generateLeaseToken }),
        ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
        unavailableErrorCode: 'feishu_unavailable',
        onRetry: async (retry) => await this.recordRetryObservation(retry),
      },
    );
  }

  async deliver(outboxId: string): Promise<OutboxDeliveryResult> {
    return await this.fenced.deliver(outboxId);
  }

  async drain(limit = 25): Promise<OutboxDeliveryResult[]> {
    return await this.fenced.drain(limit);
  }

  private async perform(outbox: FencedOutboxRecord): Promise<OutboxEffectOutcome | void> {
    if (outbox.kind !== 'feishu_delivery_card_upsert') {
      throw new OutboxEffectError('unsupported_feishu_card_kind');
    }
    const prefix = 'd1://feishu-delivery-card-presentations/';
    if (!outbox.payloadRef.startsWith(prefix)) {
      throw new OutboxEffectError('feishu_card_ref_invalid');
    }
    const presentationId = outbox.payloadRef.slice(prefix.length);
    if (!TARGET_ID_PATTERN.test(presentationId)) {
      throw new OutboxEffectError('feishu_card_ref_invalid');
    }
    const row = await this.context(presentationId, outbox.runId);
    if (row === null) throw new OutboxEffectError('feishu_card_presentation_missing');
    if (row.prior_delivery_disposition === 'rejected') {
      return { settledCode: 'feishu_request_rejected' };
    }
    if (row.prior_delivery_disposition !== null) {
      return { settledCode: 'feishu_card_already_delivered' };
    }
    if (row.latest_presentation_id !== row.presentation_id) {
      return { settledCode: 'feishu_card_presentation_stale' };
    }
    if (
      row.delivered_presentation_id === row.presentation_id ||
      row.delivered_digest === row.digest
    ) return { settledCode: 'feishu_card_already_delivered' };

    const presentation = this.presentation(row);
    const card = renderFeishuDeliveryCard(presentation);
    const now = this.now();
    let messageId = row.active_message_id;
    let disposition: 'created' | 'updated';
    if (messageId !== null && this.canPatch(row.active_message_created_at, now)) {
      const update = await this.effects.updateCard({ messageId, card });
      if (update.disposition === 'rejected') {
        await this.recordRejected(row, outbox.outboxId, now.toISOString());
        return { settledCode: update.errorCode };
      }
      if (update.disposition === 'updated') {
        disposition = 'updated';
      } else {
        messageId = null;
        disposition = 'created';
      }
    } else {
      messageId = null;
      disposition = 'created';
    }
    if (messageId === null) {
      const created = await this.effects.createCard({
        chatId: row.chat_id,
        dedupeId: this.dedupeId(row.digest),
        card,
      });
      if (created.disposition === 'rejected') {
        await this.recordRejected(row, outbox.outboxId, now.toISOString());
        return { settledCode: created.errorCode };
      }
      messageId = created.messageId;
      disposition = 'created';
    }
    if (!MESSAGE_ID_PATTERN.test(messageId)) {
      throw new OutboxEffectError('feishu_message_id_invalid');
    }
    await this.recordSuccess(
      row,
      outbox.outboxId,
      disposition,
      messageId,
      now.toISOString(),
    );
  }

  private async context(presentationId: string, runId: string): Promise<DeliveryCardRow | null> {
    return await this.db.prepare(
      `SELECT presentations.presentation_id, presentations.card_id,
              presentations.run_id, presentations.run_version,
              presentations.revision, presentations.digest,
              presentations.schema_version, presentations.presentation_json,
              presentations.refresh_request_id,
              presentations.pr_status, presentations.pr_url,
              presentations.merge_status, presentations.merge_url,
              presentations.test_deploy_status, presentations.test_deploy_url,
              presentations.production_deploy_status,
              presentations.production_deploy_url,
              cards.chat_id, cards.latest_presentation_id,
              cards.delivered_presentation_id, cards.delivered_digest,
              cards.active_message_id, cards.active_message_created_at,
              deliveries.disposition AS prior_delivery_disposition
       FROM feishu_delivery_card_presentations AS presentations
       JOIN feishu_delivery_cards AS cards ON cards.card_id = presentations.card_id
       LEFT JOIN feishu_delivery_card_deliveries AS deliveries
         ON deliveries.presentation_id = presentations.presentation_id
       WHERE presentations.presentation_id = ? AND presentations.run_id = ?`,
    ).bind(presentationId, runId).first<DeliveryCardRow>();
  }

  private presentation(row: DeliveryCardRow) {
    return feishuDeliveryCardPresentationFromRow(row);
  }

  private canPatch(createdAt: string | null, now: Date): boolean {
    if (createdAt === null) return false;
    const createdMs = Date.parse(createdAt);
    return Number.isFinite(createdMs) && createdMs <= now.getTime() &&
      now.getTime() - createdMs < CARD_MESSAGE_MAX_AGE_MS;
  }

  private dedupeId(digest: string): string {
    const hex = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : '';
    if (!/^[a-f0-9]{64}$/.test(hex)) throw new OutboxEffectError('feishu_card_digest_invalid');
    return `feishu_${hex.slice(0, 43)}`;
  }

  private async recordRejected(
    row: DeliveryCardRow,
    outboxId: string,
    nowIso: string,
  ): Promise<void> {
    await this.db.prepare(
      `INSERT OR IGNORE INTO feishu_delivery_card_deliveries (
         delivery_id, presentation_id, outbox_id, disposition,
         message_id, error_code, delivered_at
       ) VALUES (?, ?, ?, 'rejected', NULL, 'feishu_request_rejected', ?)`,
    ).bind(`feishu_delivery_${row.presentation_id}`, row.presentation_id, outboxId, nowIso).run();
  }

  private async recordRetryObservation(input: {
    outboxId: string;
    runId: string;
    kind: string;
    payloadRef: string;
    attemptCount: number;
    errorCode: string;
    observedAt: string;
  }): Promise<void> {
    const prefix = 'd1://feishu-delivery-card-presentations/';
    const allowedErrors = new Set([
      'feishu_rate_limited', 'feishu_api_timeout', 'feishu_token_invalid',
      'feishu_api_unavailable', 'feishu_token_unavailable', 'feishu_unavailable',
    ]);
    if (
      input.kind !== 'feishu_delivery_card_upsert' ||
      !input.payloadRef.startsWith(prefix) ||
      !Number.isSafeInteger(input.attemptCount) || input.attemptCount < 1 ||
      !allowedErrors.has(input.errorCode)
    ) return;
    const presentationId = input.payloadRef.slice(prefix.length);
    if (!TARGET_ID_PATTERN.test(presentationId)) return;
    const digest = await canonicalSha256({
      schemaVersion: '1',
      outboxId: input.outboxId,
      attemptCount: input.attemptCount,
    });
    await this.db.prepare(
      `INSERT OR IGNORE INTO feishu_delivery_card_retry_observations (
         observation_id, outbox_id, run_id, presentation_id,
         attempt_count, error_code, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      `feishu_retry_${digest.slice('sha256:'.length, 'sha256:'.length + 48)}`,
      input.outboxId,
      input.runId,
      presentationId,
      input.attemptCount,
      input.errorCode,
      input.observedAt,
    ).run();
  }

  private async recordSuccess(
    row: DeliveryCardRow,
    outboxId: string,
    disposition: 'created' | 'updated',
    messageId: string,
    nowIso: string,
  ): Promise<void> {
    await this.db.batch([
      this.db.prepare(
        `INSERT OR IGNORE INTO feishu_delivery_card_deliveries (
           delivery_id, presentation_id, outbox_id, disposition,
           message_id, error_code, delivered_at
         ) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      ).bind(
        `feishu_delivery_${row.presentation_id}`,
        row.presentation_id,
        outboxId,
        disposition,
        messageId,
        nowIso,
      ),
      this.db.prepare(
        `UPDATE feishu_delivery_cards
         SET delivered_presentation_id = ?, delivered_revision = ?,
             delivered_digest = ?, active_message_id = ?,
             active_message_created_at = CASE
               WHEN ? = 'created' THEN ? ELSE active_message_created_at END,
             updated_at = ?
         WHERE card_id = ? AND latest_presentation_id = ?
           AND delivered_revision < ?`,
      ).bind(
        row.presentation_id,
        row.revision,
        row.digest,
        messageId,
        disposition,
        nowIso,
        nowIso,
        row.card_id,
        row.presentation_id,
        row.revision,
      ),
    ]);
  }
}
