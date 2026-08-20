/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const OPERATIONS_TOKEN = 'test-operations-token';
const AUTH = { authorization: `Bearer ${OPERATIONS_TOKEN}` };
const BASE = 'https://control.test';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = '2026-08-19T15:00:00.000Z';

async function seedTaskRun(
  suffix: string,
  state: string,
  repository: string,
  title: string,
): Promise<{ runId: string; taskId: string }> {
  const taskId = `task_dashbd_${suffix}`;
  const runId = `run_dashbd_${suffix}`;
  await env.DB_CONTROL.prepare(
    `INSERT INTO tasks (
       task_id, source_system, tenant_key, source_task_key, task_revision,
       task_digest, payload_ref, actor_type, actor_id, target_repository,
       target_base_branch, target_environment, intent_kind, title, priority,
       acceptance_criteria_count, allow_repository_write, allow_test_deploy,
       allow_production_deploy, require_human_approval, created_at, updated_at
     ) VALUES (?, 'manual', 'board', ?, 'revision-1', ?, 'r2://tasks/board',
               'user', 'op', ?, 'main', 'none', 'requirement', ?, 'p1', 1, 1, 0, 0, 1, ?, ?)`,
  ).bind(taskId, taskId, DIGEST, repository, title, NOW, NOW).run();
  await env.DB_CONTROL.prepare(
    `INSERT INTO runs (
       run_id, task_id, task_revision, task_digest, base_sha,
       workflow_instance_id, state, version, created_at, updated_at
     ) VALUES (?, ?, 'revision-1', ?, ?, ?, ?, 1, ?, ?)`,
  ).bind(runId, taskId, DIGEST, 'b'.repeat(40), runId, state, NOW, NOW).run();
  return { runId, taskId };
}

// The workflow pool shares one local D1 across all test files (serialized,
// no isolated storage), so scope every reset to this file's own fixtures by id
// prefix rather than truncating shared tables — a global DELETE FROM runs would
// abort on another file's child rows and leave this file's cleanup half-done.
beforeEach(async () => {
  // FK-safe order: execution instances (ref attempts, profiles, outbox) →
  // attempts (ref profiles, runs) → routes/profiles → outbox → runs → tasks.
  await env.DB_CONTROL.prepare(
    `DELETE FROM attempt_execution_instances WHERE execution_id LIKE 'exec_dashbd_%'`,
  ).run();
  await env.DB_CONTROL.prepare(`DELETE FROM attempts WHERE attempt_id LIKE 'attempt_dashbd_%'`).run();
  await env.DB_CONTROL.prepare(`DELETE FROM executor_routes WHERE route_id LIKE 'board-%'`).run();
  await env.DB_CONTROL.prepare(`DELETE FROM executor_profiles WHERE profile_id = 'board-profile'`).run();
  await env.DB_CONTROL.prepare(`DELETE FROM outbox WHERE outbox_id LIKE 'ob_dashbd_%'`).run();
  await env.DB_CONTROL.prepare(`DELETE FROM runs WHERE run_id LIKE 'run_dashbd_%'`).run();
  await env.DB_CONTROL.prepare(`DELETE FROM tasks WHERE task_id LIKE 'task_dashbd_%'`).run();
});

