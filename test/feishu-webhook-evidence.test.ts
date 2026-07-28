import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  FeishuWebhookEvidenceManifestV1Schema,
  FeishuWebhookObservabilityReportV1Schema,
  type FeishuWebhookEvidenceManifestV1,
  type FeishuWebhookObservabilityReportV1,
} from '../src/domain/feishu-webhook-evidence.js';
import {
  FeishuWebhookEvidenceVerificationError,
  verifyFeishuWebhookEvidence,
} from '../src/pilot/feishu-webhook-evidence-verifier.js';

const APP_ID = 'cli_delivery_loop_pilot';
const TENANT_KEY = 'tenant_delivery_loop_pilot';
const CALLBACK_URL = 'https://control.example.com/v1/webhooks/feishu';
const OBSERVABILITY_URL = 'https://observability.example.com/feishu/round-106';
const RECORDED_AT = '2026-07-27T10:10:00.000Z';
const DIGESTS = {
  challengeRequest: `sha256:${'1'.repeat(64)}`,
  challengeResponse: `sha256:${'2'.repeat(64)}`,
  eventRequest: `sha256:${'3'.repeat(64)}`,
  eventResponse: `sha256:${'4'.repeat(64)}`,
  eventBody: `sha256:${'5'.repeat(64)}`,
  invalidSignatureRequest: `sha256:${'6'.repeat(64)}`,
  invalidSignatureResponse: `sha256:${'7'.repeat(64)}`,
  expiredTimestampRequest: `sha256:${'8'.repeat(64)}`,
  expiredTimestampResponse: `sha256:${'9'.repeat(64)}`,
  wrongTenantRequest: `sha256:${'a'.repeat(64)}`,
  wrongTenantResponse: `sha256:${'b'.repeat(64)}`,
} as const;

interface Fixture {
  manifest: FeishuWebhookEvidenceManifestV1;
  observability: FeishuWebhookObservabilityReportV1;
}

