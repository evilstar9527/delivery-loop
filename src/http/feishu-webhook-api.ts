import { Hono } from 'hono';
import { z } from 'zod';
import { canonicalSha256, sha256Bytes } from '../domain/digest.js';
import { decodeFeishuCardAction } from '../domain/feishu-card-action.js';
import type { Bindings } from '../env.js';
import { secureStructuredLogSink } from '../observability/structured-log.js';
import { configuredSecrets } from '../security/runtime-secrets.js';
import {
  extractFeishuChallenge,
  verifyAndExtractFeishuWebhook,
} from '../feishu/webhook-verifier.js';
import {
  FeishuCardActionError,
  FeishuCardActionStore,
} from '../storage/feishu-card-action-store.js';
import {
  FeishuWebhookStore,
  FeishuWebhookStoreError,
} from '../storage/feishu-webhook-store.js';
import { errorResponse } from './errors.js';

const MAX_REQUEST_BYTES = 256 * 1024;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const TENANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const APP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const EVENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const FeishuEventEnvelopeSchema = z.object({
  schema: z.string().max(20).optional(),
  header: z.object({
    event_id: z.string().regex(EVENT_ID_PATTERN),
    event_type: z.string().regex(EVENT_TYPE_PATTERN),
    create_time: z.string().regex(/^[0-9]{13}$/),
    token: z.string().min(1).max(2_048).optional(),
    app_id: z.string().regex(APP_PATTERN),
    tenant_key: z.string().regex(TENANT_PATTERN),
  }).passthrough(),
  event: z.record(z.string(), z.unknown()),
}).passthrough();

function lowerHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

