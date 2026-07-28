import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  SupplementalContextEvidenceManifestV1Schema,
  SupplementalContextObservabilityReportV1Schema,
  type SupplementalContextEvidenceManifestV1,
  type SupplementalContextObservabilityReportV1,
} from '../src/domain/supplemental-context-evidence.js';
import {
  SupplementalContextEvidenceVerificationError,
  verifySupplementalContextEvidence,
} from '../src/pilot/supplemental-context-evidence-verifier.js';

const CONTROL_ORIGIN = 'https://control.example';
const OBSERVER_URL = 'https://observer.example/supplemental-context/round-111';
const FEISHU_ORIGIN = 'https://open.feishu.cn';
const OPERATIONS_TOKEN = 'operations-purpose-token';
const OBSERVER_TOKEN = 'observer-purpose-token';
const FEISHU_TOKEN = 'feishu-purpose-token';
const CANARY = 'supplemental-context-synthetic-canary';
const RECORDED_AT = '2026-07-27T10:00:00.000Z';

function digest(index: number): `sha256:${string}` {
  return `sha256:${index.toString(16).padStart(2, '0').repeat(32)}`;
}

interface Fixture {
  manifest: SupplementalContextEvidenceManifestV1;
  report: SupplementalContextObservabilityReportV1;
  projections: Map<string, Record<string, unknown>>;
  message: Record<string, unknown>;
}

function runSnapshot(
  runId: string,
  version: number,
  state: 'executing' | 'planning',
  updatedAt: string,
) {
  return {
    runId,
    state,
    version,
    baseSha: 'a'.repeat(40),
    activePlanId: `plan_${runId}`,
    activePlanVersion: 2,
    activePlanDigest: digest(31),
    updatedAt,
  };
}

function priorAttempt(
  attemptId: string,
  planId: string,
  status: 'running' | 'cancelled',
  version: number,
  leaseGeneration: number,
  updatedAt: string,
) {
  return {
    attemptId,
    mode: 'implement',
    status,
    planId,
    planVersion: 2,
    version,
    leaseGeneration,
    updatedAt,
    tokenCount: 1,
    revokedTokenCount: status === 'cancelled' ? 1 : 0,
  };
}

