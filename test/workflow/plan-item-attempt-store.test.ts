/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PlanItemAttemptError,
  PlanItemAttemptStore,
} from '../../src/storage/plan-item-attempt-store.js';
import { PlanItemEvidenceVerifier } from '../../src/storage/plan-item-evidence-verifier.js';

const NOW = new Date('2026-07-25T10:00:00.000Z');
const RUN_ID = 'run-plan-item-claim';
const PLAN_ID = 'plan-plan-item-claim';
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'd'.repeat(40);
const PLAN_DIGEST = `sha256:${'b'.repeat(64)}`;

async function reset(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM plan_item_done_when_evidence'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_verifications'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_revocations'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
    env.DB_CONTROL.prepare('DELETE FROM checkpoints'),
    env.DB_CONTROL.prepare('DELETE FROM workflow_signals'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_external_facts'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_evidence_kinds'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_command_refs'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_effects'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_dependencies'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_done_when'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_acceptance_criteria'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_progress'),
    env.DB_CONTROL.prepare('DELETE FROM plan_items'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plan_evidence_refs'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plan_assumptions'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plans'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM idempotency_keys'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
}

async function seedPlan(): Promise<void> {
  const now = NOW.toISOString();
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (
         'task-plan-item-claim', 'manual', 'plan-item-test', 'plan-item-test', 'rev-1', ?,
         'r2://tasks/plan-item-test', 'system', 'plan-item-test', 'example/repo',
         'main', 'test', 'bug', 'Plan item claim test', 'p1', 1, 1, 0, 0, 1, ?, ?
       )`,
    ).bind(`sha256:${'c'.repeat(64)}`, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, 'task-plan-item-claim', 'rev-1', ?, ?, ?, 'executing', 4,
                 ?, 1, ?, ?, ?)`,
    ).bind(RUN_ID, `sha256:${'c'.repeat(64)}`, BASE_SHA, RUN_ID, PLAN_ID, PLAN_DIGEST, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, lease_generation, version, created_at, updated_at
       ) VALUES ('attempt-analysis-plan-item', ?, 1, 'analysis', 'completed', ?,
                 'example/repo',
                 'example/repo/.github/workflows/delivery-agent.yml@refs/heads/main',
                 0, 1, ?, ?)`,
    ).bind(RUN_ID, BASE_SHA, now, now),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, 'rev-1', ?, ?, 'active', 'attempt-analysis-plan-item',
                 'Investigate, change, and verify in order.', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, now, now),
  ]);

  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES (?, 'investigate', 'investigation', 'Investigate', 'Find the cause.', 1, 0)`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES (?, 'change', 'change', 'Change', 'Implement the fix.', 1, 1)`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES (?, 'verify', 'verification', 'Verify', 'Run trusted verification.', 1, 2)`,
    ).bind(PLAN_ID),
    ...['investigate', 'change', 'verify'].map((itemId) =>
      env.DB_CONTROL.prepare(
        `INSERT INTO plan_item_progress (plan_id, item_id, status, version, updated_at)
         VALUES (?, ?, 'pending', 0, ?)`,
      ).bind(PLAN_ID, itemId, now),
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_dependencies (plan_id, item_id, depends_on_item_id)
       VALUES (?, 'change', 'investigate')`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_dependencies (plan_id, item_id, depends_on_item_id)
       VALUES (?, 'verify', 'change')`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_done_when (plan_id, item_id, position, condition)
       VALUES (?, 'investigate', 0, 'The root cause is supported by diagnostic evidence.')`,
    ).bind(PLAN_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_evidence_kinds (plan_id, item_id, evidence_kind)
       VALUES (?, 'investigate', 'diagnostic')`,
    ).bind(PLAN_ID),
  ]);
}

beforeEach(async () => {
  await reset();
  await seedPlan();
});

function claimInput(itemId = 'investigate', progressVersion = 1): Record<string, unknown> {
  return {
    runId: RUN_ID,
    expectedRunVersion: 4,
    planVersion: 1,
    planItemId: itemId,
    expectedProgressVersion: progressVersion,
  };
}

