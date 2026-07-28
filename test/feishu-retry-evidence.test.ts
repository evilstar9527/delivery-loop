import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  FeishuRetryEvidenceManifestV1Schema,
  type FeishuRetryEvidenceManifestV1,
} from '../src/domain/feishu-retry-evidence.js';
import { verifyFeishuRetryEvidence } from '../src/pilot/feishu-retry-evidence-verifier.js';

const MANIFEST: FeishuRetryEvidenceManifestV1 = {
  schemaVersion: '1',
  evidenceId: 'feishu-retry-evidence-1',
  recordedAt: '2026-07-26T13:00:00.000Z',
  runId: 'run-feishu-retry-1',
  repository: 'example/delivery-pilot',
  first: {
    outboxId: 'outbox-feishu-retry-1',
    presentationId: 'presentation-feishu-retry-1',
    initialRevision: 2,
    finalRevision: 2,
    initialMessageId: 'om_feishu_retry_1',
    finalMessageId: 'om_feishu_retry_1',
    retryHistory: [
      { attemptCount: 1, errorCode: 'feishu_rate_limited', observedAt: '2026-07-26T12:40:00.000Z' },
      { attemptCount: 2, errorCode: 'feishu_api_timeout', observedAt: '2026-07-26T12:41:00.000Z' },
      { attemptCount: 3, errorCode: 'feishu_token_invalid', observedAt: '2026-07-26T12:41:30.000Z' },
    ],
    deliveredAt: '2026-07-26T12:42:00.000Z',
  },
  refresh: {
    requestId: 'refresh-feishu-retry-1',
    expectedPresentationId: 'presentation-feishu-retry-1',
    expectedRevision: 2,
    expectedDigest: `sha256:${'2'.repeat(64)}`,
    nextPresentationId: 'presentation-feishu-refresh-1',
    nextRevision: 3,
    nextDigest: `sha256:${'4'.repeat(64)}`,
    nextOutboxId: 'outbox-feishu-refresh-1',
    finalMessageId: 'om_feishu_retry_2',
  },
  card: {
    appId: 'cli_delivery_loop',
    tenantKey: 'tenant_delivery_loop',
    chatId: 'oc_delivery_loop_pilot',
    finalRenderedDigest: `sha256:${'3'.repeat(64)}`,
    finalCreatedAt: '2026-07-26T12:50:00.000Z',
    finalUpdatedAt: '2026-07-26T12:51:00.000Z',
  },
};

const FINAL_CARD = {
  config: { wide_screen_mode: true, update_multi: true },
  elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**当前状态**\n已修复' } }],
};

async function fixture(): Promise<FeishuRetryEvidenceManifestV1> {
  return {
    ...MANIFEST,
    card: {
      ...MANIFEST.card,
      finalRenderedDigest: await canonicalSha256(FINAL_CARD),
    },
  };
}

function operations(manifest: FeishuRetryEvidenceManifestV1): Record<string, unknown> {
  return {
    schemaVersion: '1',
    card: {
      runId: manifest.runId,
      latest: {
        presentationId: manifest.refresh.nextPresentationId,
        revision: manifest.refresh.nextRevision,
        digest: manifest.refresh.nextDigest,
        renderedDigest: manifest.card.finalRenderedDigest,
        outboxId: manifest.refresh.nextOutboxId,
        deliveryState: 'settled',
        attemptCount: 1,
        lastErrorCode: null,
      },
      delivered: {
        presentationId: manifest.refresh.nextPresentationId,
        revision: manifest.refresh.nextRevision,
        digest: manifest.refresh.nextDigest,
        messageId: manifest.refresh.finalMessageId,
      },
      retryHistory: manifest.first.retryHistory.map((retry) => ({
        outboxId: manifest.first.outboxId,
        presentationId: manifest.first.presentationId,
        ...retry,
      })),
      refresh: {
        requestId: manifest.refresh.requestId,
        expectedPresentationId: manifest.refresh.expectedPresentationId,
        expectedRevision: manifest.refresh.expectedRevision,
        expectedDigest: manifest.refresh.expectedDigest,
        nextPresentationId: manifest.refresh.nextPresentationId,
        nextRevision: manifest.refresh.nextRevision,
        nextDigest: manifest.refresh.nextDigest,
        nextOutboxId: manifest.refresh.nextOutboxId,
        nextDeliveryState: 'settled',
      },
    },
  };
}

function feishuMessage(
  manifest: FeishuRetryEvidenceManifestV1,
  rawCard: unknown = FINAL_CARD,
): Record<string, unknown> {
  return {
    code: 0,
    data: {
      items: [{
        message_id: manifest.refresh.finalMessageId,
        msg_type: 'interactive',
        chat_id: manifest.card.chatId,
        deleted: false,
        create_time: String(Date.parse(manifest.card.finalCreatedAt)),
        update_time: String(Date.parse(manifest.card.finalUpdatedAt)),
        sender: {
          sender_type: 'app',
          id: manifest.card.appId,
          tenant_key: manifest.card.tenantKey,
        },
        body: { content: JSON.stringify(rawCard) },
      }],
    },
  };
}