async function fixture(): Promise<Fixture> {
  const card = {
    schemaVersion: '2',
    elements: [{
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '补充上下文·新 Run' } },
        { tag: 'button', text: { tag: 'plain_text', content: '补充上下文·当前 Run' } },
      ],
    }],
  };
  const feishuCases = [
    {
      mode: 'new_run' as const,
      tenantKey: 'tenant_delivery_loop',
      eventId: 'evt_context_new_run',
      deliveryId: 'delivery_context_new_run',
      actionReceiptId: 'receipt_context_new_run',
      outcomeId: 'outcome_context_new_run',
      operatorDigest: digest(1),
      contextId: 'supplemental_context_new_run',
      priorTaskId: 'task_context_prior_new',
      newTaskId: 'task_context_next_new',
      newRunId: 'run_context_next_new',
      sourceRunId: 'run_context_prior_new',
      expectedRunVersion: 7,
      priorAttemptId: 'attempt_context_prior_new',
      priorAttemptVersion: 4,
      priorAttemptLeaseGeneration: 3,
      contextDigest: digest(2),
      newTaskDigest: digest(3),
      planRevisionId: null,
      analysisAttemptId: null,
    },
    {
      mode: 'apply_current' as const,
      tenantKey: 'tenant_delivery_loop',
      eventId: 'evt_context_apply_current',
      deliveryId: 'delivery_context_apply_current',
      actionReceiptId: 'receipt_context_apply_current',
      outcomeId: 'outcome_context_apply_current',
      operatorDigest: digest(4),
      contextId: 'supplemental_context_apply_current',
      priorTaskId: 'task_context_prior_apply',
      newTaskId: 'task_context_next_apply',
      newRunId: 'run_context_next_apply',
      sourceRunId: 'run_context_prior_apply',
      expectedRunVersion: 8,
      priorAttemptId: 'attempt_context_prior_apply',
      priorAttemptVersion: 5,
      priorAttemptLeaseGeneration: 4,
      contextDigest: digest(5),
      newTaskDigest: digest(6),
      planRevisionId: 'revision_context_apply',
      analysisAttemptId: 'attempt_context_analysis_apply',
    },
  ];
  const meegleConvergence = {
    tenantKey: 'tenant_delivery_loop',
    projectKey: 'project_delivery_loop',
    workItemTypeKey: 'story',
    workItemId: 'work_item_context_42',
    externalRevision: 'revision_context_42',
    contextId: 'supplemental_context_meegle',
    priorTaskId: 'task_context_prior_meegle',
    newTaskId: 'task_context_next_meegle',
    newRunId: 'run_context_next_meegle',
    contextDigest: digest(7),
    newTaskDigest: digest(8),
    eventIds: ['evt_meegle_context_primary', 'evt_meegle_context_peer'] as const,
    ingressOutboxIds: ['ingress_meegle_context_primary', 'ingress_meegle_context_peer'] as const,
    exactSnapshotDigests: [digest(9), digest(10)] as const,
    mappingSnapshotDigest: digest(11),
    mappingProfileDigest: digest(12),
  };
  const observations = [
    ['feishu_new_run', 'feishu', feishuCases[0]!.eventId],
    ['feishu_apply_current', 'feishu', feishuCases[1]!.eventId],
    ['meegle_primary', 'meegle', meegleConvergence.eventIds[0]],
    ['meegle_primary_retry', 'meegle', meegleConvergence.eventIds[0]],
    ['meegle_peer', 'meegle', meegleConvergence.eventIds[1]],
  ].map(([scenario, provider, eventId], index) => ({
    scenario,
    provider,
    eventId,
    requestDigest: digest(40 + index),
    responseDigest: digest(50 + index),
    statusCode: 200,
    startedAt: `2026-07-27T09:0${index}:00.000Z`,
    completedAt: `2026-07-27T09:0${index}:00.100Z`,
    latencyMs: 100,
  }));
  const reportBody = {
    schemaVersion: '1' as const,
    evidenceId: 'supplemental_context_round_111',
    service: 'delivery-loop-supplemental-context-observer' as const,
    generatedAt: '2026-07-27T09:10:00.000Z',
    requests: observations,
  };
  const report = SupplementalContextObservabilityReportV1Schema.parse({
    ...reportBody,
    reportDigest: await canonicalSha256(reportBody),
  });
  const manifest = SupplementalContextEvidenceManifestV1Schema.parse({
    schemaVersion: '1',
    evidenceId: report.evidenceId,
    recordedAt: RECORDED_AT,
    controlPlaneOrigin: CONTROL_ORIGIN,
    observabilityReportUrl: OBSERVER_URL,
    observabilityReportDigest: report.reportDigest,
    application: {
      appId: 'cli_delivery_loop',
      tenantKey: 'tenant_delivery_loop',
      chatId: 'oc_delivery_loop_pilot',
      callbackUrl: `${CONTROL_ORIGIN}/v1/webhooks/feishu`,
    },
    card: {
      messageId: 'om_supplemental_context',
      cardDigest: await canonicalSha256(card),
      createdAt: '2026-07-27T08:00:00.000Z',
      updatedAt: '2026-07-27T09:30:00.000Z',
    },
    feishuCases,
    meegleConvergence,
    safety: { canaryDigest: await canonicalSha256(CANARY) },
    review: {
      feishuDeveloperConsoleUrl: 'https://open.feishu.cn/app/cli_delivery_loop/event',
      feishuPermissionUrl: 'https://open.feishu.cn/app/cli_delivery_loop/permission',
      feishuChatUrl: 'https://example.feishu.cn/messenger/chat/oc_delivery_loop_pilot',
      feishuMappingEvidenceUrl: 'https://evidence.example/feishu/context-mapping.json',
      meegleProjectUrl: 'https://example.feishu.cn/meegle/projects/project_delivery_loop',
      screenshotBundleUrl: 'https://evidence.example/supplemental-context/round-111/',
      reviewer: 'release_owner',
      reviewedAt: '2026-07-27T09:45:00.000Z',
      eventSubscription: 'active',
      botMembership: 'member',
      meegleProjectAccess: 'verified',
      feishuScopes: [
        'im:message:send_as_bot',
        'im:message:update',
        'im:message:readonly',
        'im:message.group_msg',
      ],
    },
  });

  const projections = new Map<string, Record<string, unknown>>();
  for (const expected of manifest.feishuCases) {
    const apply = expected.mode === 'apply_current';
    const planId = `plan_${expected.sourceRunId}`;
    const createdAt = apply ? '2026-07-27T09:01:00.100Z' : '2026-07-27T09:00:00.100Z';
    const before = priorAttempt(
      expected.priorAttemptId,
      planId,
      apply ? 'cancelled' : 'running',
      expected.priorAttemptVersion + (apply ? 1 : 0),
      expected.priorAttemptLeaseGeneration + (apply ? 1 : 0),
      apply ? createdAt : '2026-07-27T08:55:00.000Z',
    );
    const current = runSnapshot(
      expected.sourceRunId,
      expected.expectedRunVersion + (apply ? 1 : 0),
      apply ? 'planning' : 'executing',
      apply ? createdAt : '2026-07-27T08:55:00.000Z',
    );
    projections.set(expected.contextId, {
      schemaVersion: '1',
      contextId: expected.contextId,
      lineage: {
        eventDigest: digest(apply ? 61 : 60),
        priorTaskId: expected.priorTaskId,
        priorTaskRevisionDigest: digest(apply ? 63 : 62),
        newTaskId: expected.newTaskId,
        newTaskRevisionDigest: digest(apply ? 65 : 64),
        newTaskDigest: expected.newTaskDigest,
        newRunId: expected.newRunId,
        contextDigest: expected.contextDigest,
        mode: expected.mode,
        createdAt,
      },
      source: {
        system: 'feishu', tenantKey: expected.tenantKey, taskKey: `work_item_${expected.mode}`,
        revision: `revision_${expected.mode}`, repository: 'example/delivery-target',
        baseBranch: 'main', environment: 'test', intentKind: 'bug',
      },
      objects: { contextVerified: true, newTaskVerified: true },
      newRun: {
        runId: expected.newRunId,
        state: apply ? 'cancelled' : 'queued',
        version: apply ? 1 : 0,
        workflowInstanceId: expected.newRunId,
        updatedAt: createdAt,
      },
      workflowCreate: {
        outboxId: `outbox_${expected.newRunId}`,
        deliveryState: apply ? 'settled' : 'pending',
        lastErrorCode: apply ? 'supplemental_context_absorbed' : null,
        attemptCount: 0,
        createdAt,
        updatedAt: createdAt,
      },
      feishuActions: [{
        actionReceiptId: expected.actionReceiptId,
        deliveryId: expected.deliveryId,
        tenantKey: expected.tenantKey,
        eventId: expected.eventId,
        eventDigest: digest(apply ? 71 : 70),
        operatorDigest: expected.operatorDigest,
        messageId: manifest.card.messageId,
        cardId: `card_${expected.mode}`,
        presentationId: `presentation_${expected.mode}`,
        sourceRunId: expected.sourceRunId,
        sourceRunVersion: expected.expectedRunVersion,
        planId,
        planVersion: 2,
        planDigest: digest(31),
        baseSha: 'a'.repeat(40),
        contextMode: expected.mode,
        outcomeId: expected.outcomeId,
        resultId: expected.newTaskId,
        receivedAt: createdAt,
        completedAt: createdAt,
        currentSourceRun: current,
        priorPlanAttempts: [before],
        priorApprovalCount: 1,
        approvalInvalidationCount: apply ? 1 : 0,
        planRevisionCount: apply ? 1 : 0,
      }],
      meegleMappings: [],
      currentRunSnapshot: apply ? current : null,
      planRevision: apply ? {
        revisionId: expected.planRevisionId,
        expectedRunVersion: expected.expectedRunVersion,
        priorPlanId: planId,
        priorPlanVersion: 2,
        priorPlanDigest: digest(31),
        sourceDigest: expected.contextDigest,
        requestedBaseSha: 'a'.repeat(40),
        analysisAttemptId: expected.analysisAttemptId,
        status: 'analyzing',
        createdAt,
        analysisAttemptStatus: 'pending',
        analysisAttemptVersion: 0,
        analysisAttemptLeaseGeneration: 0,
        analysisOutboxId: 'outbox_analysis_context_apply',
        analysisOutboxDeliveryState: 'pending',
        analysisOutboxAttemptCount: 0,
        priorApprovalCount: 1,
        approvalInvalidationCount: 1,
      } : null,
      attempts: apply ? [before] : [],
      counts: {
        contextRevisions: 1, newTasks: 1, newRuns: 1, workflowCreates: 1,
        planRevisions: apply ? 1 : 0, feishuActions: 1, meegleMappings: 0,
      },
    });
  }

  projections.set(manifest.meegleConvergence.contextId, {
    schemaVersion: '1',
    contextId: manifest.meegleConvergence.contextId,
    lineage: {
      eventDigest: digest(80),
      priorTaskId: manifest.meegleConvergence.priorTaskId,
      priorTaskRevisionDigest: digest(81),
      newTaskId: manifest.meegleConvergence.newTaskId,
      newTaskRevisionDigest: digest(82),
      newTaskDigest: manifest.meegleConvergence.newTaskDigest,
      newRunId: manifest.meegleConvergence.newRunId,
      contextDigest: manifest.meegleConvergence.contextDigest,
      mode: 'new_run',
      createdAt: '2026-07-27T09:02:00.100Z',
    },
    source: {
      system: 'meego', tenantKey: manifest.meegleConvergence.tenantKey,
      taskKey: manifest.meegleConvergence.workItemId,
      revision: manifest.meegleConvergence.externalRevision,
      repository: 'example/delivery-target', baseBranch: 'main',
      environment: 'test', intentKind: 'requirement',
    },
    objects: { contextVerified: true, newTaskVerified: true },
    newRun: {
      runId: manifest.meegleConvergence.newRunId,
      state: 'queued', version: 0,
      workflowInstanceId: manifest.meegleConvergence.newRunId,
      updatedAt: '2026-07-27T09:02:00.100Z',
    },
    workflowCreate: {
      outboxId: 'outbox_context_meegle', deliveryState: 'pending', lastErrorCode: null,
      attemptCount: 0, createdAt: '2026-07-27T09:02:00.100Z',
      updatedAt: '2026-07-27T09:02:00.100Z',
    },
    feishuActions: [],
    meegleMappings: manifest.meegleConvergence.eventIds.map((eventId, index) => ({
      ingressOutboxId: manifest.meegleConvergence.ingressOutboxIds[index]!,
      eventId,
      tenantKey: manifest.meegleConvergence.tenantKey,
      projectKey: manifest.meegleConvergence.projectKey,
      workItemTypeKey: manifest.meegleConvergence.workItemTypeKey,
      workItemId: manifest.meegleConvergence.workItemId,
      externalRevision: manifest.meegleConvergence.externalRevision,
      exactSnapshotDigest: manifest.meegleConvergence.exactSnapshotDigests[index]!,
      mappingSnapshotDigest: manifest.meegleConvergence.mappingSnapshotDigest,
      mappingProfileVersion: 3,
      mappingProfileDigest: manifest.meegleConvergence.mappingProfileDigest,
      taskId: manifest.meegleConvergence.newTaskId,
      runId: manifest.meegleConvergence.newRunId,
      createdAt: `2026-07-27T09:0${2 + index}:00.100Z`,
    })),
    currentRunSnapshot: null,
    planRevision: null,
    attempts: [],
    counts: {
      contextRevisions: 1, newTasks: 1, newRuns: 1, workflowCreates: 1,
      planRevisions: 0, feishuActions: 0, meegleMappings: 2,
    },
  });

  const message = {
    code: 0,
    data: { items: [{
      message_id: manifest.card.messageId,
      msg_type: 'interactive',
      deleted: false,
      chat_id: manifest.application.chatId,
      sender: {
        sender_type: 'app',
        id: manifest.application.appId,
        tenant_key: manifest.application.tenantKey,
      },
      create_time: String(Date.parse(manifest.card.createdAt)),
      update_time: String(Date.parse(manifest.card.updatedAt)),
      body: { content: JSON.stringify(card) },
    }] },
  };
  return { manifest, report, projections, message };
}

