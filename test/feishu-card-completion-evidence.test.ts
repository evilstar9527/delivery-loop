import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  FeishuCardCompletionEvidenceManifestV1Schema,
  type FeishuCardCompletionEvidenceManifestV1,
} from '../src/domain/feishu-card-completion-evidence.js';
import {
  FeishuDeliveryCardPresentationV2Schema,
  renderFeishuDeliveryCard,
} from '../src/domain/feishu-delivery-card.js';
import {
  verifyFeishuCardCompletionEvidence,
} from '../src/pilot/feishu-card-completion-evidence-verifier.js';

const REPOSITORY = 'example/delivery-pilot';
const CANARY = `ghp_${'Q'.repeat(32)}`;
const DIGEST = (letter: string) => `sha256:${letter.repeat(64)}`;
const SHA = (letter: string) => letter.repeat(40);

async function fixture(): Promise<FeishuCardCompletionEvidenceManifestV1> {
  const cases = (['test', 'production'] as const).map((lane, index) => ({
    caseId: `completion-${lane}`,
    lane,
    taskId: `task-completion-${lane}`,
    runId: `run-completion-${lane}`,
    repository: REPOSITORY,
    runVersion: 20 + index,
    taskRevision: `revision-completion-${lane}`,
    baseSha: SHA(index === 0 ? 'a' : 'b'),
    planVersion: 2,
    planDigest: DIGEST(index === 0 ? 'c' : 'd'),
    progress: {
      passed: 5, total: 5, requiredPassed: 5, requiredTotal: 5,
      inProgress: 0 as const, failed: 0 as const, blocked: 0 as const,
    },
    pullRequestUrl: `https://github.com/${REPOSITORY}/pull/${40 + index}`,
    mergeUrl: `https://github.com/${REPOSITORY}/pull/${40 + index}`,
    deploymentUrl: `https://${lane}.example.test/releases/${100 + index}`,
    card: {
      appId: 'cli_delivery_loop',
      tenantKey: 'tenant_delivery_loop',
      chatId: 'oc_delivery_loop_pilot',
      messageId: `om_completion_${lane}`,
      createdAt: `2026-07-27T0${index + 6}:00:10.000Z`,
      updatedAt: `2026-07-27T0${index + 6}:10:02.000Z`,
    },
    completion: {
      presentationId: `presentation-completion-${lane}`,
      revision: 3,
      presentationDigest: DIGEST(index === 0 ? 'e' : 'f'),
      renderedDigest: DIGEST(index === 0 ? '1' : '2'),
      outboxId: `outbox-completion-${lane}`,
      deliveredAt: `2026-07-27T0${index + 6}:10:02.000Z`,
    },
    review: {
      messageUrl: `https://example.feishu.cn/message/om_completion_${lane}`,
      screenshotUrl: `https://evidence.example.test/completion-${lane}.png`,
      reviewer: 'release-owner',
      reviewedAt: `2026-07-27T0${index + 6}:11:00.000Z`,
    },
  }));
  return FeishuCardCompletionEvidenceManifestV1Schema.parse({
    schemaVersion: '1', evidenceId: 'feishu-card-completion-evidence-test',
    repository: REPOSITORY, recordedAt: '2026-07-27T08:00:00.000Z',
    safety: { canaryDigest: await canonicalSha256(CANARY) }, cases,
  });
}

function snapshot(item: FeishuCardCompletionEvidenceManifestV1['cases'][number]) {
  return {
    runVersion: item.runVersion,
    runState: 'succeeded' as const,
    taskRevision: item.taskRevision,
    targetRepository: item.repository,
    baseSha: item.baseSha,
    planVersion: item.planVersion,
    planDigest: item.planDigest,
    progress: item.progress,
    currentGoal: '交付已完成',
    actionUrl: `https://github.com/${item.repository}/actions/runs/${item.runVersion}`,
    checkUrl: `https://github.com/${item.repository}/actions/runs/${item.runVersion}/job/1`,
    checkpointSummary: null,
    evidenceSummary: 'Final external deployment fact verified.',
    evidenceUrl: item.deploymentUrl,
    blocker: null,
    approvedEffects: [],
    pr: { status: 'open' as const, url: item.pullRequestUrl },
    merge: { status: 'merged' as const, url: item.mergeUrl },
    testDeploy: item.lane === 'test'
      ? { status: 'succeeded' as const, url: item.deploymentUrl }
      : { status: 'not_started' as const, url: null },
    productionDeploy: item.lane === 'production'
      ? { status: 'succeeded' as const, url: item.deploymentUrl }
      : { status: 'not_started' as const, url: null },
  };
}

