import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  MonitorAlertEvidenceManifestV1Schema,
  MonitorAlertObservabilityReportV1Schema,
  type MonitorAlertEvidenceManifestV1,
  type MonitorAlertObservabilityReportV1,
} from '../src/domain/monitor-alert-evidence.js';
import {
  MonitorAlertEvidenceVerificationError,
  verifyMonitorAlertEvidence,
} from '../src/pilot/monitor-alert-evidence-verifier.js';

const CONTROL_ORIGIN = 'https://control.example';
const OBSERVER_URL = 'https://observer.example/monitor-alert/round-113';
const CLOUDFLARE_URL =
  'https://api.cloudflare.com/client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' +
  'workers/services/delivery-loop/environments/production/settings';
const CLOUDFLARE_TOKEN = 'cloudflare-monitor-read-purpose';
const OPERATIONS_TOKEN = 'monitor-operations-read-purpose';
const OBSERVER_TOKEN = 'monitor-observer-read-purpose';
const SENTRY_TOKEN = 'sentry-monitor-read-purpose';
const CANARY = 'github_pat_MONITOR_ALERT_CANARY_1234567890';

function digest(index: number): `sha256:${string}` {
  return `sha256:${index.toString(16).padStart(2, '0').repeat(32)}`;
}

interface EnabledFixture {
  manifest: Extract<MonitorAlertEvidenceManifestV1, { mode: 'enabled' }>;
  report: MonitorAlertObservabilityReportV1;
  projections: Map<string, Record<string, unknown>>;
}

