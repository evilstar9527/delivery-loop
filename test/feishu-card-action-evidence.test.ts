import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  FeishuCardActionEvidenceManifestV1Schema,
  FeishuCardActionObservabilityReportV1Schema,
  type FeishuCardActionEvidenceManifestV1,
  type FeishuCardActionObservabilityReportV1,
} from '../src/domain/feishu-card-action-evidence.js';
import {
  FeishuCardActionEvidenceVerificationError,
  verifyFeishuCardActionEvidence,
} from '../src/pilot/feishu-card-action-evidence-verifier.js';

const CANARY = `ghp_${'Q'.repeat(32)}`;
const CALLBACK_URL = 'https://control.example/v1/webhooks/feishu';
const OBSERVABILITY_URL = 'https://observer.example/feishu/card-actions/round-110';
const TENANT_KEY = 'tenant_delivery_loop';
const APP_ID = 'cli_delivery_loop';
const CHAT_ID = 'oc_delivery_loop_pilot';
const RECORDED_AT = '2026-07-27T09:10:00.000Z';

function digest(index: number): `sha256:${string}` {
  return `sha256:${index.toString(16).padStart(2, '0').repeat(32)}`;
}

const SUCCESS_SHAPES = [
  ['approve', 'repo_write', 'approval'],
  ['reject', 'repo_write', 'approval'],
  ['cancel', 'cancel_run', 'cancellation'],
  ['retry', 'retry_run', 'recovery_attempt'],
  ['replay', 'replay_run', 'workflow_replay'],
  ['add_context', 'add_context', 'task_revision'],
] as const;

const REJECTION_SHAPES = [
  ['duplicate_nonce', 409, 'replay_rejected'],
  ['tampered_value', 400, 'invalid_request'],
  ['forwarded_message', 403, 'binding_conflict'],
  ['stale_card', 403, 'binding_conflict'],
  ['stale_task_revision', 403, 'binding_conflict'],
  ['stale_plan_version', 403, 'binding_conflict'],
  ['stale_plan_digest', 403, 'binding_conflict'],
  ['stale_base_sha', 403, 'binding_conflict'],
  ['wrong_chat', 403, 'binding_conflict'],
  ['role_revoked', 403, 'actor_not_authorized'],
  ['unauthorized_account', 403, 'identity_unresolved'],
  ['secret_add_context', 403, 'secret_detected'],
] as const;

interface Fixture {
  manifest: FeishuCardActionEvidenceManifestV1;
  report: FeishuCardActionObservabilityReportV1;
  projections: Map<string, Record<string, unknown>>;
}

