/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ExecutorPluginRegistry } from '../../src/executor/core/executor-registry.js';
import {
  CloudflareSandboxExecutorPlugin,
  cloudflareSandboxExecutorProfile,
  type CloudflareSandboxExecutorEffects,
} from '../../src/executor/plugins/cloudflare-sandbox/cloudflare-sandbox-plugin.js';
import {
  GitHubActionsExecutorPlugin,
  GITHUB_ACTIONS_EXECUTOR_RELEASE_DIGEST_V1,
  githubActionsExecutorProfile,
} from '../../src/executor/plugins/github-actions/github-actions-plugin.js';
import {
  ExecutorControlError,
  ExecutorControlStore,
} from '../../src/storage/executor-control-store.js';
import { RunStore } from '../../src/storage/run-store.js';

const NOW = '2026-08-17T06:30:00.000Z';
const SHA = 'a'.repeat(40);
const TASK_DIGEST = `sha256:${'c'.repeat(64)}`;
const routing = {
  controlPlaneUrl: 'https://control.example.test',
  modelProfileId: 'codex-production',
};

const cloudflareEffects: CloudflareSandboxExecutorEffects = {
  async ensureSandbox() {
    throw new Error('routing must not start an executor');
  },
  async observeSandbox() {
    throw new Error('routing must not observe an executor');
  },
  async cancelSandbox() {
    throw new Error('routing must not cancel an executor');
  },
  async verifySandboxIdentity() {
    throw new Error('routing must not verify an executor identity');
  },
};

const registry = new ExecutorPluginRegistry([
  new CloudflareSandboxExecutorPlugin(cloudflareEffects),
  new GitHubActionsExecutorPlugin({
    async ensureDispatch() {
      throw new Error('routing must not dispatch GitHub Actions');
    },
  }),
]);