async function operations(
  item: FeishuCardCompletionEvidenceManifestV1['cases'][number],
  mutate?: (body: Record<string, unknown>) => void,
) {
  const prior = (revision: number) => ({
    presentationId: `presentation-${item.lane}-${revision}`,
    revision,
    digest: DIGEST(revision === 1 ? '8' : '9'),
    renderedDigest: DIGEST(revision === 1 ? '8' : '9'),
    createdAt: item.card.createdAt,
    lineage: {
      trigger: revision === 1 ? 'initial' : 'source_change',
      priorPresentationId: revision === 1 ? null : `presentation-${item.lane}-1`,
      priorSourceObservedAt: revision === 1 ? null : item.card.createdAt,
      sourceObservedAt: item.card.createdAt,
      triggerRefreshAt: null,
      nextRefreshAt: null,
      projectedAt: item.card.createdAt,
    },
    snapshot: snapshot(item),
    outbox: {
      outboxId: `outbox-${item.lane}-${revision}`,
      deliveryState: 'settled', attemptCount: 1, lastErrorCode: null,
      payloadKind: 'presentation_ref',
    },
    delivery: {
      disposition: revision === 1 ? 'created' : 'updated',
      messageId: item.card.messageId,
      deliveredAt: item.card.createdAt,
    },
  });
  const body: Record<string, unknown> = {
    schemaVersion: '1',
    evidence: {
      taskId: item.taskId, runId: item.runId, repository: item.repository,
      tenantKey: item.card.tenantKey, chatId: item.card.chatId,
      cardId: `card-${item.lane}`,
      presentations: [
        prior(1), prior(2),
        {
          presentationId: item.completion.presentationId,
          revision: item.completion.revision,
          digest: item.completion.presentationDigest,
          renderedDigest: item.completion.renderedDigest,
          createdAt: item.completion.deliveredAt,
          lineage: {
            trigger: 'source_change',
            priorPresentationId: `presentation-${item.lane}-2`,
            priorSourceObservedAt: item.card.createdAt,
            sourceObservedAt: item.completion.deliveredAt,
            triggerRefreshAt: null, nextRefreshAt: null,
            projectedAt: item.completion.deliveredAt,
          },
          snapshot: snapshot(item),
          outbox: {
            outboxId: item.completion.outboxId,
            deliveryState: 'settled', attemptCount: 1, lastErrorCode: null,
            payloadKind: 'presentation_ref',
          },
          delivery: {
            disposition: 'updated', messageId: item.card.messageId,
            deliveredAt: item.completion.deliveredAt,
          },
        },
      ],
    },
  };
  mutate?.(body);
  return body;
}

function card(item: FeishuCardCompletionEvidenceManifestV1['cases'][number]) {
  return renderFeishuDeliveryCard(FeishuDeliveryCardPresentationV2Schema.parse({
    schemaVersion: '2', cardId: `card-${item.lane}`,
    presentationId: item.completion.presentationId, runId: item.runId,
    ...snapshot(item), actions: [],
  }));
}

async function withRenderedDigests(manifest: FeishuCardCompletionEvidenceManifestV1) {
  for (const item of manifest.cases) item.completion.renderedDigest = await canonicalSha256(card(item));
  return manifest;
}

function fetcher(
  manifest: FeishuCardCompletionEvidenceManifestV1,
  mutate?: (body: Record<string, unknown>, lane: 'test' | 'production') => void,
): typeof fetch {
  return (async (request) => {
    const url = new URL(String(request));
    const item = url.origin === 'https://control.example'
      ? manifest.cases.find((candidate) => candidate.runId === url.searchParams.get('runId'))
      : manifest.cases.find((candidate) => url.pathname.includes(candidate.card.messageId));
    if (item === undefined) return new Response('missing', { status: 404 });
    if (url.origin === 'https://control.example') {
      return Response.json(await operations(item, (body) => mutate?.(body, item.lane)));
    }
    return Response.json({
      code: 0,
      data: { items: [{
        message_id: item.card.messageId, msg_type: 'interactive', deleted: false,
        chat_id: item.card.chatId,
        create_time: String(Date.parse(item.card.createdAt)),
        update_time: String(Date.parse(item.card.updatedAt)),
        sender: { sender_type: 'app', id: item.card.appId, tenant_key: item.card.tenantKey },
        body: { content: JSON.stringify(card(item)) },
      }] },
    });
  }) as typeof fetch;
}

