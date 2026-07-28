/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import type { TaskEnvelope } from '../../src/domain/task.js';
import {
  FeishuIngressRelay,
  consumeFeishuIngressBatch,
  type FeishuIngressQueueMessage,
} from '../../src/outbox/feishu-ingress.js';
import { FeishuNormalizedTaskStore } from '../../src/storage/feishu-normalized-task-store.js';
import { FeishuWebhookStore } from '../../src/storage/feishu-webhook-store.js';

const TENANT_KEY = 'test-feishu-tenant';
const APP_ID = 'cli_test_delivery_loop';
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const OPERATIONS_AUTHORIZATION = 'Bearer test-operations-token';

class FakeQueue {
  readonly bodies: FeishuIngressQueueMessage[] = [];

  constructor(private failuresRemaining = 0) {}

  async send(body: FeishuIngressQueueMessage): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('queue unavailable');
    }
    this.bodies.push(body);
  }
}

interface FakeMessage {
  id: string;
  timestamp: Date;
  attempts: number;
  body: FeishuIngressQueueMessage;
  ackCount: number;
  retryCount: number;
  ack(): void;
  retry(): void;
}

function fakeMessage(
  body: FeishuIngressQueueMessage,
  id = `queue-message-${body.outboxId}`,
  timestamp = new Date(NOW.getTime() + 10_000),
  attempts = 1,
): FakeMessage {
  return {
    id,
    timestamp,
    attempts,
    body,
    ackCount: 0,
    retryCount: 0,
    ack() {
      this.ackCount += 1;
    },
    retry() {
      this.retryCount += 1;
    },
  };
}

async function receipt(
  eventId: string,
  nonce: string,
  requestOrdinal: number,
) {
  const requestTimestamp = new Date(NOW.getTime() + requestOrdinal * 1_000).toISOString();
  return await new FeishuWebhookStore(env.DB_CONTROL).accept({
    eventId,
    tenantKey: TENANT_KEY,
    appId: APP_ID,
    eventType: 'work_item.updated_v1',
    eventCreatedAt: NOW.toISOString(),
    verificationMode: 'encrypted',
    requestTimestamp,
    nonceDigest: await canonicalSha256(nonce),
    requestDigest: await canonicalSha256({ eventId, nonce, requestOrdinal }),
    eventDigest: await canonicalSha256({
      tenantKey: TENANT_KEY,
      eventId,
      revision: 'revision-7',
    }),
    receivedAt: requestTimestamp,
  });
}

function task(eventId: string, description = 'Investigate the reported failure.'): TaskEnvelope {
  return {
    schemaVersion: '1',
    eventId,
    occurredAt: NOW.toISOString(),
    source: {
      system: 'feishu',
      tenantKey: TENANT_KEY,
      taskKey: 'work-item-42',
      revision: 'revision-7',
      url: 'https://example.feishu.cn/project/work-item-42',
    },
    actor: { type: 'user', id: 'principal-feishu-owner' },
    target: {
      owner: 'example',
      repo: 'delivery-pilot',
      baseBranch: 'main',
      environment: 'test',
    },
    intent: {
      kind: 'bug',
      title: 'Investigate delivery failure',
      description,
      acceptanceCriteria: ['The failure is reproduced and fixed with regression evidence.'],
      priority: 'p1',
    },
    policy: {
      allowRepositoryWrite: false,
      allowTestDeploy: false,
      allowProductionDeploy: false,
      requireHumanApproval: true,
    },
  };
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM feishu_ingress_queue_observations'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_ingress_outbox'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_webhook_nonces'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_webhook_deliveries'),
    env.DB_CONTROL.prepare('DELETE FROM idempotency_keys'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  const objects = await env.TASK_OBJECTS.list({ prefix: 'tasks/' });
  if (objects.objects.length > 0) {
    await env.TASK_OBJECTS.delete(objects.objects.map((object) => object.key));
  }
}

