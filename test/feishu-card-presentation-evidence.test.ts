import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  FeishuDeliveryCardPresentationV2Schema,
  renderFeishuDeliveryCard,
  type FeishuDeliveryCardJson,
} from '../src/domain/feishu-delivery-card.js';
import {
  FeishuCardPresentationEvidenceManifestV1Schema,
  type FeishuCardPresentationEvidenceManifestV1,
} from '../src/domain/feishu-card-presentation-evidence.js';
import {
  FeishuCardPresentationEvidenceVerificationError,
  verifyFeishuCardPresentationEvidence,
} from '../src/pilot/feishu-card-presentation-evidence-verifier.js';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;
const PLAN_DIGEST = `sha256:${'d'.repeat(64)}`;
const CANARY = `ghp_${'Z'.repeat(32)}`;
const MESSAGE_ID = 'om_feishu_card_presentation_1';

const BASE_MANIFEST = {
  schemaVersion: '1',
  evidenceId: 'feishu-card-presentation-evidence-1',
  recordedAt: '2026-07-27T05:12:00.000Z',
  taskId: 'task-feishu-card-presentation-1',
  runId: 'run-feishu-card-presentation-1',
  repository: 'example/delivery-pilot',
  card: {
    appId: 'cli_delivery_loop',
    tenantKey: 'tenant_delivery_loop',
    chatId: 'oc_delivery_loop_pilot',
    messageId: MESSAGE_ID,
    createdAt: '2026-07-27T05:00:10.000Z',
    updatedAt: '2026-07-27T05:10:02.000Z',
  },
  lifecycle: {
    created: {
      presentationId: 'presentation-card-created-1',
      revision: 1,
      presentationDigest: DIGEST_A,
      renderedDigest: DIGEST_A,
      outboxId: 'outbox-card-created-1',
      deliveredAt: '2026-07-27T05:00:10.000Z',
    },
    beforeExpiry: {
      presentationId: 'presentation-card-before-expiry-1',
      revision: 2,
      presentationDigest: DIGEST_B,
      renderedDigest: DIGEST_B,
      outboxId: 'outbox-card-before-expiry-1',
      deliveredAt: '2026-07-27T05:05:01.000Z',
    },
    afterExpiry: {
      presentationId: 'presentation-card-after-expiry-1',
      revision: 3,
      presentationDigest: DIGEST_C,
      renderedDigest: DIGEST_C,
      outboxId: 'outbox-card-after-expiry-1',
      deliveredAt: '2026-07-27T05:10:02.000Z',
    },
    expiringEffect: 'repo_write',
    expiresAt: '2026-07-27T05:10:00.000Z',
  },
  safety: {
    canaryDigest: `sha256:${'0'.repeat(64)}`,
    largeLog: {
      digest: `sha256:${'9'.repeat(64)}`,
      sizeBytes: 262_144,
      controlledUrl: 'https://github.com/example/delivery-pilot/actions/runs/987654',
    },
  },
  review: {
    developerConsoleUrl: 'https://open.feishu.cn/app/cli_delivery_loop/permission',
    messageUrl: 'https://example.feishu.cn/message/om_feishu_card_presentation_1',
    screenshotUrl: 'https://evidence.example.test/feishu/card-presentation-1.png',
    reviewer: 'release-owner',
    reviewedAt: '2026-07-27T05:11:00.000Z',
    botMembership: 'member',
    scopes: [
      'im:message:send_as_bot',
      'im:message:update',
      'im:message:readonly',
      'im:message.group_msg',
    ],
  },
} as const;

async function fixture(): Promise<FeishuCardPresentationEvidenceManifestV1> {
  return FeishuCardPresentationEvidenceManifestV1Schema.parse({
    ...BASE_MANIFEST,
    safety: {
      ...BASE_MANIFEST.safety,
      canaryDigest: await canonicalSha256(CANARY),
    },
  });
}