describe('dashboard overview api', () => {
  it('requires the operations token for the JSON projection', async () => {
    const res = await SELF.fetch(`${BASE}/v1/dashboard/overview`);
    expect(res.status).toBe(401);
  });

  it('serves the board shell without a token', async () => {
    const res = await SELF.fetch(`${BASE}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Delivery Loop Board');
    expect(html).toContain('/v1/dashboard/overview');
  });

  it('classifies runs into in-progress, unfinished, and completed lanes', async () => {
    await seedTaskRun('inprog', 'executing', 'acme/api', 'Add pagination');
    await seedTaskRun('blocked', 'blocked', 'acme/web', 'Fix login');
    await seedTaskRun('done', 'succeeded', 'acme/api', 'Ship docs');

    const res = await SELF.fetch(`${BASE}/v1/dashboard/overview`, { headers: AUTH });
    expect(res.status).toBe(200);
    const data = await res.json() as {
      laneCounts: Record<string, number>;
      tasks: Array<{ runId: string; lane: string; state: string; repository: string }>;
    };
    // laneCounts always equals the sum across the three lanes for whatever runs
    // exist; assert it stays internally consistent with the returned tasks
    // rather than an absolute total (the shared pool DB may hold other rows).
    const tallied = { in_progress: 0, unfinished: 0, completed: 0 };
    for (const t of data.tasks) tallied[t.lane as keyof typeof tallied] += 1;
    expect(data.laneCounts).toEqual(tallied);
    const lane = (id: string) => data.tasks.find((t) => t.runId === id)?.lane;
    expect(lane('run_dashbd_inprog')).toBe('in_progress');
    expect(lane('run_dashbd_blocked')).toBe('unfinished');
    expect(lane('run_dashbd_done')).toBe('completed');
  });

  it('reports which sandbox is modifying which repository for running executions only', async () => {
    const { runId, taskId } = await seedTaskRun('sbx', 'executing', 'acme/api', 'Live change');
    const attemptId = `attempt_dashbd_${runId}`;
    await env.DB_CONTROL.prepare(
      `INSERT INTO executor_profiles (
         profile_id, schema_version, provider_kind, plugin_schema_version,
         release_digest, configuration_json, capabilities_json, status,
         created_at, activated_at
       ) VALUES ('board-profile', '1', 'cloudflare_sandbox', '1', ?, '{}', '{}',
                 'active', ?, ?)`,
    ).bind(DIGEST, NOW, NOW).run();
    await env.DB_CONTROL.prepare(
      `INSERT INTO executor_routes (
         route_id, repository, attempt_mode, execution_role, profile_id,
         route_version, status, created_at, updated_at
       ) VALUES ('board-route', 'acme/api', 'implement', 'work', 'board-profile', 5,
                 'active', ?, ?)`,
    ).bind(NOW, NOW).run();
    await env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, executor_profile_id,
         executor_route_version, created_at, updated_at
       ) VALUES (?, ?, 1, 'implement', 'running', ?, 'acme/api',
                 'acme/api/.github/workflows/x.yml@refs/heads/main', 1, 1,
                 'board-profile', 5, ?, ?)`,
    ).bind(attemptId, runId, 'b'.repeat(40), NOW, NOW).run();
    await env.DB_CONTROL.prepare(
      `INSERT INTO outbox (
         outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
         delivery_state, created_at, updated_at
       ) VALUES (?, ?, 'agent_execution_start', 'agent_executor', ?, ?, 'settled', ?, ?)`,
    ).bind(`ob_dashbd_${runId}`, runId, `d1://x/${runId}`, `dk:${runId}`, NOW, NOW).run();
    await env.DB_CONTROL.prepare(
      `INSERT INTO attempt_execution_instances (
         execution_id, attempt_id, attempt_version, lease_generation,
         execution_role, executor_profile_id, executor_route_version,
         spec_digest, spec_json, release_digest, provider_kind,
         plugin_schema_version, status, provider_external_id, validated_handle_json,
         outbox_id, created_at, started_at, updated_at
       ) VALUES (?, ?, 1, 1, 'work', 'board-profile', 5, ?, '{}', ?,
                 'cloudflare_sandbox', '1', 'running', 'executor-live-01', '{}', ?, ?, ?, ?)`,
    ).bind(`exec_dashbd_${runId}`, attemptId, DIGEST, DIGEST, `ob_dashbd_${runId}`, NOW, NOW, NOW).run();
    // A terminal execution must NOT appear as an active sandbox: flip the live
    // one to succeeded in a second run and confirm it drops out below.
    void taskId;

    const res = await SELF.fetch(`${BASE}/v1/dashboard/overview`, { headers: AUTH });
    expect(res.status).toBe(200);
    const data = await res.json() as {
      activeSandboxes: Array<{ sandboxId: string; repository: string; role: string; runId: string }>;
    };
    const mine = data.activeSandboxes.filter((s) => s.sandboxId === 'executor-live-01');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      sandboxId: 'executor-live-01',
      repository: 'acme/api',
      role: 'work',
      runId,
    });

    // Once the execution reaches a terminal state it is no longer "modifying"
    // the repository and must drop out of the active list.
    await env.DB_CONTROL.prepare(
      `UPDATE attempt_execution_instances
       SET status = 'succeeded', terminal_at = ?, updated_at = ?
       WHERE execution_id = ?`,
    ).bind(NOW, NOW, `exec_dashbd_${runId}`).run();
    const after = await SELF.fetch(`${BASE}/v1/dashboard/overview`, { headers: AUTH });
    const afterData = await after.json() as { activeSandboxes: Array<{ sandboxId: string }> };
    const stillMine = (afterData.activeSandboxes as Array<{ sandboxId: string }>)
      .filter((s) => s.sandboxId === 'executor-live-01');
    expect(stillMine).toHaveLength(0);
  });

  it('rejects an invalid limit', async () => {
    const res = await SELF.fetch(`${BASE}/v1/dashboard/overview?limit=0`, { headers: AUTH });
    expect(res.status).toBe(400);
  });
});
