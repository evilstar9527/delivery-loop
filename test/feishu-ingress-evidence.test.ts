import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  FeishuIngressEvidenceManifestV1Schema,
  FeishuIngressObservabilityReportV1Schema,
  type FeishuIngressEvidenceManifestV1,
  type FeishuIngressObservabilityReportV1,
} from '../src/domain/feishu-ingress-evidence.js';
import {
  FeishuIngressEvidenceVerificationError,
  verifyFeishuIngressEvidence,
} from '../src/pilot/feishu-ingress-evidence-verifier.js';

const TENANT_KEY = 'tenant_delivery_loop_pilot';
const EVENT_TYPE = 'work_item.updated_v1';
const CONTROL_ORIGIN = 'https://control.example.com';
const OBSERVABILITY_URL = 'https://observability.example.com/feishu/ingress-round-107';
const ACCOUNT_ID = 'a'.repeat(32);
const RUN_ID = 'run_feishu_revision_7';
const TASK_ID = 'task_feishu_revision_7';
const TASK_DIGEST = `sha256:${'c'.repeat(64)}`;
const REQUEST_DIGESTS = [
  `sha256:${'1'.repeat(64)}`,
  `sha256:${'2'.repeat(64)}`,
  `sha256:${'3'.repeat(64)}`,
  `sha256:${'4'.repeat(64)}`,
] as const;

interface Fixture {
  manifest: FeishuIngressEvidenceManifestV1;
  observability: FeishuIngressObservabilityReportV1;
}

function eventObservation(
  eventId: string,
  deliveryId: string,
  requestDigest: string,
  ordinal: number,
) {
  const minute = String(ordinal).padStart(2, '0');
  return {
    case: 'event' as const,
    requestDigest,
    responseDigest: `sha256:${String(ordinal + 4).repeat(64)}`,
    statusCode: 200 as const,
    outcome: 'event_accepted' as const,
    startedAt: `2026-07-27T11:${minute}:00.000Z`,
    completedAt: `2026-07-27T11:${minute}:00.200Z`,
    latencyMs: 200,
    eventId,
    eventType: EVENT_TYPE,
    deliveryId,
  };
}

async function fixture(): Promise<Fixture> {
  const requests = [
    eventObservation('evt_round_107_replayed', 'feishu_webhook_round_107_a', REQUEST_DIGESTS[0], 1),
    eventObservation('evt_round_107_replayed', 'feishu_webhook_round_107_a', REQUEST_DIGESTS[1], 2),
    eventObservation('evt_round_107_replayed', 'feishu_webhook_round_107_a', REQUEST_DIGESTS[2], 3),
    eventObservation('evt_round_107_peer', 'feishu_webhook_round_107_b', REQUEST_DIGESTS[3], 4),
  ];
  const reportBody = {
    schemaVersion: '1' as const,
    evidenceId: 'feishu-ingress-round-107',
    service: 'delivery-loop-control-plane' as const,
    generatedAt: '2026-07-27T11:05:00.000Z',
    requests,
  };
  const observability = FeishuIngressObservabilityReportV1Schema.parse({
    ...reportBody,
    reportDigest: await canonicalSha256(reportBody),
  });
  const manifest = FeishuIngressEvidenceManifestV1Schema.parse({
    schemaVersion: '1',
    evidenceId: reportBody.evidenceId,
    recordedAt: '2026-07-27T11:10:00.000Z',
    tenantKey: TENANT_KEY,
    eventType: EVENT_TYPE,
    observabilityReportUrl: OBSERVABILITY_URL,
    observabilityReportDigest: observability.reportDigest,
    events: {
      replayed: {
        eventId: 'evt_round_107_replayed',
        deliveryId: 'feishu_webhook_round_107_a',
        ingressOutboxId: 'feishu_ingress_round_107_a',
        eventDigest: `sha256:${'a'.repeat(64)}`,
        requestDigests: REQUEST_DIGESTS.slice(0, 3),
        relayAttemptCount: 1,
        queueMessageIdDigest: `sha256:${'d'.repeat(64)}`,
        queueObservationCount: 1,
        maximumQueueDeliveryAttempt: 1,
        enqueuedAt: '2026-07-27T11:04:10.000Z',
        queueObservedAt: '2026-07-27T11:04:11.000Z',
        settledAt: '2026-07-27T11:04:12.000Z',
      },
      sameRevisionPeer: {
        eventId: 'evt_round_107_peer',
        deliveryId: 'feishu_webhook_round_107_b',
        ingressOutboxId: 'feishu_ingress_round_107_b',
        eventDigest: `sha256:${'b'.repeat(64)}`,
        requestDigests: [REQUEST_DIGESTS[3]],
        relayAttemptCount: 1,
        queueMessageIdDigest: `sha256:${'e'.repeat(64)}`,
        queueObservationCount: 1,
        maximumQueueDeliveryAttempt: 1,
        enqueuedAt: '2026-07-27T11:04:13.000Z',
        queueObservedAt: '2026-07-27T11:04:14.000Z',
        settledAt: '2026-07-27T11:04:15.000Z',
      },
    },
    task: {
      sourceSystem: 'meego',
      sourceTaskKey: 'project_1/story/work_item_42',
      taskRevision: 'revision-7',
      taskDigest: TASK_DIGEST,
      taskId: TASK_ID,
      runId: RUN_ID,
      workflowInstanceId: RUN_ID,
      workflowCreateOutboxId: 'outbox_workflow_create_round_107',
    },
    cloudflare: {
      accountIdDigest: await canonicalSha256(ACCOUNT_ID),
      queueName: 'delivery-loop-feishu-ingress',
      queueDashboardUrl: 'https://dash.cloudflare.com/account-id/queues/delivery-loop-feishu-ingress',
      queueReviewedAt: '2026-07-27T11:06:00.000Z',
      workflowName: 'delivery-run',
      workflowInstanceVersionId: '12345678-1234-4234-8234-123456789abc',
      workflowInstanceStatus: 'waiting',
      workflowInstanceStartedAt: '2026-07-27T11:04:20.000Z',
      workflowDashboardUrl: `https://dash.cloudflare.com/account-id/workflows/delivery-run/instances/${RUN_ID}`,
    },
  });
  return { manifest, observability };
}