function verifierFetcher(data: Fixture): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get('authorization');
    if (url === OBSERVER_URL) {
      expect(authorization).toBe(`Bearer ${OBSERVER_TOKEN}`);
      return Response.json(data.report);
    }
    if (url.startsWith(`${CONTROL_ORIGIN}/v1/operations/supplemental-context/evidence`)) {
      expect(authorization).toBe(`Bearer ${OPERATIONS_TOKEN}`);
      const contextId = new URL(url).searchParams.get('contextId') ?? '';
      const projection = data.projections.get(contextId);
      return projection === undefined ? new Response(null, { status: 404 }) : Response.json(projection);
    }
    if (url.startsWith(`${FEISHU_ORIGIN}/open-apis/im/v1/messages/`)) {
      expect(authorization).toBe(`Bearer ${FEISHU_TOKEN}`);
      return Response.json(data.message);
    }
    return new Response(null, { status: 404 });
  };
}

function options(data: Fixture) {
  return {
    controlPlaneOrigin: CONTROL_ORIGIN,
    operationsToken: OPERATIONS_TOKEN,
    observabilityReportUrl: OBSERVER_URL,
    observabilityToken: OBSERVER_TOKEN,
    feishuApiOrigin: FEISHU_ORIGIN,
    feishuAccessToken: FEISHU_TOKEN,
    canary: CANARY,
    fetcher: verifierFetcher(data),
  };
}

