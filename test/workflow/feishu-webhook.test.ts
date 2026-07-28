/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeFeishuSignature } from '../../src/feishu/webhook-crypto.js';

const BASE_URL = 'https://delivery-loop.test';
const ENCRYPT_KEY = 'test-feishu-event-encrypt-key';
const VERIFICATION_TOKEN = 'test-feishu-event-verification-token';
const TENANT_KEY = 'test-feishu-tenant';
const APP_ID = 'cli_test_delivery_loop';
const OPERATIONS_AUTHORIZATION = 'Bearer test-operations-token';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function encryptPayload(payload: unknown, keyValue = ENCRYPT_KEY): Promise<string> {
  const encoder = new TextEncoder();
  const keyBytes = await crypto.subtle.digest('SHA-256', encoder.encode(keyValue));
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-CBC' },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv },
    key,
    encoder.encode(JSON.stringify(payload)),
  ));
  const complete = new Uint8Array(iv.length + ciphertext.length);
  complete.set(iv);
  complete.set(ciphertext, iv.length);
  return bytesToBase64(complete);
}

async function requestFor(
  payload: unknown,
  options: { timestamp?: number; nonce?: string; signature?: string } = {},
): Promise<{
  url: string;
  init: { method: 'POST'; headers: Record<string, string>; body: string };
}> {
  const body = JSON.stringify({ encrypt: await encryptPayload(payload) });
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1_000));
  const nonce = options.nonce ?? crypto.randomUUID();
  const signature = options.signature ?? await computeFeishuSignature(
    timestamp,
    nonce,
    ENCRYPT_KEY,
    body,
  );
  return {
    url: `${BASE_URL}/v1/webhooks/feishu`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lark-request-timestamp': timestamp,
        'x-lark-request-nonce': nonce,
        'x-lark-signature': signature,
      },
      body,
    },
  };
}

async function fetchRequest(request: Awaited<ReturnType<typeof requestFor>>): Promise<Response> {
  return await SELF.fetch(request.url, request.init);
}

function eventPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      event_id: 'event-feishu-message-1',
      event_type: 'im.message.receive_v1',
      create_time: String(Date.now()),
      token: VERIFICATION_TOKEN,
      app_id: APP_ID,
      tenant_key: TENANT_KEY,
      ...((overrides.header as Record<string, unknown> | undefined) ?? {}),
    },
    event: {
      sender: { sender_id: { open_id: 'ou_test_sender' } },
      message: {
        chat_id: 'oc_test_chat',
        content: '{"text":"CANARY_UNTRUSTED_FEISHU_MESSAGE"}',
      },
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'header')),
  };
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM feishu_ingress_queue_observations'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_ingress_outbox'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_webhook_nonces'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_webhook_deliveries'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
}

async function businessCounts(): Promise<Record<string, number>> {
  const results = await env.DB_CONTROL.batch<{
    count: number;
  }>([
    env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM feishu_ingress_outbox'),
    env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM feishu_webhook_nonces'),
    env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM feishu_webhook_deliveries'),
    env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM tasks'),
    env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM runs'),
    env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM outbox'),
  ]);
  return {
    ingress: results[0]?.results[0]?.count ?? -1,
    nonces: results[1]?.results[0]?.count ?? -1,
    deliveries: results[2]?.results[0]?.count ?? -1,
    tasks: results[3]?.results[0]?.count ?? -1,
    runs: results[4]?.results[0]?.count ?? -1,
    outbox: results[5]?.results[0]?.count ?? -1,
  };
}

async function evidenceProjection(tenantKey: string, eventId: string): Promise<Response> {
  const query = new URLSearchParams({ tenantKey, eventId });
  return await SELF.fetch(`${BASE_URL}/v1/operations/feishu-webhook/evidence?${query}`, {
    headers: { authorization: OPERATIONS_AUTHORIZATION },
  });
}

beforeEach(async () => {
  await reset();
});