function projection(
  manifest: FeishuIngressEvidenceManifestV1,
  role: 'replayed' | 'sameRevisionPeer',
): Record<string, unknown> {
  const event = manifest.events[role];
  const startedAt = role === 'replayed'
    ? ['2026-07-27T11:01:00.000Z', '2026-07-27T11:02:00.000Z', '2026-07-27T11:03:00.000Z']
    : ['2026-07-27T11:04:00.000Z'];
  return {
    schemaVersion: '1',
    tenantKey: TENANT_KEY,
    eventId: event.eventId,
    counts: {
      deliveries: 1,
      transportReceipts: event.requestDigests.length,
      ingressOutboxes: 1,
      queueMessageIdentities: 1,
      queueObservations: event.queueObservationCount,
      tasks: 1,
      runs: 1,
      workflowCreateOutboxes: 1,
    },
    delivery: {
      deliveryId: event.deliveryId,
      eventType: EVENT_TYPE,
      eventDigest: event.eventDigest,
      verificationMode: 'encrypted',
      receivedAt: startedAt[0],
    },
    transportReceipts: event.requestDigests.map((requestDigest, index) => ({
      requestTimestamp: startedAt[index],
      requestDigest,
      receivedAt: new Date(Date.parse(startedAt[index]!) + 100).toISOString(),
    })),
    ingress: {
      outboxId: event.ingressOutboxId,
      deliveryId: event.deliveryId,
      eventType: EVENT_TYPE,
      eventDigest: event.eventDigest,
      deliveryState: 'settled',
      relayAttemptCount: event.relayAttemptCount,
      enqueuedAt: event.enqueuedAt,
      queueObservedAt: event.queueObservedAt,
      taskId: TASK_ID,
      runId: RUN_ID,
      taskDigest: TASK_DIGEST,
      settledAt: event.settledAt,
    },
    queueObservations: [{
      queueName: 'delivery-loop-feishu-ingress',
      queueMessageIdDigest: event.queueMessageIdDigest,
      deliveryAttempt: 1,
      messageTimestamp: event.enqueuedAt,
      observedAt: event.queueObservedAt,
    }],
    task: {
      sourceSystem: 'meego',
      tenantKey: TENANT_KEY,
      sourceTaskKey: manifest.task.sourceTaskKey,
      taskRevision: manifest.task.taskRevision,
      taskDigest: TASK_DIGEST,
      taskId: TASK_ID,
      runId: RUN_ID,
      workflowInstanceId: RUN_ID,
      runState: 'queued',
      workflowCreateOutboxId: manifest.task.workflowCreateOutboxId,
      workflowCreateState: 'settled',
    },
  };
}

