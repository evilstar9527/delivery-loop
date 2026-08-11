/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Bindings } from '../../src/env.js';
import { githubDispatchProcessorFromEnv } from '../../src/outbox/github-dispatch-runtime.js';
import { githubPullRequestRuntimeFromEnv } from '../../src/outbox/github-pull-request-runtime.js';
import { githubTestAcceptanceRuntimeFromEnv } from '../../src/outbox/github-test-acceptance-runtime.js';
import { githubTestDeploymentRuntimeFromEnv } from '../../src/outbox/github-test-deployment-runtime.js';
import { githubTestRollbackRuntimeFromEnv } from '../../src/outbox/github-test-rollback-runtime.js';
import { githubProductionDeploymentRuntimeFromEnv } from '../../src/outbox/github-production-deployment-runtime.js';
import { feishuDeliveryCardRuntimeFromEnv } from '../../src/outbox/feishu-delivery-card-runtime.js';
import { githubProductionDeploymentStatusReconcilerFromEnv } from '../../src/reconciliation/github-production-deployment-status-runtime.js';
import {
  OutboxDestinationRouter,
  consumeOutboxBatch,
  type DestinationOutboxProcessor,
} from '../../src/outbox/outbox-queue-consumer.js';
import {
  WorkflowOutboxRelay,
  type WorkflowOutboxMessage,
} from '../../src/outbox/workflow-outbox.js';
import type { OutboxDeliveryResult } from '../../src/outbox/fenced-outbox.js';

const NOW = '2026-07-25T09:00:00.000Z';
const TEST_PRIVATE_KEY_PEM = [
  ['-----', 'BEGIN PRIVATE KEY', '-----'].join(''),
  btoa('delivery-loop-test-key'.repeat(5)),
  ['-----', 'END PRIVATE KEY', '-----'].join(''),
].join('\n');

class FakeDestinationProcessor implements DestinationOutboxProcessor {
  readonly calls: string[] = [];

  constructor(public result: OutboxDeliveryResult = 'settled') {}

  async deliver(outboxId: string): Promise<OutboxDeliveryResult> {
    this.calls.push(outboxId);
    return this.result;
  }
}

class FakeQueue {
  readonly bodies: WorkflowOutboxMessage[] = [];

  async sendBatch(messages: Iterable<MessageSendRequest<WorkflowOutboxMessage>>): Promise<void> {
    for (const message of messages) this.bodies.push(message.body);
  }
}

interface FakeMessage {
  body: WorkflowOutboxMessage;
  ackCount: number;
  retryCount: number;
  ack(): void;
  retry(): void;
}

function fakeMessage(outboxId: string): FakeMessage {
  return {
    body: { outboxId },
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

async function seedOutboxes(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (
         'task-outbox-routing', 'manual', 'outbox-routing', 'outbox-routing', '1', ?,
         'r2://tasks/outbox-routing', 'system', 'outbox-routing', 'example/repo',
         'main', 'none', 'bug', 'Outbox routing', 'p1', 1, 0, 0, 0, 1, ?, ?
       )`,
    ).bind(`sha256:${'5'.repeat(64)}`, NOW, NOW),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, created_at, updated_at
       ) VALUES (
         'run-outbox-routing', 'task-outbox-routing', '1', ?, ?,
         'run-outbox-routing', 'planning', 1, ?, ?
       )`,
    ).bind(`sha256:${'5'.repeat(64)}`, 'f'.repeat(40), NOW, NOW),
    ...[
      ['outbox-workflow-route', 'workflow_create', 'cloudflare_workflows'],
      ['outbox-github-route', 'analysis_dispatch', 'github_actions'],
      ['outbox-github-api-route', 'pull_request', 'github_api'],
      ['outbox-github-deployment-route', 'test_deploy', 'github_deployments'],
      ['outbox-github-acceptance-route', 'test_acceptance_dispatch', 'github_acceptance'],
      ['outbox-github-production-route', 'production_deploy', 'github_production_deployments'],
      ['outbox-github-test-rollback-route', 'test_rollback_dispatch', 'github_test_rollback'],
      ['outbox-feishu-card-route', 'feishu_delivery_card_upsert', 'feishu_cards'],
      ['outbox-unknown-route', 'future_effect', 'unsupported_destination'],
    ].map(([outboxId, kind, destination]) =>
      env.DB_CONTROL.prepare(
        `INSERT INTO outbox (
           outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
           delivery_state, created_at, updated_at
         ) VALUES (?, 'run-outbox-routing', ?, ?, ?, ?, 'pending', ?, ?)`,
      ).bind(
        outboxId,
        kind,
        destination,
        `d1://test/${outboxId}`,
        `dedupe:${outboxId}`,
        NOW,
        NOW,
      ),
    ),
  ]);
}