async function enabledFixture(): Promise<EnabledFixture> {
  const eventRows = [
    ['primary', 'source-primary', 'event-primary', 'candidate-window-1', 1, false,
      '2026-07-27T09:00:00.000Z', '2026-07-27T09:00:01.000Z'],
    ['suppressed_second', 'source-second', 'event-second', 'candidate-window-1', 2, true,
      '2026-07-27T09:00:10.000Z', '2026-07-27T09:00:11.000Z'],
    ['suppressed_third', 'source-third', 'event-third', 'candidate-window-1', 3, true,
      '2026-07-27T09:00:20.000Z', '2026-07-27T09:00:21.000Z'],
    ['after_window', 'source-after', 'event-after', 'candidate-window-2', 1, false,
      '2026-07-27T09:01:01.000Z', '2026-07-27T09:01:02.000Z'],
  ] as const;
  const events = eventRows.map((row, index) => ({
    scenario: row[0], sourceEventId: row[1], eventId: row[2],
    receiptId: `monitor_receipt_${index + 1}`,
    lineageId: `monitor_lineage_${index + 1}`,
    candidateId: row[3], occurrenceOrdinal: row[4], suppressed: row[5],
    occurredAt: row[6], receivedAt: row[7],
  }));
  const rejections = [
    {
      scenario: 'invalid_native_signature' as const,
      sourceEventId: 'source-invalid-signature', eventId: 'event-invalid-signature',
      expectedStatus: 401 as const, expectedReason: 'invalid_signature' as const,
    },
    {
      scenario: 'repository_denied' as const,
      sourceEventId: 'source-repository-denied', eventId: 'event-repository-denied',
      expectedStatus: 403 as const, expectedReason: 'repository_not_allowed' as const,
    },
    {
      scenario: 'authority_injection_denied' as const,
      sourceEventId: 'source-authority-denied', eventId: 'event-authority-denied',
      expectedStatus: 400 as const, expectedReason: 'invalid_request' as const,
    },
  ];
  const requestBase = [
    ['primary', 'source-primary', 'event-primary', true, true, 202, 'created',
      'monitor_receipt_1', 'monitor_lineage_1', 'candidate-window-1', null],
    ['retry', 'source-primary', 'event-primary', true, true, 202, 'duplicate',
      'monitor_receipt_1', 'monitor_lineage_1', 'candidate-window-1', null],
    ['suppressed_second', 'source-second', 'event-second', true, true, 202, 'suppressed',
      'monitor_receipt_2', 'monitor_lineage_2', 'candidate-window-1', null],
    ['suppressed_third', 'source-third', 'event-third', true, true, 202, 'suppressed',
      'monitor_receipt_3', 'monitor_lineage_3', 'candidate-window-1', null],
    ['after_window', 'source-after', 'event-after', true, true, 202, 'created',
      'monitor_receipt_4', 'monitor_lineage_4', 'candidate-window-2', null],
    ['invalid_native_signature', 'source-invalid-signature', 'event-invalid-signature',
      false, false, 401, 'rejected', null, null, null, 'invalid_signature'],
    ['repository_denied', 'source-repository-denied', 'event-repository-denied',
      true, true, 403, 'rejected', null, null, null, 'repository_not_allowed'],
    ['authority_injection_denied', 'source-authority-denied', 'event-authority-denied',
      true, true, 400, 'rejected', null, null, null, 'invalid_request'],
  ] as const;
  const requests = requestBase.map((row, index) => ({
    scenario: row[0], sourceEventId: row[1], eventId: row[2],
    nativeRequestDigest: index === 1 ? digest(20) : digest(20 + index),
    normalizedRequestDigest: row[4] ? (index === 1 ? digest(30) : digest(30 + index)) : null,
    responseDigest: digest(50 + index),
    signatureAlgorithm: 'sentry_hook_hmac_sha256' as const,
    signatureVerified: row[3], forwarded: row[4], statusCode: row[5], outcome: row[6],
    receiptId: row[7], lineageId: row[8], candidateId: row[9], reasonCode: row[10],
    startedAt: `2026-07-27T09:0${2 + index}:00.000Z`,
    completedAt: `2026-07-27T09:0${2 + index}:00.100Z`,
    latencyMs: 100,
  }));
  // Same native/normalized bytes are required for the exact primary retry.
  requests[1]!.nativeRequestDigest = requests[0]!.nativeRequestDigest;
  requests[1]!.normalizedRequestDigest = requests[0]!.normalizedRequestDigest;
  const reportBody = {
    schemaVersion: '1' as const,
    evidenceId: 'monitor_alert_round_113',
    service: 'delivery-loop-monitor-alert-observer' as const,
    provider: 'sentry' as const,
    generatedAt: '2026-07-27T09:10:00.000Z',
    requests,
  };
  const report = MonitorAlertObservabilityReportV1Schema.parse({
    ...reportBody,
    reportDigest: await canonicalSha256(reportBody),
  });
  const parsedManifest = MonitorAlertEvidenceManifestV1Schema.parse({
    schemaVersion: '1', mode: 'enabled', evidenceId: report.evidenceId,
    recordedAt: '2026-07-27T10:00:00.000Z',
    worker: {
      accountId: 'a'.repeat(32), service: 'delivery-loop', environment: 'production',
      settingsUrl: CLOUDFLARE_URL,
      dashboardUrl: 'https://dash.cloudflare.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/workers/services/view/delivery-loop/production/settings',
      configurationNames: [
        'MONITOR_WEBHOOK_SECRET', 'MONITOR_TENANT_KEY',
        'MONITOR_ALLOWED_REPOSITORIES', 'MONITOR_SUPPRESSION_WINDOW_SECONDS',
      ],
    },
    decision: {
      decision: 'enabled', owner: 'delivery_owner', decisionId: 'decision_monitor_enabled',
      decisionDigest: digest(1),
      decisionEvidenceUrl: 'https://evidence.example/monitor-alert/decision.json',
      decidedAt: '2026-07-27T08:00:00.000Z',
    },
    safety: { canaryDigest: await canonicalSha256(CANARY) },
    controlPlaneOrigin: CONTROL_ORIGIN,
    observabilityReportUrl: OBSERVER_URL,
    observabilityReportDigest: report.reportDigest,
    source: {
      provider: 'sentry', organizationSlug: 'example-org', projectSlug: 'delivery-loop',
      projectId: '1234', ruleId: '42',
      projectUrl: 'https://sentry.io/organizations/example-org/projects/delivery-loop/',
      ruleUrl:
        'https://sentry.io/organizations/example-org/projects/delivery-loop/alerts/rules/42/details/',
      integrationUrl: 'https://sentry.io/settings/example-org/integrations/delivery-loop/',
      nativeSignatureHeader: 'Sentry-Hook-Signature',
      nativeSignatureAlgorithm: 'HMAC-SHA256(client-secret, exact-body)',
    },
    profile: {
      adapter: 'generic', tenantKey: 'tenant-monitor-production',
      allowedRepositories: ['example/delivery-target'], suppressionWindowMs: 60_000,
      alertRuleId: 'sentry:42', repository: 'example/delivery-target',
      environment: 'production', severity: 'critical',
    },
    events, rejections,
    review: {
      observerDeploymentUrl: 'https://observer.example/deployments/monitor-alert',
      mappingEvidenceUrl: 'https://evidence.example/monitor-alert/mapping.json',
      reviewer: 'release_reviewer', reviewedAt: '2026-07-27T09:30:00.000Z',
      nativeSignatureVerified: true, projectAccessVerified: true,
    },
  });
  if (parsedManifest.mode !== 'enabled') throw new Error('enabled fixture is invalid');
  const manifest = parsedManifest;
  const projections = new Map<string, Record<string, unknown>>();
  for (const event of manifest.events) {
    const candidateSize = event.scenario === 'after_window' ? 1 : 3;
    projections.set(event.eventId, {
      schemaVersion: '1', adapter: 'generic', tenantKey: manifest.profile.tenantKey,
      eventId: event.eventId, found: true,
      counts: {
        receipts: 1, lineages: 1, candidates: 1,
        taskSources: 0, runs: 0, approvals: 0, outboxes: 0,
      },
      receipt: {
        receiptId: event.receiptId, lineageId: event.lineageId,
        candidateId: event.candidateId, occurrenceOrdinal: event.occurrenceOrdinal,
        suppressed: event.suppressed, occurredAt: event.occurredAt, receivedAt: event.receivedAt,
      },
      mapping: {
        repository: manifest.profile.repository, alertRuleId: manifest.profile.alertRuleId,
        environment: manifest.profile.environment, severity: manifest.profile.severity,
        suppressionWindowMs: manifest.profile.suppressionWindowMs,
      },
      candidate: {
        candidateId: event.candidateId, status: 'triaging', occurrenceCount: candidateSize,
        lineageCount: candidateSize, firstSeenAt: event.receivedAt, lastSeenAt: event.receivedAt,
        suppressionExpiresAt: '2026-07-27T09:02:02.000Z', createdAt: event.receivedAt,
        updatedAt: event.receivedAt,
      },
      snapshot: { objectPresent: true, objectVerified: true },
    });
  }
  for (const rejection of manifest.rejections) projections.set(rejection.eventId, {
    schemaVersion: '1', adapter: 'generic', tenantKey: manifest.profile.tenantKey,
    eventId: rejection.eventId, found: false,
    counts: {
      receipts: 0, lineages: 0, candidates: 0,
      taskSources: 0, runs: 0, approvals: 0, outboxes: 0,
    },
    receipt: null, mapping: null, candidate: null, snapshot: null,
  });
  return { manifest, report, projections };
}