async function fixture(): Promise<Fixture> {
  const actorOpenIds = {
    reviewer_a: await canonicalSha256('ou_reviewer_a'),
    reviewer_b: await canonicalSha256('ou_reviewer_b'),
    revoked_actor: await canonicalSha256('ou_revoked_actor'),
    unknown_actor: await canonicalSha256('ou_unknown_actor'),
  };
  const actorPrincipals = {
    reviewer_a: await canonicalSha256('user:reviewer-a'),
    reviewer_b: await canonicalSha256('user:reviewer-b'),
    revoked_actor: await canonicalSha256('user:revoked-actor'),
  };
  const roles = {
    reviewer_a: await canonicalSha256([
      'approve:repo_write', 'context:add', 'human',
      'operate:cancel', 'operate:replay', 'operate:retry',
    ]),
    reviewer_b: await canonicalSha256([
      'approve:repo_write', 'context:add', 'human',
      'operate:cancel', 'operate:replay', 'operate:retry',
    ]),
  };
  const successes = SUCCESS_SHAPES.map(([scenario, effect, resultKind], index) => ({
    scenario,
    eventId: `evt_action_${scenario}`,
    deliveryId: `delivery_action_${scenario}`,
    requestDigest: digest(index + 1),
    responseDigest: digest(index + 31),
    statusCode: 200 as const,
    startedAt: `2026-07-27T09:00:0${index}.000Z`,
    operatorDigest: index % 2 === 0 ? actorOpenIds.reviewer_a : actorOpenIds.reviewer_b,
    actionReceiptId: `receipt_action_${scenario}`,
    command: scenario,
    effect,
    resultKind,
    resultId: `${resultKind}_${scenario}`,
    actorKey: index % 2 === 0 ? 'reviewer_a' : 'reviewer_b',
    eventDigest: digest(index + 61),
    commandDigest: digest(index + 71),
    cardId: `card_action_${scenario}`,
    presentationId: `presentation_action_${scenario}`,
    messageId: `om_action_${scenario}`,
    taskId: `task_action_${scenario}`,
    runId: `run_action_${scenario}`,
    runVersion: 7,
    taskRevisionDigest: digest(index + 81),
    planId: `plan_action_${scenario}`,
    planVersion: 2,
    planDigest: digest(index + 91),
    baseSha: (index + 1).toString(16).repeat(40),
    actionId: `action_${scenario}`,
    contextMode: scenario === 'add_context' ? 'new_run' as const : null,
  }));
  const rejections = REJECTION_SHAPES.map(([scenario, statusCode, reasonCode], index) => {
    const actorKey = scenario === 'role_revoked'
      ? 'revoked_actor'
      : scenario === 'unauthorized_account'
        ? 'unknown_actor'
        : 'reviewer_a';
    return {
      scenario,
      eventId: `evt_rejected_${scenario}`,
      deliveryId: `delivery_rejected_${scenario}`,
      requestDigest: digest(index + 111),
      responseDigest: digest(index + 131),
      statusCode,
      startedAt: `2026-07-27T09:01:${index.toString().padStart(2, '0')}.000Z`,
      operatorDigest: actorOpenIds[actorKey],
      reasonCode,
      ...(scenario === 'role_revoked' || scenario === 'unauthorized_account'
        ? { attemptedCommand: 'approve' as const, attemptedEffect: 'repo_write' as const }
        : {}),
      actorKey,
      eventDigest: digest(index + 151),
      sourceSuccessEventId: scenario === 'duplicate_nonce' ? successes[0]!.eventId : null,
    };
  });
  const requests = [
    ...successes.map((item) => ({
      scenario: item.scenario,
      outcome: 'applied' as const,
      eventId: item.eventId,
      deliveryId: item.deliveryId,
      requestDigest: item.requestDigest,
      responseDigest: item.responseDigest,
      statusCode: item.statusCode,
      startedAt: item.startedAt,
      completedAt: new Date(Date.parse(item.startedAt) + 100).toISOString(),
      latencyMs: 100,
      operatorDigest: item.operatorDigest,
      actionReceiptId: item.actionReceiptId,
      command: item.command,
      effect: item.effect,
      resultKind: item.resultKind,
      resultId: item.resultId,
    })),
    ...rejections.map((item) => ({
      scenario: item.scenario,
      outcome: 'rejected' as const,
      eventId: item.eventId,
      deliveryId: item.deliveryId,
      requestDigest: item.requestDigest,
      responseDigest: item.responseDigest,
      statusCode: item.statusCode,
      startedAt: item.startedAt,
      completedAt: new Date(Date.parse(item.startedAt) + 100).toISOString(),
      latencyMs: 100,
      operatorDigest: item.operatorDigest,
      reasonCode: item.reasonCode,
      ...('attemptedCommand' in item
        ? {
            attemptedCommand: item.attemptedCommand,
            attemptedEffect: item.attemptedEffect,
          }
        : {}),
    })),
  ];
  const reportBody = {
    schemaVersion: '1' as const,
    evidenceId: 'feishu-card-action-round-110',
    service: 'delivery-loop-feishu-action-observer' as const,
    callbackUrl: CALLBACK_URL,
    generatedAt: '2026-07-27T09:05:00.000Z',
    requests,
  };
  const report = FeishuCardActionObservabilityReportV1Schema.parse({
    ...reportBody,
    reportDigest: await canonicalSha256(reportBody),
  });
  const manifest = FeishuCardActionEvidenceManifestV1Schema.parse({
    schemaVersion: '1',
    evidenceId: reportBody.evidenceId,
    recordedAt: RECORDED_AT,
    application: {
      appId: APP_ID,
      tenantKey: TENANT_KEY,
      chatId: CHAT_ID,
      callbackUrl: CALLBACK_URL,
    },
    observabilityReportUrl: OBSERVABILITY_URL,
    observabilityReportDigest: report.reportDigest,
    successes,
    rejections,
    actors: [
      {
        actorKey: 'reviewer_a',
        openIdDigest: actorOpenIds.reviewer_a,
        principalDigest: actorPrincipals.reviewer_a,
        rolesDigest: roles.reviewer_a,
        mappingStatus: 'mapped_human',
        reviewedAt: '2026-07-27T09:06:00.000Z',
      },
      {
        actorKey: 'reviewer_b',
        openIdDigest: actorOpenIds.reviewer_b,
        principalDigest: actorPrincipals.reviewer_b,
        rolesDigest: roles.reviewer_b,
        mappingStatus: 'mapped_human',
        reviewedAt: '2026-07-27T09:06:00.000Z',
      },
      {
        actorKey: 'revoked_actor',
        openIdDigest: actorOpenIds.revoked_actor,
        principalDigest: actorPrincipals.revoked_actor,
        rolesDigest: null,
        mappingStatus: 'revoked',
        reviewedAt: '2026-07-27T09:06:00.000Z',
      },
      {
        actorKey: 'unknown_actor',
        openIdDigest: actorOpenIds.unknown_actor,
        principalDigest: null,
        rolesDigest: null,
        mappingStatus: 'unmapped',
        reviewedAt: '2026-07-27T09:06:00.000Z',
      },
    ],
    safety: { canaryDigest: await canonicalSha256(CANARY) },
    review: {
      developerConsoleUrl: `https://open.feishu.cn/app/${APP_ID}/event`,
      permissionUrl: `https://open.feishu.cn/app/${APP_ID}/permission`,
      chatUrl: 'https://example.feishu.cn/messenger/chat/oc_delivery_loop_pilot',
      mappingEvidenceUrl: 'https://evidence.example/feishu/mapping-round-110.json',
      screenshotBundleUrl: 'https://evidence.example/feishu/card-action-round-110/',
      reviewer: 'release-owner',
      reviewedAt: '2026-07-27T09:07:00.000Z',
      eventSubscription: 'active',
      botMembership: 'member',
      scopes: [
        'im:message:send_as_bot',
        'im:message:update',
        'im:message:readonly',
        'im:message.group_msg',
      ],
    },
  });
  const actorMap = new Map(manifest.actors.map((actor) => [actor.actorKey, actor]));
  const chatDigest = await canonicalSha256(CHAT_ID);
  const projections = new Map<string, Record<string, unknown>>();
  for (const item of manifest.successes) {
    const actor = actorMap.get(item.actorKey)!;
    const commonAction = {
      actionReceiptId: item.actionReceiptId,
      deliveryId: item.deliveryId,
      eventCreatedAt: item.startedAt,
      operatorDigest: item.operatorDigest,
      principalDigest: actor.principalDigest,
      rolesDigest: actor.rolesDigest,
      chatDigest,
      messageId: item.messageId,
      cardId: item.cardId,
      presentationId: item.presentationId,
      taskId: item.taskId,
      runId: item.runId,
      runVersion: item.runVersion,
      taskRevisionDigest: item.taskRevisionDigest,
      planId: item.planId,
      planVersion: item.planVersion,
      planDigest: item.planDigest,
      baseSha: item.baseSha,
      actionId: item.actionId,
      command: item.command,
      effect: item.effect,
      contextMode: item.contextMode,
      commandDigest: item.commandDigest,
      receivedAt: item.startedAt,
      createdAt: item.startedAt,
      outcome: {
        outcomeId: `outcome_${item.scenario}`,
        disposition: 'applied',
        resultKind: item.resultKind,
        resultId: item.resultId,
        reasonCode: null,
        completedAt: new Date(Date.parse(item.startedAt) + 50).toISOString(),
      },
      businessEffect: effectFor(item),
    };
    projections.set(item.eventId, projectionBase(item, commonAction));
  }
  for (const item of manifest.rejections) {
    if (item.scenario !== 'secret_add_context') {
      projections.set(item.eventId, projectionBase(item, null, 0, 0, 0));
      continue;
    }
    const source = manifest.successes.find((success) => success.scenario === 'add_context')!;
    const actor = actorMap.get(item.actorKey)!;
    projections.set(item.eventId, projectionBase(item, {
      ...((projections.get(source.eventId)!.action) as Record<string, unknown>),
      actionReceiptId: 'receipt_rejected_secret_add_context',
      deliveryId: item.deliveryId,
      eventCreatedAt: item.startedAt,
      operatorDigest: item.operatorDigest,
      principalDigest: actor.principalDigest,
      rolesDigest: actor.rolesDigest,
      outcome: {
        outcomeId: 'outcome_rejected_secret_add_context',
        disposition: 'rejected',
        resultKind: null,
        resultId: null,
        reasonCode: 'secret_detected',
        completedAt: new Date(Date.parse(item.startedAt) + 50).toISOString(),
      },
      businessEffect: null,
    }, 1, 1, 0));
  }
  return { manifest, report, projections };
}