async function fixture(): Promise<Fixture> {
  const requests = [
    {
      case: 'challenge' as const,
      requestDigest: DIGESTS.challengeRequest,
      responseDigest: DIGESTS.challengeResponse,
      statusCode: 200 as const,
      outcome: 'challenge_echoed' as const,
      startedAt: '2026-07-27T10:00:00.000Z',
      completedAt: '2026-07-27T10:00:00.420Z',
      latencyMs: 420,
    },
    {
      case: 'event' as const,
      requestDigest: DIGESTS.eventRequest,
      responseDigest: DIGESTS.eventResponse,
      statusCode: 200 as const,
      outcome: 'event_accepted' as const,
      startedAt: '2026-07-27T10:01:00.000Z',
      completedAt: '2026-07-27T10:01:00.630Z',
      latencyMs: 630,
      eventId: 'evt_round_106_success',
      eventType: 'im.message.receive_v1',
      deliveryId: 'feishu_webhook_round_106_success',
    },
    {
      case: 'invalid_signature' as const,
      requestDigest: DIGESTS.invalidSignatureRequest,
      responseDigest: DIGESTS.invalidSignatureResponse,
      statusCode: 401 as const,
      outcome: 'signature_invalid' as const,
      startedAt: '2026-07-27T10:02:00.000Z',
      completedAt: '2026-07-27T10:02:00.050Z',
      latencyMs: 50,
    },
    {
      case: 'expired_timestamp' as const,
      requestDigest: DIGESTS.expiredTimestampRequest,
      responseDigest: DIGESTS.expiredTimestampResponse,
      statusCode: 401 as const,
      outcome: 'timestamp_invalid' as const,
      startedAt: '2026-07-27T10:03:00.000Z',
      completedAt: '2026-07-27T10:03:00.040Z',
      latencyMs: 40,
    },
    {
      case: 'wrong_tenant' as const,
      requestDigest: DIGESTS.wrongTenantRequest,
      responseDigest: DIGESTS.wrongTenantResponse,
      statusCode: 403 as const,
      outcome: 'binding_rejected' as const,
      startedAt: '2026-07-27T10:04:00.000Z',
      completedAt: '2026-07-27T10:04:00.070Z',
      latencyMs: 70,
      eventId: 'evt_round_106_wrong_tenant',
      eventType: 'im.message.receive_v1',
    },
  ];
  const reportBody = {
    schemaVersion: '1' as const,
    evidenceId: 'feishu-webhook-round-106',
    service: 'delivery-loop-control-plane' as const,
    callbackUrl: CALLBACK_URL,
    generatedAt: '2026-07-27T10:06:00.000Z',
    requests,
  };
  const observability = FeishuWebhookObservabilityReportV1Schema.parse({
    ...reportBody,
    reportDigest: await canonicalSha256(reportBody),
  });
  const manifest = FeishuWebhookEvidenceManifestV1Schema.parse({
    schemaVersion: '1',
    evidenceId: reportBody.evidenceId,
    recordedAt: RECORDED_AT,
    application: {
      appId: APP_ID,
      tenantKey: TENANT_KEY,
      callbackUrl: CALLBACK_URL,
      encryptionMode: 'encrypted',
      subscriptionStatus: 'active',
      reviewedAt: '2026-07-27T10:07:00.000Z',
      developerConsoleUrl: `https://open.feishu.cn/app/${APP_ID}/event`,
    },
    observabilityReportUrl: OBSERVABILITY_URL,
    observabilityReportDigest: observability.reportDigest,
    challenge: {
      requestDigest: DIGESTS.challengeRequest,
      responseDigest: DIGESTS.challengeResponse,
      observedAt: requests[0]!.startedAt,
      latencyMs: requests[0]!.latencyMs,
      developerConsoleStatus: 'SUCCESS',
      developerConsoleLogUrl: `https://open.feishu.cn/app/${APP_ID}/event/log`,
      reviewedAt: '2026-07-27T10:07:00.000Z',
    },
    event: {
      tenantKey: TENANT_KEY,
      eventId: 'evt_round_106_success',
      eventType: 'im.message.receive_v1',
      deliveryId: 'feishu_webhook_round_106_success',
      requestDigest: DIGESTS.eventRequest,
      responseDigest: DIGESTS.eventResponse,
      eventDigest: DIGESTS.eventBody,
      observedAt: requests[1]!.startedAt,
      developerConsoleStatus: 'SUCCESS',
      developerConsoleLogUrl: `https://open.feishu.cn/app/${APP_ID}/event/log`,
      reviewedAt: '2026-07-27T10:07:00.000Z',
    },
    rejections: [
      {
        case: 'invalid_signature',
        tenantKey: TENANT_KEY,
        eventId: 'evt_round_106_invalid_signature',
        requestDigest: DIGESTS.invalidSignatureRequest,
        responseDigest: DIGESTS.invalidSignatureResponse,
        statusCode: 401,
        observedAt: requests[2]!.startedAt,
      },
      {
        case: 'expired_timestamp',
        tenantKey: TENANT_KEY,
        eventId: 'evt_round_106_expired_timestamp',
        requestDigest: DIGESTS.expiredTimestampRequest,
        responseDigest: DIGESTS.expiredTimestampResponse,
        statusCode: 401,
        observedAt: requests[3]!.startedAt,
      },
      {
        case: 'wrong_tenant',
        tenantKey: 'tenant_delivery_loop_wrong',
        eventId: 'evt_round_106_wrong_tenant',
        requestDigest: DIGESTS.wrongTenantRequest,
        responseDigest: DIGESTS.wrongTenantResponse,
        statusCode: 403,
        observedAt: requests[4]!.startedAt,
      },
    ],
  });
  return { manifest, observability };
}

function positiveProjection(manifest: FeishuWebhookEvidenceManifestV1): Record<string, unknown> {
  return {
    schemaVersion: '1',
    tenantKey: manifest.event.tenantKey,
    eventId: manifest.event.eventId,
    counts: { deliveries: 1, nonces: 1, ingressOutboxes: 1, tasks: 0, runs: 0, outboxEffects: 0 },
    delivery: {
      deliveryId: manifest.event.deliveryId,
      appId: APP_ID,
      eventType: manifest.event.eventType,
      eventCreatedAt: '2026-07-27T10:00:59.000Z',
      verificationMode: 'encrypted',
      requestTimestamp: '2026-07-27T10:01:00.000Z',
      requestDigest: manifest.event.requestDigest,
      eventDigest: manifest.event.eventDigest,
      status: 'accepted',
      receivedAt: '2026-07-27T10:01:00.620Z',
    },
    ingress: {
      outboxId: 'feishu_ingress_round_106_success',
      deliveryId: manifest.event.deliveryId,
      eventType: manifest.event.eventType,
      eventDigest: manifest.event.eventDigest,
      deliveryState: 'pending',
      taskId: null,
      runId: null,
      createdAt: '2026-07-27T10:01:00.620Z',
    },
  };
}