const SNAPSHOT_BEFORE = {
  runVersion: 7,
  runState: 'blocked',
  taskRevision: 'revision-safe-1',
  targetRepository: 'example/delivery-pilot',
  baseSha: '1'.repeat(40),
  planVersion: 2,
  planDigest: PLAN_DIGEST,
  progress: {
    passed: 1,
    total: 3,
    requiredPassed: 1,
    requiredTotal: 3,
    inProgress: 0,
    failed: 0,
    blocked: 2,
  },
  currentGoal: 'Implement *bounded* [retry] safely',
  actionUrl: 'https://github.com/example/delivery-pilot/actions/runs/987654',
  checkUrl: 'https://github.com/example/delivery-pilot/actions/runs/987654/job/111',
  checkpointSummary: '摘要已隐藏（检测到敏感内容）',
  evidenceSummary: 'Large verification log passed; full output remains behind the controlled link.',
  evidenceUrl: 'https://github.com/example/delivery-pilot/actions/runs/987654',
  blocker: {
    reason: 'repeated_fingerprint',
    attemptCount: 2,
    attemptedPaths: ['repository_inspection', 'targeted_test'],
    neededHumanInput: 'provide_reproduction',
  },
  approvedEffects: [{
    effect: 'repo_write',
    expiresAt: '2026-07-27T05:10:00.000Z',
  }],
  pr: {
    status: 'open',
    url: 'https://github.com/example/delivery-pilot/pull/42',
  },
  merge: {
    status: 'waiting',
    url: 'https://github.com/example/delivery-pilot/pull/42',
  },
  testDeploy: { status: 'not_started', url: null },
  productionDeploy: { status: 'not_started', url: null },
} as const;

function snapshotAfter() {
  return { ...SNAPSHOT_BEFORE, approvedEffects: [] };
}

function presentation(
  manifest: FeishuCardPresentationEvidenceManifestV1,
  phase: 'created' | 'beforeExpiry' | 'afterExpiry',
) {
  const ref = manifest.lifecycle[phase];
  const after = phase === 'afterExpiry';
  return {
    presentationId: ref.presentationId,
    revision: ref.revision,
    digest: ref.presentationDigest,
    renderedDigest: ref.renderedDigest,
    createdAt: phase === 'created'
      ? '2026-07-27T05:00:00.000Z'
      : phase === 'beforeExpiry'
        ? '2026-07-27T05:05:00.000Z'
        : '2026-07-27T05:10:01.000Z',
    lineage: phase === 'created' ? {
      trigger: 'initial',
      priorPresentationId: null,
      priorSourceObservedAt: null,
      sourceObservedAt: '2026-07-27T04:59:59.000Z',
      triggerRefreshAt: null,
      nextRefreshAt: null,
      projectedAt: '2026-07-27T05:00:00.000Z',
    } : phase === 'beforeExpiry' ? {
      trigger: 'source_change',
      priorPresentationId: manifest.lifecycle.created.presentationId,
      priorSourceObservedAt: '2026-07-27T04:59:59.000Z',
      sourceObservedAt: '2026-07-27T05:04:59.000Z',
      triggerRefreshAt: null,
      nextRefreshAt: manifest.lifecycle.expiresAt,
      projectedAt: '2026-07-27T05:05:00.000Z',
    } : {
      trigger: 'approval_expiry',
      priorPresentationId: manifest.lifecycle.beforeExpiry.presentationId,
      priorSourceObservedAt: '2026-07-27T05:04:59.000Z',
      sourceObservedAt: '2026-07-27T05:04:59.000Z',
      triggerRefreshAt: manifest.lifecycle.expiresAt,
      nextRefreshAt: null,
      projectedAt: '2026-07-27T05:10:01.000Z',
    },
    snapshot: after ? snapshotAfter() : SNAPSHOT_BEFORE,
    outbox: {
      outboxId: ref.outboxId,
      deliveryState: 'settled',
      attemptCount: 1,
      lastErrorCode: null,
      payloadKind: 'presentation_ref',
    },
    delivery: {
      disposition: phase === 'created' ? 'created' : 'updated',
      messageId: manifest.card.messageId,
      deliveredAt: ref.deliveredAt,
    },
  };
}