function effectFor(item: FeishuCardActionEvidenceManifestV1['successes'][number]) {
  if (item.command === 'approve' || item.command === 'reject') return {
    kind: 'approval',
    approvalId: item.resultId,
    decision: item.command,
    effect: item.effect,
    expiresAt: '2026-07-27T10:00:00.000Z',
    lineageId: `lineage_${item.scenario}`,
    sourceOccurredAt: item.startedAt,
    decisionRecordedAt: item.startedAt,
    externalEventDigest: item.eventDigest,
    currentTrusted: item.command === 'approve',
  };
  if (item.command === 'cancel') return {
    kind: 'cancellation',
    outboxId: item.resultId,
    runId: item.runId,
    deliveryState: 'pending',
  };
  if (item.command === 'retry') return {
    kind: 'recovery_attempt',
    attemptId: item.resultId,
    runId: item.runId,
    status: 'pending',
    planId: item.planId,
    planVersion: item.planVersion,
    planItemId: 'item_server_selected',
    recoveredFromAttemptId: 'attempt_lost_source',
    checkpointId: 'checkpoint_server_selected',
    baseSha: item.baseSha,
    headSha: 'a'.repeat(40),
  };
  if (item.command === 'replay') return {
    kind: 'workflow_replay',
    replayId: item.resultId,
    runId: item.runId,
    planId: item.planId,
    planVersion: item.planVersion,
    targetKind: 'system_step',
    targetStepName: 'verify-analysis-result',
    targetStepType: 'do',
    targetStepCount: 1,
    outboxId: 'outbox_server_replay',
    deliveryState: 'pending',
  };
  return {
    kind: 'task_revision',
    contextId: 'context_server_created',
    priorTaskId: item.taskId,
    priorTaskRevisionDigest: item.taskRevisionDigest,
    newTaskId: item.resultId,
    newTaskRevisionDigest: digest(201),
    newTaskDigest: digest(202),
    newRunId: 'run_context_server_created',
    contextDigest: digest(203),
    contextMode: item.contextMode,
    appliedRunId: null,
  };
}

