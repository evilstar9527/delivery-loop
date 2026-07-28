import { z } from 'zod';
import { canonicalSha256 } from '../domain/digest.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const TENANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const APP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const EVENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

const FeishuWebhookReceiptInputSchema = z.object({
  eventId: z.string().regex(ID_PATTERN),
  tenantKey: z.string().regex(TENANT_PATTERN),
  appId: z.string().regex(APP_PATTERN),
  eventType: z.string().regex(EVENT_TYPE_PATTERN),
  eventCreatedAt: z.iso.datetime({ offset: true }),
  verificationMode: z.enum(['encrypted', 'plaintext']),
  requestTimestamp: z.iso.datetime({ offset: true }).nullable(),
  nonceDigest: z.string().regex(DIGEST_PATTERN).nullable(),
  requestDigest: z.string().regex(DIGEST_PATTERN),
  eventDigest: z.string().regex(DIGEST_PATTERN),
  receivedAt: z.iso.datetime({ offset: true }),
}).strict();

export type FeishuWebhookReceiptInput = z.infer<typeof FeishuWebhookReceiptInputSchema>;

export interface FeishuWebhookReceiptResult {
  deliveryId: string;
  ingressOutboxId: string;
  eventId: string;
  disposition: 'created' | 'duplicate';
}

export interface FeishuWebhookActionReceiptResult {
  deliveryId: string;
  eventId: string;
  disposition: 'created' | 'duplicate';
}

export class FeishuWebhookStoreError extends Error {
  constructor(readonly code: 'event_conflict' | 'nonce_replay' | 'persistence_conflict') {
    super(`Feishu webhook receipt rejected: ${code}`);
    this.name = 'FeishuWebhookStoreError';
  }
}

interface ReceiptRow {
  delivery_id: string;
  event_id: string;
  tenant_key: string;
  app_id: string;
  event_type: string;
  event_created_at: string;
  verification_mode: 'encrypted' | 'plaintext';
  request_timestamp: string | null;
  nonce_digest: string | null;
  request_digest: string;
  event_digest: string;
  status: 'accepted';
}

interface NonceRow {
  nonce_id: string;
  event_id: string;
  request_timestamp: string;
  request_digest: string;
}

/** Metadata-only durable receipt. Decrypted event bodies never enter D1. */
export class FeishuWebhookStore {
  constructor(private readonly db: D1Database) {}

  async accept(rawInput: FeishuWebhookReceiptInput): Promise<FeishuWebhookReceiptResult> {
    const result = await this.acceptRoute(rawInput, true);
    if (!('ingressOutboxId' in result)) {
      throw new FeishuWebhookStoreError('persistence_conflict');
    }
    return result;
  }

  /** Card actions keep the verified metadata receipt but never enter Task normalization. */
  async acceptAction(
    rawInput: FeishuWebhookReceiptInput,
  ): Promise<FeishuWebhookActionReceiptResult> {
    const result = await this.acceptRoute(rawInput, false);
    return {
      deliveryId: result.deliveryId,
      eventId: result.eventId,
      disposition: result.disposition,
    };
  }

