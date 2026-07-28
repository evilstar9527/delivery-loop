import {
  constantTimeEqual,
  decryptFeishuPayload,
  verifyFeishuSignature,
} from './webhook-crypto.js';

const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/;
const TIMESTAMP_PATTERN = /^[0-9]{10}$/;
const MAX_NONCE_LENGTH = 512;
const MAX_ENCRYPTED_VALUE_LENGTH = 2 * 1024 * 1024;
const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 300;

export interface RawFeishuWebhook {
  headers: Record<string, string>;
  body: string;
}

export interface FeishuWebhookVerifyConfig {
  encryptKey?: string;
  verificationToken?: string;
  now?: () => number;
  maxClockSkewSeconds?: number;
}

export type FeishuWebhookVerificationErrorCode =
  | 'configuration_invalid'
  | 'body_invalid'
  | 'signature_headers_missing'
  | 'timestamp_invalid'
  | 'signature_invalid'
  | 'encrypted_payload_invalid'
  | 'decrypt_failed'
  | 'token_invalid';

export type FeishuWebhookVerificationResult =
  | {
    ok: true;
    mode: 'encrypted' | 'plaintext';
    payload: Record<string, unknown>;
    requestTimestamp?: string;
    nonce?: string;
  }
  | { ok: false; code: FeishuWebhookVerificationErrorCode };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeJson(value: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function configured(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && value.length <= 2_048 &&
    !value.includes('\0') && !value.includes('\r') && !value.includes('\n');
}

function payloadToken(payload: Record<string, unknown>): string | null {
  if (typeof payload.token === 'string') return payload.token;
  const header = record(payload.header);
  return typeof header?.token === 'string' ? header.token : null;
}

function tokenMatches(payload: Record<string, unknown>, expected: string | undefined): boolean {
  if (!configured(expected)) return false;
  const actual = payloadToken(payload);
  return actual !== null && constantTimeEqual(actual, expected);
}

function freshTimestamp(
  raw: string,
  now: () => number,
  maxClockSkewSeconds: number,
): boolean {
  if (!TIMESTAMP_PATTERN.test(raw)) return false;
  const timestamp = Number(raw);
  return Number.isSafeInteger(timestamp) && Math.abs(now() - timestamp) <= maxClockSkewSeconds;
}

/**
 * Watt's verify/decrypt flow with delivery-loop hardening: verification cannot
 * be disabled, encrypted requests have a bounded timestamp, and a configured
 * verification token is checked after decryption as a second source binding.
 */
export async function verifyAndExtractFeishuWebhook(
  raw: RawFeishuWebhook,
  config: FeishuWebhookVerifyConfig,
): Promise<FeishuWebhookVerificationResult> {
  if (!configured(config.encryptKey) && !configured(config.verificationToken)) {
    return { ok: false, code: 'configuration_invalid' };
  }
  const outer = safeJson(raw.body);
  if (outer === null) return { ok: false, code: 'body_invalid' };

  if (configured(config.encryptKey)) {
    const encryptKey = config.encryptKey;
    const signature = raw.headers['x-lark-signature'];
    const timestamp = raw.headers['x-lark-request-timestamp'];
    const nonce = raw.headers['x-lark-request-nonce'];
    if (
      signature === undefined || timestamp === undefined || nonce === undefined ||
      nonce.length < 1 || nonce.length > MAX_NONCE_LENGTH
    ) return { ok: false, code: 'signature_headers_missing' };
    const now = config.now ?? (() => Math.floor(Date.now() / 1_000));
    const maxClockSkewSeconds = config.maxClockSkewSeconds ?? DEFAULT_MAX_CLOCK_SKEW_SECONDS;
    if (
      !Number.isSafeInteger(maxClockSkewSeconds) || maxClockSkewSeconds < 1 ||
      maxClockSkewSeconds > 3_600 || !freshTimestamp(timestamp, now, maxClockSkewSeconds)
    ) return { ok: false, code: 'timestamp_invalid' };
    if (!SIGNATURE_PATTERN.test(signature)) {
      return { ok: false, code: 'signature_invalid' };
    }
    if (!await verifyFeishuSignature({ timestamp, nonce, body: raw.body, signature }, encryptKey)) {
      return { ok: false, code: 'signature_invalid' };
    }
    const encrypted = outer.encrypt;
    if (
      typeof encrypted !== 'string' || encrypted.length < 1 ||
      encrypted.length > MAX_ENCRYPTED_VALUE_LENGTH
    ) return { ok: false, code: 'encrypted_payload_invalid' };
    let plaintext: string;
    try {
      plaintext = await decryptFeishuPayload(encrypted, encryptKey);
    } catch {
      return { ok: false, code: 'decrypt_failed' };
    }
    const payload = safeJson(plaintext);
    if (payload === null) return { ok: false, code: 'body_invalid' };
    if (configured(config.verificationToken) && !tokenMatches(payload, config.verificationToken)) {
      return { ok: false, code: 'token_invalid' };
    }
    return { ok: true, mode: 'encrypted', payload, requestTimestamp: timestamp, nonce };
  }

  if (!tokenMatches(outer, config.verificationToken)) {
    return { ok: false, code: 'token_invalid' };
  }
  return { ok: true, mode: 'plaintext', payload: outer };
}

export function extractFeishuChallenge(payload: Record<string, unknown>): string | undefined {
  if (
    payload.type === 'url_verification' && typeof payload.challenge === 'string' &&
    payload.challenge.length >= 1 && payload.challenge.length <= 512 &&
    !payload.challenge.includes('\0')
  ) return payload.challenge;
  return undefined;
}