describe('Feishu encrypted webhook contract', () => {
  it('echoes an authenticated url_verification challenge without a D1 business write', async () => {
    const response = await fetchRequest(await requestFor({
      type: 'url_verification',
      challenge: 'challenge-delivery-loop',
      token: VERIFICATION_TOKEN,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: 'challenge-delivery-loop' });
    expect(await businessCounts()).toEqual({
      ingress: 0, nonces: 0, deliveries: 0, tasks: 0, runs: 0, outbox: 0,
    });
  });

  it('accepts one signed, decrypted, exact-tenant event and stores metadata only', async () => {
    const payload = eventPayload();
    const request = await requestFor(payload, { nonce: 'nonce-feishu-valid-1' });
    const first = await fetchRequest(request);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      accepted: true,
      eventId: 'event-feishu-message-1',
      disposition: 'created',
    });
    const duplicate = await fetchRequest(request);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ disposition: 'duplicate' });
    const redelivered = await fetchRequest(await requestFor(payload, {
      nonce: 'nonce-feishu-valid-2',
    }));
    expect(redelivered.status).toBe(200);
    expect(await redelivered.json()).toMatchObject({ disposition: 'duplicate' });

    const row = await env.DB_CONTROL.prepare(
      `SELECT event_id, tenant_key, app_id, event_type, verification_mode, status,
              request_digest, event_digest, nonce_digest
       FROM feishu_webhook_deliveries`,
    ).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      event_id: 'event-feishu-message-1',
      tenant_key: TENANT_KEY,
      app_id: APP_ID,
      event_type: 'im.message.receive_v1',
      verification_mode: 'encrypted',
      status: 'accepted',
    });
    expect(row?.request_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(row?.event_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(row?.nonce_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain('CANARY_UNTRUSTED_FEISHU_MESSAGE');
    expect(JSON.stringify(row)).not.toContain(ENCRYPT_KEY);
    expect(JSON.stringify(row)).not.toContain(VERIFICATION_TOKEN);
    expect(await businessCounts()).toEqual({
      ingress: 1, nonces: 2, deliveries: 1, tasks: 0, runs: 0, outbox: 0,
    });
  });

  it('rejects wrong signature, stale timestamp, wrong tenant/app/token before any write', async () => {
    const now = Math.floor(Date.now() / 1_000);
    const cases = [
      [await requestFor(eventPayload(), { signature: '0'.repeat(64) }), 401],
      [await requestFor(eventPayload(), { timestamp: now - 301 }), 401],
      [await requestFor(eventPayload({ header: { tenant_key: 'other-tenant' } })), 403],
      [await requestFor(eventPayload({ header: { app_id: 'cli_other_app' } })), 403],
      [await requestFor(eventPayload({ header: { token: 'wrong-token' } })), 401],
    ] as const;
    for (const [request, status] of cases) {
      await reset();
      const response = await fetchRequest(request);
      expect(response.status).toBe(status);
      expect(await businessCounts()).toEqual({
        ingress: 0, nonces: 0, deliveries: 0, tasks: 0, runs: 0, outbox: 0,
      });
    }
  });

  it('rejects nonce reuse across different event identities', async () => {
    const nonce = 'nonce-feishu-replay-1';
    expect((await fetchRequest(await requestFor(eventPayload(), { nonce }))).status).toBe(200);
    const second = await fetchRequest(await requestFor(eventPayload({
      header: { event_id: 'event-feishu-message-2' },
    }), { nonce }));
    expect(second.status).toBe(409);
    expect(await businessCounts()).toEqual({
      ingress: 1, nonces: 1, deliveries: 1, tasks: 0, runs: 0, outbox: 0,
    });
  });

  it('exposes only an authenticated exact-event evidence projection', async () => {
    const eventId = 'event-feishu-evidence-positive';
    const unauthenticated = await SELF.fetch(
      `${BASE_URL}/v1/operations/feishu-webhook/evidence?tenantKey=${TENANT_KEY}&eventId=${eventId}`,
    );
    expect(unauthenticated.status).toBe(401);
    const invalid = await SELF.fetch(
      `${BASE_URL}/v1/operations/feishu-webhook/evidence?tenantKey=${TENANT_KEY}`,
      { headers: { authorization: OPERATIONS_AUTHORIZATION } },
    );
    expect(invalid.status).toBe(400);

    const before = await evidenceProjection(TENANT_KEY, eventId);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({
      schemaVersion: '1',
      tenantKey: TENANT_KEY,
      eventId,
      counts: {
        deliveries: 0, nonces: 0, ingressOutboxes: 0, tasks: 0, runs: 0, outboxEffects: 0,
      },
      delivery: null,
      ingress: null,
    });

    const accepted = await fetchRequest(await requestFor(eventPayload({
      header: { event_id: eventId },
    }), { nonce: 'nonce-feishu-evidence-positive' }));
    expect(accepted.status).toBe(200);
    const projection = await evidenceProjection(TENANT_KEY, eventId);
    expect(projection.status).toBe(200);
    const body = await projection.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      schemaVersion: '1',
      tenantKey: TENANT_KEY,
      eventId,
      counts: {
        deliveries: 1, nonces: 1, ingressOutboxes: 1, tasks: 0, runs: 0, outboxEffects: 0,
      },
      delivery: {
        appId: APP_ID,
        eventType: 'im.message.receive_v1',
        verificationMode: 'encrypted',
        status: 'accepted',
      },
      ingress: {
        eventType: 'im.message.receive_v1',
        deliveryState: 'pending',
        taskId: null,
        runId: null,
      },
    });
    expect(JSON.stringify(body)).not.toContain('CANARY_UNTRUSTED_FEISHU_MESSAGE');
    expect(JSON.stringify(body)).not.toContain(ENCRYPT_KEY);
    expect(JSON.stringify(body)).not.toContain(VERIFICATION_TOKEN);

    const rejectedEventId = 'event-feishu-evidence-rejected';
    const rejected = await fetchRequest(await requestFor(eventPayload({
      header: { event_id: rejectedEventId },
    }), { signature: '0'.repeat(64) }));
    expect(rejected.status).toBe(401);
    const rejectedProjection = await evidenceProjection(TENANT_KEY, rejectedEventId);
    expect(await rejectedProjection.json()).toMatchObject({
      counts: {
        deliveries: 0, nonces: 0, ingressOutboxes: 0, tasks: 0, runs: 0, outboxEffects: 0,
      },
      delivery: null,
      ingress: null,
    });
  });
});
