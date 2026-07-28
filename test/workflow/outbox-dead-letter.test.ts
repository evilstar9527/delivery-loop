/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { FencedOutboxProcessor } from '../../src/outbox/fenced-outbox.js';
import {
  OutboxDestinationRouter,
  consumeOutboxBatch,
} from '../../src/outbox/outbox-queue-consumer.js';
import {
  OUTBOX_DEAD_LETTER_QUEUE,
  OutboxDeadLetterStore,
  consumeOutboxDeadLetterBatch,
} from '../../src/outbox/outbox-dead-letter.js';
import { WorkflowOutboxRelay } from '../../src/outbox/workflow-outbox.js';

const NOW = new Date('2026-07-26T14:00:00.000Z');
const OPERATIONS_TOKEN = 'test-operations-token';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const BASE_SHA = 'b'.repeat(40);

interface FakeMessage<Body> {
  id: string;
  timestamp: Date;
  body: Body;
  attempts: number;
  ackCount: number;
  retryCount: number;
  ack(): void;
  retry(): void;
}

function fakeMessage<Body>(id: string, body: Body, attempts = 4): FakeMessage<Body> {
  return {
    id,
    timestamp: NOW,
    body,
    attempts,
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

function batch<Body>(queue: string, messages: Array<FakeMessage<Body>>): MessageBatch<Body> {
  return { queue, messages } as unknown as MessageBatch<Body>;
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM outbox_dead_letter_replays'),
    env.DB_CONTROL.prepare('DELETE FROM outbox_dead_letters'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
}

async function seedOutbox(
  suffix: string,
  state: 'executing' | 'verifying' | 'deploying',
  kind: string,
  destination: 'github_actions' | 'github_api' | 'github_deployments',
): Promise<string> {
  const taskId = `task-dlq-${suffix}`;
  const runId = `run-dlq-${suffix}`;
  const outboxId = `outbox-dlq-${suffix}`;
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'manual', 'dlq-test', ?, 'revision-1', ?,
                 'r2://tasks/dlq-test', 'system', 'control-plane',
                 'example/delivery-target', 'main', 'none', 'bug',
                 'CANARY_DLQ_TASK_BODY', 'p1', 1, 0, 0, 0, 1, ?, ?)`,
    ).bind(taskId, taskId, DIGEST, NOW.toISOString(), NOW.toISOString()),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, created_at, updated_at
       ) VALUES (?, ?, 'revision-1', ?, ?, ?, ?, 1, ?, ?)`,
    ).bind(
      runId,
      taskId,
      DIGEST,
      BASE_SHA,
      runId,
      state,
      NOW.toISOString(),
      NOW.toISOString(),
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO outbox (
         outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
         delivery_state, attempt_count, last_error_code, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 3,
                 'destination_unavailable', ?, ?)`,
    ).bind(
      outboxId,
      runId,
      kind,
      destination,
      `d1://test/${outboxId}`,
      `dlq-test:${outboxId}`,
      NOW.toISOString(),
      NOW.toISOString(),
    ),
  ]);
  return outboxId;
}

beforeEach(reset);