async function operations(
  manifest: FeishuCardPresentationEvidenceManifestV1,
  mutate?: (body: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    schemaVersion: '1',
    evidence: {
      taskId: manifest.taskId,
      runId: manifest.runId,
      repository: manifest.repository,
      tenantKey: manifest.card.tenantKey,
      chatId: manifest.card.chatId,
      cardId: 'feishu-card-presentation-1',
      presentations: [
        presentation(manifest, 'created'),
        presentation(manifest, 'beforeExpiry'),
        presentation(manifest, 'afterExpiry'),
      ],
    },
  };
  mutate?.(body);
  return body;
}

function finalCard(rawSnapshot: unknown = snapshotAfter()): FeishuDeliveryCardJson {
  const presentation = FeishuDeliveryCardPresentationV2Schema.parse({
    schemaVersion: '2',
    cardId: 'feishu-card-presentation-1',
    presentationId: 'presentation-card-after-expiry-1',
    runId: 'run-feishu-card-presentation-1',
    ...(rawSnapshot as Record<string, unknown>),
    actions: [],
  });
  return renderFeishuDeliveryCard(presentation);
}

async function feishuMessage(
  manifest: FeishuCardPresentationEvidenceManifestV1,
  card: unknown = finalCard(),
): Promise<Record<string, unknown>> {
  return {
    code: 0,
    data: {
      items: [{
        message_id: manifest.card.messageId,
        msg_type: 'interactive',
        chat_id: manifest.card.chatId,
        deleted: false,
        create_time: String(Date.parse(manifest.card.createdAt)),
        update_time: String(Date.parse(manifest.card.updatedAt)),
        sender: {
          sender_type: 'app',
          id: manifest.card.appId,
          tenant_key: manifest.card.tenantKey,
        },
        body: { content: JSON.stringify(card) },
      }],
    },
  };
}

function fakeFetch(
  manifest: FeishuCardPresentationEvidenceManifestV1,
  options: {
    mutateOperations?: (body: Record<string, unknown>) => void;
    liveCard?: unknown;
    rawFeishuFailure?: string;
  } = {},
): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.origin === 'https://control.example') {
      return Response.json(await operations(manifest, options.mutateOperations));
    }
    if (options.rawFeishuFailure !== undefined) {
      return Response.json({ code: 1, msg: options.rawFeishuFailure }, { status: 503 });
    }
    return Response.json(await feishuMessage(manifest, options.liveCard ?? finalCard()));
  }) as typeof fetch;
}

async function verify(
  manifest: FeishuCardPresentationEvidenceManifestV1,
  fetcher: typeof fetch,
) {
  return await verifyFeishuCardPresentationEvidence(manifest, {
    controlPlaneOrigin: 'https://control.example',
    operationsToken: 'CANARY_OPERATIONS_TOKEN',
    feishuAccessToken: 'CANARY_FEISHU_TOKEN',
    canarySecret: CANARY,
    feishuApiOrigin: 'https://open.feishu.test',
    fetch: fetcher,
  });
}