describe('Plan Item readiness and Attempt claims', () => {
  it('promotes only dependency-satisfied items and converges 20 claims to one Attempt', async () => {
    const store = new PlanItemAttemptStore(env.DB_CONTROL);
    const promotion = await store.promoteReadyItems(
      { runId: RUN_ID, expectedRunVersion: 4, planVersion: 1 },
      NOW,
    );
    expect(promotion).toEqual({ changed: 1, readyItemIds: ['investigate'] });

    const before = await env.DB_CONTROL.prepare(
      `SELECT item_id, status, version FROM plan_item_progress
       WHERE plan_id = ? ORDER BY item_id`,
    ).bind(PLAN_ID).all<{ item_id: string; status: string; version: number }>();
    expect(before.results).toEqual([
      { item_id: 'change', status: 'pending', version: 0 },
      { item_id: 'investigate', status: 'ready', version: 1 },
      { item_id: 'verify', status: 'pending', version: 0 },
    ]);

    const claims = await Promise.all(
      Array.from({ length: 20 }, () => store.claimReadyItem(claimInput(), NOW)),
    );
    expect(new Set(claims.map((claim) => claim.attemptId)).size).toBe(1);
    expect(claims.filter((claim) => claim.created)).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      runId: RUN_ID,
      planId: PLAN_ID,
      planVersion: 1,
      planItemId: 'investigate',
      ordinal: 2,
      mode: 'implement',
    });
    expect(claims[0]?.outboxId).toBe(`outbox_execution_${claims[0]?.attemptId}`);

    const progress = await env.DB_CONTROL.prepare(
      `SELECT status, version, active_attempt_id FROM plan_item_progress
       WHERE plan_id = ? AND item_id = 'investigate'`,
    ).bind(PLAN_ID).first<{
      status: string;
      version: number;
      active_attempt_id: string | null;
    }>();
    expect(progress).toEqual({
      status: 'in_progress',
      version: 2,
      active_attempt_id: claims[0]?.attemptId,
    });
    const attempts = await env.DB_CONTROL.prepare(
      `SELECT attempt_id, ordinal, mode, status, plan_id, plan_version, plan_item_id,
              claimed_progress_version
       FROM attempts WHERE run_id = ? ORDER BY ordinal`,
    ).bind(RUN_ID).all();
    expect(attempts.results).toHaveLength(2);
    expect(attempts.results[1]).toMatchObject({
      attempt_id: claims[0]?.attemptId,
      ordinal: 2,
      mode: 'implement',
      status: 'pending',
      plan_id: PLAN_ID,
      plan_version: 1,
      plan_item_id: 'investigate',
      claimed_progress_version: 1,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT outbox_id, kind, destination, payload_ref, dedupe_key, delivery_state
       FROM outbox WHERE run_id = ? AND kind = 'execution_dispatch'`,
    ).bind(RUN_ID).first()).toEqual({
      outbox_id: `outbox_execution_${claims[0]?.attemptId}`,
      kind: 'execution_dispatch',
      destination: 'github_actions',
      payload_ref: `d1://attempts/${claims[0]?.attemptId}`,
      dedupe_key: `execution-dispatch:${claims[0]?.attemptId}`,
      delivery_state: 'pending',
    });
  });

  it('rejects a forged ready state while any dependency is not passed', async () => {
    await env.DB_CONTROL.prepare(
      `UPDATE plan_item_progress SET status = 'ready', version = 1
       WHERE plan_id = ? AND item_id = 'change'`,
    ).bind(PLAN_ID).run();
    const store = new PlanItemAttemptStore(env.DB_CONTROL);
    await expect(store.claimReadyItem(claimInput('change'), NOW)).rejects.toMatchObject({
      name: PlanItemAttemptError.name,
      code: 'dependency_incomplete',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts WHERE run_id = ? AND plan_item_id = 'change'`,
    ).bind(RUN_ID).first<{ count: number }>()).toEqual({ count: 0 });
  });

  it('requires ready/current active context and rejects caller-supplied state mutations', async () => {
    const store = new PlanItemAttemptStore(env.DB_CONTROL);
    await expect(store.claimReadyItem(claimInput(), NOW)).rejects.toMatchObject({
      code: 'item_not_ready',
    });

    await store.promoteReadyItems(
      { runId: RUN_ID, expectedRunVersion: 4, planVersion: 1 },
      NOW,
    );
    await expect(store.claimReadyItem({
      ...claimInput(),
      status: 'passed',
      skip: true,
    }, NOW)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(store.claimReadyItem({
      ...claimInput(),
      expectedRunVersion: 3,
    }, NOW)).rejects.toMatchObject({ code: 'state_conflict' });

    const progress = await env.DB_CONTROL.prepare(
      `SELECT status, version, active_attempt_id FROM plan_item_progress
       WHERE plan_id = ? AND item_id = 'investigate'`,
    ).bind(PLAN_ID).first();
    expect(progress).toEqual({ status: 'ready', version: 1, active_attempt_id: null });
  });

  it('does not promote downstream investigation or verification until every dependency passed', async () => {
    const store = new PlanItemAttemptStore(env.DB_CONTROL);
    await store.promoteReadyItems(
      { runId: RUN_ID, expectedRunVersion: 4, planVersion: 1 },
      NOW,
    );
    const claim = await store.claimReadyItem(claimInput(), NOW);
    const leaseExpiresAt = new Date(NOW.getTime() + 60_000).toISOString();
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE attempts
         SET status = 'running', head_branch = 'agent/test/investigate', head_sha = ?,
             version = 1, lease_generation = 1, lease_token_digest = ?,
             lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
         WHERE attempt_id = ? AND status = 'pending' AND version = 0`,
      ).bind(
        HEAD_SHA,
        `sha256:${'e'.repeat(64)}`,
        leaseExpiresAt,
        NOW.toISOString(),
        NOW.toISOString(),
        claim.attemptId,
      ),
      env.DB_CONTROL.prepare(
        `INSERT INTO evidence (
           evidence_id, run_id, attempt_id, plan_id, plan_version, plan_item_id,
           kind, status, sha, summary, verification_status, observed_at, created_at
         ) VALUES (
           'evidence-investigation-root-cause', ?, ?, ?, 1, 'investigate',
           'diagnostic', 'passed', ?, 'Root cause reproduced and isolated.',
           'unverified', ?, ?
         )`,
      ).bind(
        RUN_ID,
        claim.attemptId,
        PLAN_ID,
        HEAD_SHA,
        NOW.toISOString(),
        NOW.toISOString(),
      ),
    ]);
    await new PlanItemEvidenceVerifier(env.DB_CONTROL).verify({
      runId: RUN_ID,
      expectedRunVersion: 4,
      planVersion: 1,
      planItemId: 'investigate',
      expectedProgressVersion: 2,
      attemptId: claim.attemptId,
      expectedAttemptVersion: 1,
      leaseGeneration: 1,
      headSha: HEAD_SHA,
      doneWhenEvidence: [{
        position: 0,
        evidenceIds: ['evidence-investigation-root-cause'],
      }],
    }, NOW);
    expect(await store.promoteReadyItems(
      { runId: RUN_ID, expectedRunVersion: 4, planVersion: 1 },
      NOW,
    )).toEqual({ changed: 1, readyItemIds: ['change'] });

    const verify = await env.DB_CONTROL.prepare(
      `SELECT status, version FROM plan_item_progress
       WHERE plan_id = ? AND item_id = 'verify'`,
    ).bind(PLAN_ID).first();
    expect(verify).toEqual({ status: 'pending', version: 0 });
  });

  it('rejects skipping required, investigation, or verification Items at the D1 boundary', async () => {
    for (const itemId of ['investigate', 'change', 'verify']) {
      await expect(env.DB_CONTROL.prepare(
        `UPDATE plan_item_progress SET status = 'skipped'
         WHERE plan_id = ? AND item_id = ?`,
      ).bind(PLAN_ID, itemId).run()).rejects.toThrow('protected_plan_item_cannot_be_skipped');
    }
    const rows = await env.DB_CONTROL.prepare(
      `SELECT item_id, status FROM plan_item_progress
       WHERE plan_id = ? ORDER BY item_id`,
    ).bind(PLAN_ID).all();
    expect(rows.results).toEqual([
      { item_id: 'change', status: 'pending' },
      { item_id: 'investigate', status: 'pending' },
      { item_id: 'verify', status: 'pending' },
    ]);
  });

  it('rejects an Agent completion request that tries to self-report Item passed', async () => {
    const store = new PlanItemAttemptStore(env.DB_CONTROL);
    await store.promoteReadyItems(
      { runId: RUN_ID, expectedRunVersion: 4, planVersion: 1 },
      NOW,
    );
    const claim = await store.claimReadyItem(claimInput(), NOW);
    const response = await SELF.fetch(
      `https://delivery-loop.test/v1/attempts/${claim.attemptId}/complete`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer untrusted-agent-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          schemaVersion: '1',
          eventId: 'agent-self-pass',
          sequence: 1,
          payloadRef: `d1://execution-plans/${PLAN_ID}`,
          digest: PLAN_DIGEST,
          occurredAt: NOW.toISOString(),
          expectedVersion: 0,
          leaseGeneration: 1,
          planItemStatus: 'passed',
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_argument' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, active_attempt_id FROM plan_item_progress
       WHERE plan_id = ? AND item_id = 'investigate'`,
    ).bind(PLAN_ID).first()).toEqual({
      status: 'in_progress',
      active_attempt_id: claim.attemptId,
    });
  });
});
