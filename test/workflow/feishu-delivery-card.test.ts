/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import {
  FeishuDeliveryCardOutboxProcessor,
  FeishuDeliveryCardUnavailableError,
  type CreateFeishuDeliveryCardRequest,
  type FeishuDeliveryCardEffects,
  type UpdateFeishuDeliveryCardRequest,
} from '../../src/outbox/feishu-delivery-card.js';
import { FeishuDeliveryCardReconciler } from '../../src/reconciliation/feishu-delivery-card-reconciler.js';
import { FeishuDeliveryCardMessageReconciler } from '../../src/reconciliation/feishu-delivery-card-message-reconciler.js';

const RUN_ID = 'run-feishu-delivery-card';
const TASK_ID = 'task-feishu-delivery-card';
const TENANT_KEY = 'test-feishu-tenant';
const CHAT_ID = 'oc_feishu_delivery_status';
const TASK_DIGEST = `sha256:${'a'.repeat(64)}`;
const START = '2026-07-26T05:00:00.000Z';

class FakeFeishuEffects implements FeishuDeliveryCardEffects {
  readonly creates: CreateFeishuDeliveryCardRequest[] = [];
  readonly updates: UpdateFeishuDeliveryCardRequest[] = [];

  async createCard(request: CreateFeishuDeliveryCardRequest) {
    this.creates.push(request);
    return {
      disposition: 'created' as const,
      messageId: `om_delivery_status_${this.creates.length}`,
    };
  }

  async updateCard(request: UpdateFeishuDeliveryCardRequest) {
    this.updates.push(request);
    return { disposition: 'updated' as const };
  }
}

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM feishu_delivery_card_observations'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_delivery_card_deliveries'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_delivery_card_refresh_requests'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_delivery_card_presentation_lineages'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_delivery_card_presentations'),
    env.DB_CONTROL.prepare('DELETE FROM feishu_delivery_cards'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_failure_paths'),
    env.DB_CONTROL.prepare('DELETE FROM run_blockers'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_failures'),
    env.DB_CONTROL.prepare('DELETE FROM approvals'),
    env.DB_CONTROL.prepare('DELETE FROM checkpoints'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_progress'),
    env.DB_CONTROL.prepare('DELETE FROM plan_items'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plans'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
}

async function seed(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (?, 'feishu', ?, ?, 'revision-1', ?, 'r2://tasks/feishu-delivery',
                 'user', 'external-user', 'example/delivery-target', 'main',
                 'production', 'requirement', 'CANARY_UNTRUSTED_TASK_TITLE',
                 'p1', 1, 1, 1, 1, 1, ?, ?)`,
    ).bind(TASK_ID, TENANT_KEY, TASK_ID, TASK_DIGEST, START, START),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, workflow_instance_id,
         state, version, created_at, updated_at
       ) VALUES (?, ?, 'revision-1', ?, ?, 'received', 0, ?, ?)`,
    ).bind(RUN_ID, TASK_ID, TASK_DIGEST, RUN_ID, START, START),
  ]);
}