beforeEach(async () => {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM feishu_delivery_card_deliveries'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_delivery_card_presentations'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_delivery_cards'),
    env.DB_CONTROL.prepare('DELETE FROM github_api_observations'),
    env.DB_CONTROL.prepare('DELETE FROM github_webhook_deliveries'),
    env.DB_CONTROL.prepare('DELETE FROM workflow_signals'),
    env.DB_CONTROL.prepare('DELETE FROM idempotency_keys'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  await seedOutboxes();
});

describe('production outbox Queue routing', () => {
  it('relays every configured control-plane and GitHub destination', async () => {
    const queue = new FakeQueue();
    const relay = new WorkflowOutboxRelay(
      env.DB_CONTROL,
      queue as unknown as Queue<WorkflowOutboxMessage>,
      [
        'cloudflare_workflows',
        'github_actions',
        'github_api',
        'github_deployments',
        'github_acceptance',
        'github_production_deployments',
        'github_test_rollback',
        'feishu_cards',
      ],
    );
    expect(await relay.relay(100, new Date(NOW))).toBe(8);
    expect(queue.bodies.map((message) => message.outboxId).sort()).toEqual([
      'outbox-feishu-card-route',
      'outbox-github-acceptance-route',
      'outbox-github-api-route',
      'outbox-github-deployment-route',
      'outbox-github-production-route',
      'outbox-github-route',
      'outbox-github-test-rollback-route',
      'outbox-workflow-route',
    ]);
  });

  it('relays one priority GitHub agent dispatch without touching older destinations', async () => {
    const queue = new FakeQueue();
    const relay = new WorkflowOutboxRelay(
      env.DB_CONTROL,
      queue as unknown as Queue<WorkflowOutboxMessage>,
      ['cloudflare_workflows', 'github_actions'],
    );

    expect(await relay.relayDestination('github_actions', 1, new Date(NOW))).toBe(1);
    expect(queue.bodies).toEqual([{ outboxId: 'outbox-github-route' }]);

    const unconfigured = new WorkflowOutboxRelay(
      env.DB_CONTROL,
      queue as unknown as Queue<WorkflowOutboxMessage>,
      ['cloudflare_workflows'],
    );
    expect(await unconfigured.relayDestination('github_actions', 1, new Date(NOW))).toBe(0);
    expect(queue.bodies).toEqual([{ outboxId: 'outbox-github-route' }]);
  });

  it('routes by the D1 destination instead of trusting the Queue payload', async () => {
    const workflow = new FakeDestinationProcessor();
    const github = new FakeDestinationProcessor();
    const githubApi = new FakeDestinationProcessor();
    const githubDeployments = new FakeDestinationProcessor();
    const githubAcceptance = new FakeDestinationProcessor();
    const githubProduction = new FakeDestinationProcessor();
    const githubTestRollback = new FakeDestinationProcessor();
    const feishuCards = new FakeDestinationProcessor();
    const router = new OutboxDestinationRouter(
      env.DB_CONTROL,
      workflow,
      github,
      githubApi,
      githubDeployments,
      githubAcceptance,
      githubProduction,
      githubTestRollback,
      feishuCards,
    );

    expect(await router.deliver('outbox-workflow-route')).toBe('settled');
    expect(await router.deliver('outbox-github-route')).toBe('settled');
    expect(await router.deliver('outbox-github-api-route')).toBe('settled');
    expect(await router.deliver('outbox-github-deployment-route')).toBe('settled');
    expect(await router.deliver('outbox-github-acceptance-route')).toBe('settled');
    expect(await router.deliver('outbox-github-production-route')).toBe('settled');
    expect(await router.deliver('outbox-github-test-rollback-route')).toBe('settled');
    expect(await router.deliver('outbox-feishu-card-route')).toBe('settled');
    expect(await router.deliver('outbox-unknown-route')).toBe('unsupported');
    expect(await router.deliver('missing-outbox')).toBe('missing');
    expect(workflow.calls).toEqual(['outbox-workflow-route']);
    expect(github.calls).toEqual(['outbox-github-route']);
    expect(githubApi.calls).toEqual(['outbox-github-api-route']);
    expect(githubDeployments.calls).toEqual(['outbox-github-deployment-route']);
    expect(githubAcceptance.calls).toEqual(['outbox-github-acceptance-route']);
    expect(githubProduction.calls).toEqual(['outbox-github-production-route']);
    expect(githubTestRollback.calls).toEqual(['outbox-github-test-rollback-route']);
    expect(feishuCards.calls).toEqual(['outbox-feishu-card-route']);
  });

  it('keeps GitHub messages retryable when App dispatch is not configured', async () => {
    const router = new OutboxDestinationRouter(
      env.DB_CONTROL,
      new FakeDestinationProcessor(),
      null,
    );
    expect(await router.deliver('outbox-github-route')).toBe('unconfigured');
    expect(await router.deliver('outbox-github-api-route')).toBe('unconfigured');
    expect(await router.deliver('outbox-github-deployment-route')).toBe('unconfigured');
    expect(await router.deliver('outbox-github-acceptance-route')).toBe('unconfigured');
    expect(await router.deliver('outbox-github-production-route')).toBe('unconfigured');
    expect(await router.deliver('outbox-github-test-rollback-route')).toBe('unconfigured');
    expect(await router.deliver('outbox-feishu-card-route')).toBe('unconfigured');
    const row = await env.DB_CONTROL.prepare(
      'SELECT delivery_state, attempt_count FROM outbox WHERE outbox_id = ?',
    )
      .bind('outbox-github-route')
      .first<Record<string, unknown>>();
    expect(row).toEqual({ delivery_state: 'pending', attempt_count: 0 });
  });

  it('enables the production GitHub processor only for complete App and control-plane config', () => {
    const base = { DB_CONTROL: env.DB_CONTROL } as Bindings;
    expect(githubDispatchProcessorFromEnv(base)).toBeNull();
    expect(githubPullRequestRuntimeFromEnv(base)).toBeNull();
    expect(githubTestDeploymentRuntimeFromEnv(base)).toBeNull();
    expect(githubTestAcceptanceRuntimeFromEnv(base)).toBeNull();
    expect(githubTestRollbackRuntimeFromEnv(base)).toBeNull();
    expect(githubProductionDeploymentRuntimeFromEnv(base)).toBeNull();
    expect(githubProductionDeploymentStatusReconcilerFromEnv(base)).toBeNull();
    expect(feishuDeliveryCardRuntimeFromEnv(base)).toBeNull();
    expect(() =>
      githubDispatchProcessorFromEnv({ ...base, GITHUB_APP_ID: '123' }),
    ).toThrow('GitHub reconciliation configuration is incomplete');
    expect(() =>
      githubPullRequestRuntimeFromEnv({ ...base, GITHUB_APP_ID: '123' }),
    ).toThrow('GitHub reconciliation configuration is incomplete');
    expect(() =>
      githubTestDeploymentRuntimeFromEnv({
        ...base,
        TEST_DEPLOY_TARGETS_JSON: '[]',
      }),
    ).toThrow('test deployment configuration is incomplete');
    expect(() =>
      githubTestAcceptanceRuntimeFromEnv({
        ...base,
        TEST_DEPLOY_TARGETS_JSON: '[]',
      }),
    ).toThrow('test acceptance configuration is incomplete');
    expect(() =>
      githubTestRollbackRuntimeFromEnv({
        ...base,
        TEST_DEPLOY_TARGETS_JSON: '[]',
      }),
    ).toThrow('test rollback configuration is incomplete');
    expect(() =>
      githubProductionDeploymentRuntimeFromEnv({
        ...base,
        PRODUCTION_DEPLOY_TARGETS_JSON: '[]',
      }),
    ).toThrow('production deployment configuration is incomplete');
    expect(() => feishuDeliveryCardRuntimeFromEnv({
      ...base,
      FEISHU_APP_ID: 'test-app-id',
    })).toThrow('Feishu delivery card configuration is incomplete');
    const appBindings = {
      ...base,
      GITHUB_APP_ID: '123',
      GITHUB_APP_INSTALLATION_ID: '456',
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
      GITHUB_ALLOWED_REPOSITORIES: '["example/repo"]',
    };
    expect(() => githubDispatchProcessorFromEnv(appBindings)).toThrow(
      'GitHub dispatch configuration is incomplete',
    );
    expect(githubPullRequestRuntimeFromEnv(appBindings)).not.toBeNull();
    expect(githubTestDeploymentRuntimeFromEnv(appBindings)).toBeNull();
    expect(githubTestAcceptanceRuntimeFromEnv(appBindings)).toBeNull();
    expect(githubTestRollbackRuntimeFromEnv(appBindings)).toBeNull();
    expect(githubProductionDeploymentRuntimeFromEnv(appBindings)).toBeNull();
    expect(githubProductionDeploymentStatusReconcilerFromEnv(appBindings)).not.toBeNull();
    expect(feishuDeliveryCardRuntimeFromEnv({
      ...base,
      FEISHU_APP_ID: 'test-app-id',
      FEISHU_APP_SECRET: 'test-app-secret',
      FEISHU_DELIVERY_TENANT_KEY: 'outbox-routing',
      FEISHU_DELIVERY_CHAT_ID: 'oc_outbox_routing',
    })).not.toBeNull();
    expect(githubTestDeploymentRuntimeFromEnv({
      ...appBindings,
      TEST_DEPLOY_TARGETS_JSON: JSON.stringify([{
        repository: 'example/repo',
        environment: 'test',
        workflowPath: '.github/workflows/delivery-test-deploy.yml',
        oidcAudience: 'delivery-loop-test-deploy',
        roleRef: 'test:delivery-loop-deployer',
      }]),
    })).not.toBeNull();
    expect(githubTestAcceptanceRuntimeFromEnv({
      ...appBindings,
      CONTROL_PLANE_URL: 'https://control.example.test',
      TEST_DEPLOY_TARGETS_JSON: JSON.stringify([{
        repository: 'example/repo',
        environment: 'test',
        workflowPath: '.github/workflows/delivery-test-deploy.yml',
        oidcAudience: 'delivery-loop-test-deploy',
        roleRef: 'test:delivery-loop-deployer',
      }]),
    })).not.toBeNull();
    expect(githubTestRollbackRuntimeFromEnv({
      ...appBindings,
      CONTROL_PLANE_URL: 'https://control.example.test',
      TEST_DEPLOY_TARGETS_JSON: JSON.stringify([{
        repository: 'example/repo',
        environment: 'test',
        workflowPath: '.github/workflows/delivery-test-deploy.yml',
        oidcAudience: 'delivery-loop-test-deploy',
        roleRef: 'test:delivery-loop-deployer',
      }]),
    })).not.toBeNull();
    expect(githubProductionDeploymentRuntimeFromEnv({
      ...appBindings,
      PRODUCTION_DEPLOY_TARGETS_JSON: JSON.stringify([{
        repository: 'example/repo',
        environment: 'production',
        workflowPath: '.github/workflows/delivery-production-deploy.yml',
        oidcAudience: 'delivery-loop-production-deploy',
        roleRef: 'production:delivery-loop-deployer',
      }]),
    })).not.toBeNull();
    expect(
      githubDispatchProcessorFromEnv({
        ...appBindings,
        CONTROL_PLANE_URL: 'https://control.example.test',
        CODEX_MODEL_PROFILE_ID: 'codex-production',
      }),
    ).not.toBeNull();
  });

  it('acks only terminal/missing deliveries and retries busy, failed, or unconfigured routes', async () => {
    const messages = [
      fakeMessage('settled'),
      fakeMessage('missing'),
      fakeMessage('retry'),
      fakeMessage('busy'),
      fakeMessage('unconfigured'),
      fakeMessage('unsupported'),
    ];
    const results = new Map(
      messages.map((message) => [message.body.outboxId, message.body.outboxId]),
    );
    await consumeOutboxBatch(
      { messages } as unknown as MessageBatch<WorkflowOutboxMessage>,
      {
        async deliver(outboxId) {
          return results.get(outboxId) as
            | 'settled'
            | 'missing'
            | 'retry'
            | 'busy'
            | 'unconfigured'
            | 'unsupported';
        },
      },
    );
    expect(messages.map(({ ackCount, retryCount }) => ({ ackCount, retryCount }))).toEqual([
      { ackCount: 1, retryCount: 0 },
      { ackCount: 1, retryCount: 0 },
      { ackCount: 0, retryCount: 1 },
      { ackCount: 0, retryCount: 1 },
      { ackCount: 0, retryCount: 1 },
      { ackCount: 0, retryCount: 1 },
    ]);
  });
});