function projectionBase(
  item: { eventId: string; deliveryId: string; requestDigest: string; eventDigest: string; startedAt: string },
  action: Record<string, unknown> | null,
  actionReceipts = 1,
  actionOutcomes = 1,
  businessEffects = 1,
): Record<string, unknown> {
  return {
    schemaVersion: '1',
    tenantKey: TENANT_KEY,
    eventId: item.eventId,
    counts: {
      deliveries: 1,
      ingressOutboxes: 0,
      actionReceipts,
      actionOutcomes,
      businessEffects,
    },
    delivery: {
      deliveryId: item.deliveryId,
      appId: APP_ID,
      eventType: 'card.action.trigger',
      eventCreatedAt: item.startedAt,
      verificationMode: 'encrypted',
      requestDigest: item.requestDigest,
      eventDigest: item.eventDigest,
      receivedAt: item.startedAt,
    },
    action,
  };
}

function fakeFetch(
  current: Fixture,
  options: {
    mutateProjection?: (eventId: string, body: Record<string, unknown>) => void;
    report?: unknown;
    rawControlPlaneFailure?: string;
  } = {},
): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.origin === 'https://observer.example') {
      return Response.json(options.report ?? current.report);
    }
    if (options.rawControlPlaneFailure !== undefined) {
      return Response.json({ error: options.rawControlPlaneFailure });
    }
    const eventId = url.searchParams.get('eventId') ?? '';
    const body = structuredClone(current.projections.get(eventId)!);
    options.mutateProjection?.(eventId, body);
    return Response.json(body);
  }) as typeof fetch;
}

async function verify(current: Fixture, fetcher = fakeFetch(current)) {
  return await verifyFeishuCardActionEvidence(current.manifest, {
    controlPlaneOrigin: 'https://control.example',
    operationsToken: 'CANARY_ACTION_OPERATIONS_TOKEN',
    observabilityReportUrl: OBSERVABILITY_URL,
    observabilityToken: 'CANARY_ACTION_OBSERVABILITY_TOKEN',
    canarySecret: CANARY,
    fetch: fetcher,
  });
}