async function disabledManifest(): Promise<Extract<MonitorAlertEvidenceManifestV1, { mode: 'disabled' }>> {
  const manifest = MonitorAlertEvidenceManifestV1Schema.parse({
    schemaVersion: '1', mode: 'disabled', evidenceId: 'monitor_alert_disabled_round_113',
    recordedAt: '2026-07-27T10:00:00.000Z',
    worker: {
      accountId: 'a'.repeat(32), service: 'delivery-loop', environment: 'production',
      settingsUrl: CLOUDFLARE_URL,
      dashboardUrl: 'https://dash.cloudflare.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/workers/services/view/delivery-loop/production/settings',
      configurationNames: [
        'MONITOR_WEBHOOK_SECRET', 'MONITOR_TENANT_KEY',
        'MONITOR_ALLOWED_REPOSITORIES', 'MONITOR_SUPPRESSION_WINDOW_SECONDS',
      ],
    },
    decision: {
      decision: 'not_enabled', owner: 'delivery_owner', decisionId: 'decision_monitor_disabled',
      decisionDigest: digest(2),
      decisionEvidenceUrl: 'https://evidence.example/monitor-alert/decision-disabled.json',
      decidedAt: '2026-07-27T08:00:00.000Z',
    },
    safety: { canaryDigest: await canonicalSha256(CANARY) },
    review: {
      reviewer: 'release_reviewer', reviewedAt: '2026-07-27T09:30:00.000Z',
      productionConfigurationAbsent: true,
    },
  });
  if (manifest.mode !== 'disabled') throw new Error('disabled fixture is invalid');
  return manifest;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
}