async function seedFullRunStatus(): Promise<void> {
  const baseSha = 'b'.repeat(40);
  const planDigest = `sha256:${'c'.repeat(64)}`;
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha,
         version, lease_generation, created_at, updated_at
       ) VALUES ('attempt-card-analysis', ?, 1, 'analysis', 'completed', ?, 1, 1, ?, ?)`,
    ).bind(RUN_ID, baseSha, START, START),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha,
         plan_id, plan_version, plan_item_id, version, lease_generation,
         created_at, updated_at
       ) VALUES ('attempt-card-failed', ?, 2, 'implement', 'failed', ?,
                 'plan-card-active', 2, 'item-card-change', 1, 1, ?, ?)`,
    ).bind(RUN_ID, baseSha, '2026-07-26T05:01:00.000Z', '2026-07-26T05:02:00.000Z'),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         github_run_id, github_status, github_external_updated_at,
         github_observation_version, plan_id, plan_version, plan_item_id,
         version, lease_generation, created_at, updated_at
       ) VALUES ('attempt-card-observed', ?, 3, 'review_fix', 'completed', ?,
                 'example/delivery-target', '987654', 'completed', ?, 1,
                 'plan-card-active', 2, 'item-card-change', 1, 1, ?, ?)`,
    ).bind(
      RUN_ID,
      baseSha,
      '2026-07-26T05:04:00.000Z',
      '2026-07-26T05:03:00.000Z',
      '2026-07-26T05:04:00.000Z',
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest,
         status, created_by_attempt_id, objective, created_at, updated_at
       ) VALUES ('plan-card-active', ?, 2, 'revision-1', ?, ?, 'active',
                 'attempt-card-analysis', 'Deliver the bounded change.', ?, ?)`,
    ).bind(RUN_ID, baseSha, planDigest, START, '2026-07-26T05:01:00.000Z'),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (
         plan_id, item_id, kind, title, objective, required, position
       ) VALUES ('plan-card-active', 'item-card-change', 'change',
                 'Implement bounded retry safely', 'Change only the retry boundary.', 1, 0)`,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (
         plan_id, item_id, status, active_attempt_id, version, updated_at
       ) VALUES ('plan-card-active', 'item-card-change', 'blocked', NULL, 3, ?)`,
    ).bind('2026-07-26T05:04:00.000Z'),
    env.DB_CONTROL.prepare(
      `INSERT INTO checkpoints (
         checkpoint_id, attempt_id, sequence, plan_id, plan_version,
         plan_item_id, head_sha, payload_ref, payload_digest, summary,
         next_step, created_at
       ) VALUES ('checkpoint-card', 'attempt-card-observed', 3,
                 'plan-card-active', 2, 'item-card-change', ?,
                 'r2://checkpoints/card', ?,
                 'Checkpoint contains CANARY_CARD_SECRET and must be hidden.',
                 'Wait for human input.', ?)`,
    ).bind(baseSha, `sha256:${'d'.repeat(64)}`, '2026-07-26T05:04:00.000Z'),
    env.DB_CONTROL.prepare(
      `INSERT INTO evidence (
         evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
         kind, status, sha, external_url, summary, verification_status,
         observed_at, created_at
       ) VALUES ('evidence-card-check', ?, 'attempt-card-observed',
                 'plan-card-active', 2, 'item-card-change', 'check', 'passed', ?,
                 'https://github.com/example/delivery-target/actions/runs/987654/job/111',
                 'Full verification passed; detailed logs remain external.', 'verified', ?, ?)`,
    ).bind(
      RUN_ID,
      baseSha,
      '2026-07-26T05:04:00.000Z',
      '2026-07-26T05:04:00.000Z',
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-card-valid', ?, 'revision-1', 'plan-card-active', 2, ?, ?,
                 'repo_write', 'human-reviewer', 'approve', ?, ?, ?)`,
    ).bind(
      RUN_ID,
      planDigest,
      baseSha,
      `sha256:${'e'.repeat(64)}`,
      '2026-07-26T05:10:00.000Z',
      '2026-07-26T05:04:00.000Z',
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version, plan_digest,
         base_sha, effect, actor_id, decision, nonce_digest, expires_at, created_at
       ) VALUES ('approval-card-expired', ?, 'revision-1', 'plan-card-active', 2, ?, ?,
                 'test_deploy', 'human-reviewer', 'approve', ?, ?, ?)`,
    ).bind(
      RUN_ID,
      planDigest,
      baseSha,
      `sha256:${'f'.repeat(64)}`,
      '2026-07-26T05:03:00.000Z',
      '2026-07-26T05:02:00.000Z',
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_failures (
         failure_id, run_id, attempt_id, attempt_ordinal, event_id, sequence,
         retry_scope_digest, fingerprint_digest, failure_class, failure_code,
         failure_site, needed_human_input, scope_attempt_count,
         consecutive_fingerprint_count, revoked_lease_generation, occurred_at, created_at
       ) VALUES ('failure-card', ?, 'attempt-card-failed', 2, 'event-card-failure', 1,
                 ?, ?, 'verification_error', 'verification_nonzero_exit',
                 'targeted_verification', 'provide_reproduction', 2, 2, 1, ?, ?)`,
    ).bind(
      RUN_ID,
      `sha256:${'1'.repeat(64)}`,
      `sha256:${'2'.repeat(64)}`,
      '2026-07-26T05:02:00.000Z',
      '2026-07-26T05:02:00.000Z',
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_failure_paths (failure_id, position, path_code)
       VALUES ('failure-card', 0, 'repository_inspection')`,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempt_failure_paths (failure_id, position, path_code)
       VALUES ('failure-card', 1, 'targeted_test')`,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO run_blockers (
         blocker_id, run_id, reason, retry_scope_digest, fingerprint_digest,
         attempt_count, consecutive_fingerprint_count, needed_human_input, created_at
       ) VALUES ('blocker-card', ?, 'repeated_fingerprint', ?, ?, 2, 2,
                 'provide_reproduction', ?)`,
    ).bind(
      RUN_ID,
      `sha256:${'1'.repeat(64)}`,
      `sha256:${'2'.repeat(64)}`,
      '2026-07-26T05:02:00.000Z',
    ),
    env.DB_CONTROL.prepare(
      `UPDATE runs SET state = 'blocked', version = 7, base_sha = ?,
         active_plan_id = 'plan-card-active', active_plan_version = 2,
         active_plan_digest = ?, updated_at = ? WHERE run_id = ?`,
    ).bind(baseSha, planDigest, '2026-07-26T05:04:00.000Z', RUN_ID),
  ]);
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('durable Feishu delivery-card presentation and outbox', () => {
  it('removes consumed approvals and every action from a succeeded completion card', async () => {
    await seedFullRunStatus();
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE run_blockers SET resolved_at = ? WHERE run_id = ? AND resolved_at IS NULL`,
      ).bind('2026-07-26T05:04:30.000Z', RUN_ID),
      env.DB_CONTROL.prepare(
        `UPDATE runs SET state = 'succeeded', version = 8, updated_at = ? WHERE run_id = ?`,
      ).bind('2026-07-26T05:04:30.000Z', RUN_ID),
    ]);
    const result = await new FeishuDeliveryCardReconciler(
      env.DB_CONTROL,
      { tenantKey: TENANT_KEY, chatId: CHAT_ID },
      { now: () => new Date('2026-07-26T05:05:00.000Z') },
    ).reconcileRun(RUN_ID);
    if (result === 'not_found') throw new Error('completion presentation missing');
    const raw = await env.DB_CONTROL.prepare(
      `SELECT presentation_json FROM feishu_delivery_card_presentations
       WHERE presentation_id = ?`,
    ).bind(result.presentationId).first<string>('presentation_json');
    const presentation = JSON.parse(raw!) as {
      runState: string;
      approvedEffects: unknown[];
      actions: unknown[];
    };
    expect(presentation.runState).toBe('succeeded');
    expect(presentation.approvedEffects).toEqual([]);
    expect(presentation.actions).toEqual([]);
  });

  it('projects the full Run/Plan/DoD/action/blocker/approval card and refreshes expired effects', async () => {
    await seedFullRunStatus();
    const reconciler = new FeishuDeliveryCardReconciler(
      env.DB_CONTROL,
      { tenantKey: TENANT_KEY, chatId: CHAT_ID },
      {
        now: () => new Date('2026-07-26T05:05:00.000Z'),
        secrets: ['CANARY_CARD_SECRET'],
      },
    );
    const first = await reconciler.reconcileRun(RUN_ID);
    if (first === 'not_found') throw new Error('full presentation missing');
    const stored = await env.DB_CONTROL.prepare(
      `SELECT schema_version, presentation_json
       FROM feishu_delivery_card_presentations WHERE presentation_id = ?`,
    ).bind(first.presentationId).first<{
      schema_version: string;
      presentation_json: string;
    }>();
    expect(stored?.schema_version).toBe('2');
    const presentation = JSON.parse(stored!.presentation_json) as Record<string, unknown>;
    expect(presentation).toMatchObject({
      schemaVersion: '2',
      runState: 'blocked',
      taskRevision: 'revision-1',
      targetRepository: 'example/delivery-target',
      planVersion: 2,
      progress: {
        passed: 0,
        total: 1,
        requiredPassed: 0,
        requiredTotal: 1,
        inProgress: 0,
        failed: 0,
        blocked: 1,
      },
      currentGoal: 'Implement bounded retry safely',
      actionUrl: 'https://github.com/example/delivery-target/actions/runs/987654',
      checkUrl: 'https://github.com/example/delivery-target/actions/runs/987654/job/111',
      checkpointSummary: '摘要已隐藏（检测到敏感内容）',
      evidenceSummary: 'Full verification passed; detailed logs remain external.',
      blocker: {
        reason: 'repeated_fingerprint',
        attemptCount: 2,
        attemptedPaths: ['repository_inspection', 'targeted_test'],
        neededHumanInput: 'provide_reproduction',
      },
      approvedEffects: [{
        effect: 'repo_write',
        expiresAt: '2026-07-26T05:10:00.000Z',
      }],
    });
    expect(stored!.presentation_json).not.toContain('CANARY_CARD_SECRET');
    expect(stored!.presentation_json).not.toContain('r2://');

    const effects = new FakeFeishuEffects();
    const processor = new FeishuDeliveryCardOutboxProcessor(env.DB_CONTROL, effects, {
      now: () => new Date('2026-07-26T05:05:00.000Z'),
    });
    await expect(processor.deliver(first.outboxId)).resolves.toBe('settled');
    const encodedCard = JSON.stringify(effects.creates[0]!.card);
    expect(encodedCard).toContain('Implement bounded retry safely');
    expect(encodedCard).toContain('repo_write');
    expect(encodedCard).toContain('delivery-loop:');
    expect(encodedCard).toContain('"signal"');
    expect(effects.creates[0]!.card.elements).toHaveLength(16);
    expect(encodedCard).not.toContain('CANARY_CARD_SECRET');

    const afterExpiry = new FeishuDeliveryCardReconciler(
      env.DB_CONTROL,
      { tenantKey: TENANT_KEY, chatId: CHAT_ID },
      {
        now: () => new Date('2026-07-26T05:11:00.000Z'),
        secrets: ['CANARY_CARD_SECRET'],
      },
    );
    const refreshed = await afterExpiry.reconcileBatch(25);
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]!.presentationId).not.toBe(first.presentationId);
    const refreshedJson = await env.DB_CONTROL.prepare(
      `SELECT presentation_json FROM feishu_delivery_card_presentations
       WHERE presentation_id = ?`,
    ).bind(refreshed[0]!.presentationId).first<string>('presentation_json');
    expect(JSON.parse(refreshedJson!).approvedEffects).toEqual([]);

    const expiryProcessor = new FeishuDeliveryCardOutboxProcessor(env.DB_CONTROL, effects, {
      now: () => new Date('2026-07-26T05:11:01.000Z'),
    });
    await expect(expiryProcessor.deliver(refreshed[0]!.outboxId)).resolves.toBe('settled');
    expect(effects.creates).toHaveLength(1);
    expect(effects.updates).toHaveLength(1);
    expect(effects.updates[0]!.messageId).toBe('om_delivery_status_1');

    const evidenceEndpoint =
      `https://delivery-loop.test/v1/operations/feishu-card-presentation/evidence?runId=${RUN_ID}`;
    expect((await SELF.fetch(evidenceEndpoint)).status).toBe(401);
    expect((await SELF.fetch(`${evidenceEndpoint}&extra=1`, {
      headers: { authorization: 'Bearer test-operations-token' },
    })).status).toBe(400);
    const response = await SELF.fetch(evidenceEndpoint, {
      headers: { authorization: 'Bearer test-operations-token' },
    });
    expect(response.status).toBe(200);
    const evidence = await response.json<{
      evidence: {
        presentations: Array<{
          presentationId: string;
          lineage: {
            trigger: string;
            priorSourceObservedAt: string | null;
            sourceObservedAt: string;
            triggerRefreshAt: string | null;
          };
          snapshot: { approvedEffects: Array<{ effect: string }> };
          delivery: { disposition: string; messageId: string } | null;
        }>;
      };
    }>();
    expect(evidence.evidence.presentations).toHaveLength(2);
    expect(evidence.evidence.presentations[0]).toMatchObject({
      presentationId: first.presentationId,
      lineage: { trigger: 'initial' },
      delivery: { disposition: 'created', messageId: 'om_delivery_status_1' },
    });
    expect(evidence.evidence.presentations[1]).toMatchObject({
      presentationId: refreshed[0]!.presentationId,
      lineage: {
        trigger: 'approval_expiry',
        triggerRefreshAt: '2026-07-26T05:10:00.000Z',
      },
      snapshot: { approvedEffects: [] },
      delivery: { disposition: 'updated', messageId: 'om_delivery_status_1' },
    });
    expect(evidence.evidence.presentations[1]!.lineage.priorSourceObservedAt).toBe(
      evidence.evidence.presentations[1]!.lineage.sourceObservedAt,
    );
    const encodedEvidence = JSON.stringify(evidence);
    expect(encodedEvidence).not.toContain('CANARY_CARD_SECRET');
    expect(encodedEvidence).not.toContain('r2://');
    expect(encodedEvidence).not.toContain('"nonce"');
    await expect(env.DB_CONTROL.prepare(
      `UPDATE feishu_delivery_card_presentation_lineages SET trigger_reason = 'source_change'
       WHERE presentation_id = ?`,
    ).bind(refreshed[0]!.presentationId).run()).rejects.toThrow(
      'feishu_card_presentation_lineage_is_immutable',
    );
  });

  it('converges 20 reconcilers, settles stale revisions without an effect, and creates then PATCHes one card', async () => {
    const reconciler = new FeishuDeliveryCardReconciler(
      env.DB_CONTROL,
      { tenantKey: TENANT_KEY, chatId: CHAT_ID },
      { now: () => new Date(START) },
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, async () => await reconciler.reconcileRun(RUN_ID)),
    );
    const found = results.filter((result) => result !== 'not_found');
    expect(found).toHaveLength(20);
    expect(found.filter((result) => result.disposition === 'created')).toHaveLength(1);
    expect(new Set(found.map((result) => result.presentationId))).toHaveLength(1);
    expect(new Set(found.map((result) => result.outboxId))).toHaveLength(1);
    await expect(env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM feishu_delivery_card_presentations',
    ).first<{ count: number }>('count')).resolves.toBe(1);
    await expect(env.DB_CONTROL.prepare(
      "SELECT COUNT(*) AS count FROM outbox WHERE destination = 'feishu_cards'",
    ).first<{ count: number }>('count')).resolves.toBe(1);

    const first = found[0]!;
    await env.DB_CONTROL.prepare(
      `UPDATE runs SET version = 1, state = 'triaging', updated_at = ? WHERE run_id = ?`,
    ).bind('2026-07-26T05:01:00.000Z', RUN_ID).run();
    const second = await reconciler.reconcileRun(RUN_ID);
    expect(second).not.toBe('not_found');
    if (second === 'not_found') throw new Error('second presentation missing');
    expect(second.presentationId).not.toBe(first.presentationId);

    const effects = new FakeFeishuEffects();
    const processor = new FeishuDeliveryCardOutboxProcessor(env.DB_CONTROL, effects, {
      now: () => new Date('2026-07-26T05:02:00.000Z'),
      generateLeaseToken: () => crypto.randomUUID(),
    });
    await expect(processor.deliver(first.outboxId)).resolves.toBe('settled');
    expect(effects.creates).toHaveLength(0);
    expect(effects.updates).toHaveLength(0);
    await expect(env.DB_CONTROL.prepare(
      'SELECT last_error_code FROM outbox WHERE outbox_id = ?',
    ).bind(first.outboxId).first<string>('last_error_code')).resolves.toBe(
      'feishu_card_presentation_stale',
    );

    await expect(processor.deliver(second.outboxId)).resolves.toBe('settled');
    expect(effects.creates).toHaveLength(1);
    expect(effects.updates).toHaveLength(0);
    const encodedCreate = JSON.stringify(effects.creates[0]!.card);
    expect(encodedCreate).not.toContain('CANARY_UNTRUSTED_TASK_TITLE');
    expect(effects.creates[0]!.card.elements).toHaveLength(14);
    expect(effects.creates[0]!.dedupeId).toHaveLength(50);

    await env.DB_CONTROL.prepare(
      `UPDATE runs SET version = 2, state = 'planning', updated_at = ? WHERE run_id = ?`,
    ).bind('2026-07-26T05:03:00.000Z', RUN_ID).run();
    const third = await reconciler.reconcileRun(RUN_ID);
    if (third === 'not_found') throw new Error('third presentation missing');
    await expect(processor.deliver(third.outboxId)).resolves.toBe('settled');
    expect(effects.creates).toHaveLength(1);
    expect(effects.updates).toHaveLength(1);
    expect(effects.updates[0]!.messageId).toBe('om_delivery_status_1');

    await expect(env.DB_CONTROL.prepare(
      `SELECT delivered_revision, active_message_id
       FROM feishu_delivery_cards WHERE run_id = ?`,
    ).bind(RUN_ID).first()).resolves.toMatchObject({
      delivered_revision: 3,
      active_message_id: 'om_delivery_status_1',
    });
    await expect(env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM feishu_delivery_card_deliveries',
    ).first<{ count: number }>('count')).resolves.toBe(2);
  });

  it('recreates a card whose Feishu PATCH window has expired', async () => {
    const reconciler = new FeishuDeliveryCardReconciler(env.DB_CONTROL, {
      tenantKey: TENANT_KEY,
      chatId: CHAT_ID,
    });
    const first = await reconciler.reconcileRun(RUN_ID);
    if (first === 'not_found') throw new Error('first presentation missing');
    const effects = new FakeFeishuEffects();
    const processor = new FeishuDeliveryCardOutboxProcessor(env.DB_CONTROL, effects, {
      now: () => new Date('2026-07-26T05:00:00.000Z'),
    });
    await expect(processor.deliver(first.outboxId)).resolves.toBe('settled');
    await env.DB_CONTROL.prepare(
      `UPDATE feishu_delivery_cards SET active_message_created_at = ? WHERE run_id = ?`,
    ).bind('2026-07-01T00:00:00.000Z', RUN_ID).run();
    await env.DB_CONTROL.prepare(
      `UPDATE runs SET version = 1, updated_at = ? WHERE run_id = ?`,
    ).bind('2026-07-26T05:01:00.000Z', RUN_ID).run();
    const second = await reconciler.reconcileRun(RUN_ID);
    if (second === 'not_found') throw new Error('second presentation missing');
    await expect(processor.deliver(second.outboxId)).resolves.toBe('settled');
    expect(effects.updates).toHaveLength(0);
    expect(effects.creates).toHaveLength(2);
    await expect(env.DB_CONTROL.prepare(
      'SELECT active_message_id FROM feishu_delivery_cards WHERE run_id = ?',
    ).bind(RUN_ID).first<string>('active_message_id')).resolves.toBe('om_delivery_status_2');
  });

  it('settles a lost PATCH response after the read-only Feishu message matches', async () => {
    const projector = new FeishuDeliveryCardReconciler(env.DB_CONTROL, {
      tenantKey: TENANT_KEY,
      chatId: CHAT_ID,
    }, { now: () => new Date(START) });
    const first = await projector.reconcileRun(RUN_ID);
    if (first === 'not_found') throw new Error('first presentation missing');
    const effects = new FakeFeishuEffects();
    const firstProcessor = new FeishuDeliveryCardOutboxProcessor(env.DB_CONTROL, effects, {
      now: () => new Date(START),
    });
    await expect(firstProcessor.deliver(first.outboxId)).resolves.toBe('settled');

    await env.DB_CONTROL.prepare(
      `UPDATE runs SET version = 1, state = 'triaging', updated_at = ? WHERE run_id = ?`,
    ).bind('2026-07-26T05:01:00.000Z', RUN_ID).run();
    const second = await projector.reconcileRun(RUN_ID);
    if (second === 'not_found') throw new Error('second presentation missing');
    const lostResponseEffects: FeishuDeliveryCardEffects = {
      createCard: async () => {
        throw new Error('create must not run');
      },
      updateCard: async (request) => {
        effects.updates.push(request);
        throw new Error('CANARY_LOST_PATCH_RESPONSE');
      },
    };
    const retrying = new FeishuDeliveryCardOutboxProcessor(
      env.DB_CONTROL,
      lostResponseEffects,
      { now: () => new Date('2026-07-26T05:02:00.000Z') },
    );
    await expect(retrying.deliver(second.outboxId)).resolves.toBe('retry');
    expect(effects.updates).toHaveLength(1);
    const expectedCardDigest = await canonicalSha256(effects.updates[0]!.card);
    const getCardMessage = async () => ({
      messageId: 'om_delivery_status_1',
      chatId: CHAT_ID,
      appId: 'cli_delivery_loop',
      tenantKey: TENANT_KEY,
      msgType: 'interactive' as const,
      deleted: false as const,
      cardDigest: expectedCardDigest,
      createdAt: START,
      updatedAt: '2026-07-26T05:02:00.000Z',
    });
    const reconciler = new FeishuDeliveryCardMessageReconciler(
      env.DB_CONTROL,
      { getCardMessage },
      { appId: 'cli_delivery_loop', tenantKey: TENANT_KEY, chatId: CHAT_ID },
      () => new Date('2026-07-26T05:03:00.000Z'),
    );

    const results = await Promise.all(
      Array.from({ length: 20 }, () => reconciler.reconcileCard(RUN_ID)),
    );
    expect(results.some((result) => result === 'applied')).toBe(true);
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivered_revision, active_message_id
       FROM feishu_delivery_cards WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({
      delivered_revision: 2,
      active_message_id: 'om_delivery_status_1',
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT delivery_state, last_error_code FROM outbox WHERE outbox_id = ?',
    ).bind(second.outboxId).first()).toEqual({
      delivery_state: 'settled',
      last_error_code: null,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM feishu_delivery_card_observations
       WHERE processing_state = 'applied'`,
    ).first()).toEqual({ count: 1 });
    expect(JSON.stringify(await env.DB_CONTROL.prepare(
      'SELECT * FROM feishu_delivery_card_observations',
    ).first())).not.toContain('CANARY_LOST_PATCH_RESPONSE');
  });

  it('retries the same outbox on rate limit and timeout without regressing card state', async () => {
    const reconciler = new FeishuDeliveryCardReconciler(env.DB_CONTROL, {
      tenantKey: TENANT_KEY,
      chatId: CHAT_ID,
    }, { now: () => new Date(START) });
    const first = await reconciler.reconcileRun(RUN_ID);
    if (first === 'not_found') throw new Error('first presentation missing');
    const created = new FakeFeishuEffects();
    await expect(new FeishuDeliveryCardOutboxProcessor(
      env.DB_CONTROL,
      created,
      { now: () => new Date(START) },
    ).deliver(first.outboxId)).resolves.toBe('settled');

    await env.DB_CONTROL.prepare(
      `UPDATE runs SET version = 1, state = 'triaging', updated_at = ? WHERE run_id = ?`,
    ).bind('2026-07-26T05:01:00.000Z', RUN_ID).run();
    const second = await reconciler.reconcileRun(RUN_ID);
    if (second === 'not_found') throw new Error('second presentation missing');
    let call = 0;
    const flaky: FeishuDeliveryCardEffects = {
      createCard: async () => {
        throw new Error('create must not run');
      },
      updateCard: async () => {
        call += 1;
        if (call === 1) {
          throw new FeishuDeliveryCardUnavailableError('feishu_rate_limited');
        }
        if (call === 2) {
          throw new FeishuDeliveryCardUnavailableError('feishu_api_timeout');
        }
        return { disposition: 'updated' };
      },
    };
    const processor = new FeishuDeliveryCardOutboxProcessor(env.DB_CONTROL, flaky, {
      now: () => new Date('2026-07-26T05:02:00.000Z'),
    });

    await expect(processor.deliver(second.outboxId)).resolves.toBe('retry');
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state, attempt_count, last_error_code FROM outbox WHERE outbox_id = ?`,
    ).bind(second.outboxId).first()).toEqual({
      delivery_state: 'pending',
      attempt_count: 1,
      last_error_code: 'feishu_rate_limited',
    });
    await expect(processor.deliver(second.outboxId)).resolves.toBe('retry');
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state, attempt_count, last_error_code FROM outbox WHERE outbox_id = ?`,
    ).bind(second.outboxId).first()).toEqual({
      delivery_state: 'pending',
      attempt_count: 2,
      last_error_code: 'feishu_api_timeout',
    });
    expect((await env.DB_CONTROL.prepare(
      `SELECT attempt_count, error_code FROM feishu_delivery_card_retry_observations
       WHERE outbox_id = ? ORDER BY attempt_count`,
    ).bind(second.outboxId).all()).results).toEqual([
      { attempt_count: 1, error_code: 'feishu_rate_limited' },
      { attempt_count: 2, error_code: 'feishu_api_timeout' },
    ]);
    await expect(env.DB_CONTROL.prepare(
      `UPDATE feishu_delivery_card_retry_observations
       SET error_code = 'feishu_unavailable' WHERE outbox_id = ? AND attempt_count = 1`,
    ).bind(second.outboxId).run()).rejects.toThrow('feishu_card_retry_observation_is_immutable');
    const retrySnapshot = await SELF.fetch(
      `https://delivery-loop.test/v1/runs/${RUN_ID}/feishu-card`,
      { headers: { authorization: 'Bearer test-operations-token' } },
    );
    expect(retrySnapshot.status).toBe(200);
    expect(await retrySnapshot.json<{
      card: { retryHistory: Array<{
        attemptCount: number;
        errorCode: string;
      }> };
    }>()).toMatchObject({
      card: {
        retryHistory: [
          { attemptCount: 1, errorCode: 'feishu_rate_limited' },
          { attemptCount: 2, errorCode: 'feishu_api_timeout' },
        ],
      },
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT latest_revision, delivered_revision, active_message_id
       FROM feishu_delivery_cards WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({
      latest_revision: 2,
      delivered_revision: 1,
      active_message_id: 'om_delivery_status_1',
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM feishu_delivery_card_deliveries',
    ).first()).toEqual({ count: 1 });

    await expect(processor.deliver(second.outboxId)).resolves.toBe('settled');
    expect(await env.DB_CONTROL.prepare(
      `SELECT delivery_state, attempt_count, last_error_code FROM outbox WHERE outbox_id = ?`,
    ).bind(second.outboxId).first()).toEqual({
      delivery_state: 'settled',
      attempt_count: 3,
      last_error_code: null,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT latest_revision, delivered_revision, active_message_id
       FROM feishu_delivery_cards WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({
      latest_revision: 2,
      delivered_revision: 2,
      active_message_id: 'om_delivery_status_1',
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM feishu_delivery_card_deliveries',
    ).first()).toEqual({ count: 2 });
  });

  it('makes 20 operations refreshes one immutable repair and rejects stale or caller-controlled effects', async () => {
    const reconciler = new FeishuDeliveryCardReconciler(env.DB_CONTROL, {
      tenantKey: TENANT_KEY,
      chatId: CHAT_ID,
    }, { now: () => new Date(START) });
    const first = await reconciler.reconcileRun(RUN_ID);
    if (first === 'not_found') throw new Error('first presentation missing');
    const rejected: FeishuDeliveryCardEffects = {
      createCard: async () => ({
        disposition: 'rejected',
        errorCode: 'feishu_request_rejected',
      }),
      updateCard: async () => {
        throw new Error('update must not run');
      },
    };
    await expect(new FeishuDeliveryCardOutboxProcessor(
      env.DB_CONTROL,
      rejected,
      { now: () => new Date(START) },
    ).deliver(first.outboxId)).resolves.toBe('settled');
    const queryEndpoint = `https://delivery-loop.test/v1/runs/${RUN_ID}/feishu-card`;
    expect((await SELF.fetch(queryEndpoint)).status).toBe(401);
    const query = await SELF.fetch(queryEndpoint, {
      headers: { authorization: 'Bearer test-operations-token' },
    });
    expect(query.status).toBe(200);
    const queried = await query.json<{
      card: {
        latest: {
          presentationId: string;
          revision: number;
          digest: string;
          renderedDigest: string;
        };
        delivered: null;
      };
    }>();
    expect(queried.card.delivered).toBeNull();
    expect(queried.card.latest.renderedDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(queried)).not.toContain(TENANT_KEY);
    expect(JSON.stringify(queried)).not.toContain(CHAT_ID);
    const endpoint = `https://delivery-loop.test/v1/runs/${RUN_ID}/feishu-card/refresh`;
    const body = {
      expectedPresentationId: queried.card.latest.presentationId,
      expectedRevision: queried.card.latest.revision,
      expectedDigest: queried.card.latest.digest,
    };

    const unauthenticated = await SELF.fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(unauthenticated.status).toBe(401);
    const injected = await SELF.fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-operations-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...body,
        messageId: 'om_caller_controlled',
        card: { text: 'CANARY_CALLER_CARD' },
        destination: 'caller',
        reason: 'CANARY_CALLER_REASON',
      }),
    });
    expect(injected.status).toBe(400);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM feishu_delivery_card_refresh_requests',
    ).first()).toEqual({ count: 0 });

    const responses = await Promise.all(Array.from({ length: 20 }, async () => {
      return await SELF.fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-operations-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    }));
    expect(responses.every((response) => response.status === 202)).toBe(true);
    const projections = await Promise.all(responses.map(async (response) => await response.json<{
      requestId: string;
      presentationId: string;
      outboxId: string;
    }>()));
    expect(new Set(projections.map((projection) => projection.requestId))).toHaveLength(1);
    expect(new Set(projections.map((projection) => projection.presentationId))).toHaveLength(1);
    expect(new Set(projections.map((projection) => projection.outboxId))).toHaveLength(1);
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM feishu_delivery_card_refresh_requests',
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM feishu_delivery_card_presentations',
    ).first()).toEqual({ count: 2 });
    expect(await env.DB_CONTROL.prepare(
      "SELECT COUNT(*) AS count FROM outbox WHERE destination = 'feishu_cards'",
    ).first()).toEqual({ count: 2 });

    const repaired = projections[0]!;
    const success = new FakeFeishuEffects();
    await expect(new FeishuDeliveryCardOutboxProcessor(
      env.DB_CONTROL,
      success,
      { now: () => new Date('2026-07-26T05:01:00.000Z') },
    ).deliver(repaired.outboxId)).resolves.toBe('settled');
    expect(success.creates).toHaveLength(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT latest_revision, delivered_revision, active_message_id
       FROM feishu_delivery_cards WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({
      latest_revision: 2,
      delivered_revision: 2,
      active_message_id: 'om_delivery_status_1',
    });
    expect(await env.DB_CONTROL.prepare(
      'SELECT COUNT(*) AS count FROM feishu_delivery_card_deliveries',
    ).first()).toEqual({ count: 2 });
    const repairedQuery = await SELF.fetch(queryEndpoint, {
      headers: { authorization: 'Bearer test-operations-token' },
    });
    expect(await repairedQuery.json<{
      card: {
        latest: { presentationId: string; revision: number; outboxId: string };
        refresh: {
          requestId: string;
          expectedPresentationId: string;
          nextPresentationId: string;
          nextRevision: number;
          nextOutboxId: string;
          nextDeliveryState: string;
        } | null;
      };
    }>()).toMatchObject({
      card: {
        latest: { revision: 2, outboxId: repaired.outboxId },
        refresh: {
          requestId: repaired.requestId,
          nextPresentationId: repaired.presentationId,
          nextRevision: 2,
          nextOutboxId: repaired.outboxId,
          nextDeliveryState: 'settled',
        },
      },
    });

    await env.DB_CONTROL.prepare(
      `UPDATE runs SET version = 1, state = 'triaging', updated_at = ? WHERE run_id = ?`,
    ).bind('2026-07-26T05:02:00.000Z', RUN_ID).run();
    const superseded = await reconciler.reconcileRun(RUN_ID);
    if (superseded === 'not_found') throw new Error('superseded presentation missing');
    const supersededSnapshot = await env.DB_CONTROL.prepare(
      `SELECT presentation_id, revision, digest
       FROM feishu_delivery_card_presentations WHERE presentation_id = ?`,
    ).bind(superseded.presentationId).first<{
      presentation_id: string;
      revision: number;
      digest: string;
    }>();
    if (supersededSnapshot === null) throw new Error('superseded snapshot missing');
    await env.DB_CONTROL.prepare(
      `UPDATE runs SET version = 2, state = 'planning', updated_at = ? WHERE run_id = ?`,
    ).bind('2026-07-26T05:03:00.000Z', RUN_ID).run();
    await reconciler.reconcileRun(RUN_ID);
    const stale = await SELF.fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-operations-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        expectedPresentationId: supersededSnapshot.presentation_id,
        expectedRevision: supersededSnapshot.revision,
        expectedDigest: supersededSnapshot.digest,
      }),
    });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(await env.DB_CONTROL.prepare(
      'SELECT * FROM feishu_delivery_card_refresh_requests',
    ).all())).not.toContain('CANARY_CALLER');
  });

  it('lets cron finish a persisted refresh after the operations request is interrupted', async () => {
    const reconciler = new FeishuDeliveryCardReconciler(env.DB_CONTROL, {
      tenantKey: TENANT_KEY,
      chatId: CHAT_ID,
    }, { now: () => new Date(START) });
    const first = await reconciler.reconcileRun(RUN_ID);
    if (first === 'not_found') throw new Error('first presentation missing');
    const snapshot = await env.DB_CONTROL.prepare(
      `SELECT cards.card_id, presentations.presentation_id,
              presentations.revision, presentations.digest
       FROM feishu_delivery_cards AS cards
       JOIN feishu_delivery_card_presentations AS presentations
         ON presentations.presentation_id = cards.latest_presentation_id
       WHERE cards.run_id = ?`,
    ).bind(RUN_ID).first<{
      card_id: string;
      presentation_id: string;
      revision: number;
      digest: string;
    }>();
    if (snapshot === null) throw new Error('card snapshot missing');
    await env.DB_CONTROL.prepare(
      `INSERT INTO feishu_delivery_card_refresh_requests (
         refresh_request_id, card_id, run_id, expected_presentation_id,
         expected_revision, expected_digest, requested_by, requested_at
       ) VALUES ('feishu_card_refresh_interrupted', ?, ?, ?, ?, ?,
                 'service:operations', ?)`,
    ).bind(
      snapshot.card_id,
      RUN_ID,
      snapshot.presentation_id,
      snapshot.revision,
      snapshot.digest,
      START,
    ).run();

    const recovered = await reconciler.reconcileBatch(25);
    expect(recovered).toHaveLength(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT refresh_request_id FROM feishu_delivery_card_presentations
       WHERE presentation_id = ?`,
    ).bind(recovered[0]!.presentationId).first<string>('refresh_request_id')).toBe(
      'feishu_card_refresh_interrupted',
    );
    await expect(env.DB_CONTROL.prepare(
      `UPDATE feishu_delivery_card_refresh_requests SET requested_at = ?
       WHERE refresh_request_id = 'feishu_card_refresh_interrupted'`,
    ).bind('2026-07-26T05:10:00.000Z').run()).rejects.toThrow(
      'feishu_card_refresh_request_is_immutable',
    );
    expect(await env.DB_CONTROL.prepare(
      `SELECT latest_revision, delivered_revision
       FROM feishu_delivery_cards WHERE run_id = ?`,
    ).bind(RUN_ID).first()).toEqual({ latest_revision: 2, delivered_revision: 0 });
  });
});