function configured(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function validSecret(value: string | undefined): boolean {
  return value === undefined || (
    value.length > 0 && value.length <= 2_048 &&
    !value.includes('\0') && !value.includes('\r') && !value.includes('\n')
  );
}

function eventConfiguration(env: Bindings): {
  appId: string;
  tenantKey: string;
  encryptKey?: string;
  verificationToken?: string;
} | null {
  if (
    !configured(env.FEISHU_APP_ID) || !APP_PATTERN.test(env.FEISHU_APP_ID) ||
    !configured(env.FEISHU_DELIVERY_TENANT_KEY) ||
    !TENANT_PATTERN.test(env.FEISHU_DELIVERY_TENANT_KEY) ||
    !validSecret(env.FEISHU_EVENT_ENCRYPT_KEY) ||
    !validSecret(env.FEISHU_EVENT_VERIFICATION_TOKEN)
  ) return null;
  const hasEncryptKey = configured(env.FEISHU_EVENT_ENCRYPT_KEY);
  const hasVerificationToken = configured(env.FEISHU_EVENT_VERIFICATION_TOKEN);
  if (!hasEncryptKey && !hasVerificationToken) return null;
  return {
    appId: env.FEISHU_APP_ID,
    tenantKey: env.FEISHU_DELIVERY_TENANT_KEY,
    ...(hasEncryptKey ? { encryptKey: env.FEISHU_EVENT_ENCRYPT_KEY } : {}),
    ...(hasVerificationToken ? { verificationToken: env.FEISHU_EVENT_VERIFICATION_TOKEN } : {}),
  };
}

function verificationResponse(
  c: Parameters<typeof errorResponse>[0],
  code: string,
): Response {
  if (code === 'configuration_invalid') {
    return errorResponse(c, 503, 'unavailable', 'Feishu webhook verification unavailable', true);
  }
  if (
    code === 'signature_headers_missing' || code === 'timestamp_invalid' ||
    code === 'signature_invalid' || code === 'token_invalid'
  ) return errorResponse(c, 401, 'unauthenticated', 'Feishu webhook verification failed', false);
  return errorResponse(c, 400, 'invalid_argument', 'invalid Feishu webhook payload', false);
}

type ObservedWebhookCase =
  | {
    case: 'challenge';
    outcome: 'challenge_echoed';
  }
  | {
    case: 'event';
    outcome: 'event_accepted';
    eventId: string;
    eventType: string;
    deliveryId: string;
  }
  | {
    case: 'invalid_signature';
    outcome: 'signature_invalid';
  }
  | {
    case: 'expired_timestamp';
    outcome: 'timestamp_invalid';
  }
  | {
    case: 'wrong_tenant';
    outcome: 'binding_rejected';
    eventId: string;
    eventType: string;
  }
  | {
    case: 'card_action';
    outcome: 'action_applied';
    eventId: string;
    eventType: 'card.action.trigger';
    deliveryId: string;
    operatorDigest: string;
    actionReceiptId: string;
    command: string;
    effect: string;
    resultKind: string;
    resultId: string;
  }
  | {
    case: 'card_action';
    outcome: 'action_rejected';
    eventId: string;
    eventType: 'card.action.trigger';
    deliveryId: string;
    operatorDigest: string | null;
    reasonCode: string;
  };

function cardActionErrorResponse(
  c: Parameters<typeof errorResponse>[0],
  error: FeishuCardActionError,
): Response {
  if (error.code === 'invalid_request' || error.code === 'context_required') {
    return errorResponse(c, 400, 'invalid_argument', 'invalid Feishu card action', false);
  }
  if (
    error.code === 'identity_unresolved' || error.code === 'actor_not_human' ||
    error.code === 'actor_not_authorized' || error.code === 'self_approval_denied' ||
    error.code === 'secret_detected' || error.code === 'binding_conflict'
  ) return errorResponse(c, 403, 'policy_denied', 'Feishu card action rejected', false);
  return errorResponse(c, 409, 'conflict', 'Feishu card action state changed', false);
}

async function operatorDigest(raw: unknown): Promise<string | null> {
  if (typeof raw !== 'object' || raw === null || !('event' in raw)) return null;
  const event = raw.event;
  if (typeof event !== 'object' || event === null || !('operator' in event)) return null;
  const operator = event.operator;
  if (typeof operator !== 'object' || operator === null || !('open_id' in operator)) return null;
  return typeof operator.open_id === 'string' ? await canonicalSha256(operator.open_id) : null;
}

async function observedResponse(
  c: Parameters<typeof errorResponse>[0],
  startedAtMs: number,
  requestDigest: string,
  observation: ObservedWebhookCase,
  response: Response,
): Promise<Response> {
  const completedAtMs = Date.now();
  const responseDigest = await sha256Bytes(await response.clone().arrayBuffer());
  secureStructuredLogSink({
    component: 'feishu_webhook',
    secrets: configuredSecrets(c.env),
  })({
    schemaVersion: '1',
    event: 'feishu_webhook_request_observed',
    ...observation,
    requestDigest,
    responseDigest,
    statusCode: response.status,
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    latencyMs: completedAtMs - startedAtMs,
  });
  return response;
}

export function feishuWebhookApi(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();

  app.post('/v1/webhooks/feishu', async (c) => {
    const startedAtMs = Date.now();
    const configuration = eventConfiguration(c.env);
    if (configuration === null) {
      return errorResponse(c, 503, 'unavailable', 'Feishu webhook is not configured', true);
    }
    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 400, 'invalid_argument', 'invalid Feishu webhook content type', false);
    }
    let rawBody: string;
    try {
      rawBody = await c.req.text();
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid Feishu webhook payload', false);
    }
    if (new TextEncoder().encode(rawBody).length > MAX_REQUEST_BYTES) {
      return errorResponse(c, 413, 'invalid_argument', 'Feishu webhook payload is too large', false);
    }
    const requestDigest = await canonicalSha256(rawBody);
    const verified = await verifyAndExtractFeishuWebhook(
      { headers: lowerHeaders(c.req.raw.headers), body: rawBody },
      {
        ...(configuration.encryptKey === undefined
          ? {}
          : { encryptKey: configuration.encryptKey }),
        ...(configuration.verificationToken === undefined
          ? {}
          : { verificationToken: configuration.verificationToken }),
      },
    );
    if (!verified.ok) {
      const response = verificationResponse(c, verified.code);
      if (verified.code === 'signature_invalid') {
        return await observedResponse(c, startedAtMs, requestDigest, {
          case: 'invalid_signature',
          outcome: 'signature_invalid',
        }, response);
      }
      if (verified.code === 'timestamp_invalid') {
        return await observedResponse(c, startedAtMs, requestDigest, {
          case: 'expired_timestamp',
          outcome: 'timestamp_invalid',
        }, response);
      }
      return response;
    }

    const challenge = extractFeishuChallenge(verified.payload);
    if (challenge !== undefined) {
      c.header('cache-control', 'no-store');
      return await observedResponse(c, startedAtMs, requestDigest, {
        case: 'challenge',
        outcome: 'challenge_echoed',
      }, c.json({ challenge }));
    }
    const parsed = FeishuEventEnvelopeSchema.safeParse(verified.payload);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid Feishu event envelope', false);
    }
    if (
      parsed.data.header.tenant_key !== configuration.tenantKey ||
      parsed.data.header.app_id !== configuration.appId
    ) {
      return await observedResponse(c, startedAtMs, requestDigest, {
        case: 'wrong_tenant',
        outcome: 'binding_rejected',
        eventId: parsed.data.header.event_id,
        eventType: parsed.data.header.event_type,
      }, errorResponse(c, 403, 'policy_denied', 'Feishu event binding rejected', false));
    }

    const createdAtMs = Number(parsed.data.header.create_time);
    if (!Number.isSafeInteger(createdAtMs) || createdAtMs <= 0) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid Feishu event time', false);
    }
    const eventCreatedAt = new Date(createdAtMs).toISOString();
    if (verified.mode === 'plaintext' && Math.abs(Date.now() - createdAtMs) > 300_000) {
      return errorResponse(c, 401, 'unauthenticated', 'Feishu event timestamp expired', false);
    }
    const requestTimestamp = verified.requestTimestamp === undefined
      ? null
      : new Date(Number(verified.requestTimestamp) * 1_000).toISOString();
    const nonceDigest = verified.nonce === undefined
      ? null
      : await canonicalSha256(verified.nonce);
    const receivedAt = new Date().toISOString();
    const eventDigest = await canonicalSha256(parsed.data);
    try {
      const receiptInput = {
        eventId: parsed.data.header.event_id,
        tenantKey: parsed.data.header.tenant_key,
        appId: parsed.data.header.app_id,
        eventType: parsed.data.header.event_type,
        eventCreatedAt,
        verificationMode: verified.mode,
        requestTimestamp,
        nonceDigest,
        requestDigest,
        eventDigest,
        receivedAt,
      } as const;
      if (parsed.data.header.event_type === 'card.action.trigger') {
        // A verified action first receives a metadata-only delivery receipt. This
        // preserves evidence for malformed/forwarded/stale callbacks without ever
        // sending card actions to Task normalization.
        const receipt = await new FeishuWebhookStore(c.env.DB_CONTROL).acceptAction(receiptInput);
        const observedOperatorDigest = await operatorDigest(parsed.data);
        const decoded = decodeFeishuCardAction(parsed.data);
        if (!decoded.ok) {
          return await observedResponse(c, startedAtMs, requestDigest, {
            case: 'card_action',
            outcome: 'action_rejected',
            eventId: receipt.eventId,
            eventType: 'card.action.trigger',
            deliveryId: receipt.deliveryId,
            operatorDigest: observedOperatorDigest,
            reasonCode: 'invalid_request',
          }, errorResponse(c, 400, 'invalid_argument', 'invalid Feishu card action', false));
        }
        if (
          !configured(c.env.FEISHU_DELIVERY_CHAT_ID) ||
          decoded.action.chatId !== c.env.FEISHU_DELIVERY_CHAT_ID
        ) return await observedResponse(c, startedAtMs, requestDigest, {
          case: 'card_action',
          outcome: 'action_rejected',
          eventId: receipt.eventId,
          eventType: 'card.action.trigger',
          deliveryId: receipt.deliveryId,
          operatorDigest: observedOperatorDigest,
          reasonCode: 'binding_conflict',
        }, errorResponse(c, 403, 'policy_denied', 'Feishu card action binding rejected', false));
        try {
          const secrets = configuredSecrets(c.env);
          const action = await new FeishuCardActionStore(
            c.env.DB_CONTROL,
            c.env.TASK_OBJECTS,
            c.env.CHECKPOINT_OBJECTS,
            { secrets },
          ).execute({
            deliveryId: receipt.deliveryId,
            tenantKey: configuration.tenantKey,
            appId: configuration.appId,
            eventDigest,
            receivedAt,
            action: decoded.action,
          });
          c.header('cache-control', 'no-store');
          const safeAction = {
            actionReceiptId: action.actionReceiptId,
            command: action.command,
            effect: action.effect,
            resultKind: action.resultKind,
            resultId: action.resultId,
          };
          return await observedResponse(c, startedAtMs, requestDigest, {
            case: 'card_action',
            outcome: 'action_applied',
            eventId: receipt.eventId,
            eventType: 'card.action.trigger',
            deliveryId: receipt.deliveryId,
            operatorDigest: observedOperatorDigest ?? await canonicalSha256(
              decoded.action.operatorOpenId,
            ),
            actionReceiptId: action.actionReceiptId,
            command: action.command,
            effect: action.effect,
            resultKind: action.resultKind,
            resultId: action.resultId,
          }, c.json({ accepted: true, eventId: receipt.eventId, action: safeAction }));
        } catch (error) {
          if (!(error instanceof FeishuCardActionError)) throw error;
          return await observedResponse(c, startedAtMs, requestDigest, {
            case: 'card_action',
            outcome: 'action_rejected',
            eventId: receipt.eventId,
            eventType: 'card.action.trigger',
            deliveryId: receipt.deliveryId,
            operatorDigest: observedOperatorDigest,
            reasonCode: error.code,
          }, cardActionErrorResponse(c, error));
        }
      }
      const result = await new FeishuWebhookStore(c.env.DB_CONTROL).accept(receiptInput);
      c.header('cache-control', 'no-store');
      return await observedResponse(c, startedAtMs, requestDigest, {
        case: 'event',
        outcome: 'event_accepted',
        eventId: result.eventId,
        eventType: parsed.data.header.event_type,
        deliveryId: result.deliveryId,
      }, c.json({ accepted: true, eventId: result.eventId, disposition: result.disposition }));
    } catch (error) {
      if (error instanceof FeishuWebhookStoreError) {
        return errorResponse(c, 409, 'conflict', 'Feishu webhook replay conflict', false);
      }
      throw error;
    }
  });

  return app;
}
