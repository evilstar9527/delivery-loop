/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const OPERATIONS_TOKEN = 'test-operations-token';
const AUTH = { authorization: `Bearer ${OPERATIONS_TOKEN}` };
const JSON_AUTH = { ...AUTH, 'content-type': 'application/json' };
const BASE = 'https://control.test';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = '2026-08-20T09:00:00.000Z';

/**
 * Seeds a run, optionally with a live execution instance. `runState` decides
 * whether removal has to cancel the run first or merely hide it.
 */
async function seedRun(
  suffix: string,
  options: {
    runState?: string;
    executionStatus?: 'running' | 'succeeded';
    sandboxId?: string;
  } = {},
): Promise<string> {
  const runState = options.runState ?? 'executing';
  const taskId = `task_del_${suffix}`;
  const runId = `run_del_${suffix}`;
  const attemptId = `attempt_del_${suffix}`;
  await env.DB_CONTROL.prepare(
    `INSERT INTO tasks (
       task_id, source_system, tenant_key, source_task_key, task_revision,
       task_digest, payload_ref, actor_type, actor_id, target_repository,
       target_base_branch, target_environment, intent_kind, title, priority,
       acceptance_criteria_count, allow_repository_write, allow_test_deploy,
       allow_production_deploy, require_human_approval, created_at, updated_at
     ) VALUES (?, 'manual', 'board', ?, 'revision-1', ?, 'r2://tasks/board',
               'user', 'op', 'acme/api', 'main', 'none', 'requirement', ?, 'p1', 1, 1, 0, 0, 1, ?, ?)`,
  ).bind(taskId, taskId, DIGEST, `Delete ${suffix}`, NOW, NOW).run();
  await env.DB_CONTROL.prepare(
    `INSERT INTO runs (
       run_id, task_id, task_revision, task_digest, base_sha,
       workflow_instance_id, state, version, created_at, updated_at
     ) VALUES (?, ?, 'revision-1', ?, ?, ?, ?, 1, ?, ?)`,
  ).bind(runId, taskId, DIGEST, 'b'.repeat(40), runId, runState, NOW, NOW).run();
  if (options.executionStatus === undefined) return runId;

  await env.DB_CONTROL.prepare(
    `INSERT OR IGNORE INTO executor_profiles (
       profile_id, schema_version, provider_kind, plugin_schema_version,
       release_digest, configuration_json, capabilities_json, status,
       created_at, activated_at
     ) VALUES ('del-profile', '1', 'cloudflare_sandbox', '1', ?, '{}', '{}',
               'active', ?, ?)`,
  ).bind(DIGEST, NOW, NOW).run();
  await env.DB_CONTROL.prepare(
    `INSERT OR IGNORE INTO executor_routes (
       route_id, repository, attempt_mode, execution_role, profile_id,
       route_version, status, created_at, updated_at
     ) VALUES ('del-route', 'acme/api', 'implement', 'work', 'del-profile', 5,
               'active', ?, ?)`,
  ).bind(NOW, NOW).run();
  await env.DB_CONTROL.prepare(
    `INSERT INTO attempts (
       attempt_id, run_id, ordinal, mode, status, base_sha, repository,
       workflow_ref, version, lease_generation, executor_profile_id,
       executor_route_version, created_at, updated_at
     ) VALUES (?, ?, 1, 'implement', 'running', ?, 'acme/api',
               'acme/api/.github/workflows/x.yml@refs/heads/main', 1, 1,
               'del-profile', 5, ?, ?)`,
  ).bind(attemptId, runId, 'b'.repeat(40), NOW, NOW).run();
  await env.DB_CONTROL.prepare(
    `INSERT INTO outbox (
       outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
       delivery_state, created_at, updated_at
     ) VALUES (?, ?, 'agent_execution_start', 'agent_executor', ?, ?, 'settled', ?, ?)`,
  ).bind(`ob_del_${suffix}`, runId, `d1://x/${runId}`, `dk:${runId}`, NOW, NOW).run();
  await env.DB_CONTROL.prepare(
    `INSERT INTO attempt_execution_instances (
       execution_id, attempt_id, attempt_version, lease_generation,
       execution_role, executor_profile_id, executor_route_version,
       spec_digest, spec_json, release_digest, provider_kind,
       plugin_schema_version, status, provider_external_id, validated_handle_json,
       outbox_id, created_at, started_at, updated_at, terminal_at
     ) VALUES (?, ?, 1, 1, 'work', 'del-profile', 5, ?, '{}', ?,
               'cloudflare_sandbox', '1', ?, ?, '{}', ?, ?, ?, ?, ?)`,
  ).bind(
    `exec_del_${suffix}`, attemptId, DIGEST, DIGEST, options.executionStatus,
    options.sandboxId ?? `executor-del-${suffix}`,
    `ob_del_${suffix}`, NOW, NOW, NOW,
    options.executionStatus === 'running' ? null : NOW,
  ).run();
  return runId;
}

