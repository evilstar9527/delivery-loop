/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseSessionEvents } from '../../src/dashboard/sandbox-session-store.js';

const OPERATIONS_TOKEN = 'test-operations-token';
const AUTH = { authorization: `Bearer ${OPERATIONS_TOKEN}` };
const BASE = 'https://control.test';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = '2026-08-20T09:00:00.000Z';

// Seeds a run whose attempt owns one execution instance in the given status,
// which is what decides whether the run has a "live sandbox".
async function seedSandboxRun(
  suffix: string,
  status: 'running' | 'succeeded',
  sandboxId: string,
): Promise<string> {
  const taskId = `task_sbxsess_${suffix}`;
  const runId = `run_sbxsess_${suffix}`;
  const attemptId = `attempt_sbxsess_${suffix}`;
  await env.DB_CONTROL.prepare(
    `INSERT INTO tasks (
       task_id, source_system, tenant_key, source_task_key, task_revision,
       task_digest, payload_ref, actor_type, actor_id, target_repository,
       target_base_branch, target_environment, intent_kind, title, priority,
       acceptance_criteria_count, allow_repository_write, allow_test_deploy,
       allow_production_deploy, require_human_approval, created_at, updated_at
     ) VALUES (?, 'manual', 'board', ?, 'revision-1', ?, 'r2://tasks/board',
               'user', 'op', 'acme/api', 'main', 'none', 'requirement', ?, 'p1', 1, 1, 0, 0, 1, ?, ?)`,
  ).bind(taskId, taskId, DIGEST, `Session ${suffix}`, NOW, NOW).run();
  await env.DB_CONTROL.prepare(
    `INSERT INTO runs (
       run_id, task_id, task_revision, task_digest, base_sha,
       workflow_instance_id, state, version, created_at, updated_at
     ) VALUES (?, ?, 'revision-1', ?, ?, ?, 'executing', 1, ?, ?)`,
  ).bind(runId, taskId, DIGEST, 'b'.repeat(40), runId, NOW, NOW).run();
  // A DB trigger requires the execution instance's profile/route binding to
  // match its attempt, against an active profile and route.
  await env.DB_CONTROL.prepare(
    `INSERT OR IGNORE INTO executor_profiles (
       profile_id, schema_version, provider_kind, plugin_schema_version,
       release_digest, configuration_json, capabilities_json, status,
       created_at, activated_at
     ) VALUES ('sbxsess-profile', '1', 'cloudflare_sandbox', '1', ?, '{}', '{}',
               'active', ?, ?)`,
  ).bind(DIGEST, NOW, NOW).run();
  await env.DB_CONTROL.prepare(
    `INSERT OR IGNORE INTO executor_routes (
       route_id, repository, attempt_mode, execution_role, profile_id,
       route_version, status, created_at, updated_at
     ) VALUES ('sbxsess-route', 'acme/api', 'implement', 'work', 'sbxsess-profile', 5,
               'active', ?, ?)`,
  ).bind(NOW, NOW).run();
  await env.DB_CONTROL.prepare(
    `INSERT INTO attempts (
       attempt_id, run_id, ordinal, mode, status, base_sha, repository,
       workflow_ref, version, lease_generation, executor_profile_id,
       executor_route_version, created_at, updated_at
     ) VALUES (?, ?, 1, 'implement', 'running', ?, 'acme/api',
               'acme/api/.github/workflows/x.yml@refs/heads/main', 1, 1,
               'sbxsess-profile', 5, ?, ?)`,
  ).bind(attemptId, runId, 'b'.repeat(40), NOW, NOW).run();
  await env.DB_CONTROL.prepare(
    `INSERT INTO outbox (
       outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
       delivery_state, created_at, updated_at
     ) VALUES (?, ?, 'agent_execution_start', 'agent_executor', ?, ?, 'settled', ?, ?)`,
  ).bind(`ob_sbxsess_${suffix}`, runId, `d1://x/${runId}`, `dk:${runId}`, NOW, NOW).run();
  await env.DB_CONTROL.prepare(
    `INSERT INTO attempt_execution_instances (
       execution_id, attempt_id, attempt_version, lease_generation,
       execution_role, executor_profile_id, executor_route_version,
       spec_digest, spec_json, release_digest, provider_kind,
       plugin_schema_version, status, provider_external_id, validated_handle_json,
       outbox_id, created_at, started_at, updated_at, terminal_at
     ) VALUES (?, ?, 1, 1, 'work', 'sbxsess-profile', 5, ?, '{}', ?,
               'cloudflare_sandbox', '1', ?, ?, '{}', ?, ?, ?, ?, ?)`,
  ).bind(
    `exec_sbxsess_${suffix}`, attemptId, DIGEST, DIGEST, status, sandboxId,
    `ob_sbxsess_${suffix}`, NOW, NOW, NOW,
    // A CHECK constraint ties terminal statuses to terminal_at.
    status === 'running' ? null : NOW,
  ).run();
  return runId;
}