function zeroProjection(tenantKey: string, eventId: string): Record<string, unknown> {
  return {
    schemaVersion: '1',
    tenantKey,
    eventId,
    counts: { deliveries: 0, nonces: 0, ingressOutboxes: 0, tasks: 0, runs: 0, outboxEffects: 0 },
    delivery: null,
    ingress: null,
  };
}

function fakeFetch(
  evidence: Fixture,
  options: { observability?: unknown; positive?: unknown; rejectionWrite?: boolean; raw?: string } = {},
): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === 'https://observability.example.com') {
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer CANARY_OBSERVABILITY_TOKEN',
      });
      return Response.json(options.observability ?? evidence.observability);
    }
    if (url.origin === 'https://control.example.com') {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer CANARY_OPERATIONS_TOKEN' });
      const tenantKey = url.searchParams.get('tenantKey')!;
      const eventId = url.searchParams.get('eventId')!;
      if (eventId === evidence.manifest.event.eventId) {
        return Response.json(options.positive ?? positiveProjection(evidence.manifest));
      }
      const projection = zeroProjection(tenantKey, eventId);
      if (options.rejectionWrite && eventId.endsWith('invalid_signature')) {
        return Response.json({
          ...projection,
          counts: { ...(projection.counts as object), deliveries: 1 },
        });
      }
      return Response.json(projection);
    }
    return Response.json({ message: options.raw ?? 'not found' }, { status: 404 });
  }) as typeof fetch;
}

function verify(evidence: Fixture, fetcher: typeof fetch) {
  return verifyFeishuWebhookEvidence(evidence.manifest, {
    controlPlaneOrigin: 'https://control.example.com',
    operationsToken: 'CANARY_OPERATIONS_TOKEN',
    observabilityReportUrl: evidence.manifest.observabilityReportUrl,
    observabilityToken: 'CANARY_OBSERVABILITY_TOKEN',
    fetch: fetcher,
  });
}

