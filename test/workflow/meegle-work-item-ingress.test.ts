/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import type {
  MeegleTaskMappingProfileV1,
  MeegleWorkItemSnapshotV1,
} from '../../src/domain/meegle-work-item.js';
import { TaskEnvelopeSchema, taskRevisionDigest } from '../../src/domain/task.js';
import {
  FeishuIngressRelay,
  consumeFeishuIngressBatch,
  type FeishuIngressQueueMessage,
} from '../../src/outbox/feishu-ingress.js';
import { MeegleWorkItemIngressStore } from '../../src/storage/meegle-work-item-ingress-store.js';
import { SupplementalContextRevisionStore } from
  '../../src/storage/supplemental-context-revision-store.js';
import { FeishuWebhookStore } from '../../src/storage/feishu-webhook-store.js';

const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const TENANT_KEY = 'test-feishu-tenant';

class FakeQueue {
  readonly bodies: FeishuIngressQueueMessage[] = [];

  async send(body: FeishuIngressQueueMessage): Promise<void> {
    this.bodies.push(body);
  }
}

function profile(): MeegleTaskMappingProfileV1 {
  return {
    schemaVersion: '1',
    profileVersion: 1,
    tenantKey: TENANT_KEY,
    projectKey: 'project-a',
    workItemTypeKey: 'story',
    ownerRoleKey: 'delivery_owner',
    acceptanceCriteriaFieldKey: 'acceptance',
    targetRepositoryFieldKey: 'repository',
    kind: 'requirement',
    baseBranch: 'main',
    environment: 'test',
    defaultPriority: 'p2',
    allowedRepositories: ['example/delivery-pilot'],
  };
}

function snapshot(
  eventId: string,
  overrides: Partial<MeegleWorkItemSnapshotV1> = {},
): MeegleWorkItemSnapshotV1 {
  return {
    schemaVersion: '1',
    eventId,
    eventOccurredAt: NOW.toISOString(),
    tenantKey: TENANT_KEY,
    projectKey: 'project-a',
    workItemTypeKey: 'story',
    workItemId: 'work-item-42',
    revision: 'revision-7',
    updatedAt: NOW.toISOString(),
    url: 'https://example.feishu.cn/project/work-item/work-item-42',
    title: 'Resume delivery safely',
    description: 'Persist durable state and resume from its last checkpoint.',
    actor: { type: 'user', id: 'source-reporter' },
    fieldsComplete: true,
    nextPageToken: null,
    fields: [
      { fieldKey: 'acceptance', value: ['Resume at checkpoint', 'Dispatch remains unique'] },
      { fieldKey: 'repository', value: 'example/delivery-pilot' },
    ],
    roles: [{ roleKey: 'delivery_owner', owners: [{ userKey: 'owner-user-key' }] }],
    ...overrides,
  };
}

async function queuedIngress(eventId: string, ordinal: number): Promise<string> {
  const receivedAt = new Date(NOW.getTime() + ordinal * 1_000).toISOString();
  const receipt = await new FeishuWebhookStore(env.DB_CONTROL).accept({
    eventId,
    tenantKey: TENANT_KEY,
    appId: 'cli_test_delivery_loop',
    eventType: 'work_item.updated_v1',
    eventCreatedAt: NOW.toISOString(),
    verificationMode: 'encrypted',
    requestTimestamp: receivedAt,
    nonceDigest: await canonicalSha256(`nonce-${eventId}`),
    requestDigest: await canonicalSha256({ eventId, ordinal }),
    eventDigest: await canonicalSha256({ eventId, workItemId: 'work-item-42' }),
    receivedAt,
  });
  const queue = new FakeQueue();
  await new FeishuIngressRelay(
    env.DB_CONTROL,
    queue as unknown as Queue<FeishuIngressQueueMessage>,
    {
      now: () => new Date(NOW.getTime() + 10_000 + ordinal),
      generateLeaseId: () => `lease-${eventId}`,
    },
  ).relay(25);
  const message = {
    id: `queue-message-${receipt.ingressOutboxId}`,
    timestamp: new Date(NOW.getTime() + 10_000 + ordinal),
    attempts: 1,
    body: queue.bodies.find((body) => body.outboxId === receipt.ingressOutboxId)!,
    ack() {},
    retry() { throw new Error('unexpected retry'); },
  };
  await consumeFeishuIngressBatch(
    { queue: 'delivery-loop-feishu-ingress', messages: [message] } as unknown as
      MessageBatch<FeishuIngressQueueMessage>,
    env.DB_CONTROL,
    new Date(NOW.getTime() + 20_000 + ordinal),
  );
  return receipt.ingressOutboxId;
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM supplemental_context_revisions'),
    env.DB_CONTROL.prepare('DELETE FROM meegle_mapping_lineage'),
    env.DB_CONTROL.prepare('DELETE FROM meegle_triage_lineage'),
    env.DB_CONTROL.prepare('DELETE FROM meegle_triage_candidates'),
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
  const objects = await env.TASK_OBJECTS.list();
  if (objects.objects.length > 0) {
    await env.TASK_OBJECTS.delete(objects.objects.map((object) => object.key));
  }
}