function options(fetch: typeof globalThis.fetch) {
  return {
    controlPlaneOrigin: 'https://control.example',
    operationsToken: 'CANARY_COMPLETION_OPERATIONS_TOKEN',
    feishuAccessToken: 'CANARY_COMPLETION_FEISHU_TOKEN',
    canarySecret: CANARY,
    feishuApiOrigin: 'https://open.feishu.test',
    fetch,
  };
}

describe('final Feishu completion-card live evidence', () => {
  it('requires strict test and production lanes and verifies both settled live cards', async () => {
    const manifest = await withRenderedDigests(await fixture());
    expect(FeishuCardCompletionEvidenceManifestV1Schema.safeParse(manifest).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/feishu-card-completion-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    expect(FeishuCardCompletionEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    await expect(verifyFeishuCardCompletionEvidence(
      manifest, options(fetcher(manifest)),
    )).resolves.toEqual({
      schemaVersion: '1', evidenceId: manifest.evidenceId, repository: REPOSITORY,
      testRunId: 'run-completion-test', productionRunId: 'run-completion-production',
      completedCards: 2, settledPresentations: 2, liveCards: 2,
      activeActions: 0, activeApprovals: 0, plaintextLeaks: 0,
    });
  });

  it('rejects incomplete progress, a non-latest presentation and a live action', async () => {
    const manifest = await withRenderedDigests(await fixture());
    expect(FeishuCardCompletionEvidenceManifestV1Schema.safeParse({
      ...manifest,
      cases: manifest.cases.map((item, index) => index === 0 ? {
        ...item, progress: { ...item.progress, requiredPassed: 4 },
      } : item),
    }).success).toBe(false);
    await expect(verifyFeishuCardCompletionEvidence(manifest, options(fetcher(
      manifest,
      (body, lane) => {
        if (lane !== 'test') return;
        const evidence = body.evidence as Record<string, unknown>;
        const rows = evidence.presentations as Array<Record<string, unknown>>;
        rows.push({ ...rows.at(-1), presentationId: 'presentation-later', revision: 4 });
      },
    )))).rejects.toMatchObject({ code: 'completion_delivery_mismatch' });

    const actionManifest = await fixture();
    for (const item of actionManifest.cases) {
      const liveCard = card(item);
      liveCard.elements.push({
        tag: 'action',
        actions: [],
      });
      item.completion.renderedDigest = await canonicalSha256(liveCard);
    }
    const actionFetch = (async (request: RequestInfo | URL) => {
      const url = new URL(String(request));
      const item = url.origin === 'https://control.example'
        ? actionManifest.cases.find((candidate) => candidate.runId === url.searchParams.get('runId'))
        : actionManifest.cases.find((candidate) => url.pathname.includes(candidate.card.messageId));
      if (item === undefined) return new Response('missing', { status: 404 });
      if (url.origin === 'https://control.example') return Response.json(await operations(item));
      const liveCard = card(item);
      liveCard.elements.push({ tag: 'action', actions: [] });
      return Response.json({ code: 0, data: { items: [{
        message_id: item.card.messageId, msg_type: 'interactive', deleted: false,
        chat_id: item.card.chatId,
        create_time: String(Date.parse(item.card.createdAt)),
        update_time: String(Date.parse(item.card.updatedAt)),
        sender: { sender_type: 'app', id: item.card.appId, tenant_key: item.card.tenantKey },
        body: { content: JSON.stringify(liveCard) },
      }] } });
    }) as typeof fetch;
    await expect(verifyFeishuCardCompletionEvidence(
      actionManifest, options(actionFetch),
    )).rejects.toMatchObject({ code: 'completion_card_mismatch' });
  });
});