describe('durable outbox dead-letter capture and replay', () => {
  it('captures an exhausted queue message once and blocks stale primary deliveries', async () => {
    const outboxId = await seedOutbox(
      'dispatch',
      'executing',
      'analysis_dispatch',
      'github_actions',
    );
    const malformed = fakeMessage<unknown>('dlq-malformed', { raw: 'CANARY_DLQ_RAW' });
    const exhausted = fakeMessage<unknown>('dlq-dispatch-message', { outboxId });
    await consumeOutboxDeadLetterBatch(
      batch(OUTBOX_DEAD_LETTER_QUEUE, [malformed, exhausted]),
      new OutboxDeadLetterStore(env.DB_CONTROL),
      NOW,
    );
    expect([malformed, exhausted].map(({ ackCount, retryCount }) => ({
      ackCount,
      retryCount,
    }))).toEqual([
      { ackCount: 1, retryCount: 0 },
      { ackCount: 1, retryCount: 0 },
    ]);
    expect(await env.DB_CONTROL.prepare(
      `SELECT outbox_id, status, source_attempts, outbox_attempt_count,
              destination, last_error_code
       FROM outbox_dead_letters`,
    ).first()).toEqual({
      outbox_id: outboxId,
      status: 'open',
      source_attempts: 4,
      outbox_attempt_count: 3,
      destination: 'github_actions',
      last_error_code: 'destination_unavailable',
    });
    const blocked = await new OutboxDestinationRouter(
      env.DB_CONTROL,
      { async deliver() { return 'settled'; } },
      { async deliver() { throw new Error('effect must stay fenced'); } },
    ).deliver(outboxId);
    expect(blocked).toBe('dead_lettered');
    let directEffectCalls = 0;
    await expect(new FencedOutboxProcessor(
      env.DB_CONTROL,
      'github_actions',
      async () => {
        directEffectCalls += 1;
      },
      { now: () => NOW },
    ).deliver(outboxId)).resolves.toBe('busy');
    expect(directEffectCalls).toBe(0);
    let relayCalls = 0;
    const queue = {
      async sendBatch() {
        relayCalls += 1;
      },
    } as unknown as Queue<{ outboxId: string }>;
    await expect(new WorkflowOutboxRelay(
      env.DB_CONTROL,
      queue,
      ['github_actions'],
    ).relay(100, NOW)).resolves.toBe(0);
    expect(relayCalls).toBe(0);
    expect(JSON.stringify(await new OutboxDeadLetterStore(env.DB_CONTROL).list('open', 100)))
      .not.toContain('CANARY_DLQ_TASK_BODY');
    expect(JSON.stringify(await new OutboxDeadLetterStore(env.DB_CONTROL).list('open', 100)))
      .not.toContain('CANARY_DLQ_RAW');
  });

  it('requires the operations identity and makes three replay requests one immutable schedule', async () => {
    const outboxId = await seedOutbox(
      'pr',
      'verifying',
      'pull_request',
      'github_api',
    );
    await new OutboxDeadLetterStore(env.DB_CONTROL).capture({
      sourceMessageId: 'dlq-pr-message',
      outboxId,
      sourceAttempts: 4,
      capturedAt: NOW,
    });
    const open = await SELF.fetch('https://delivery-loop.test/v1/dead-letters?status=open', {
      headers: { authorization: `Bearer ${OPERATIONS_TOKEN}` },
    });
    expect(open.status).toBe(200);
    const openBody = await open.json() as { deadLetters: Array<{ id: string }> };
    expect(openBody.deadLetters).toHaveLength(1);
    const deadLetterId = openBody.deadLetters[0]!.id;

    const wrongIdentity = await SELF.fetch(
      `https://delivery-loop.test/v1/dead-letters/${deadLetterId}/replay`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.TASK_INTAKE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          expectedOutboxAttemptCount: 3,
          reasonCode: 'configuration_fixed',
        }),
      },
    );
    expect(wrongIdentity.status).toBe(401);
    const canary = await SELF.fetch(
      `https://delivery-loop.test/v1/dead-letters/${deadLetterId}/replay`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${OPERATIONS_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          expectedOutboxAttemptCount: 3,
          reasonCode: 'configuration_fixed',
          destination: 'merge',
          raw: 'CANARY_DLQ_REPLAY',
        }),
      },
    );
    expect(canary.status).toBe(400);
    expect(await canary.text()).not.toContain('CANARY_DLQ_REPLAY');

    const responses = [];
    for (let index = 0; index < 3; index += 1) {
      responses.push(await SELF.fetch(
        `https://delivery-loop.test/v1/dead-letters/${deadLetterId}/replay`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${OPERATIONS_TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            expectedOutboxAttemptCount: 3,
            reasonCode: 'configuration_fixed',
          }),
        },
      ));
    }
    expect(responses.map((response) => response.status)).toEqual([202, 202, 202]);
    const bodies = await Promise.all(responses.map(async (response) => await response.json())) as
      Array<{ replayId: string; created: boolean }>;
    expect(bodies.map((body) => body.created)).toEqual([true, false, false]);
    expect(new Set(bodies.map((body) => body.replayId)).size).toBe(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox_dead_letter_replays`,
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state, attempt_count, lease_token, lease_expires_at,
              last_error_code FROM outbox WHERE outbox_id = ?`,
    ).bind(outboxId).first()).toEqual({
      delivery_state: 'pending',
      attempt_count: 3,
      lease_token: null,
      lease_expires_at: null,
      last_error_code: 'dead_letter_replay',
    });
  });

  it('replays dispatch, PR, and deployment three times without a duplicate effect or merge', async () => {
    const definitions = [
      ['dispatch', 'executing', 'analysis_dispatch', 'github_actions'],
      ['pr', 'verifying', 'pull_request', 'github_api'],
      ['deploy', 'deploying', 'github_deployment', 'github_deployments'],
    ] as const;
    const outboxIds = [];
    const store = new OutboxDeadLetterStore(env.DB_CONTROL);
    for (const [suffix, state, kind, destination] of definitions) {
      const outboxId = await seedOutbox(suffix, state, kind, destination);
      outboxIds.push(outboxId);
      const deadLetter = await store.capture({
        sourceMessageId: `dlq-${suffix}-message`,
        outboxId,
        sourceAttempts: 4,
        capturedAt: NOW,
      });
      for (let replay = 0; replay < 3; replay += 1) {
        await store.replay({
          deadLetterId: deadLetter.deadLetter.id,
          expectedOutboxAttemptCount: 3,
          reasonCode: 'upstream_recovered',
          requestedAt: NOW,
        });
      }
    }

    const calls = new Map<string, number>();
    const processor = (destination: string) => new FencedOutboxProcessor(
      env.DB_CONTROL,
      destination,
      async () => {
        calls.set(destination, (calls.get(destination) ?? 0) + 1);
      },
      { now: () => NOW, generateLeaseToken: () => `lease-${destination}` },
    );
    const router = new OutboxDestinationRouter(
      env.DB_CONTROL,
      processor('cloudflare_workflows'),
      processor('github_actions'),
      processor('github_api'),
      processor('github_deployments'),
    );
    const messages = outboxIds.flatMap((outboxId) => Array.from(
      { length: 3 },
      (_, index) => fakeMessage(`replay-${outboxId}-${index}`, { outboxId }, 1),
    ));
    await consumeOutboxBatch(
      batch('delivery-loop-workflow-outbox', messages),
      router,
    );
    expect(messages.every((message) => message.ackCount === 1)).toBe(true);
    expect(messages.every((message) => message.retryCount === 0)).toBe(true);
    expect(Object.fromEntries(calls)).toEqual({
      github_actions: 1,
      github_api: 1,
      github_deployments: 1,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM github_merges`,
    ).first()).toEqual({ count: 0 });
    await expect(store.reconcile(
      100,
      new Date(NOW.getTime() + 1_000),
    )).resolves.toHaveLength(3);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox_dead_letters WHERE status = 'resolved'`,
    ).first()).toEqual({ count: 3 });
  });
});