describe('supplemental context external evidence', () => {
  it('requires strict, digest-bound, complete evidence schemas', async () => {
    const data = await fixture();
    expect(SupplementalContextEvidenceManifestV1Schema.parse(data.manifest)).toEqual(data.manifest);
    expect(SupplementalContextObservabilityReportV1Schema.parse(data.report)).toEqual(data.report);
    const manifestExample = JSON.parse(readFileSync(
      new URL('../schemas/supplemental-context-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    const reportExample = JSON.parse(readFileSync(
      new URL('../schemas/supplemental-context-observability-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    expect(SupplementalContextEvidenceManifestV1Schema.safeParse(manifestExample).success).toBe(true);
    expect(SupplementalContextObservabilityReportV1Schema.safeParse(reportExample).success).toBe(true);
    expect(() => SupplementalContextEvidenceManifestV1Schema.parse({
      ...data.manifest,
      extra: true,
    })).toThrow();
    expect(() => SupplementalContextEvidenceManifestV1Schema.parse({
      ...data.manifest,
      feishuCases: [data.manifest.feishuCases[0], data.manifest.feishuCases[0]],
    })).toThrow();
    expect(() => SupplementalContextEvidenceManifestV1Schema.parse({
      ...data.manifest,
      meegleConvergence: {
        ...data.manifest.meegleConvergence,
        eventIds: [
          data.manifest.meegleConvergence.eventIds[0],
          data.manifest.meegleConvergence.eventIds[0],
        ],
      },
    })).toThrow();
  });

  it('cross-checks two Feishu choices, two Meegle events, R2 proofs, and the live card', async () => {
    const data = await fixture();
    await expect(verifySupplementalContextEvidence(data.manifest, options(data))).resolves.toEqual({
      schemaVersion: '1',
      evidenceId: data.manifest.evidenceId,
      contextCount: 3,
      feishuModes: 2,
      meegleEvents: 2,
      objectIntegrity: 'verified',
      currentRunIsolation: 'verified',
      applyCurrentFencing: 'verified',
      liveCardActions: 'verified',
      plaintextLeaks: 0,
    });
  });

  it('fails closed on current-Run mutation, fencing drift, and Meegle duplicate effects', async () => {
    const data = await fixture();
    const newCase = data.manifest.feishuCases.find((item) => item.mode === 'new_run')!;
    const newProjection = data.projections.get(newCase.contextId)!;
    ((newProjection.feishuActions as Array<Record<string, unknown>>)[0]!
      .currentSourceRun as Record<string, unknown>).version = newCase.expectedRunVersion + 1;
    await expect(verifySupplementalContextEvidence(data.manifest, options(data))).rejects.toMatchObject({
      code: 'new_run_mismatch',
    });

    const applyData = await fixture();
    const applyCase = applyData.manifest.feishuCases.find((item) => item.mode === 'apply_current')!;
    const applyProjection = applyData.projections.get(applyCase.contextId)!;
    (applyProjection.planRevision as Record<string, unknown>).approvalInvalidationCount = 0;
    await expect(
      verifySupplementalContextEvidence(applyData.manifest, options(applyData)),
    ).rejects.toMatchObject({ code: 'apply_current_mismatch' });

    const meegleData = await fixture();
    const meegleProjection = meegleData.projections.get(
      meegleData.manifest.meegleConvergence.contextId,
    )!;
    meegleProjection.counts = {
      ...(meegleProjection.counts as Record<string, unknown>),
      newRuns: 2,
    };
    await expect(
      verifySupplementalContextEvidence(meegleData.manifest, options(meegleData)),
    ).rejects.toMatchObject({ code: 'control_plane_response_invalid' });
  });

  it('rejects object/card drift, canary leakage, and purpose-token crossover', async () => {
    const objectData = await fixture();
    const projection = objectData.projections.get(objectData.manifest.feishuCases[0]!.contextId)!;
    projection.objects = { contextVerified: false, newTaskVerified: true };
    await expect(
      verifySupplementalContextEvidence(objectData.manifest, options(objectData)),
    ).rejects.toMatchObject({ code: 'object_integrity_mismatch' });

    const cardData = await fixture();
    const item = ((cardData.message.data as { items: Array<Record<string, unknown>> }).items[0])!;
    (item.body as Record<string, unknown>).content = JSON.stringify({ elements: [] });
    await expect(
      verifySupplementalContextEvidence(cardData.manifest, options(cardData)),
    ).rejects.toMatchObject({ code: 'card_actions_mismatch' });

    const canaryData = await fixture();
    const fetcher = verifierFetcher(canaryData);
    await expect(verifySupplementalContextEvidence(canaryData.manifest, {
      ...options(canaryData),
      fetcher: async (input, init) => {
        if (String(input) === OBSERVER_URL) {
          return Response.json({ ...canaryData.report, leaked: CANARY });
        }
        return await fetcher(input, init);
      },
    })).rejects.toMatchObject({ code: 'secret_leak_detected' });

    await expect(verifySupplementalContextEvidence(canaryData.manifest, {
      ...options(canaryData),
      operationsToken: OBSERVER_TOKEN,
    })).rejects.toBeInstanceOf(SupplementalContextEvidenceVerificationError);
  });

  it('keeps the CLI explicitly opted in with stable prerequisite exit 2', () => {
    const command = ['exec', 'tsx', 'scripts/verify-supplemental-context-evidence.ts'];
    const withoutOptIn = spawnSync('pnpm', command, {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, DELIVERY_LOOP_SUPPLEMENTAL_CONTEXT_E2E: '' },
    });
    expect(withoutOptIn.status).toBe(2);
    expect(withoutOptIn.stderr).toContain('supplemental-context-e2e: opt-in missing');
    const missing = spawnSync('pnpm', command, {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, DELIVERY_LOOP_SUPPLEMENTAL_CONTEXT_E2E: '1' },
    });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('required evidence configuration is incomplete');
  });
});
