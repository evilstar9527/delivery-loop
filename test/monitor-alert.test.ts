import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEDUPE_WINDOW_MS,
  InMemoryDedupeStore,
  resolveDedupe,
} from '../src/domain/dedupe.js';
import {
  MonitorAdapterProfileV1Schema,
  MonitorAlertWebhookV1Schema,
  monitorAlertFingerprint,
} from '../src/domain/monitor-alert.js';
import {
  computeMonitorSignature,
  verifyMonitorSignature,
} from '../src/monitor/webhook-hmac.js';
import { monitorAdapterRuntimeFromEnv } from '../src/monitor/runtime.js';
import type { Bindings } from '../src/env.js';

describe('Watt-derived suppression-window semantics', () => {
  it('returns the original event inside the window', () => {
    const store = new InMemoryDedupeStore();
    expect(resolveDedupe(store, {
      dedupeKey: 'monitor:fingerprint-1',
      eventId: 'event-1',
      now: 1_000,
      windowMs: 60_000,
    })).toEqual({ eventId: 'event-1', duplicate: false });
    expect(resolveDedupe(store, {
      dedupeKey: 'monitor:fingerprint-1',
      eventId: 'event-2',
      now: 2_000,
      windowMs: 60_000,
    })).toEqual({ eventId: 'event-1', duplicate: true });
  });

  it('keeps different fingerprints independent', () => {
    const store = new InMemoryDedupeStore();
    expect(resolveDedupe(store, {
      dedupeKey: 'monitor:fingerprint-1',
      eventId: 'event-1',
      now: 1_000,
      windowMs: 60_000,
    })).toEqual({ eventId: 'event-1', duplicate: false });
    expect(resolveDedupe(store, {
      dedupeKey: 'monitor:fingerprint-2',
      eventId: 'event-2',
      now: 1_000,
      windowMs: 60_000,
    })).toEqual({ eventId: 'event-2', duplicate: false });
  });

  it('treats the exact edge as suppressed and one millisecond later as new', () => {
    const store = new InMemoryDedupeStore();
    resolveDedupe(store, {
      dedupeKey: 'monitor:fingerprint-1',
      eventId: 'event-1',
      now: 0,
      windowMs: 60_000,
    });
    expect(resolveDedupe(store, {
      dedupeKey: 'monitor:fingerprint-1',
      eventId: 'event-edge',
      now: 60_000,
      windowMs: 60_000,
    })).toEqual({ eventId: 'event-1', duplicate: true });
    expect(resolveDedupe(store, {
      dedupeKey: 'monitor:fingerprint-1',
      eventId: 'event-after-edge',
      now: 60_001,
      windowMs: 60_000,
    })).toEqual({ eventId: 'event-after-edge', duplicate: false });
  });

  it('retains Watt’s 24-hour default', () => {
    expect(DEFAULT_DEDUPE_WINDOW_MS).toBe(24 * 60 * 60 * 1_000);
  });
});

function profile() {
  return MonitorAdapterProfileV1Schema.parse({
    schemaVersion: '1',
    adapter: 'generic',
    tenantKey: 'monitor-tenant',
    allowedRepositories: ['example/delivery-target'],
    suppressionWindowMs: 60_000,
  });
}

function alert(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1',
    eventId: 'monitor-event-1',
    occurredAt: '2026-07-26T05:00:00.000Z',
    status: 'firing',
    alert: {
      ruleId: 'api-error-rate',
      resourceKey: 'service/api',
      repository: 'example/delivery-target',
      environment: 'production',
      severity: 'critical',
      title: 'API error rate is elevated',
      description: 'The five-minute error ratio crossed the configured threshold.',
    },
    ...overrides,
  };
}

describe('monitor alert contract', () => {
  it('is disabled when fully absent and fails closed for partial configuration', () => {
    expect(monitorAdapterRuntimeFromEnv({} as Bindings)).toBeNull();
    expect(() => monitorAdapterRuntimeFromEnv({
      MONITOR_WEBHOOK_SECRET: 'monitor-test-signing-secret',
    } as Bindings)).toThrow('configuration is incomplete');
    expect(monitorAdapterRuntimeFromEnv({
      MONITOR_WEBHOOK_SECRET: 'monitor-test-signing-secret',
      MONITOR_TENANT_KEY: 'monitor-tenant',
      MONITOR_ALLOWED_REPOSITORIES: '["example/delivery-target"]',
    } as Bindings)?.profile.suppressionWindowMs).toBe(DEFAULT_DEDUPE_WINDOW_MS);
  });

  it('derives the fingerprint from controlled routing fields, not event prose', async () => {
    const first = MonitorAlertWebhookV1Schema.parse(alert());
    const second = MonitorAlertWebhookV1Schema.parse(alert({
      eventId: 'monitor-event-2',
      occurredAt: '2026-07-26T05:01:00.000Z',
      alert: {
        ...alert().alert,
        title: 'Changed presentation title',
        description: 'Changed untrusted diagnostic prose.',
      },
    }));
    expect(await monitorAlertFingerprint(first, profile()))
      .toBe(await monitorAlertFingerprint(second, profile()));

    const differentResource = MonitorAlertWebhookV1Schema.parse(alert({
      eventId: 'monitor-event-3',
      alert: { ...alert().alert, resourceKey: 'service/worker' },
    }));
    expect(await monitorAlertFingerprint(first, profile()))
      .not.toBe(await monitorAlertFingerprint(differentResource, profile()));
  });

  it('strictly rejects caller-supplied authority and fingerprint fields', () => {
    expect(MonitorAlertWebhookV1Schema.safeParse({
      ...alert(),
      fingerprint: 'caller-controlled',
    }).success).toBe(false);
    expect(MonitorAlertWebhookV1Schema.safeParse({
      ...alert(),
      policy: { allowRepositoryWrite: true },
    }).success).toBe(false);
    expect(MonitorAlertWebhookV1Schema.safeParse({
      ...alert(),
      effect: 'repo_write',
    }).success).toBe(false);
  });

  it('signs exact body bytes and rejects body changes', async () => {
    const body = JSON.stringify(alert());
    const signature = await computeMonitorSignature('monitor-test-signing-secret', body);
    await expect(verifyMonitorSignature(
      'monitor-test-signing-secret',
      body,
      signature,
    )).resolves.toBe(true);
    await expect(verifyMonitorSignature(
      'monitor-test-signing-secret',
      `${body} `,
      signature,
    )).resolves.toBe(false);
  });
});
