import { describe, expect, it } from 'vitest';
import {
  renderFeishuDeliveryCard,
  safeFeishuDeliveryUrl,
  type FeishuDeliveryCardPresentation,
} from '../src/domain/feishu-delivery-card.js';
import {
  FeishuDeliveryCardApiClient,
  memoryTokenCache,
  type FeishuDeliveryCardUnavailableError,
} from '../src/outbox/feishu-delivery-card.js';
import { projectFeishuDeliveryFacts } from '../src/reconciliation/feishu-delivery-card-reconciler.js';

const PRESENTATION: FeishuDeliveryCardPresentation = {
  schemaVersion: '1',
  cardId: 'feishu_card_run_delivery',
  presentationId: 'feishu_presentation_delivery_1',
  runId: 'run-delivery-card',
  runVersion: 12,
  pr: {
    status: 'open',
    url: 'https://github.com/example/delivery-loop/pull/42',
  },
  merge: {
    status: 'merged',
    url: 'https://github.com/example/delivery-loop/pull/42',
  },
  testDeploy: {
    status: 'succeeded',
    url: 'https://deployments.example.test/test/42',
  },
  productionDeploy: {
    status: 'not_started',
    url: null,
  },
};

describe('Feishu delivery card safe renderer', () => {
  it('renders four independent statuses and only their verified HTTPS links', () => {
    const card = renderFeishuDeliveryCard(PRESENTATION);
    const encoded = JSON.stringify(card);

    expect(card.config).toEqual({ wide_screen_mode: true, update_multi: true });
    expect(card.elements).toHaveLength(4);
    expect(encoded).toContain('PR');
    expect(encoded).toContain('Merge');
    expect(encoded).toContain('Test Deploy');
    expect(encoded).toContain('Production Deploy');
    expect(encoded).toContain('https://github.com/example/delivery-loop/pull/42');
    expect(encoded).toContain('https://deployments.example.test/test/42');
  });

  it('rejects non-HTTPS, credential-bearing, markdown-breaking, and oversized URLs', () => {
    expect(safeFeishuDeliveryUrl('http://example.test/run/1')).toBeNull();
    expect(safeFeishuDeliveryUrl('https://user:pass@example.test/run/1')).toBeNull();
    expect(safeFeishuDeliveryUrl('https://example.test/run/(secret)')).toBeNull();
    expect(safeFeishuDeliveryUrl(`https://example.test/${'a'.repeat(2_100)}`)).toBeNull();
    expect(safeFeishuDeliveryUrl('https://example.test/run/1')).toBe(
      'https://example.test/run/1',
    );
  });

  it('projects links only from verified external facts and keeps all four states separate', () => {
    const projected = projectFeishuDeliveryFacts({
      pr: {
        status: 'created_unverified',
        url: 'https://github.com/example/delivery-loop/pull/CANARY_UNVERIFIED',
      },
      mergeDecisionObserved: true,
      mergeObserved: false,
      testDeploy: {
        status: 'created_unverified',
        url: 'https://deployments.example.test/CANARY_UNVERIFIED',
        observationVersion: 0,
      },
      productionDeploy: {
        status: 'succeeded',
        url: 'https://deployments.example.test/production/42',
        observationVersion: 2,
      },
    });

    expect(projected).toEqual({
      pr: { status: 'publishing', url: null },
      merge: { status: 'ready', url: null },
      testDeploy: { status: 'verifying', url: null },
      productionDeploy: {
        status: 'succeeded',
        url: 'https://deployments.example.test/production/42',
      },
    });
  });
});