describe('Feishu card presentation live evidence', () => {
  it('keeps a strict lifecycle, safety and human-review manifest', async () => {
    const manifest = await fixture();
    expect(FeishuCardPresentationEvidenceManifestV1Schema.safeParse(manifest).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/feishu-card-presentation-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    expect(FeishuCardPresentationEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(FeishuCardPresentationEvidenceManifestV1Schema.safeParse({
      ...manifest,
      rawLog: CANARY,
    }).success).toBe(false);
    expect(FeishuCardPresentationEvidenceManifestV1Schema.safeParse({
      ...manifest,
      lifecycle: {
        ...manifest.lifecycle,
        afterExpiry: { ...manifest.lifecycle.afterExpiry, revision: 2 },
      },
    }).success).toBe(false);
  });

  it('cross-checks create/PATCH, full v2 sections, expiry-only refresh and live Message GET', async () => {
    const manifest = await fixture();
    const rendered = finalCard();
    manifest.lifecycle.afterExpiry.renderedDigest = await canonicalSha256(rendered);
    const summary = await verify(manifest, fakeFetch(manifest, { liveCard: rendered }));
    expect(summary).toEqual({
      schemaVersion: '1',
      evidenceId: manifest.evidenceId,
      repository: manifest.repository,
      runId: manifest.runId,
      presentationCount: 3,
      messageId: manifest.card.messageId,
      createAndPatch: 'verified',
      approvalExpiry: 'verified',
      liveCard: 'verified',
      plaintextLeaks: 0,
    });
  });

  it('rejects a recreated message or an expiry refresh with a changed business watermark', async () => {
    const manifest = await fixture();
    manifest.lifecycle.afterExpiry.renderedDigest = await canonicalSha256(finalCard());
    await expect(verify(manifest, fakeFetch(manifest, {
      mutateOperations: (body) => {
        const evidence = body.evidence as Record<string, unknown>;
        const rows = evidence.presentations as Array<Record<string, unknown>>;
        (rows[1]!.delivery as Record<string, unknown>).messageId = 'om_recreated_message';
      },
    }))).rejects.toMatchObject({ code: 'delivery_lineage_mismatch' });
    await expect(verify(manifest, fakeFetch(manifest, {
      mutateOperations: (body) => {
        const evidence = body.evidence as Record<string, unknown>;
        const rows = evidence.presentations as Array<Record<string, unknown>>;
        (rows[2]!.lineage as Record<string, unknown>).sourceObservedAt =
          '2026-07-27T05:09:59.000Z';
      },
    }))).rejects.toMatchObject({ code: 'approval_expiry_mismatch' });
  });

  it('rejects forged card sections and detects the plaintext canary before digest trust', async () => {
    const manifest = await fixture();
    const rendered = finalCard();
    manifest.lifecycle.afterExpiry.renderedDigest = await canonicalSha256(rendered);
    const forged = structuredClone(rendered);
    (forged.elements as unknown[]).push({
      tag: 'div',
      text: { tag: 'lark_md', content: '**Raw log**\nuntrusted output' },
    });
    await expect(verify(manifest, fakeFetch(manifest, {
      liveCard: forged,
    }))).rejects.toMatchObject({ code: 'card_digest_mismatch' });

    const leaked = structuredClone(rendered);
    (leaked.elements as Array<Record<string, unknown>>)[6] = {
      tag: 'div',
      text: { tag: 'lark_md', content: `**checkpoint**\n${CANARY}` },
    };
    await expect(verify(manifest, fakeFetch(manifest, {
      liveCard: leaked,
    }))).rejects.toMatchObject({ code: 'secret_leak_detected' });
    await expect(verify(manifest, fakeFetch(manifest, {
      mutateOperations: (body) => {
        const evidence = body.evidence as Record<string, unknown>;
        const rows = evidence.presentations as Array<Record<string, unknown>>;
        (rows[2]!.snapshot as Record<string, unknown>).evidenceSummary = CANARY;
      },
    }))).rejects.toMatchObject({ code: 'secret_leak_detected' });
  });

  it('never propagates credentials/upstream text and keeps the CLI explicitly opt-in', async () => {
    const manifest = await fixture();
    const raw = 'CANARY_RAW_FEISHU_PRESENTATION_ERROR';
    const failure = await verify(manifest, fakeFetch(manifest, {
      rawFeishuFailure: raw,
    })).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FeishuCardPresentationEvidenceVerificationError);
    expect(String(failure)).not.toContain(raw);
    expect(String(failure)).not.toContain('CANARY_OPERATIONS_TOKEN');
    expect(String(failure)).not.toContain('CANARY_FEISHU_TOKEN');

    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/verify-feishu-card-presentation-evidence.ts'],
      {
        cwd: resolve('.'),
        env: { ...process.env, DELIVERY_LOOP_FEISHU_CARD_PRESENTATION_E2E: undefined },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('feishu-card-presentation-e2e: opt-in missing');
  });
});
