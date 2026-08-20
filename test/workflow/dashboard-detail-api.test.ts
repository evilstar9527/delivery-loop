/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const OPERATIONS_TOKEN = 'test-operations-token';
const AUTH = { authorization: `Bearer ${OPERATIONS_TOKEN}` };
const BASE = 'https://control.test';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const BASE_SHA = 'b'.repeat(40);

/**
 * The detail projection is asserted field-by-field below, so these tests index
 * freely into the decoded body rather than restating the whole schema.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type DetailBody = Record<string, any>;
const NOW = '2026-08-19T15:00:00.000Z';

// Seed task+run+plan+items+progress and the R2 task envelope, then read detail.
async function seedDetail(suffix: string, state = 'awaiting_approval'): Promise<string> {
  const taskId = `task_ddet_${suffix}`;
  const runId = `run_ddet_${suffix}`;
  const attemptId = `attempt_ddet_${suffix}`;
  const planId = `plan_ddet_${suffix}`;
  const payloadRef = `r2://tasks/${taskId}/${'a'.repeat(64)}.json`;
  await env.TASK_OBJECTS.put(payloadRef.slice('r2://'.length), JSON.stringify({
    intent: {
      title: `Original ${suffix}`,
      description: 'Add an e2e validation marker to the README.',
      acceptanceCriteria: ['README contains the marker', 'CI is green'],
    },
  }));
  await env.DB_CONTROL.prepare(
    `INSERT INTO tasks (
       task_id, source_system, tenant_key, source_task_key, task_revision,
       source_url, task_digest, payload_ref, actor_type, actor_id, target_repository,
       target_base_branch, target_environment, intent_kind, title, priority,
       acceptance_criteria_count, allow_repository_write, allow_test_deploy,
       allow_production_deploy, require_human_approval, created_at, updated_at
     ) VALUES (?, 'feishu', 'board', ?, 'revision-1', 'https://prd.example/x', ?, ?,
               'user', 'op', 'acme/api', 'main', 'none', 'requirement', ?, 'p1', 2, 1, 0, 0, 1, ?, ?)`,
  ).bind(taskId, taskId, DIGEST, payloadRef, `Original ${suffix}`, NOW, NOW).run();
  await env.DB_CONTROL.prepare(
    `INSERT INTO runs (
       run_id, task_id, task_revision, task_digest, base_sha,
       workflow_instance_id, state, version, active_plan_id,
       active_plan_version, active_plan_digest, created_at, updated_at
     ) VALUES (?, ?, 'revision-1', ?, ?, ?, ?, 1, ?, 1, ?, ?, ?)`,
  ).bind(runId, taskId, DIGEST, BASE_SHA, runId, state, planId, DIGEST, NOW, NOW).run();
  await env.DB_CONTROL.prepare(
    `INSERT INTO attempts (
       attempt_id, run_id, ordinal, mode, status, base_sha, repository,
       workflow_ref, version, lease_generation, created_at, updated_at
     ) VALUES (?, ?, 1, 'analysis', 'completed', ?, 'acme/api',
               'acme/api/.github/workflows/x.yml@refs/heads/main', 1, 1, ?, ?)`,
  ).bind(attemptId, runId, BASE_SHA, NOW, NOW).run();
  await env.DB_CONTROL.prepare(
    `INSERT INTO execution_plans (
       plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
       created_by_attempt_id, objective, created_at, updated_at
     ) VALUES (?, ?, 1, 'revision-1', ?, ?, 'active', ?, 'Deliver the marker', ?, ?)`,
  ).bind(planId, runId, BASE_SHA, DIGEST, attemptId, NOW, NOW).run();
  // two items: one passed, one pending
  for (const [id, pos, kind, title] of [
    ['item-1', 0, 'change', 'Edit README'],
    ['item-2', 1, 'verification', 'Run CI'],
  ] as const) {
    await env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES (?, ?, ?, ?, 'obj', 1, ?)`,
    ).bind(planId, id, kind, title, pos).run();
  }
  await env.DB_CONTROL.prepare(
    `INSERT INTO plan_item_effects (plan_id, item_id, effect) VALUES (?, 'item-1', 'repo_write')`,
  ).bind(planId).run();
  await env.DB_CONTROL.prepare(
    `INSERT INTO plan_item_done_when (plan_id, item_id, position, condition)
     VALUES (?, 'item-1', 0, 'README updated')`,
  ).bind(planId).run();
  await env.DB_CONTROL.prepare(
    `INSERT INTO plan_item_progress (plan_id, item_id, status, version, updated_at)
     VALUES (?, 'item-1', 'passed', 1, ?)`,
  ).bind(planId, NOW).run();
  return runId;
}

beforeEach(async () => {
  await env.DB_CONTROL.prepare(`DELETE FROM plan_item_progress WHERE plan_id LIKE 'plan_ddet_%'`).run();
  await env.DB_CONTROL.prepare(`DELETE FROM plan_item_done_when WHERE plan_id LIKE 'plan_ddet_%'`).run();
  await env.DB_CONTROL.prepare(`DELETE FROM plan_item_effects WHERE plan_id LIKE 'plan_ddet_%'`).run();
  await env.DB_CONTROL.prepare(`DELETE FROM plan_items WHERE plan_id LIKE 'plan_ddet_%'`).run();
  await env.DB_CONTROL.prepare(`DELETE FROM execution_plans WHERE plan_id LIKE 'plan_ddet_%'`).run();
  await env.DB_CONTROL.prepare(`DELETE FROM attempts WHERE attempt_id LIKE 'attempt_ddet_%'`).run();
  await env.DB_CONTROL.prepare(`DELETE FROM runs WHERE run_id LIKE 'run_ddet_%'`).run();
  await env.DB_CONTROL.prepare(`DELETE FROM tasks WHERE task_id LIKE 'task_ddet_%'`).run();
});

describe('dashboard task detail api', () => {
  it('requires the operations token', async () => {
    const res = await SELF.fetch(`${BASE}/v1/dashboard/runs/run_ddet_x`);
    expect(res.status).toBe(401);
  });

  it('404s an unknown run', async () => {
    const res = await SELF.fetch(`${BASE}/v1/dashboard/runs/run_ddet_missing`, { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('returns original request, DOD plan with progress, and approvable flag', async () => {
    const runId = await seedDetail('ok');
    const res = await SELF.fetch(`${BASE}/v1/dashboard/runs/${runId}`, { headers: AUTH });
    expect(res.status).toBe(200);
    const d = await res.json() as DetailBody;
    expect(d.lane).toBe('pending');
    expect(d.approvable).toBe(true);
    // original request from R2
    expect(d.origin.description).toContain('e2e validation marker');
    expect(d.origin.acceptanceCriteria).toHaveLength(2);
    expect(d.origin.sourceSystem).toBe('feishu');
    expect(d.origin.sourceUrl).toBe('https://prd.example/x');
    // DOD plan + progress
    expect(d.plan.totalCount).toBe(2);
    expect(d.plan.doneCount).toBe(1);
    expect(d.plan.items[0].progress).toBe('passed');
    expect(d.plan.items[0].effects).toContain('repo_write');
    expect(d.plan.items[0].doneWhen).toContain('README updated');
    expect(d.plan.items[1].progress).toBe('pending');
  });

  it('still renders when the R2 payload is missing (origin null)', async () => {
    const runId = await seedDetail('nopayload');
    await env.TASK_OBJECTS.delete(`tasks/task_ddet_nopayload/${'a'.repeat(64)}.json`);
    const res = await SELF.fetch(`${BASE}/v1/dashboard/runs/${runId}`, { headers: AUTH });
    expect(res.status).toBe(200);
    const d = await res.json() as DetailBody;
    expect(d.origin).toBeNull();
    expect(d.plan.totalCount).toBe(2);
  });
});