beforeEach(reset);

describe('Meegle work-item ingress', () => {
  it('publishes a complete snapshot through the existing normalized Task sink', async () => {
    const firstEventId = 'event-meegle-complete-a';
    const secondEventId = 'event-meegle-complete-b';
    const firstIngressOutboxId = await queuedIngress(firstEventId, 1);
    const secondIngressOutboxId = await queuedIngress(secondEventId, 2);
    const store = new MeegleWorkItemIngressStore(env.DB_CONTROL, env.TASK_OBJECTS);
    const results = await Promise.all([
      store.process({
        ingressOutboxId: firstIngressOutboxId,
        snapshot: snapshot(firstEventId),
        profile: profile(),
        now: new Date(NOW.getTime() + 30_000),
      }),
      store.process({
        ingressOutboxId: secondIngressOutboxId,
        snapshot: snapshot(secondEventId),
        profile: profile(),
        now: new Date(NOW.getTime() + 30_000),
      }),
    ]);
    expect(results.every((result) => result.state === 'queued')).toBe(true);
    expect(new Set(results.map((result) => result.taskId))).toHaveLength(1);
    expect(new Set(results.map((result) => result.runId))).toHaveLength(1);
    // Simulate interruption after the normalized sink settled Task/Run but before
    // mapped lineage became durable. The same source retry must backfill it.
    await env.DB_CONTROL.prepare(
      'DELETE FROM meegle_mapping_lineage WHERE ingress_outbox_id = ?',
    ).bind(firstIngressOutboxId).run();
    await expect(store.process({
      ingressOutboxId: firstIngressOutboxId,
      snapshot: snapshot(firstEventId),
      profile: profile(),
      now: new Date(NOW.getTime() + 31_000),
    })).resolves.toMatchObject({
      state: 'queued',
      disposition: 'duplicate',
      taskId: results[0]?.taskId,
      runId: results[0]?.runId,
    });

    const counts = await env.DB_CONTROL.batch<{ count: number }>([
      env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM tasks'),
      env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM runs'),
      env.DB_CONTROL.prepare(
        "SELECT COUNT(*) AS count FROM outbox WHERE kind = 'workflow_create'",
      ),
      env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM meegle_triage_candidates'),
      env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM meegle_mapping_lineage'),
      env.DB_CONTROL.prepare(
        "SELECT COUNT(*) AS count FROM feishu_ingress_outbox WHERE delivery_state = 'settled'",
      ),
    ]);
    expect(counts.map((entry) => entry.results[0]?.count)).toEqual([1, 1, 1, 0, 2, 2]);
    const object = await env.TASK_OBJECTS.get(
      (await env.DB_CONTROL.prepare('SELECT payload_ref FROM tasks').first<{ payload_ref: string }>())!
        .payload_ref.replace('r2://', ''),
    );
    expect(await object?.json()).toMatchObject({
      coordination: { owner: { id: 'owner-user-key' } },
      target: { owner: 'example', repo: 'delivery-pilot' },
    });

    const evidenceResponse = await SELF.fetch(
      `https://example.test/v1/operations/meegle/evidence?tenantKey=${TENANT_KEY}` +
      `&eventId=${firstEventId}`,
      { headers: { authorization: 'Bearer test-operations-token' } },
    );
    expect(evidenceResponse.status).toBe(200);
    const evidence = await evidenceResponse.json();
    expect(evidence).toMatchObject({
      schemaVersion: '1',
      tenantKey: TENANT_KEY,
      eventId: firstEventId,
      outcome: 'mapped',
      counts: {
        mappingLineages: 1,
        mappedLineages: 1,
        triageLineages: 0,
        tasks: 1,
        runs: 1,
        workflowCreateOutboxes: 1,
      },
      lineage: {
        projectKey: 'project-a',
        workItemTypeKey: 'story',
        workItemId: 'work-item-42',
        revision: 'revision-7',
        mappingProfileVersion: 1,
        acceptanceCriteriaFieldKey: 'acceptance',
        ownerRoleKey: 'delivery_owner',
        targetRepositoryFieldKey: 'repository',
        fieldsComplete: true,
        hasNextPageToken: false,
        fieldCount: 2,
        roleCount: 1,
        ownerCount: 1,
        targetRepositoryStatus: 'allowed',
        snapshotObjectPresent: true,
        snapshotDigestVerified: true,
      },
      mapped: {
        sourceTaskKey: 'project-a/story/work-item-42',
        taskRevision: 'revision-7',
        taskId: results[0]?.taskId,
        runId: results[0]?.runId,
        workflowInstanceId: results[0]?.runId,
      },
      triage: null,
    });
    expect(JSON.stringify(evidence)).not.toContain('owner-user-key');
    expect(JSON.stringify(evidence)).not.toContain('r2://');
  });

  it('projects two Meegle events onto one supplemental revision and workflow effect', async () => {
    const firstEventId = 'event-meegle-context-a';
    const secondEventId = 'event-meegle-context-b';
    const firstIngressOutboxId = await queuedIngress(firstEventId, 1);
    const secondIngressOutboxId = await queuedIngress(secondEventId, 2);
    const store = new MeegleWorkItemIngressStore(env.DB_CONTROL, env.TASK_OBJECTS);
    const results = await Promise.all([
      store.process({
        ingressOutboxId: firstIngressOutboxId,
        snapshot: snapshot(firstEventId),
        profile: profile(),
        now: new Date(NOW.getTime() + 30_000),
      }),
      store.process({
        ingressOutboxId: secondIngressOutboxId,
        snapshot: snapshot(secondEventId),
        profile: profile(),
        now: new Date(NOW.getTime() + 30_000),
      }),
    ]);
    const newTaskId = results[0]?.taskId;
    const newRunId = results[0]?.runId;
    if (newTaskId === undefined || newRunId === undefined) throw new Error('mapped Task missing');
    const taskRow = await env.DB_CONTROL.prepare(
      'SELECT payload_ref FROM tasks WHERE task_id = ?',
    ).bind(newTaskId).first<{ payload_ref: string }>();
    if (taskRow === null) throw new Error('mapped Task object missing');
    const object = await env.TASK_OBJECTS.get(taskRow.payload_ref.slice('r2://'.length));
    if (object === null) throw new Error('mapped Task object missing');
    const mappedTask = TaskEnvelopeSchema.parse(await object.json());
    const priorTaskId = 'task-meegle-context-prior';
    const priorRunId = 'run-meegle-context-prior';
    const priorTask = TaskEnvelopeSchema.parse({
      ...mappedTask,
      eventId: 'event-meegle-context-prior',
      source: { ...mappedTask.source, revision: 'revision-6' },
    });
    const priorDigest = await taskRevisionDigest(priorTask);
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `INSERT INTO tasks (
           task_id, source_system, tenant_key, source_task_key, task_revision, source_url,
           task_digest, payload_ref, actor_type, actor_id, target_repository,
           target_base_branch, target_environment, intent_kind, title, priority,
           acceptance_criteria_count, allow_repository_write, allow_test_deploy,
           allow_production_deploy, require_human_approval, created_at, updated_at
         ) VALUES (?, 'meego', ?, ?, 'revision-6', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        priorTaskId,
        priorTask.source.tenantKey,
        priorTask.source.taskKey,
        priorTask.source.url ?? null,
        priorDigest,
        'r2://tasks/prior-meegle-context.json',
        priorTask.actor.type,
        priorTask.actor.id,
        `${priorTask.target.owner}/${priorTask.target.repo}`,
        priorTask.target.baseBranch,
        priorTask.target.environment,
        priorTask.intent.kind,
        priorTask.intent.title,
        priorTask.intent.priority,
        priorTask.intent.acceptanceCriteria.length,
        Number(priorTask.policy.allowRepositoryWrite),
        Number(priorTask.policy.allowTestDeploy),
        Number(priorTask.policy.allowProductionDeploy),
        Number(priorTask.policy.requireHumanApproval),
        NOW.toISOString(),
        NOW.toISOString(),
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO runs (
           run_id, task_id, task_revision, task_digest, base_sha, workflow_instance_id,
           state, version, created_at, updated_at
         ) VALUES (?, ?, 'revision-6', ?, ?, ?, 'succeeded', 1, ?, ?)`,
      ).bind(
        priorRunId,
        priorTaskId,
        priorDigest,
        'a'.repeat(40),
        priorRunId,
        NOW.toISOString(),
        NOW.toISOString(),
      ),
    ]);
    const supplemental = await new SupplementalContextRevisionStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
    ).accept({
      schemaVersion: '1',
      priorTaskId,
      task: mappedTask,
      context: 'The second external observation confirms the same requested revision.',
      applyToCurrentRun: false,
    }, new Date(NOW.getTime() + 40_000));
    expect(supplemental).toMatchObject({ taskId: newTaskId, runId: newRunId });

    const response = await SELF.fetch(
      `https://example.test/v1/operations/supplemental-context/evidence` +
        `?contextId=${supplemental.contextId}`,
      { headers: { authorization: 'Bearer test-operations-token' } },
    );
    expect(response.status).toBe(200);
    const evidence = await response.json() as {
      meegleMappings: Array<{ eventId: string }>;
      [key: string]: unknown;
    };
    expect(evidence).toMatchObject({
      contextId: supplemental.contextId,
      lineage: { mode: 'new_run', newTaskId, newRunId },
      source: { system: 'meego', tenantKey: TENANT_KEY, revision: 'revision-7' },
      objects: { contextVerified: true, newTaskVerified: true },
      feishuActions: [],
      counts: {
        contextRevisions: 1,
        newTasks: 1,
        newRuns: 1,
        workflowCreates: 1,
        feishuActions: 0,
        meegleMappings: 2,
      },
    });
    expect(new Set(evidence.meegleMappings.map(
      (lineage) => lineage.eventId,
    ))).toEqual(new Set([firstEventId, secondEventId]));
    expect(JSON.stringify(evidence)).not.toContain('r2://');
    expect(JSON.stringify(evidence)).not.toContain('source-reporter');
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM supplemental_context_revisions',
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      "SELECT COUNT(*) AS count FROM outbox WHERE kind = 'workflow_create' AND run_id = ?",
    ).bind(newRunId).first()).toEqual({ count: 1 });
  });

  it('persists one metadata-only triaging candidate and lists fixed gaps without effects', async () => {
    const eventId = 'event-meegle-incomplete';
    const ingressOutboxId = await queuedIngress(eventId, 1);
    const incomplete = snapshot(eventId, {
      description: 'PRIVATE_FEEDBACK_BODY',
      fieldsComplete: false,
      nextPageToken: 'business',
      fields: [],
      roles: [],
    });
    const store = new MeegleWorkItemIngressStore(env.DB_CONTROL, env.TASK_OBJECTS);
    const results = await Promise.all(Array.from({ length: 20 }, () => store.process({
      ingressOutboxId,
      snapshot: incomplete,
      profile: profile(),
      now: new Date(NOW.getTime() + 30_000),
    })));
    expect(new Set(results.map((result) => result.candidateId))).toHaveLength(1);
    expect(results[0]).toMatchObject({
      state: 'triaging',
      gaps: [
        'source_fields_incomplete',
        'acceptance_criteria_missing',
        'owner_missing',
        'target_repository_missing',
      ],
    });
    const counts = await env.DB_CONTROL.batch<{ count: number }>([
      env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM meegle_triage_candidates'),
      env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM meegle_triage_lineage'),
      env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM meegle_mapping_lineage'),
      env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM tasks'),
      env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM runs'),
      env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM outbox'),
    ]);
    expect(counts.map((entry) => entry.results[0]?.count)).toEqual([1, 1, 1, 0, 0, 0]);
    expect(JSON.stringify(await env.DB_CONTROL.prepare(
      'SELECT * FROM meegle_triage_candidates',
    ).first())).not.toContain('PRIVATE_FEEDBACK_BODY');

    const unauthorized = await SELF.fetch('https://example.test/v1/triage/meegle?limit=10');
    expect(unauthorized.status).toBe(401);
    const response = await SELF.fetch('https://example.test/v1/triage/meegle?limit=10', {
      headers: { authorization: 'Bearer test-operations-token' },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      schemaVersion: '1',
      candidates: [{
        status: 'triaging',
        source: {
          system: 'meego',
          tenantKey: TENANT_KEY,
          projectKey: 'project-a',
          workItemTypeKey: 'story',
          workItemId: 'work-item-42',
          revision: 'revision-7',
        },
        gaps: [
          'source_fields_incomplete',
          'acceptance_criteria_missing',
          'owner_missing',
          'target_repository_missing',
        ],
        lineageCount: 1,
      }],
    });
    expect(JSON.stringify(body)).not.toContain('PRIVATE_FEEDBACK_BODY');

    const evidenceResponse = await SELF.fetch(
      `https://example.test/v1/operations/meegle/evidence?tenantKey=${TENANT_KEY}` +
      `&eventId=${eventId}`,
      { headers: { authorization: 'Bearer test-operations-token' } },
    );
    expect(evidenceResponse.status).toBe(200);
    const evidence = await evidenceResponse.json();
    expect(evidence).toMatchObject({
      outcome: 'triaging',
      counts: {
        mappingLineages: 1,
        mappedLineages: 0,
        triageLineages: 1,
        tasks: 0,
        runs: 0,
        workflowCreateOutboxes: 0,
      },
      lineage: {
        fieldsComplete: false,
        hasNextPageToken: true,
        fieldCount: 0,
        roleCount: 0,
        ownerCount: 0,
        targetRepositoryStatus: 'missing',
        snapshotObjectPresent: true,
        snapshotDigestVerified: true,
      },
      triage: {
        candidateId: results[0]?.candidateId,
        gaps: [
          'source_fields_incomplete',
          'acceptance_criteria_missing',
          'owner_missing',
          'target_repository_missing',
        ],
        lineageCount: 1,
      },
      mapped: null,
    });
    expect(JSON.stringify(evidence)).not.toContain('PRIVATE_FEEDBACK_BODY');
    expect(JSON.stringify(evidence)).not.toContain('r2://');
  });

  it('rejects event/profile binding errors and configured Secrets before R2 or D1 writes', async () => {
    const eventId = 'event-meegle-security';
    const ingressOutboxId = await queuedIngress(eventId, 1);
    const store = new MeegleWorkItemIngressStore(
      env.DB_CONTROL,
      env.TASK_OBJECTS,
      { secrets: ['CANARY_MEEGLE_SECRET'] },
    );
    await expect(store.process({
      ingressOutboxId,
      snapshot: snapshot('different-event'),
      profile: profile(),
      now: new Date(NOW.getTime() + 30_000),
    })).rejects.toMatchObject({ code: 'binding_mismatch' });
    await expect(store.process({
      ingressOutboxId,
      snapshot: snapshot(eventId, { description: 'CANARY_MEEGLE_SECRET' }),
      profile: profile(),
      now: new Date(NOW.getTime() + 30_000),
    })).rejects.toMatchObject({ code: 'secret_detected' });
    await expect(store.process({
      ingressOutboxId,
      snapshot: snapshot(eventId),
      profile: { ...profile(), tenantKey: 'other-tenant' },
      now: new Date(NOW.getTime() + 30_000),
    })).rejects.toMatchObject({ code: 'profile_binding_mismatch' });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM meegle_triage_candidates',
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare('SELECT COUNT(*) AS count FROM tasks').first())
      .toEqual({ count: 0 });
    expect((await env.TASK_OBJECTS.list()).objects).toHaveLength(0);
  });
});