function fakeFetch(
  manifest: FeishuRetryEvidenceManifestV1,
  options: { history?: unknown; rawCard?: unknown; status?: number } = {},
): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.origin === 'https://control.example') {
      if (options.history !== undefined) {
        const body = operations(manifest);
        const card = body.card as Record<string, unknown>;
        card.retryHistory = options.history;
        return Response.json(body);
      }
      return Response.json(operations(manifest));
    }
    return Response.json(
      feishuMessage(manifest, options.rawCard ?? FINAL_CARD),
      options.status === undefined ? {} : { status: options.status },
    );
  }) as typeof fetch;
}

describe('Feishu retry and refresh live evidence', () => {
  it('keeps a strict cross-field manifest', () => {
    expect(FeishuRetryEvidenceManifestV1Schema.safeParse(MANIFEST).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/feishu-retry-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    expect(FeishuRetryEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(FeishuRetryEvidenceManifestV1Schema.safeParse({
      ...MANIFEST,
      first: {
        ...MANIFEST.first,
        retryHistory: MANIFEST.first.retryHistory.slice(0, 2),
      },
    }).success).toBe(false);
    expect(FeishuRetryEvidenceManifestV1Schema.safeParse({
      ...MANIFEST,
      rawError: 'CANARY_RAW_FEISHU_ERROR',
    }).success).toBe(false);
  });

  it('cross-checks retry history, refresh lineage and the live message', async () => {
    const manifest = await fixture();
    const summary = await verifyFeishuRetryEvidence(manifest, {
      controlPlaneOrigin: 'https://control.example',
      operationsToken: 'CANARY_OPERATIONS_TOKEN',
      feishuAccessToken: 'CANARY_FEISHU_TOKEN',
      feishuApiOrigin: 'https://open.feishu.test',
      fetch: fakeFetch(manifest),
    });
    expect(summary).toEqual({
      schemaVersion: '1',
      evidenceId: manifest.evidenceId,
      repository: manifest.repository,
      runId: manifest.runId,
      retries: 3,
      retryCodes: [
        'feishu_rate_limited', 'feishu_api_timeout', 'feishu_token_invalid',
      ],
      refresh: 'verified',
      finalPresentationId: manifest.refresh.nextPresentationId,
      finalMessageId: manifest.refresh.finalMessageId,
    });
  });

  it('rejects missing retry facts, changed refresh lineage, or message drift', async () => {
    const manifest = await fixture();
    await expect(verifyFeishuRetryEvidence(manifest, fakeOptions(manifest, {
      history: [],
    }))).rejects.toMatchObject({ code: 'retry_history_mismatch' });
    const changed = { ...manifest, refresh: {
      ...manifest.refresh,
      nextRevision: manifest.refresh.nextRevision + 1,
    } };
    await expect(verifyFeishuRetryEvidence(changed, fakeOptions(manifest)))
      .rejects.toMatchObject({ code: 'refresh_lineage_mismatch' });
    await expect(verifyFeishuRetryEvidence(manifest, fakeOptions(manifest, {
      rawCard: { config: { wide_screen_mode: true, update_multi: true }, elements: [] },
    }))).rejects.toMatchObject({ code: 'feishu_message_mismatch' });
  });

  it('does not propagate token, raw response, or oversized control-plane data', async () => {
    const manifest = await fixture();
    const raw = 'CANARY_RAW_FEISHU_RESPONSE';
    const failure = await verifyFeishuRetryEvidence(manifest, fakeOptions(manifest, {
      status: 503,
    })).catch((error: unknown) => error);
    expect(String(failure)).not.toContain(raw);
    expect(String(failure)).not.toContain('CANARY_OPERATIONS_TOKEN');
    expect(String(failure)).not.toContain('CANARY_FEISHU_TOKEN');
  });

  it('keeps the verifier available for the explicit CLI contract', () => {
    expect(typeof verifyFeishuRetryEvidence).toBe('function');
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/verify-feishu-retry-evidence.ts'],
      {
        cwd: resolve('.'),
        env: { ...process.env, DELIVERY_LOOP_FEISHU_RETRY_E2E: undefined },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('feishu-retry-e2e: opt-in missing');
  });
});

function fakeOptions(
  manifest: FeishuRetryEvidenceManifestV1,
  options: { history?: unknown; rawCard?: unknown; status?: number } = {},
) {
  return {
    controlPlaneOrigin: 'https://control.example',
    operationsToken: 'CANARY_OPERATIONS_TOKEN',
    feishuAccessToken: 'CANARY_FEISHU_TOKEN',
    feishuApiOrigin: 'https://open.feishu.test',
    fetch: fakeFetch(manifest, options),
  };
}