function fetcherFor(fixture: EnabledFixture): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url === CLOUDFLARE_URL) return json({
      success: true, errors: [], messages: [], result: { bindings: [
        { name: 'MONITOR_WEBHOOK_SECRET', type: 'secret_text' },
        { name: 'MONITOR_TENANT_KEY', type: 'plain_text', text: 'tenant-monitor-production' },
        { name: 'MONITOR_ALLOWED_REPOSITORIES', type: 'plain_text',
          text: '["example/delivery-target"]' },
        { name: 'MONITOR_SUPPRESSION_WINDOW_SECONDS', type: 'plain_text', text: '60' },
      ] },
    });
    if (url === OBSERVER_URL) return json(fixture.report);
    if (url.includes('/v1/operations/monitor-alert/evidence?')) {
      return json(fixture.projections.get(new URL(url).searchParams.get('eventId') ?? ''));
    }
    if (url.endsWith('/api/0/projects/example-org/delivery-loop/')) {
      return json({ id: '1234', slug: 'delivery-loop', organization: { slug: 'example-org' } });
    }
    if (url.endsWith('/api/0/projects/example-org/delivery-loop/rules/42/')) {
      return json({ id: '42', environment: 'production' });
    }
    return new Response('not found', { status: 404 });
  };
}

function enabledOptions(fixture: EnabledFixture) {
  return {
    cloudflareApiUrl: CLOUDFLARE_URL, cloudflareApiToken: CLOUDFLARE_TOKEN,
    canary: CANARY, controlPlaneOrigin: CONTROL_ORIGIN, operationsToken: OPERATIONS_TOKEN,
    observabilityReportUrl: OBSERVER_URL, observabilityToken: OBSERVER_TOKEN,
    sentryApiOrigin: 'https://sentry.io', sentryReadToken: SENTRY_TOKEN,
    fetcher: fetcherFor(fixture),
  };
}