function cloudflareInstance(manifest: FeishuIngressEvidenceManifestV1): Record<string, unknown> {
  return {
    success: true,
    errors: [],
    messages: [],
    result: {
      status: manifest.cloudflare.workflowInstanceStatus,
      versionId: manifest.cloudflare.workflowInstanceVersionId,
      start: manifest.cloudflare.workflowInstanceStartedAt,
    },
  };
}

function fakeFetch(
  evidence: Fixture,
  options: {
    observability?: unknown;
    replayed?: unknown;
    peer?: unknown;
    cloudflare?: unknown;
    raw?: string;
  } = {},
): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === 'https://observability.example.com') {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer CANARY_OBSERVABILITY_TOKEN' });
      return Response.json(options.observability ?? evidence.observability);
    }
    if (url.origin === CONTROL_ORIGIN) {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer CANARY_OPERATIONS_TOKEN' });
      const eventId = url.searchParams.get('eventId');
      return Response.json(eventId === evidence.manifest.events.replayed.eventId
        ? options.replayed ?? projection(evidence.manifest, 'replayed')
        : options.peer ?? projection(evidence.manifest, 'sameRevisionPeer'));
    }
    if (url.origin === 'https://api.cloudflare.test') {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer CANARY_CLOUDFLARE_TOKEN' });
      return Response.json(options.cloudflare ?? cloudflareInstance(evidence.manifest));
    }
    return Response.json({ message: options.raw ?? 'not found' }, { status: 404 });
  }) as typeof fetch;
}

function verify(evidence: Fixture, fetcher: typeof fetch) {
  return verifyFeishuIngressEvidence(evidence.manifest, {
    controlPlaneOrigin: CONTROL_ORIGIN,
    operationsToken: 'CANARY_OPERATIONS_TOKEN',
    observabilityReportUrl: evidence.manifest.observabilityReportUrl,
    observabilityToken: 'CANARY_OBSERVABILITY_TOKEN',
    cloudflareAccountId: ACCOUNT_ID,
    cloudflareToken: 'CANARY_CLOUDFLARE_TOKEN',
    cloudflareApiOrigin: 'https://api.cloudflare.test/client/v4',
    fetch: fetcher,
  });
}