// The workflow pool shares one local D1 across files, so scope cleanup to this
// file's own fixture ids.
beforeEach(async () => {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `DELETE FROM attempt_execution_instances WHERE execution_id LIKE 'exec_sbxsess_%'`,
    ),
    env.DB_CONTROL.prepare(`DELETE FROM outbox WHERE outbox_id LIKE 'ob_sbxsess_%'`),
    env.DB_CONTROL.prepare(`DELETE FROM attempts WHERE attempt_id LIKE 'attempt_sbxsess_%'`),
    env.DB_CONTROL.prepare(`DELETE FROM runs WHERE run_id LIKE 'run_sbxsess_%'`),
    env.DB_CONTROL.prepare(`DELETE FROM tasks WHERE task_id LIKE 'task_sbxsess_%'`),
  ]);
});

describe('dashboard sandbox session API', () => {
  it('requires the operations token for reads and for termination', async () => {
    const runId = await seedSandboxRun('auth', 'running', 'executor-sess-auth');
    const session = await SELF.fetch(`${BASE}/v1/dashboard/runs/${runId}/session`);
    expect(session.status).toBe(401);
    const cancel = await SELF.fetch(
      `${BASE}/v1/dashboard/sandboxes/executor-sess-auth/cancel`,
      { method: 'POST' },
    );
    expect(cancel.status).toBe(401);
  });

  it('rejects malformed run and sandbox identifiers', async () => {
    const badRun = await SELF.fetch(`${BASE}/v1/dashboard/runs/bad%20id/session`, { headers: AUTH });
    expect(badRun.status).toBe(400);
    const badSandbox = await SELF.fetch(
      `${BASE}/v1/dashboard/sandboxes/bad%20id/cancel`,
      { method: 'POST', headers: AUTH },
    );
    expect(badSandbox.status).toBe(400);
  });

  it('reports 404 when the run has no live sandbox', async () => {
    const runId = await seedSandboxRun('terminal', 'succeeded', 'executor-sess-done');
    const res = await SELF.fetch(`${BASE}/v1/dashboard/runs/${runId}/session`, { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('resolves the live sandbox for a run and never invents session content', async () => {
    const runId = await seedSandboxRun('live', 'running', 'executor-sess-live');
    const res = await SELF.fetch(`${BASE}/v1/dashboard/runs/${runId}/session`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.sandboxId).toBe('executor-sess-live');
    expect(body.executionId).toBe('exec_sbxsess_live');
    expect(body.role).toBe('work');
    expect(body.recordedStatus).toBe('running');
    // No executor transport is configured in tests, so the container cannot be
    // reached. The projection must say so rather than render an empty session as
    // if the agent were simply idle.
    expect(body.unreachable).toBe(true);
    expect(body.liveStatus).toBeNull();
    expect(body.events).toEqual([]);
  });
});

describe('sandbox session stdout parsing', () => {
  it('projects structured records and keeps their fields', () => {
    const events = parseSessionEvents(
      '{"component":"runner","level":"info","event":"execution_agent_activity",' +
        '"observedAt":"2026-08-20T09:00:01.000Z","jsonlEventCount":12}\n' +
        '{"event":"execution_attempt_result","observedAt":"2026-08-20T09:00:02.000Z",' +
        '"outcome":"passed"}\n',
    );
    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe('execution_agent_activity');
    expect(events[0]?.observedAt).toBe('2026-08-20T09:00:01.000Z');
    expect(events[0]?.fields).toEqual({ jsonlEventCount: 12 });
    // component/level are transport noise, not session content.
    expect(events[0]?.fields).not.toHaveProperty('component');
    expect(events[1]?.fields).toEqual({ outcome: 'passed' });
  });

  it('surfaces unparseable output verbatim instead of dropping it', () => {
    const events = parseSessionEvents(
      'Traceback (most recent call last):\n{"broken":\nnot json at all\n',
    );
    expect(events).toHaveLength(3);
    expect(events[0]?.raw).toBe('Traceback (most recent call last):');
    expect(events[1]?.raw).toBe('{"broken":');
    expect(events[2]?.raw).toBe('not json at all');
    for (const event of events) expect(event.event).toBe('output');
  });

  it('ignores blank lines and caps the retained window', () => {
    expect(parseSessionEvents('\n\n   \n')).toEqual([]);
    const many = Array.from(
      { length: 500 },
      (_unused, index) => `{"event":"tick","n":${index}}`,
    ).join('\n');
    const events = parseSessionEvents(many);
    expect(events).toHaveLength(400);
    // Keeps the newest frontier, drops the oldest.
    expect(events[events.length - 1]?.fields).toEqual({ n: 499 });
  });
});
