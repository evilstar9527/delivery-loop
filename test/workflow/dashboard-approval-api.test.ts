/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const OPERATIONS_TOKEN = 'test-operations-token';
const AUTH = { authorization: `Bearer ${OPERATIONS_TOKEN}` };
const BASE = 'https://control.test';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const BASE_SHA = 'b'.repeat(40);
const NOW = '2026-08-19T15:00:00.000Z';

// Seed a full task → run(awaiting_approval) → attempt → active plan chain with a
// repo_write plan-item effect, i.e. exactly the shape the pre-execution gate
// waits on. `allowWrite`/`state`/`effect` are knobs for the negative cases.
async function seedApprovable(
  suffix: string,
  opts: { state?: string; allowWrite?: 0 | 1; effect?: string } = {},
): Promise<{ runId: string; planId: string }> {
  const state = opts.state ?? 'awaiting_approval';
  const allowWrite = opts.allowWrite ?? 1;
  const effect = opts.effect ?? 'repo_write';
  const taskId = `task_dappr_${suffix}`;
  const runId = `run_dappr_${suffix}`;
  const attemptId = `attempt_dappr_${suffix}`;
  const planId = `plan_dappr_${suffix}`;
  await env.DB_CONTROL.prepare(
    `INSERT INTO tasks (
       task_id, source_system, tenant_key, source_task_key, task_revision,
       task_digest, payload_ref, actor_type, actor_id, target_repository,
       target_base_branch, target_environment, intent_kind, title, priority,
       acceptance_criteria_count, allow_repository_write, allow_test_deploy,
       allow_production_deploy, require_human_approval, created_at, updated_at
     ) VALUES (?, 'manual', 'board', ?, 'revision-1', ?, 'r2://tasks/board',
               'user', 'op', 'acme/api', 'main', 'none', 'requirement', ?, 'p1', 1, ?, 0, 0, 1, ?, ?)`,
  ).bind(taskId, taskId, DIGEST, `Approvable ${suffix}`, allowWrite, NOW, NOW).run();
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
     ) VALUES (?, ?, 1, 'revision-1', ?, ?, 'active', ?, 'obj', ?, ?)`,
  ).bind(planId, runId, BASE_SHA, DIGEST, attemptId, NOW, NOW).run();
  await env.DB_CONTROL.prepare(
    `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
     VALUES (?, 'item-1', 'change', 'change', 'obj', 1, 0)`,
  ).bind(planId).run();
  await env.DB_CONTROL.prepare(
    `INSERT INTO plan_item_effects (plan_id, item_id, effect) VALUES (?, 'item-1', ?)`,
  ).bind(planId, effect).run();
  return { runId, planId };
}

beforeEach(async () => {
  await env.DB_CONTROL.prepare(`DELETE FROM approvals WHERE run_id LIKE 'run_dappr_%'`).run();
  await env.DB_CONTROL.prepare(`DELETE FROM plan_item_effects WHERE plan_id LIKE 'plan_dappr_%'`).run();
  await env.DB_CONTROL.prepare(`DELETE FROM plan_items WHERE plan_id LIKE 'plan_dappr_%'`).run();
  await env.DB_CONTROL.prepare(`DELETE FROM execution_plans WHERE plan_id LIKE 'plan_dappr_%'`).run();
  await env.DB_CONTROL.prepare(`DELETE FROM attempts WHERE attempt_id LIKE 'attempt_dappr_%'`).run();
  await env.DB_CONTROL.prepare(`DELETE FROM runs WHERE run_id LIKE 'run_dappr_%'`).run();
  await env.DB_CONTROL.prepare(`DELETE FROM tasks WHERE task_id LIKE 'task_dappr_%'`).run();
});

describe('dashboard approval api', () => {
  it('requires the operations token', async () => {
    const res = await SELF.fetch(`${BASE}/v1/dashboard/runs/run_dappr_x/approve`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed run id', async () => {
    const res = await SELF.fetch(`${BASE}/v1/dashboard/runs/bad%20id/approve`, {
      method: 'POST', headers: AUTH,
    });
    expect(res.status).toBe(400);
  });

  it('records a repo_write approval that lets the reconciler advance the run', async () => {
    const { runId, planId } = await seedApprovable('ok');
    const res = await SELF.fetch(`${BASE}/v1/dashboard/runs/${runId}/approve`, {
      method: 'POST', headers: AUTH,
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { status: string; created: boolean };
    expect(body.status).toBe('approved');
    expect(body.created).toBe(true);

    // A well-formed, unexpired repo_write approve row now exists for the plan key.
    const approval = await env.DB_CONTROL.prepare(
      `SELECT effect, decision, actor_id FROM approvals WHERE run_id = ? AND plan_id = ?`,
    ).bind(runId, planId).first<{ effect: string; decision: string; actor_id: string }>();
    expect(approval).toMatchObject({ effect: 'repo_write', decision: 'approve' });

    // And it appears in the trusted gate view the reconciler consumes.
    const trusted = await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS n FROM trusted_effect_approvals
       WHERE run_id = ? AND effect = 'repo_write' AND decision = 'approve'`,
    ).bind(runId).first<{ n: number }>();
    expect(trusted?.n).toBe(1);
  });

  it('is idempotent across repeated clicks', async () => {
    const { runId } = await seedApprovable('idem');
    const first = await SELF.fetch(`${BASE}/v1/dashboard/runs/${runId}/approve`, { method: 'POST', headers: AUTH });
    expect(first.status).toBe(201);
    const second = await SELF.fetch(`${BASE}/v1/dashboard/runs/${runId}/approve`, { method: 'POST', headers: AUTH });
    expect(second.status).toBe(200);
    expect((await second.json() as { created: boolean }).created).toBe(false);
    const count = await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?`,
    ).bind(runId).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('refuses a run that is not awaiting approval', async () => {
    const { runId } = await seedApprovable('exec', { state: 'executing' });
    const res = await SELF.fetch(`${BASE}/v1/dashboard/runs/${runId}/approve`, { method: 'POST', headers: AUTH });
    expect(res.status).toBe(409);
    const count = await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?`,
    ).bind(runId).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('refuses when the plan has no repo_write effect', async () => {
    const { runId } = await seedApprovable('noeffect', { effect: 'repo_read' });
    const res = await SELF.fetch(`${BASE}/v1/dashboard/runs/${runId}/approve`, { method: 'POST', headers: AUTH });
    expect(res.status).toBe(409);
  });

  it('refuses when repository writes are not allowed', async () => {
    const { runId } = await seedApprovable('nowrite', { allowWrite: 0 });
    const res = await SELF.fetch(`${BASE}/v1/dashboard/runs/${runId}/approve`, { method: 'POST', headers: AUTH });
    expect(res.status).toBe(409);
  });
});