describe('real Feishu ingress replay evidence', () => {
  it('requires exactly three replay receipts and one same-revision peer event', async () => {
    const evidence = await fixture();
    expect(FeishuIngressEvidenceManifestV1Schema.safeParse(evidence.manifest).success).toBe(true);
    expect(FeishuIngressEvidenceManifestV1Schema.safeParse({
      ...evidence.manifest,
      events: {
        ...evidence.manifest.events,
        replayed: {
          ...evidence.manifest.events.replayed,
          requestDigests: evidence.manifest.events.replayed.requestDigests.slice(0, 2),
        },
      },
    }).success).toBe(false);
    expect(FeishuIngressEvidenceManifestV1Schema.safeParse({
      ...evidence.manifest,
      task: { ...evidence.manifest.task, workflowInstanceId: 'another-run' },
    }).success).toBe(false);
    expect(FeishuIngressEvidenceManifestV1Schema.safeParse({
      ...evidence.manifest,
      rawPayload: 'CANARY_RAW_FEISHU_PAYLOAD',
    }).success).toBe(false);

    const exampleManifest = JSON.parse(await readFile(
      new URL('../schemas/feishu-ingress-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    const exampleReport = FeishuIngressObservabilityReportV1Schema.parse(JSON.parse(
      await readFile(
        new URL('../schemas/feishu-ingress-observability-v1.example.json', import.meta.url),
        'utf8',
      ),
    ));
    expect(FeishuIngressEvidenceManifestV1Schema.safeParse(exampleManifest).success).toBe(true);
    const reportBody = Object.fromEntries(
      Object.entries(exampleReport).filter(([key]) => key !== 'reportDigest'),
    );
    expect(await canonicalSha256(reportBody)).toBe(exampleReport.reportDigest);
  });

  it('cross-checks four HTTP receipts, two Queue lineages, one Task/Run, and one live Workflow', async () => {
    const evidence = await fixture();
    const summary = await verify(evidence, fakeFetch(evidence));
    expect(summary).toEqual({
      schemaVersion: '1',
      evidenceId: evidence.manifest.evidenceId,
      tenantKey: TENANT_KEY,
      replayedEventId: evidence.manifest.events.replayed.eventId,
      replayTransportReceiptCount: 3,
      logicalIngressOutboxCount: 2,
      distinctQueueMessageCount: 2,
      queueObservationCount: 2,
      sameRevisionEventCount: 2,
      taskId: TASK_ID,
      runId: RUN_ID,
      workflowInstanceId: RUN_ID,
      workflowCreateOutboxCount: 1,
      duplicateTasks: 0,
      duplicateRuns: 0,
    });
    expect(JSON.stringify(summary)).not.toContain('CANARY_');
  });

  it('rejects transport, Queue, Task/Run, and workflow-create drift', async () => {
    const evidence = await fixture();
    const replayed = projection(evidence.manifest, 'replayed');
    await expect(verify(evidence, fakeFetch(evidence, {
      replayed: {
        ...replayed,
        transportReceipts: (replayed.transportReceipts as unknown[]).slice(0, 2),
        counts: { ...(replayed.counts as object), transportReceipts: 2 },
      },
    }))).rejects.toMatchObject({ code: 'transport_replay_mismatch' });
    await expect(verify(evidence, fakeFetch(evidence, {
      replayed: {
        ...replayed,
        counts: { ...(replayed.counts as object), queueMessageIdentities: 2 },
      },
    }))).rejects.toMatchObject({ code: 'queue_lineage_mismatch' });
    const peer = projection(evidence.manifest, 'sameRevisionPeer');
    await expect(verify(evidence, fakeFetch(evidence, {
      peer: {
        ...peer,
        task: { ...(peer.task as object), runId: 'run_other_revision' },
      },
    }))).rejects.toMatchObject({ code: 'task_revision_mismatch' });
    await expect(verify(evidence, fakeFetch(evidence, {
      peer: {
        ...peer,
        counts: { ...(peer.counts as object), workflowCreateOutboxes: 2 },
      },
    }))).rejects.toMatchObject({ code: 'workflow_identity_mismatch' });
  });

  it('rejects observability or live Cloudflare Workflow drift', async () => {
    const evidence = await fixture();
    await expect(verify(evidence, fakeFetch(evidence, {
      observability: { ...evidence.observability, generatedAt: '2026-07-27T11:05:01.000Z' },
    }))).rejects.toMatchObject({ code: 'observability_digest_mismatch' });
    await expect(verify(evidence, fakeFetch(evidence, {
      cloudflare: {
        ...cloudflareInstance(evidence.manifest),
        result: {
          ...(cloudflareInstance(evidence.manifest).result as object),
          status: 'errored',
        },
      },
    }))).rejects.toMatchObject({ code: 'cloudflare_instance_mismatch' });
  });

  it('binds configured authorities, bounds errors, and keeps live execution opt-in', async () => {
    const evidence = await fixture();
    let calls = 0;
    await expect(verifyFeishuIngressEvidence(evidence.manifest, {
      controlPlaneOrigin: CONTROL_ORIGIN,
      operationsToken: 'CANARY_OPERATIONS_TOKEN',
      observabilityReportUrl: 'https://attacker.example/collect',
      observabilityToken: 'CANARY_OBSERVABILITY_TOKEN',
      cloudflareAccountId: ACCOUNT_ID,
      cloudflareToken: 'CANARY_CLOUDFLARE_TOKEN',
      cloudflareApiOrigin: 'https://api.cloudflare.test/client/v4',
      fetch: async () => {
        calls += 1;
        return Response.json({});
      },
    })).rejects.toMatchObject({ code: 'configuration_invalid' });
    expect(calls).toBe(0);

    const raw = 'CANARY_RAW_FEISHU_INGRESS_UPSTREAM';
    const failure = await verify(evidence, async () => new Response(raw, { status: 503 }))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FeishuIngressEvidenceVerificationError);
    expect(String(failure)).not.toContain(raw);
    expect(String(failure)).not.toContain('CANARY_OPERATIONS_TOKEN');
    expect(String(failure)).not.toContain('CANARY_CLOUDFLARE_TOKEN');

    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_FEISHU_INGRESS_E2E;
    const result = spawnSync(
      resolve('node_modules/.bin/tsx'),
      ['scripts/verify-feishu-ingress-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('feishu-ingress-e2e: opt-in missing');
  });
});
