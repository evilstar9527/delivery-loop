/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  MonitorAdapterProfileV1,
  MonitorAlertWebhookV1,
} from '../../src/domain/monitor-alert.js';
import {
  MonitorAlertCandidateStore,
  MonitorAlertIngressStore,
} from '../../src/storage/monitor-alert-ingress-store.js';

const WEBHOOK_SECRET = 'test-monitor-webhook-secret';
const OPERATIONS_TOKEN = 'test-operations-token';
const REPOSITORY = 'example/delivery-target';

function alert(
  eventId: string,
  occurredAt: string,
  overrides: Partial<MonitorAlertWebhookV1['alert']> = {},
): MonitorAlertWebhookV1 {
  return {
    schemaVersion: '1',
    eventId,
    occurredAt,
    status: 'firing',
    alert: {
      ruleId: 'api-error-rate',
      resourceKey: 'service/api',
      repository: REPOSITORY,
      environment: 'production',
      severity: 'critical',
      title: `Alert presentation ${eventId}`,
      description: `Untrusted diagnostic context ${eventId}`,
      ...overrides,
    },
  };
}

const PROFILE: MonitorAdapterProfileV1 = {
  schemaVersion: '1',
  adapter: 'generic',
  tenantKey: 'test-monitor-tenant',
  allowedRepositories: [REPOSITORY],
  suppressionWindowMs: 60_000,
};

async function signature(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  ));
  return `sha256=${[...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function postAlert(
  input: unknown,
  options: { adapter?: string; signature?: string } = {},
): Promise<Response> {
  const body = JSON.stringify(input);
  return await SELF.fetch(
    `https://delivery-loop.test/v1/webhooks/monitor/${options.adapter ?? 'generic'}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-delivery-loop-monitor-signature': options.signature ?? await signature(body),
      },
      body,
    },
  );
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM monitor_alert_lineage'),
    env.DB_CONTROL.prepare('DELETE FROM monitor_alert_candidates'),
    env.DB_CONTROL.prepare('DELETE FROM monitor_alert_suppression_heads'),
    env.DB_CONTROL.prepare('DELETE FROM monitor_alert_receipts'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  const objects = await env.TASK_OBJECTS.list({ prefix: 'monitor-alerts/' });
  if (objects.objects.length > 0) {
    await env.TASK_OBJECTS.delete(objects.objects.map((object) => object.key));
  }
}

async function evidence(eventId: string, tenantKey = PROFILE.tenantKey): Promise<Response> {
  return await SELF.fetch(
    'https://delivery-loop.test/v1/operations/monitor-alert/evidence' +
      `?tenantKey=${encodeURIComponent(tenantKey)}&eventId=${encodeURIComponent(eventId)}`,
    { headers: { authorization: `Bearer ${OPERATIONS_TOKEN}` } },
  );
}

beforeEach(async () => {
  await reset();
});