async function seedPlanningRun(suffix: string, repository: string): Promise<{
  runId: string;
  attemptId: string;
}> {
  const taskId = `task-route-${suffix}`;
  const runId = `run-route-${suffix}`;
  const attemptId = `attempt-route-${suffix}`;
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (
         ?, 'manual', 'executor-route-test', ?, '1', ?, ?, 'system',
         'executor-route-test', ?, 'main', 'none', 'bug', 'Executor route test',
         'p1', 1, 0, 0, 0, 1, ?, ?
       )`,
    ).bind(
      taskId,
      suffix,
      TASK_DIGEST,
      `r2://tasks/${taskId}`,
      repository,
      NOW,
      NOW,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, created_at, updated_at
       ) VALUES (?, ?, '1', ?, ?, ?, 'planning', 1, ?, ?)`,
    ).bind(runId, taskId, TASK_DIGEST, SHA, runId, NOW, NOW),
  ]);
  return { runId, attemptId };
}

function cloudflareProfile(profileId: string, marker: string) {
  return cloudflareSandboxExecutorProfile({
    profileId,
    workerOrigin: 'https://agent-executor.example.test',
    imageRef: `registry.example/work@sha256:${marker.repeat(64)}`,
    releaseDigest: `sha256:${marker.repeat(64)}`,
  });
}

async function installAnalysisRoute(
  repository: string,
  profileId: string,
  marker: string,
  routeVersion: number,
): Promise<void> {
  const control = new ExecutorControlStore(env.DB_CONTROL, registry);
  await control.registerProfile(cloudflareProfile(profileId, marker), 'active', new Date(NOW));
  await control.installRoute({
    routeId: `route-${profileId}`,
    repository,
    attemptMode: 'analysis',
    executionRole: 'work',
    profileId,
    routeVersion,
  }, new Date(NOW));
}

describe('production Attempt creation uses provider-neutral executor routes', () => {
  it('converges 20 analysis creates to one frozen Attempt/execution/outbox', async () => {
    const repository = 'route-test/cloudflare-concurrency';
    const ids = await seedPlanningRun('cloudflare-concurrency', repository);
    await installAnalysisRoute(repository, 'cloudflare-analysis-concurrency-v1', 'b', 1);
    const store = new RunStore(env.DB_CONTROL, routing);

    const results = await Promise.all(Array.from({ length: 20 }, async () =>
      await store.ensureAnalysisDispatch(ids.runId, ids.attemptId, NOW)));

    expect(new Set(results.map((result) => result.outboxId))).toEqual(
      new Set([`outbox-agent-${ids.attemptId}`]),
    );
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?`,
    ).bind(ids.runId).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempt_execution_instances WHERE attempt_id = ?`,
    ).bind(ids.attemptId).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox
       WHERE run_id = ? AND kind = 'agent_execution_start'
         AND destination = 'agent_executor'`,
    ).bind(ids.runId).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox
       WHERE run_id = ? AND destination = 'github_actions'`,
    ).bind(ids.runId).first()).toEqual({ count: 0 });
  });

  it('fails closed with zero Attempt/execution/outbox when no route is active', async () => {
    const repository = 'route-test/missing';
    const ids = await seedPlanningRun('missing', repository);
    const store = new RunStore(env.DB_CONTROL, routing);

    await expect(
      store.ensureAnalysisDispatch(ids.runId, ids.attemptId, NOW),
    ).rejects.toMatchObject({
      name: ExecutorControlError.name,
      code: 'route_not_found',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempts WHERE run_id = ?`,
    ).bind(ids.runId).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempt_execution_instances WHERE attempt_id = ?`,
    ).bind(ids.attemptId).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE run_id = ?`,
    ).bind(ids.runId).first()).toEqual({ count: 0 });
  });

  it('keeps an existing Attempt on its frozen profile after the active route changes', async () => {
    const repository = 'route-test/frozen';
    const ids = await seedPlanningRun('frozen', repository);
    await installAnalysisRoute(repository, 'cloudflare-analysis-frozen-v1', 'd', 1);
    const store = new RunStore(env.DB_CONTROL, routing);
    const first = await store.ensureAnalysisDispatch(ids.runId, ids.attemptId, NOW);

    await installAnalysisRoute(repository, 'cloudflare-analysis-frozen-v2', 'e', 2);
    const replay = await store.ensureAnalysisDispatch(ids.runId, ids.attemptId, NOW);

    expect(replay).toEqual(first);
    const frozen = await env.DB_CONTROL.prepare(
      `SELECT attempts.executor_profile_id, attempts.executor_route_version,
              executions.spec_json
       FROM attempts
       JOIN attempt_execution_instances AS executions
         ON executions.attempt_id = attempts.attempt_id
       WHERE attempts.attempt_id = ?`,
    ).bind(ids.attemptId).first<{
      executor_profile_id: string;
      executor_route_version: number;
      spec_json: string;
    }>();
    expect(frozen?.executor_profile_id).toBe('cloudflare-analysis-frozen-v1');
    expect(frozen?.executor_route_version).toBe(1);
    expect(JSON.parse(frozen?.spec_json ?? '{}')).toMatchObject({
      profile: { profileId: 'cloudflare-analysis-frozen-v1' },
    });
  });

  it('routes GitHub Actions through the same semantic execution outbox', async () => {
    const repository = 'route-test/github-plugin';
    const ids = await seedPlanningRun('github-plugin', repository);
    const profile = githubActionsExecutorProfile({
      profileId: 'github-actions-route-v1',
      executorRepository: 'example/delivery-loop',
      executorRef: 'refs/heads/main',
      releaseDigest: GITHUB_ACTIONS_EXECUTOR_RELEASE_DIGEST_V1,
    });
    const control = new ExecutorControlStore(env.DB_CONTROL, registry);
    await control.registerProfile(profile, 'active', new Date(NOW));
    await control.installRoute({
      routeId: 'route-github-actions-analysis-v1',
      repository,
      attemptMode: 'analysis',
      executionRole: 'work',
      profileId: profile.profileId,
      routeVersion: 1,
    }, new Date(NOW));

    await new RunStore(env.DB_CONTROL, routing).ensureAnalysisDispatch(
      ids.runId,
      ids.attemptId,
      NOW,
    );

    expect(await env.DB_CONTROL.prepare(
      `SELECT attempts.workflow_ref, attempts.executor_profile_id,
              outbox.kind, outbox.destination
       FROM attempts
       JOIN attempt_execution_instances AS executions
         ON executions.attempt_id = attempts.attempt_id
       JOIN outbox ON outbox.outbox_id = executions.outbox_id
       WHERE attempts.attempt_id = ?`,
    ).bind(ids.attemptId).first()).toEqual({
      workflow_ref:
        'example/delivery-loop/.github/workflows/delivery-agent.yml@refs/heads/main',
      executor_profile_id: profile.profileId,
      kind: 'agent_execution_start',
      destination: 'agent_executor',
    });
  });
});