async function runRow(runId: string): Promise<{ state: string; version: number } | null> {
  return await env.DB_CONTROL
    .prepare('SELECT state, version FROM runs WHERE run_id = ?')
    .bind(runId)
    .first<{ state: string; version: number }>();
}

async function dismissed(runId: string): Promise<boolean> {
  const row = await env.DB_CONTROL
    .prepare('SELECT run_id FROM dashboard_dismissals WHERE run_id = ?')
    .bind(runId)
    .first<{ run_id: string }>();
  return row !== null;
}

// The workflow pool shares one local D1 across files, so scope cleanup to this
// file's own fixture ids.
beforeEach(async () => {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(`DELETE FROM dashboard_dismissals WHERE run_id LIKE 'run_del_%'`),
    env.DB_CONTROL.prepare(
      `DELETE FROM attempt_execution_instances WHERE execution_id LIKE 'exec_del_%'`,
    ),
    env.DB_CONTROL.prepare(`DELETE FROM attempt_revocations WHERE run_id LIKE 'run_del_%'`),
    env.DB_CONTROL.prepare(`DELETE FROM attempt_tokens WHERE attempt_id LIKE 'attempt_del_%'`),
    env.DB_CONTROL.prepare(`DELETE FROM outbox WHERE run_id LIKE 'run_del_%'`),
    env.DB_CONTROL.prepare(`DELETE FROM attempts WHERE attempt_id LIKE 'attempt_del_%'`),
    env.DB_CONTROL.prepare(`DELETE FROM runs WHERE run_id LIKE 'run_del_%'`),
    env.DB_CONTROL.prepare(`DELETE FROM tasks WHERE task_id LIKE 'task_del_%'`),
  ]);
});