describe('monitor alert candidate ingress', () => {
  it('converges 20 signed occurrences to one triage candidate with zero authority', async () => {
    const occurredAt = new Date().toISOString();
    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      postAlert(alert(`monitor-parallel-${index}`, occurredAt))));
    expect(responses.every((response) => response.status === 202)).toBe(true);
    const bodies = await Promise.all(responses.map(async (response) =>
      await response.json() as { candidateId: string; disposition: string }));
    expect(new Set(bodies.map((body) => body.candidateId)).size).toBe(1);
    expect(bodies.filter((body) => body.disposition === 'created')).toHaveLength(1);
    expect(bodies.filter((body) => body.disposition === 'suppressed')).toHaveLength(19);

    expect(await env.DB_CONTROL.prepare(
      `SELECT occurrence_count, status FROM monitor_alert_candidates`,
    ).first()).toEqual({ occurrence_count: 20, status: 'triaging' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM monitor_alert_receipts`,
    ).first()).toEqual({ count: 20 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM monitor_alert_lineage`,
    ).first()).toEqual({ count: 20 });
    for (const table of ['tasks', 'runs', 'approvals', 'outbox']) {
      expect(await env.DB_CONTROL.prepare(
        `SELECT COUNT(*) AS count FROM ${table}`,
      ).first()).toEqual({ count: 0 });
    }

    expect((await SELF.fetch('https://delivery-loop.test/v1/triage/monitor')).status).toBe(401);
    const query = await SELF.fetch('https://delivery-loop.test/v1/triage/monitor?limit=10', {
      headers: { authorization: `Bearer ${OPERATIONS_TOKEN}` },
    });
    expect(query.status).toBe(200);
    const projection = await query.json() as {
      candidates: Array<Record<string, unknown>>;
    };
    expect(projection.candidates).toHaveLength(1);
    expect(projection.candidates[0]).toMatchObject({
      status: 'triaging',
      adapter: 'generic',
      tenantKey: 'test-monitor-tenant',
      repository: REPOSITORY,
      alertRuleId: 'api-error-rate',
      severity: 'critical',
      occurrenceCount: 20,
      lineageCount: 20,
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('Untrusted diagnostic context');
    expect(serialized).not.toContain('snapshot_ref');
    expect(serialized).not.toContain(WEBHOOK_SECRET);
    expect((await SELF.fetch('https://delivery-loop.test/v1/triage/monitor?raw=1', {
      headers: { authorization: `Bearer ${OPERATIONS_TOKEN}` },
    })).status).toBe(400);
  });

  it('deduplicates one event and rejects forged or unsafe input before writes', async () => {
    const occurredAt = new Date().toISOString();
    const original = alert('monitor-replayed-event', occurredAt);
    const responses = await Promise.all(Array.from({ length: 3 }, () => postAlert(original)));
    expect(responses.every((response) => response.status === 202)).toBe(true);
    const bodies = await Promise.all(responses.map(async (response) =>
      await response.json() as { disposition: string }));
    expect(bodies.filter((body) => body.disposition === 'created')).toHaveLength(1);
    expect(bodies.filter((body) => body.disposition === 'duplicate')).toHaveLength(2);

    expect((await postAlert({
      ...original,
      alert: { ...original.alert, title: 'Changed content for the same event' },
    })).status).toBe(409);
    expect((await postAlert(original, { signature: `sha256:${'0'.repeat(64)}` })).status).toBe(401);
    expect((await postAlert(original, { adapter: 'unknown' })).status).toBe(404);
    expect((await postAlert(alert('monitor-wrong-repository', occurredAt, {
      repository: 'attacker/other-repo',
    }))).status).toBe(403);
    expect((await postAlert({ ...alert('monitor-forged-fingerprint', occurredAt),
      fingerprint: 'forged' })).status).toBe(400);
    expect((await postAlert({ ...alert('monitor-forged-policy', occurredAt),
      policy: { allowRepositoryWrite: true } })).status).toBe(400);
    expect((await postAlert(alert('monitor-secret', occurredAt, {
      description: `credential ${WEBHOOK_SECRET}`,
    }))).status).toBe(403);
    expect((await postAlert(alert(
      'monitor-stale',
      new Date(Date.now() - 24 * 60 * 60 * 1_000 - 1).toISOString(),
    ))).status).toBe(400);

    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM monitor_alert_receipts`,
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT occurrence_count FROM monitor_alert_candidates`,
    ).first()).toEqual({ occurrence_count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM monitor_alert_lineage`,
    ).first()).toEqual({ count: 1 });
    expect((await env.TASK_OBJECTS.list({ prefix: 'monitor-alerts/' })).objects).toHaveLength(1);
    expect(JSON.stringify(await env.DB_CONTROL.prepare(
      `SELECT * FROM monitor_alert_receipts`,
    ).all())).not.toContain('Untrusted diagnostic context');
  });

  it('projects exact accepted evidence from D1/R2 and proves rejected authority has no effect',
    async () => {
      expect((await SELF.fetch(
        'https://delivery-loop.test/v1/operations/monitor-alert/evidence' +
          '?tenantKey=test-monitor-tenant&eventId=unauthenticated',
      )).status).toBe(401);
      expect((await SELF.fetch(
        'https://delivery-loop.test/v1/operations/monitor-alert/evidence' +
          '?tenantKey=test-monitor-tenant&eventId=a&extra=1',
        { headers: { authorization: `Bearer ${OPERATIONS_TOKEN}` } },
      )).status).toBe(400);
      expect((await SELF.fetch(
        'https://delivery-loop.test/v1/operations/monitor-alert/evidence' +
          '?tenantKey=test-monitor-tenant&eventId=a&eventId=b',
        { headers: { authorization: `Bearer ${OPERATIONS_TOKEN}` } },
      )).status).toBe(400);

      const now = new Date();
      const store = new MonitorAlertIngressStore(env.DB_CONTROL, env.TASK_OBJECTS, {
        profile: PROFILE,
      });
      const firstEvent = alert('monitor-evidence-primary', now.toISOString());
      const secondEvent = alert(
        'monitor-evidence-second',
        new Date(now.getTime() + 10_000).toISOString(),
      );
      const thirdEvent = alert(
        'monitor-evidence-third',
        new Date(now.getTime() + 20_000).toISOString(),
      );
      const first = await store.accept(firstEvent, now);
      await store.accept(secondEvent, new Date(now.getTime() + 10_000));
      await store.accept(thirdEvent, new Date(now.getTime() + 20_000));

      const acceptedResponse = await evidence(firstEvent.eventId);
      expect(acceptedResponse.status).toBe(200);
      expect(acceptedResponse.headers.get('cache-control')).toBe('no-store');
      const accepted = await acceptedResponse.json() as Record<string, unknown>;
      expect(accepted).toMatchObject({
        schemaVersion: '1', adapter: 'generic', tenantKey: PROFILE.tenantKey,
        eventId: firstEvent.eventId, found: true,
        counts: {
          receipts: 1, lineages: 1, candidates: 1,
          taskSources: 0, runs: 0, approvals: 0, outboxes: 0,
        },
        receipt: {
          receiptId: first.receiptId, candidateId: first.candidateId,
          occurrenceOrdinal: 1, suppressed: false,
        },
        mapping: {
          repository: REPOSITORY, alertRuleId: 'api-error-rate',
          environment: 'production', severity: 'critical', suppressionWindowMs: 60_000,
        },
        candidate: {
          candidateId: first.candidateId, status: 'triaging',
          occurrenceCount: 3, lineageCount: 3,
        },
        snapshot: { objectPresent: true, objectVerified: true },
      });
      const serialized = JSON.stringify(accepted);
      for (const forbidden of [
        firstEvent.alert.title, firstEvent.alert.description, firstEvent.alert.resourceKey,
        'fingerprintDigest', 'profileDigest', 'exactSnapshotDigest', 'snapshotRef',
        'snapshot_ref', WEBHOOK_SECRET,
      ]) expect(serialized).not.toContain(forbidden);

      const forged = {
        ...alert('monitor-evidence-authority-denied', new Date().toISOString()),
        policy: { effect: 'repo_write' },
      };
      expect((await postAlert(forged)).status).toBe(400);
      const rejectedResponse = await evidence(forged.eventId);
      expect(rejectedResponse.status).toBe(200);
      expect(await rejectedResponse.json()).toEqual({
        schemaVersion: '1', adapter: 'generic', tenantKey: PROFILE.tenantKey,
        eventId: forged.eventId, found: false,
        counts: {
          receipts: 0, lineages: 0, candidates: 0,
          taskSources: 0, runs: 0, approvals: 0, outboxes: 0,
        },
        receipt: null, mapping: null, candidate: null, snapshot: null,
      });
    });

  it('suppresses at the exact window edge and starts a new candidate one millisecond later',
    async () => {
      const store = new MonitorAlertIngressStore(env.DB_CONTROL, env.TASK_OBJECTS, {
        profile: PROFILE,
      });
      const start = new Date('2026-07-26T05:00:00.000Z');
      const first = await store.accept(alert('monitor-edge-1', start.toISOString()), start);
      const edge = new Date(start.getTime() + 60_000);
      const second = await store.accept(alert('monitor-edge-2', edge.toISOString()), edge);
      const after = new Date(start.getTime() + 60_001);
      const third = await store.accept(alert('monitor-edge-3', after.toISOString()), after);
      expect(second.candidateId).toBe(first.candidateId);
      expect(second.disposition).toBe('suppressed');
      expect(third.candidateId).not.toBe(first.candidateId);
      expect(third.disposition).toBe('created');
      expect(await new MonitorAlertCandidateStore(env.DB_CONTROL).list(10)).toMatchObject([
        { candidateId: first.candidateId, occurrenceCount: 2, lineageCount: 2 },
        { candidateId: third.candidateId, occurrenceCount: 1, lineageCount: 1 },
      ]);
      await expect(env.DB_CONTROL.prepare(
        `UPDATE monitor_alert_candidates SET repository = 'attacker/other-repo'
         WHERE candidate_id = ?`,
      ).bind(first.candidateId).run()).rejects.toThrow(
        'monitor_alert_candidate_update_is_invalid',
      );
    });
});