describe('Feishu delivery card REST adapter', () => {
  it('reuses Watt token caching and uuid semantics for create, then PATCHes the same card', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = new FeishuDeliveryCardApiClient({
      appId: 'test-app-id',
      appSecret: 'CANARY_APP_SECRET',
      baseUrl: 'https://open.feishu.test',
      cache: memoryTokenCache(),
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/tenant_access_token/internal')) {
          return Response.json({
            code: 0,
            tenant_access_token: 'CANARY_TENANT_TOKEN',
            expire: 7_200,
          });
        }
        if (init?.method === 'POST') {
          return Response.json({ code: 0, data: { message_id: 'om_delivery_card_1' } });
        }
        return Response.json({ code: 0, data: {} });
      },
    });
    const card = renderFeishuDeliveryCard(PRESENTATION);

    await expect(client.createCard({
      chatId: 'oc_delivery_status',
      dedupeId: 'feishu_delivery_card_revision_1',
      card,
    })).resolves.toEqual({ disposition: 'created', messageId: 'om_delivery_card_1' });
    await expect(client.updateCard({
      messageId: 'om_delivery_card_1',
      card,
    })).resolves.toEqual({ disposition: 'updated' });

    expect(calls).toHaveLength(3);
    expect(calls[1]!.url).toBe(
      'https://open.feishu.test/open-apis/im/v1/messages?receive_id_type=chat_id',
    );
    expect(calls[2]!.url).toBe(
      'https://open.feishu.test/open-apis/im/v1/messages/om_delivery_card_1',
    );
    const created = JSON.parse(String(calls[1]!.init?.body)) as Record<string, unknown>;
    expect(created).toMatchObject({
      receive_id: 'oc_delivery_status',
      msg_type: 'interactive',
      uuid: 'feishu_delivery_card_revision_1',
    });
    expect(JSON.parse(String(created.content))).toMatchObject({
      config: { wide_screen_mode: true, update_multi: true },
    });
    expect(calls[2]!.init?.method).toBe('PATCH');
    expect(new Headers(calls[2]!.init?.headers).get('authorization')).toBe(
      'Bearer CANARY_TENANT_TOKEN',
    );
  });

  it('drops an invalid cached token and never propagates raw Feishu response text', async () => {
    const cache = memoryTokenCache();
    await cache.put('feishu:tenant_access_token', 'CANARY_INVALID_TOKEN', 7_200);
    const rawCanary = 'CANARY_RAW_FEISHU_ERROR';
    const client = new FeishuDeliveryCardApiClient({
      appId: 'test-app-id',
      appSecret: 'CANARY_APP_SECRET',
      baseUrl: 'https://open.feishu.test',
      cache,
      fetch: async () => Response.json({ code: 99991661, msg: rawCanary }),
    });

    const operation = client.createCard({
      chatId: 'oc_delivery_status',
      dedupeId: 'feishu_delivery_card_revision_2',
      card: renderFeishuDeliveryCard(PRESENTATION),
    });
    await expect(operation).rejects.toMatchObject({
      code: 'feishu_token_invalid',
    } satisfies Partial<FeishuDeliveryCardUnavailableError>);
    await expect(operation).rejects.not.toThrow(rawCanary);
    await expect(cache.get('feishu:tenant_access_token')).resolves.toBeNull();
  });

  it('classifies rate limits as retryable, expired PATCHes as recreate, and business rejects as terminal', async () => {
    const responses = [
      { code: 230020, msg: 'CANARY_RATE_LIMIT' },
      { code: 230031, msg: 'CANARY_EXPIRED' },
      { code: 230001, msg: 'CANARY_REJECTED' },
    ];
    const cache = memoryTokenCache();
    await cache.put('feishu:tenant_access_token', 'tenant-token', 7_200);
    const client = new FeishuDeliveryCardApiClient({
      appId: 'test-app-id',
      appSecret: 'CANARY_APP_SECRET',
      baseUrl: 'https://open.feishu.test',
      cache,
      fetch: async () => Response.json(responses.shift()),
    });
    const card = renderFeishuDeliveryCard(PRESENTATION);

    const limited = client.createCard({
      chatId: 'oc_delivery_status',
      dedupeId: 'feishu_delivery_card_revision_3',
      card,
    });
    await expect(limited).rejects.toMatchObject({ code: 'feishu_rate_limited' });
    await expect(limited).rejects.not.toThrow('CANARY_RATE_LIMIT');
    await expect(client.updateCard({ messageId: 'om_old_card', card })).resolves.toEqual({
      disposition: 'expired',
    });
    await expect(client.updateCard({ messageId: 'om_rejected_card', card })).resolves.toEqual({
      disposition: 'rejected',
      errorCode: 'feishu_request_rejected',
    });
  });

  it('copies Watt bounded AbortSignal semantics and classifies a hung request as a safe timeout', async () => {
    const cache = memoryTokenCache();
    await cache.put('feishu:tenant_access_token', 'tenant-token', 7_200);
    let observedSignal: AbortSignal | null = null;
    let observedAbort = false;
    const client = new FeishuDeliveryCardApiClient({
      appId: 'test-app-id',
      appSecret: 'CANARY_APP_SECRET',
      baseUrl: 'https://open.feishu.test',
      cache,
      timeoutMs: 5,
      fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        observedSignal = init?.signal ?? null;
        observedSignal?.addEventListener('abort', () => {
          observedAbort = true;
          reject(observedSignal?.reason);
        }, { once: true });
      }),
    });

    const operation = client.createCard({
      chatId: 'oc_delivery_status',
      dedupeId: 'feishu_delivery_card_timeout',
      card: renderFeishuDeliveryCard(PRESENTATION),
    });
    await expect(operation).rejects.toMatchObject({ code: 'feishu_api_timeout' });
    expect(observedAbort).toBe(true);
    await expect(operation).rejects.not.toThrow('TimeoutError');

    const tokenOperation = new FeishuDeliveryCardApiClient({
      appId: 'test-app-id',
      appSecret: 'CANARY_APP_SECRET',
      baseUrl: 'https://open.feishu.test',
      timeoutMs: 5,
      fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    }).createCard({
      chatId: 'oc_delivery_status',
      dedupeId: 'feishu_delivery_card_token_timeout',
      card: renderFeishuDeliveryCard(PRESENTATION),
    });
    await expect(tokenOperation).rejects.toMatchObject({ code: 'feishu_api_timeout' });
  });

  it('reads a known card as a safe digest without returning raw Feishu content', async () => {
    const rawCanary = 'CANARY_RAW_FEISHU_CARD_CONTENT';
    const card = renderFeishuDeliveryCard(PRESENTATION);
    const cache = memoryTokenCache();
    await cache.put('feishu:tenant_access_token', 'tenant-token', 7_200);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new FeishuDeliveryCardApiClient({
      appId: 'cli_delivery_loop',
      appSecret: 'CANARY_APP_SECRET',
      baseUrl: 'https://open.feishu.test',
      cache,
      fetch: async (input, init) => {
        calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
        return Response.json({
          code: 0,
          msg: rawCanary,
          data: {
            items: [{
              message_id: 'om_delivery_card_1',
              msg_type: 'interactive',
              create_time: '1785045600000',
              update_time: '1785045660000',
              deleted: false,
              chat_id: 'oc_delivery_status',
              sender: {
                id: 'cli_delivery_loop',
                sender_type: 'app',
                tenant_key: 'tenant_delivery_loop',
              },
              body: { content: JSON.stringify(card) },
            }],
          },
        });
      },
    });

    const fact = await client.getCardMessage('om_delivery_card_1');
    expect(fact).toMatchObject({
      messageId: 'om_delivery_card_1',
      chatId: 'oc_delivery_status',
      appId: 'cli_delivery_loop',
      tenantKey: 'tenant_delivery_loop',
      msgType: 'interactive',
      deleted: false,
      createdAt: '2026-07-26T06:00:00.000Z',
      updatedAt: '2026-07-26T06:01:00.000Z',
    });
    expect(fact?.cardDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(fact)).not.toContain(rawCanary);
    expect(JSON.stringify(fact)).not.toContain('Delivery Loop 交付状态');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://open.feishu.test/open-apis/im/v1/messages/om_delivery_card_1' +
      '?card_msg_content_type=user_card_content',
    );
    expect(calls[0]!.init?.method).toBe('GET');
  });
});