describe('real Feishu webhook evidence', () => {
  it('requires one challenge, one event, and each negative case exactly once', async () => {
    const evidence = await fixture();
    expect(FeishuWebhookEvidenceManifestV1Schema.safeParse(evidence.manifest).success).toBe(true);
    expect(FeishuWebhookEvidenceManifestV1Schema.safeParse({
      ...evidence.manifest,
      rejections: evidence.manifest.rejections.slice(0, 2),
    }).success).toBe(false);
    expect(FeishuWebhookEvidenceManifestV1Schema.safeParse({
      ...evidence.manifest,
      rawBody: 'CANARY_SECRET_RAW_FEISHU_BODY',
    }).success).toBe(false);
    expect(FeishuWebhookEvidenceManifestV1Schema.safeParse({
      ...evidence.manifest,
      application: { ...evidence.manifest.application, encryptionMode: 'plaintext' },
    }).success).toBe(false);

    const exampleManifest = JSON.parse(await readFile(
      new URL('../schemas/feishu-webhook-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    const exampleReport = FeishuWebhookObservabilityReportV1Schema.parse(JSON.parse(
      await readFile(
        new URL('../schemas/feishu-webhook-observability-v1.example.json', import.meta.url),
        'utf8',
      ),
    ));
    expect(FeishuWebhookEvidenceManifestV1Schema.safeParse(exampleManifest).success).toBe(true);
    const { reportDigest, ...reportBody } = exampleReport;
    expect(await canonicalSha256(reportBody)).toBe(reportDigest);
  });

  it('cross-checks external request outcomes against immutable D1 receipt and zero-write projections', async () => {
    const evidence = await fixture();
    const summary = await verify(evidence, fakeFetch(evidence));
    expect(summary).toEqual({
      schemaVersion: '1',
      evidenceId: evidence.manifest.evidenceId,
      appId: APP_ID,
      tenantKey: TENANT_KEY,
      challenge: 'verified',
      eventId: evidence.manifest.event.eventId,
      eventType: evidence.manifest.event.eventType,
      deliveryId: evidence.manifest.event.deliveryId,
      rejectionCases: ['expired_timestamp', 'invalid_signature', 'wrong_tenant'],
      rejectedBusinessRecordCount: 0,
      developerConsoleReview: 'required_and_recorded',
    });
    expect(JSON.stringify(summary)).not.toContain('CANARY_');
  });

  it('rejects observability drift, slow challenge, receipt drift, and any negative business write', async () => {
    const evidence = await fixture();
    await expect(verify(evidence, fakeFetch(evidence, {
      observability: { ...evidence.observability, generatedAt: '2026-07-27T10:06:01.000Z' },
    }))).rejects.toMatchObject({ code: 'observability_digest_mismatch' });
    const slowRequests = evidence.observability.requests.map((request) =>
      request.case === 'challenge'
        ? { ...request, completedAt: '2026-07-27T10:00:01.001Z', latencyMs: 1_001 }
        : request);
    const reportBody = Object.fromEntries(
      Object.entries(evidence.observability).filter(([key]) => key !== 'reportDigest'),
    );
    const slowBody = { ...reportBody, requests: slowRequests };
    const slow = { ...slowBody, reportDigest: await canonicalSha256(slowBody) };
    const changedManifest = {
      ...evidence.manifest,
      observabilityReportDigest: slow.reportDigest,
      challenge: { ...evidence.manifest.challenge, latencyMs: 1_001 },
    };
    await expect(verify(
      { manifest: changedManifest, observability: slow as FeishuWebhookObservabilityReportV1 },
      fakeFetch({
        manifest: changedManifest,
        observability: slow as FeishuWebhookObservabilityReportV1,
      }),
    )).rejects.toMatchObject({ code: 'challenge_mismatch' });
    await expect(verify(evidence, fakeFetch(evidence, {
      positive: {
        ...positiveProjection(evidence.manifest),
        delivery: {
          ...(positiveProjection(evidence.manifest).delivery as object),
          requestDigest: `sha256:${'f'.repeat(64)}`,
        },
      },
    }))).rejects.toMatchObject({ code: 'event_projection_mismatch' });
    await expect(verify(evidence, fakeFetch(evidence, { rejectionWrite: true })))
      .rejects.toMatchObject({ code: 'rejected_business_record_observed' });
  });

  it('binds configured authorities before network access and never propagates raw upstream text', async () => {
    const evidence = await fixture();
    let calls = 0;
    await expect(verifyFeishuWebhookEvidence(evidence.manifest, {
      controlPlaneOrigin: 'https://control.example.com',
      operationsToken: 'CANARY_OPERATIONS_TOKEN',
      observabilityReportUrl: 'https://attacker.example/collect',
      observabilityToken: 'CANARY_OBSERVABILITY_TOKEN',
      fetch: async () => {
        calls += 1;
        return Response.json({});
      },
    })).rejects.toMatchObject({ code: 'configuration_invalid' });
    expect(calls).toBe(0);

    const raw = 'CANARY_RAW_FEISHU_UPSTREAM_TOKEN';
    const operation = verify(evidence, fakeFetch(evidence, {
      observability: { message: raw },
      raw,
    }));
    await expect(operation).rejects.toSatisfy((error: unknown) =>
      error instanceof FeishuWebhookEvidenceVerificationError &&
      error.code === 'observability_response_invalid');
    await expect(operation).rejects.not.toThrow(raw);
  });

  it('keeps the live command behind the Watt-derived explicit opt-in gate', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_FEISHU_WEBHOOK_E2E;
    const result = spawnSync(
      resolve('node_modules/.bin/tsx'),
      ['scripts/verify-feishu-webhook-evidence.ts'],
      { cwd: resolve('.'), env: environment, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('feishu-webhook-e2e: opt-in missing');
  });
});