describe('monitor alert external evidence', () => {
  it('strictly parses enabled/disabled contracts and checked-in examples', async () => {
    const enabled = await enabledFixture();
    expect(MonitorAlertEvidenceManifestV1Schema.parse(enabled.manifest).mode).toBe('enabled');
    expect(MonitorAlertEvidenceManifestV1Schema.parse(await disabledManifest()).mode).toBe('disabled');
    for (const file of [
      'monitor-alert-evidence-enabled-v1.example.json',
      'monitor-alert-evidence-disabled-v1.example.json',
    ]) {
      const raw = JSON.parse(readFileSync(resolve('schemas', file), 'utf8')) as unknown;
      expect(MonitorAlertEvidenceManifestV1Schema.safeParse(raw).success).toBe(true);
    }
    const report = JSON.parse(readFileSync(
      resolve('schemas/monitor-alert-observability-v1.example.json'), 'utf8')) as unknown;
    expect(MonitorAlertObservabilityReportV1Schema.safeParse(report).success).toBe(true);
    expect(MonitorAlertEvidenceManifestV1Schema.safeParse({ ...enabled.manifest, extra: true }).success)
      .toBe(false);
  });

  it('cross-checks native Sentry observations, D1/R2 projections, settings and live Sentry',
    async () => {
      const fixture = await enabledFixture();
      await expect(verifyMonitorAlertEvidence(fixture.manifest, enabledOptions(fixture)))
        .resolves.toMatchObject({
          productionDecision: 'enabled', acceptedEvents: 4, suppressedEvents: 2,
          triageCandidates: 2, rejectedEventsWithoutReceipt: 3,
          authorityEffects: 0, privateSnapshots: 'verified', plaintextLeaks: 0,
        });
    });

  it('accepts explicit non-enable only when all four production bindings are absent', async () => {
    const manifest = await disabledManifest();
    const absent: typeof fetch = async () => json({
      success: true, errors: [], messages: [],
      result: { bindings: [{ name: 'OPERATIONS_TOKEN', type: 'secret_text' }] },
    });
    await expect(verifyMonitorAlertEvidence(manifest, {
      cloudflareApiUrl: CLOUDFLARE_URL, cloudflareApiToken: CLOUDFLARE_TOKEN,
      canary: CANARY, fetcher: absent,
    })).resolves.toMatchObject({
      productionDecision: 'not_enabled', cloudflareConfiguration: 'absent', plaintextLeaks: 0,
    });
    const present: typeof fetch = async () => json({
      success: true, errors: [], messages: [], result: { bindings: [
        { name: 'MONITOR_TENANT_KEY', type: 'plain_text', text: 'unexpected' },
      ] },
    });
    await expect(verifyMonitorAlertEvidence(manifest, {
      cloudflareApiUrl: CLOUDFLARE_URL, cloudflareApiToken: CLOUDFLARE_TOKEN,
      canary: CANARY, fetcher: present,
    })).rejects.toMatchObject({ code: 'cloudflare_configuration_mismatch' });
  });

  it('rejects observer, candidate, rejected-effect, settings, Sentry and credential drift',
    async () => {
      const fixture = await enabledFixture();
      const options = enabledOptions(fixture);
      const driftReport = structuredClone(fixture.report);
      driftReport.requests.find((item) => item.scenario === 'retry')!.responseDigest = digest(99);
      await expect(verifyMonitorAlertEvidence(fixture.manifest, {
        ...options,
        fetcher: async (input, init) => String(input) === OBSERVER_URL
          ? json(driftReport) : await options.fetcher(input, init),
      })).rejects.toMatchObject({ code: 'observability_digest_mismatch' });

      fixture.projections.get('event-second')!.snapshot = {
        objectPresent: true, objectVerified: false,
      };
      await expect(verifyMonitorAlertEvidence(fixture.manifest, enabledOptions(fixture)))
        .rejects.toMatchObject({ code: 'projection_mismatch' });
      fixture.projections.get('event-second')!.snapshot = {
        objectPresent: true, objectVerified: true,
      };
      const rejected = fixture.projections.get('event-authority-denied')!;
      (rejected.counts as Record<string, number>).runs = 1;
      await expect(verifyMonitorAlertEvidence(fixture.manifest, enabledOptions(fixture)))
        .rejects.toMatchObject({ code: 'effect_observed' });
      (rejected.counts as Record<string, number>).runs = 0;

      await expect(verifyMonitorAlertEvidence(fixture.manifest, {
        ...enabledOptions(fixture),
        fetcher: async (input, init) => String(input) === CLOUDFLARE_URL
          ? json({
              success: true, errors: [], messages: [], result: { bindings: [
                { name: 'MONITOR_WEBHOOK_SECRET', type: 'secret_text' },
                { name: 'MONITOR_TENANT_KEY', type: 'plain_text', text: 'wrong-tenant' },
                { name: 'MONITOR_ALLOWED_REPOSITORIES', type: 'plain_text',
                  text: '["example/delivery-target"]' },
                { name: 'MONITOR_SUPPRESSION_WINDOW_SECONDS', type: 'plain_text', text: '60' },
              ] },
            })
          : await fetcherFor(fixture)(input, init),
      })).rejects.toMatchObject({ code: 'cloudflare_configuration_mismatch' });

      await expect(verifyMonitorAlertEvidence(fixture.manifest, {
        ...enabledOptions(fixture),
        fetcher: async (input, init) => String(input).endsWith('/rules/42/')
          ? json({ id: '43', environment: 'production' })
          : await fetcherFor(fixture)(input, init),
      })).rejects.toMatchObject({ code: 'sentry_fact_mismatch' });
      await expect(verifyMonitorAlertEvidence(fixture.manifest, {
        ...enabledOptions(fixture),
        fetcher: async (input, init) => String(input) === OBSERVER_URL
          ? json({ leak: CANARY }) : await fetcherFor(fixture)(input, init),
      })).rejects.toMatchObject({ code: 'secret_leak_detected' });
      expect(new MonitorAlertEvidenceVerificationError('configuration_invalid').message)
        .not.toContain(CANARY);
    });

  it('keeps CLI opt-in and missing-configuration exits distinct from evidence failure', () => {
    const run = (env: NodeJS.ProcessEnv) => spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/verify-monitor-alert-evidence.ts'],
      { cwd: resolve('.'), env: { ...process.env, ...env }, encoding: 'utf8' },
    );
    const disabled = run({ DELIVERY_LOOP_MONITOR_ALERT_E2E: '' });
    expect(disabled.status).toBe(2);
    expect(disabled.stderr).toContain('monitor-alert-e2e: opt-in missing');
    const incomplete = run({ DELIVERY_LOOP_MONITOR_ALERT_E2E: '1' });
    expect(incomplete.status).toBe(2);
    expect(incomplete.stderr).toContain('required evidence configuration is incomplete');
    expect(incomplete.stderr).not.toContain(CANARY);
  });
});