describe('Feishu card action live evidence', () => {
  it('keeps a strict 6-success/12-rejection manifest and schema example', async () => {
    const current = await fixture();
    expect(FeishuCardActionEvidenceManifestV1Schema.safeParse(current.manifest).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/feishu-card-action-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    expect(FeishuCardActionEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(FeishuCardActionEvidenceManifestV1Schema.safeParse({
      ...current.manifest,
      rawEvent: CANARY,
    }).success).toBe(false);
    expect(FeishuCardActionEvidenceManifestV1Schema.safeParse({
      ...current.manifest,
      successes: current.manifest.successes.map((item) => ({ ...item, actorKey: 'reviewer_a' })),
    }).success).toBe(false);
    const missingUnauthorizedWriteBinding = structuredClone(current.manifest);
    const unauthorized = missingUnauthorizedWriteBinding.rejections.find(
      (item) => item.scenario === 'unauthorized_account',
    )!;
    delete (unauthorized as Partial<typeof unauthorized>).attemptedEffect;
    expect(FeishuCardActionEvidenceManifestV1Schema.safeParse(
      missingUnauthorizedWriteBinding,
    ).success).toBe(false);
  });

  it('cross-checks all actions, zero ingress/effects and server-derived retry/replay targets', async () => {
    const current = await fixture();
    const summary = await verify(current);
    expect(summary).toMatchObject({
      schemaVersion: '1',
      evidenceId: current.manifest.evidenceId,
      mappedHumanPrincipals: 2,
      ingressOutboxes: 0,
      rejectedBusinessEffects: 0,
      unauthorizedRepositoryWriteRejections: 2,
      serverDerivedRetry: 'verified',
      serverDerivedReplay: 'verified',
      plaintextLeaks: 0,
    });
    expect(summary.successCommands).toEqual([
      'approve', 'reject', 'cancel', 'retry', 'replay', 'add_context',
    ]);
    expect(summary.rejectionCases).toHaveLength(12);
  });

  it('rejects business effects on denied callbacks and forged retry/replay targets', async () => {
    const current = await fixture();
    await expect(verify(current, fakeFetch(current, {
      mutateProjection: (eventId, body) => {
        if (eventId !== 'evt_rejected_stale_plan_digest') return;
        (body.counts as Record<string, unknown>).businessEffects = 1;
      },
    }))).rejects.toMatchObject({ code: 'rejected_effect_observed' });
    await expect(verify(current, fakeFetch(current, {
      mutateProjection: (eventId, body) => {
        if (eventId !== 'evt_action_retry') return;
        const action = body.action as Record<string, unknown>;
        (action.businessEffect as Record<string, unknown>).planId = 'plan_payload_selected';
      },
    }))).rejects.toMatchObject({ code: 'business_effect_mismatch' });
    await expect(verify(current, fakeFetch(current, {
      mutateProjection: (eventId, body) => {
        if (eventId !== 'evt_action_replay') return;
        const action = body.action as Record<string, unknown>;
        (action.businessEffect as Record<string, unknown>).targetStepName = 'dispatch-execution';
      },
    }))).rejects.toMatchObject({ code: 'business_effect_mismatch' });
    await expect(verify(current, fakeFetch(current, {
      mutateProjection: (eventId, body) => {
        if (eventId !== 'evt_action_approve') return;
        const action = body.action as Record<string, unknown>;
        (action.businessEffect as Record<string, unknown>).externalEventDigest = digest(249);
      },
    }))).rejects.toMatchObject({ code: 'business_effect_mismatch' });
  });

  it('rejects observability drift and scans raw responses before trusting JSON', async () => {
    const current = await fixture();
    const forged = structuredClone(current.report);
    forged.requests[0]!.responseDigest = digest(250);
    await expect(verify(current, fakeFetch(current, { report: forged })))
      .rejects.toMatchObject({ code: 'observability_digest_mismatch' });
    await expect(verify(current, fakeFetch(current, {
      rawControlPlaneFailure: CANARY,
    }))).rejects.toMatchObject({ code: 'secret_leak_detected' });
  });

  it('never propagates credentials/upstream text and keeps the CLI explicitly opt-in', async () => {
    const current = await fixture();
    const raw = 'CANARY_RAW_ACTION_UPSTREAM_FAILURE';
    const failure = await verify(current, (async () => Response.json(
      { error: raw },
      { status: 503 },
    )) as typeof fetch).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FeishuCardActionEvidenceVerificationError);
    expect(String(failure)).not.toContain(raw);
    expect(String(failure)).not.toContain('CANARY_ACTION_OPERATIONS_TOKEN');
    expect(String(failure)).not.toContain('CANARY_ACTION_OBSERVABILITY_TOKEN');

    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/verify-feishu-card-action-evidence.ts'],
      {
        cwd: resolve('.'),
        env: { ...process.env, DELIVERY_LOOP_FEISHU_CARD_ACTION_E2E: undefined },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('feishu-card-action-e2e: opt-in missing');
  });
});