async function queuePending(now: Date): Promise<FakeQueue> {
  const queue = new FakeQueue();
  const relay = new FeishuIngressRelay(
    env.DB_CONTROL,
    queue as unknown as Queue<FeishuIngressQueueMessage>,
    {
      now: () => new Date(now.getTime() - 1_000),
      generateLeaseId: () => crypto.randomUUID(),
    },
  );
  await relay.relay(25);
  const messages = queue.bodies.map((body) => fakeMessage(
    body,
    `queue-message-${body.outboxId}`,
    new Date(now.getTime() - 1_000),
  ));
  await consumeFeishuIngressBatch(
    { queue: 'delivery-loop-feishu-ingress', messages } as unknown as
      MessageBatch<FeishuIngressQueueMessage>,
    env.DB_CONTROL,
    now,
  );
  expect(messages.every((message) => message.ackCount === 1 && message.retryCount === 0))
    .toBe(true);
  return queue;
}

beforeEach(async () => {
  await reset();
});

describe('Feishu event and Task revision idempotency', () => {
  it('turns three platform replays into one durable ingress outbox and one Queue send', async () => {
    const first = await receipt('event-feishu-replay-1', 'nonce-replay-1', 1);
    const second = await receipt('event-feishu-replay-1', 'nonce-replay-2', 2);
    const third = await receipt('event-feishu-replay-1', 'nonce-replay-3', 3);
    expect([first.disposition, second.disposition, third.disposition])
      .toEqual(['created', 'duplicate', 'duplicate']);
    expect(new Set([first.ingressOutboxId, second.ingressOutboxId, third.ingressOutboxId]))
      .toHaveLength(1);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM feishu_ingress_outbox',
    ).first()).toEqual({ count: 1 });

    const queue = new FakeQueue();
    const relay = new FeishuIngressRelay(
      env.DB_CONTROL,
      queue as unknown as Queue<FeishuIngressQueueMessage>,
      {
        now: () => new Date(NOW.getTime() + 10_000),
        generateLeaseId: () => 'feishu-ingress-relay-lease',
      },
    );
    const relayed = await Promise.all(Array.from({ length: 20 }, () => relay.relay(25)));
    expect(relayed.reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(queue.bodies).toEqual([{ outboxId: first.ingressOutboxId }]);

    const message = fakeMessage(queue.bodies[0]!);
    await consumeFeishuIngressBatch(
      { queue: 'delivery-loop-feishu-ingress', messages: [message] } as unknown as
        MessageBatch<FeishuIngressQueueMessage>,
      env.DB_CONTROL,
      new Date(NOW.getTime() + 20_000),
    );
    expect(message.ackCount).toBe(1);
    expect(message.retryCount).toBe(0);
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state, queue_observed_at, attempt_count
       FROM feishu_ingress_outbox`,
    ).first()).toEqual({
      delivery_state: 'queued',
      queue_observed_at: new Date(NOW.getTime() + 20_000).toISOString(),
      attempt_count: 1,
    });
    const observations = await env.DB_CONTROL.prepare(
      `SELECT queue_name, queue_message_id_digest, delivery_attempt,
              message_timestamp, observed_at
       FROM feishu_ingress_queue_observations`,
    ).all<Record<string, unknown>>();
    expect(observations.results).toEqual([{
      queue_name: 'delivery-loop-feishu-ingress',
      queue_message_id_digest: await canonicalSha256(
        `queue-message-${first.ingressOutboxId}`,
      ),
      delivery_attempt: 1,
      message_timestamp: new Date(NOW.getTime() + 10_000).toISOString(),
      observed_at: new Date(NOW.getTime() + 20_000).toISOString(),
    }]);

    const duplicate = fakeMessage(
      queue.bodies[0]!,
      `queue-message-${first.ingressOutboxId}`,
      new Date(NOW.getTime() + 10_000),
      1,
    );
    await consumeFeishuIngressBatch(
      { queue: 'delivery-loop-feishu-ingress', messages: [duplicate] } as unknown as
        MessageBatch<FeishuIngressQueueMessage>,
      env.DB_CONTROL,
      new Date(NOW.getTime() + 21_000),
    );
    expect(duplicate.ackCount).toBe(1);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM feishu_ingress_queue_observations',
    ).first()).toEqual({ count: 1 });

    const secondAttempt = fakeMessage(
      queue.bodies[0]!,
      `queue-message-${first.ingressOutboxId}`,
      new Date(NOW.getTime() + 10_000),
      2,
    );
    await consumeFeishuIngressBatch(
      { queue: 'delivery-loop-feishu-ingress', messages: [secondAttempt] } as unknown as
        MessageBatch<FeishuIngressQueueMessage>,
      env.DB_CONTROL,
      new Date(NOW.getTime() + 22_000),
    );
    expect(secondAttempt.ackCount).toBe(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count, COUNT(DISTINCT queue_message_id_digest) AS identities,
              MAX(delivery_attempt) AS maximum_attempt
       FROM feishu_ingress_queue_observations`,
    ).first()).toEqual({ count: 2, identities: 1, maximum_attempt: 2 });
    expect(JSON.stringify(await env.DB_CONTROL.prepare(
      'SELECT * FROM feishu_ingress_queue_observations',
    ).all())).not.toContain(`queue-message-${first.ingressOutboxId}`);
  });

  it('links two different events for one source revision to one Task, Run, and workflow intent', async () => {
    const first = await receipt('event-feishu-revision-a', 'nonce-revision-a', 1);
    await receipt('event-feishu-revision-a', 'nonce-revision-a-replay-2', 2);
    await receipt('event-feishu-revision-a', 'nonce-revision-a-replay-3', 3);
    const second = await receipt('event-feishu-revision-b', 'nonce-revision-b', 4);
    const now = new Date(NOW.getTime() + 20_000);
    expect((await queuePending(now)).bodies).toHaveLength(2);

    const store = new FeishuNormalizedTaskStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
      { secrets: ['CANARY_FEISHU_ADAPTER_SECRET'] },
    );
    const [resultA, resultB] = await Promise.all([
      store.accept({ ingressOutboxId: first.ingressOutboxId, task: task(first.eventId), now }),
      store.accept({ ingressOutboxId: second.ingressOutboxId, task: task(second.eventId), now }),
    ]);
    expect(resultA.taskId).toBe(resultB.taskId);
    expect(resultA.runId).toBe(resultB.runId);
    const counts = await env.DB_CONTROL.batch<{ count: number }>([
      env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM tasks'),
      env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM runs'),
      env.DB_CONTROL.prepare(
        `SELECT COUNT(*) AS count FROM outbox WHERE kind = 'workflow_create'`,
      ),
      env.DB_CONTROL.prepare(
        `SELECT COUNT(*) AS count FROM feishu_ingress_outbox
         WHERE delivery_state = 'settled' AND run_id = ?`,
      ).bind(resultA.runId),
    ]);
    expect(counts[0]?.results[0]?.count).toBe(1);
    expect(counts[1]?.results[0]?.count).toBe(1);
    expect(counts[2]?.results[0]?.count).toBe(1);
    expect(counts[3]?.results[0]?.count).toBe(2);
    expect((await env.TASK_OBJECTS.list({ prefix: `tasks/${resultA.taskId}/` })).objects)
      .toHaveLength(1);

    const unauthenticated = await SELF.fetch(
      `https://delivery-loop.test/v1/operations/feishu-ingress/evidence?tenantKey=${TENANT_KEY}&eventId=${first.eventId}`,
    );
    expect(unauthenticated.status).toBe(401);
    const invalidQuery = await SELF.fetch(
      `https://delivery-loop.test/v1/operations/feishu-ingress/evidence?tenantKey=${TENANT_KEY}&eventId=${first.eventId}&eventId=duplicate`,
      { headers: { authorization: OPERATIONS_AUTHORIZATION } },
    );
    expect(invalidQuery.status).toBe(400);
    const projections = await Promise.all([first, second].map(async (event) => {
      const response = await SELF.fetch(
        `https://delivery-loop.test/v1/operations/feishu-ingress/evidence?tenantKey=${TENANT_KEY}&eventId=${event.eventId}`,
        { headers: { authorization: OPERATIONS_AUTHORIZATION } },
      );
      expect(response.status).toBe(200);
      return await response.json<Record<string, unknown>>();
    }));
    expect(projections[0]).toMatchObject({
      schemaVersion: '1',
      tenantKey: TENANT_KEY,
      eventId: first.eventId,
      counts: {
        deliveries: 1,
        transportReceipts: 3,
        ingressOutboxes: 1,
        queueMessageIdentities: 1,
        queueObservations: 1,
        tasks: 1,
        runs: 1,
        workflowCreateOutboxes: 1,
      },
      ingress: {
        outboxId: first.ingressOutboxId,
        deliveryState: 'settled',
        relayAttemptCount: 1,
        taskId: resultA.taskId,
        runId: resultA.runId,
      },
      task: {
        taskId: resultA.taskId,
        runId: resultA.runId,
        workflowInstanceId: resultA.runId,
        workflowCreateState: 'pending',
      },
    });
    expect(projections[1]).toMatchObject({
      counts: { transportReceipts: 1, queueMessageIdentities: 1, queueObservations: 1 },
      task: {
        taskId: resultA.taskId,
        runId: resultA.runId,
        workflowInstanceId: resultA.runId,
      },
    });
    expect(JSON.stringify(projections)).not.toContain('nonce-revision');
    expect(JSON.stringify(projections)).not.toContain('Investigate the reported failure');
  });

  it('returns a definite Queue failure to pending and safely retries the same logical outbox', async () => {
    const created = await receipt('event-feishu-queue-retry', 'nonce-queue-retry', 1);
    const queue = new FakeQueue(1);
    let lease = 0;
    const relay = new FeishuIngressRelay(
      env.DB_CONTROL,
      queue as unknown as Queue<FeishuIngressQueueMessage>,
      {
        now: () => new Date(NOW.getTime() + 10_000),
        generateLeaseId: () => `feishu-queue-lease-${++lease}`,
      },
    );
    await expect(relay.relay()).resolves.toBe(0);
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state, attempt_count, last_failure_code
       FROM feishu_ingress_outbox WHERE outbox_id = ?`,
    ).bind(created.ingressOutboxId).first()).toEqual({
      delivery_state: 'pending',
      attempt_count: 1,
      last_failure_code: 'queue_unavailable',
    });
    await expect(relay.relay()).resolves.toBe(1);
    expect(queue.bodies).toEqual([{ outboxId: created.ingressOutboxId }]);
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state, attempt_count, last_failure_code
       FROM feishu_ingress_outbox WHERE outbox_id = ?`,
    ).bind(created.ingressOutboxId).first()).toEqual({
      delivery_state: 'enqueued',
      attempt_count: 2,
      last_failure_code: null,
    });
  });

  it('rejects an unbound event or configured Secret before Task/R2 publication', async () => {
    const receiptResult = await receipt('event-feishu-policy-1', 'nonce-policy-1', 1);
    const now = new Date(NOW.getTime() + 20_000);
    expect((await queuePending(now)).bodies).toHaveLength(1);
    const store = new FeishuNormalizedTaskStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
      { secrets: ['CANARY_FEISHU_ADAPTER_SECRET'] },
    );
    await expect(store.accept({
      ingressOutboxId: receiptResult.ingressOutboxId,
      task: task('another-event'),
      now,
    })).rejects.toMatchObject({ code: 'binding_mismatch' });
    await expect(store.accept({
      ingressOutboxId: receiptResult.ingressOutboxId,
      task: task(receiptResult.eventId, 'CANARY_FEISHU_ADAPTER_SECRET'),
      now,
    })).rejects.toMatchObject({ code: 'secret_detected' });
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM tasks').first())
      .toEqual({ count: 0 });
    expect((await env.TASK_OBJECTS.list({ prefix: 'tasks/' })).objects).toHaveLength(0);
  });
});