  private async acceptRoute(
    rawInput: FeishuWebhookReceiptInput,
    createIngress: boolean,
  ): Promise<FeishuWebhookReceiptResult | FeishuWebhookActionReceiptResult> {
    const input = FeishuWebhookReceiptInputSchema.parse(rawInput);
    const identity = await canonicalSha256({
      tenantKey: input.tenantKey,
      eventId: input.eventId,
    });
    const deliveryId = `feishu_webhook_${identity.slice('sha256:'.length, 47)}`;
    const ingressOutboxId = `feishu_ingress_${identity.slice('sha256:'.length, 47)}`;
    const statements: D1PreparedStatement[] = [];
    let nonceId: string | null = null;
    if (input.nonceDigest !== null && input.requestTimestamp !== null) {
      const nonceIdentity = await canonicalSha256({
        tenantKey: input.tenantKey,
        nonceDigest: input.nonceDigest,
      });
      nonceId = `feishu_nonce_${nonceIdentity.slice('sha256:'.length, 47)}`;
      statements.push(this.db.prepare(
        `INSERT INTO feishu_webhook_nonces (
           nonce_id, tenant_key, nonce_digest, event_id, request_timestamp,
           request_digest, received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        nonceId,
        input.tenantKey,
        input.nonceDigest,
        input.eventId,
        input.requestTimestamp,
        input.requestDigest,
        input.receivedAt,
      ));
    }
    const nonceGuard = nonceId === null
      ? ''
      : `AND EXISTS (
           SELECT 1 FROM feishu_webhook_nonces
           WHERE nonce_id = ? AND tenant_key = ? AND nonce_digest = ?
             AND event_id = ? AND request_timestamp = ? AND request_digest = ?
         )`;
    const nonceBindings = nonceId === null
      ? []
      : [
        nonceId,
        input.tenantKey,
        input.nonceDigest,
        input.eventId,
        input.requestTimestamp,
        input.requestDigest,
      ];
    const deliveryResultIndex = statements.length;
    statements.push(this.db.prepare(
      `INSERT INTO feishu_webhook_deliveries (
         delivery_id, event_id, tenant_key, app_id, event_type, event_created_at,
         verification_mode, request_timestamp, nonce_digest, request_digest,
         event_digest, status, received_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?
       WHERE 1 = 1 ${nonceGuard}
       ON CONFLICT DO NOTHING`,
    ).bind(
      deliveryId,
      input.eventId,
      input.tenantKey,
      input.appId,
      input.eventType,
      input.eventCreatedAt,
      input.verificationMode,
      input.requestTimestamp,
      input.nonceDigest,
      input.requestDigest,
      input.eventDigest,
      input.receivedAt,
      ...nonceBindings,
    ));
    if (createIngress) {
      statements.push(this.db.prepare(
        `INSERT INTO feishu_ingress_outbox (
           outbox_id, delivery_id, tenant_key, event_id, event_type, event_digest,
           delivery_state, created_at, updated_at
         )
         SELECT ?, delivery_id, tenant_key, event_id, event_type, event_digest,
                'pending', ?, ?
         FROM feishu_webhook_deliveries
         WHERE delivery_id = ? AND tenant_key = ? AND event_id = ? AND event_digest = ?
         ON CONFLICT DO NOTHING`,
      ).bind(
        ingressOutboxId,
        input.receivedAt,
        input.receivedAt,
        deliveryId,
        input.tenantKey,
        input.eventId,
        input.eventDigest,
      ));
    }
    const results = await this.db.batch(statements);
    const inserted = results[deliveryResultIndex];
    if (inserted === undefined) throw new FeishuWebhookStoreError('persistence_conflict');
    if (inserted.meta.changes === 1) {
      if (createIngress) {
        const outbox = await this.db.prepare(
          `SELECT outbox_id FROM feishu_ingress_outbox
           WHERE delivery_id = ? AND tenant_key = ? AND event_id = ?`,
        ).bind(deliveryId, input.tenantKey, input.eventId).first<{ outbox_id: string }>();
        if (outbox?.outbox_id !== ingressOutboxId) {
          throw new FeishuWebhookStoreError('persistence_conflict');
        }
        return { deliveryId, ingressOutboxId, eventId: input.eventId, disposition: 'created' };
      }
      return { deliveryId, eventId: input.eventId, disposition: 'created' };
    }

    if (nonceId !== null) {
      const nonce = await this.db.prepare(
        `SELECT nonce_id, event_id, request_timestamp, request_digest
         FROM feishu_webhook_nonces WHERE nonce_id = ?`,
      ).bind(nonceId).first<NonceRow>();
      if (
        nonce === null || nonce.event_id !== input.eventId ||
        nonce.request_timestamp !== input.requestTimestamp ||
        nonce.request_digest !== input.requestDigest
      ) throw new FeishuWebhookStoreError('nonce_replay');
    }
    const existing = await this.byEvent(input.tenantKey, input.eventId);
    if (existing !== null) {
      if (!this.matches(existing, input, deliveryId)) {
        throw new FeishuWebhookStoreError('event_conflict');
      }
      if (createIngress) {
        const outbox = await this.db.prepare(
          `SELECT outbox_id FROM feishu_ingress_outbox
           WHERE delivery_id = ? AND tenant_key = ? AND event_id = ?`,
        ).bind(deliveryId, input.tenantKey, input.eventId).first<{ outbox_id: string }>();
        if (outbox?.outbox_id !== ingressOutboxId) {
          throw new FeishuWebhookStoreError('persistence_conflict');
        }
        return { deliveryId, ingressOutboxId, eventId: input.eventId, disposition: 'duplicate' };
      }
      return { deliveryId, eventId: input.eventId, disposition: 'duplicate' };
    }
    throw new FeishuWebhookStoreError('persistence_conflict');
  }

  private async byEvent(tenantKey: string, eventId: string): Promise<ReceiptRow | null> {
    return await this.db.prepare(
      `SELECT delivery_id, event_id, tenant_key, app_id, event_type,
              event_created_at, verification_mode, request_timestamp, nonce_digest,
              request_digest, event_digest, status
       FROM feishu_webhook_deliveries WHERE tenant_key = ? AND event_id = ?`,
    ).bind(tenantKey, eventId).first<ReceiptRow>();
  }

  private matches(
    row: ReceiptRow,
    input: FeishuWebhookReceiptInput,
    deliveryId: string,
  ): boolean {
    return row.delivery_id === deliveryId && row.event_id === input.eventId &&
      row.tenant_key === input.tenantKey && row.app_id === input.appId &&
      row.event_type === input.eventType && row.event_created_at === input.eventCreatedAt &&
      row.verification_mode === input.verificationMode && row.event_digest === input.eventDigest &&
      row.status === 'accepted';
  }
}