describe('dashboard task delete API', () => {
  it('requires the operations token', async () => {
    const runId = await seedRun('auth', { runState: 'succeeded' });
    const single = await SELF.fetch(`${BASE}/v1/dashboard/runs/${runId}/delete`, {
      method: 'POST',
    });
    expect(single.status).toBe(401);
    const batch = await SELF.fetch(`${BASE}/v1/dashboard/runs/delete`, {
      method: 'POST',
      body: JSON.stringify({ runIds: [runId] }),
    });
    expect(batch.status).toBe(401);
    expect(await dismissed(runId)).toBe(false);
  });

  it('rejects malformed identifiers and oversized batches', async () => {
    const bad = await SELF.fetch(`${BASE}/v1/dashboard/runs/bad%20id/delete`, {
      method: 'POST',
      headers: JSON_AUTH,
    });
    expect(bad.status).toBe(400);

    const tooMany = await SELF.fetch(`${BASE}/v1/dashboard/runs/delete`, {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({
        runIds: Array.from({ length: 51 }, (_, i) => `run_del_bulk_${i}`),
      }),
    });
    expect(tooMany.status).toBe(400);

    const empty = await SELF.fetch(`${BASE}/v1/dashboard/runs/delete`, {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({ runIds: [] }),
    });
    expect(empty.status).toBe(400);

    const unknownField = await SELF.fetch(`${BASE}/v1/dashboard/runs/delete`, {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({ runIds: ['run_del_x'], surprise: true }),
    });
    expect(unknownField.status).toBe(400);
  });

  it('reports 404 for an unknown run', async () => {
    const res = await SELF.fetch(`${BASE}/v1/dashboard/runs/run_del_missing/delete`, {
      method: 'POST',
      headers: JSON_AUTH,
    });
    expect(res.status).toBe(404);
  });

  it('hides a finished run without touching its state or its rows', async () => {
    const runId = await seedRun('done', { runState: 'succeeded' });
    const res = await SELF.fetch(`${BASE}/v1/dashboard/runs/${runId}/delete`, {
      method: 'POST',
      headers: JSON_AUTH,
    });
    expect(res.status).toBe(200);
    expect((await res.json() as Record<string, unknown>).status).toBe('deleted');
    // The lineage must survive: the run row stays, at its original state.
    const row = await runRow(runId);
    expect(row?.state).toBe('succeeded');
    expect(row?.version).toBe(1);
    expect(await dismissed(runId)).toBe(true);
  });

  it('cancels a live run when removing it', async () => {
    const runId = await seedRun('live', { runState: 'executing' });
    const res = await SELF.fetch(`${BASE}/v1/dashboard/runs/${runId}/delete`, {
      method: 'POST',
      headers: JSON_AUTH,
    });
    expect(res.status).toBe(200);
    const row = await runRow(runId);
    expect(row?.state).toBe('cancelled');
    expect(row?.version).toBe(2);
    expect(await dismissed(runId)).toBe(true);
  });

  it('refuses a run with a live sandbox until cascade is authorised', async () => {
    const runId = await seedRun('sbx', {
      runState: 'executing',
      executionStatus: 'running',
      sandboxId: 'executor-del-sbx',
    });
    const blocked = await SELF.fetch(`${BASE}/v1/dashboard/runs/${runId}/delete`, {
      method: 'POST',
      headers: JSON_AUTH,
    });
    expect(blocked.status).toBe(409);
    const body = await blocked.json() as {
      status: string;
      blocked: { runId: string; sandboxes: { sandboxId: string }[] }[];
    };
    expect(body.status).toBe('sandbox_active');
    expect(body.blocked[0]?.sandboxes[0]?.sandboxId).toBe('executor-del-sbx');
    // Nothing may change on the refused path.
    expect((await runRow(runId))?.state).toBe('executing');
    expect(await dismissed(runId)).toBe(false);

    const forced = await SELF.fetch(`${BASE}/v1/dashboard/runs/${runId}/delete`, {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({ cascadeSandboxes: true }),
    });
    expect(forced.status).toBe(200);
    expect((await runRow(runId))?.state).toBe('cancelled');
    expect(await dismissed(runId)).toBe(true);
  });

  it('does not hide a run that must not be interrupted', async () => {
    // merging is in-flight but deliberately not cancellable.
    const runId = await seedRun('merging', { runState: 'merging' });
    const res = await SELF.fetch(`${BASE}/v1/dashboard/runs/${runId}/delete`, {
      method: 'POST',
      headers: JSON_AUTH,
    });
    expect(res.status).toBe(409);
    expect((await runRow(runId))?.state).toBe('merging');
    expect(await dismissed(runId)).toBe(false);
  });

  it('is idempotent when the same run is removed twice', async () => {
    const runId = await seedRun('twice', { runState: 'succeeded' });
    const first = await SELF.fetch(`${BASE}/v1/dashboard/runs/${runId}/delete`, {
      method: 'POST',
      headers: JSON_AUTH,
    });
    expect(first.status).toBe(200);
    const second = await SELF.fetch(`${BASE}/v1/dashboard/runs/${runId}/delete`, {
      method: 'POST',
      headers: JSON_AUTH,
    });
    expect(second.status).toBe(200);
    const count = await env.DB_CONTROL
      .prepare('SELECT COUNT(*) AS n FROM dashboard_dismissals WHERE run_id = ?')
      .bind(runId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('removes a mixed batch and reports one outcome per run', async () => {
    const done = await seedRun('bulk_done', { runState: 'succeeded' });
    const live = await seedRun('bulk_live', { runState: 'executing' });
    const res = await SELF.fetch(`${BASE}/v1/dashboard/runs/delete`, {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({ runIds: [done, live, 'run_del_bulk_missing'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      deleted: number;
      results: { runId: string; status: string }[];
    };
    expect(body.deleted).toBe(2);
    const byId = new Map(body.results.map((r) => [r.runId, r.status]));
    expect(byId.get(done)).toBe('deleted');
    expect(byId.get(live)).toBe('deleted');
    expect(byId.get('run_del_bulk_missing')).toBe('not_found');
    expect(await dismissed(done)).toBe(true);
    expect(await dismissed(live)).toBe(true);
  });

  it('blocks the whole batch when any run still has a live sandbox', async () => {
    const done = await seedRun('batch_done', { runState: 'succeeded' });
    const running = await seedRun('batch_sbx', {
      runState: 'executing',
      executionStatus: 'running',
      sandboxId: 'executor-del-batch',
    });
    const res = await SELF.fetch(`${BASE}/v1/dashboard/runs/delete`, {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({ runIds: [done, running] }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { status: string; blocked: { runId: string }[] };
    expect(body.status).toBe('sandbox_active');
    expect(body.blocked.map((b) => b.runId)).toEqual([running]);
    // The safe member of the batch must not be removed behind the operator's back.
    expect(await dismissed(done)).toBe(false);
    expect(await dismissed(running)).toBe(false);
  });

  it('drops removed runs from the board but keeps their containers reapable', async () => {
    const runId = await seedRun('overview', {
      runState: 'executing',
      executionStatus: 'running',
      sandboxId: 'executor-del-overview',
    });
    const before = await SELF.fetch(`${BASE}/v1/dashboard/overview`, { headers: AUTH });
    const beforeBody = await before.json() as { tasks: { runId: string }[] };
    expect(beforeBody.tasks.some((t) => t.runId === runId)).toBe(true);

    const res = await SELF.fetch(`${BASE}/v1/dashboard/runs/${runId}/delete`, {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({ cascadeSandboxes: true }),
    });
    expect(res.status).toBe(200);

    const after = await SELF.fetch(`${BASE}/v1/dashboard/overview`, { headers: AUTH });
    const afterBody = await after.json() as {
      tasks: { runId: string }[];
      activeSandboxes: { sandboxId: string }[];
    };
    expect(afterBody.tasks.some((t) => t.runId === runId)).toBe(false);
    // No executor transport is configured in tests, so the container could not
    // actually be destroyed. It must stay listed, otherwise it becomes an
    // orphan holding an instance slot with no way to reap it.
    expect(afterBody.activeSandboxes.some((s) => s.sandboxId === 'executor-del-overview'))
      .toBe(true);
  });

  it('still removes the run when the executor transport is only half configured', async () => {
    // AGENT_EXECUTOR_URL ships as a plain var in wrangler.jsonc while the
    // control token is a secret, so any environment holding the var without the
    // secret makes transport resolution throw instead of returning null. CI runs
    // in exactly that shape, and the throw used to escape as a 500 that failed
    // the removal after the run had already been cancelled and dismissed.
    const runId = await seedRun('halfconf', {
      runState: 'executing',
      executionStatus: 'running',
      sandboxId: 'executor-del-halfconf',
    });
    const original = env.AGENT_EXECUTOR_CONTROL_TOKEN;
    // Reproduce a deployment that has the URL var but not the secret.
    delete env.AGENT_EXECUTOR_CONTROL_TOKEN;
    try {
      const res = await SELF.fetch(`${BASE}/v1/dashboard/runs/${runId}/delete`, {
        method: 'POST',
        headers: JSON_AUTH,
        body: JSON.stringify({ cascadeSandboxes: true }),
      });
      expect(res.status).toBe(200);
      // The single-run route returns the outcome directly; only the batch route
      // wraps outcomes in `results`.
      const body = await res.json() as { status: string; terminatedSandboxes: string[] };
      expect(body.status).toBe('deleted');
      // Nothing could be terminated, so the container must stay reapable.
      expect(body.terminatedSandboxes).toEqual([]);
      expect((await runRow(runId))?.state).toBe('cancelled');
      expect(await dismissed(runId)).toBe(true);
    } finally {
      if (original !== undefined) env.AGENT_EXECUTOR_CONTROL_TOKEN = original;
    }
  });
});
