/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ExecutorPluginRegistry } from '../../src/executor/core/executor-registry.js';
import type { FrozenExecutionSpec } from '../../src/executor/core/executor-plugin.js';
import {
  CloudflareSandboxExecutorPlugin,
  cloudflareSandboxExecutorProfile,
  type CloudflareSandboxExecutorEffects,
  type CloudflareSandboxProviderFact,
} from '../../src/executor/plugins/cloudflare-sandbox/cloudflare-sandbox-plugin.js';
import { CloudflareSandboxWorkerEffects } from
  '../../src/executor/plugins/cloudflare-sandbox/cloudflare-sandbox-runtime.js';
import { RegistryExecutorIdentityProvider } from
  '../../src/executor/core/executor-identity-provider.js';
import { attemptApi } from '../../src/http/attempt-api.js';
import type { Bindings } from '../../src/env.js';
import {
  ExecutorControlError,
  ExecutorControlStore,
} from '../../src/storage/executor-control-store.js';
import {
  ExecutorObservationService,
  ExecutorObservationStore,
} from '../../src/storage/executor-observation-store.js';
import type { ExecutorObservationError } from '../../src/storage/executor-observation-store.js';
import { AgentExecutorOutboxProcessor } from '../../src/outbox/agent-executor.js';
import { ExecutorReconciler } from '../../src/reconciliation/executor-reconciler.js';
import {
  ExecutorPatchPublicationError,
  ExecutorPatchPublicationStore,
} from '../../src/storage/executor-patch-publication-store.js';

const NOW = new Date('2026-08-14T02:00:00.000Z');
const REPOSITORY = 'business/repository';
const RUN_ID = 'run-executor-control';
const ATTEMPT_ID = 'attempt-executor-control';
const SHA = 'a'.repeat(40);

const effects: CloudflareSandboxExecutorEffects = {
  async ensureSandbox() {
    throw new Error('freeze must not start a provider');
  },
  async observeSandbox() {
    throw new Error('freeze must not observe a provider');
  },
  async cancelSandbox() {
    throw new Error('freeze must not cancel a provider');
  },
  async verifySandboxIdentity() {
    throw new Error('freeze must not verify provider identity');
  },
};

const profile = cloudflareSandboxExecutorProfile({
  profileId: 'cloudflare-sandbox-control-v1',
  workerOrigin: 'https://agent-executor.example.workers.dev',
  imageRef: 'registry.example/delivery-agent@sha256:immutable',
  releaseDigest: `sha256:${'b'.repeat(64)}`,
});

const publisherProfile = cloudflareSandboxExecutorProfile({
  profileId: 'cloudflare-sandbox-publisher-v1',
  workerOrigin: 'https://agent-executor.example.workers.dev',
  imageRef: 'registry.example/delivery-publisher@sha256:immutable',
  releaseDigest: `sha256:${'d'.repeat(64)}`,
});

function spec(): FrozenExecutionSpec {
  return {
    schemaVersion: '1',
    executionId: 'execution-control-1',
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    leaseGeneration: 1,
    role: 'work',
    mode: 'analysis',
    profile,
    taskDigest: `sha256:${'c'.repeat(64)}`,
    repository: REPOSITORY,
    baseSha: SHA,
    checkoutSha: SHA,
    targetBaseBranch: 'main',
    controlPlaneUrl: 'https://control.example.test',
  };
}

async function seedAttempt(): Promise<void> {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM executor_patch_publications'),
    env.DB_CONTROL.prepare('DELETE FROM executor_patch_artifacts'),
    env.DB_CONTROL.prepare('DELETE FROM quota_concurrency_reservations'),
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES (
         'task-executor-control', 'manual', 'executor-control', 'executor-control', '1', ?,
         'r2://tasks/executor-control', 'system', 'executor-control', ?,
         'main', 'none', 'bug', 'Executor control', 'p1', 1, 0, 0, 0, 1, ?, ?
       )`,
    ).bind(`sha256:${'c'.repeat(64)}`, REPOSITORY, NOW.toISOString(), NOW.toISOString()),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, created_at, updated_at
       ) VALUES (?, 'task-executor-control', '1', ?, ?, ?, 'planning', 1, ?, ?)`,
    ).bind(
      RUN_ID,
      `sha256:${'c'.repeat(64)}`,
      SHA,
      RUN_ID,
      NOW.toISOString(),
      NOW.toISOString(),
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         workflow_ref, version, lease_generation, created_at, updated_at
       ) VALUES (?, ?, 1, 'analysis', 'pending', ?, ?, NULL, 0, 0, ?, ?)`,
    ).bind(ATTEMPT_ID, RUN_ID, SHA, REPOSITORY, NOW.toISOString(), NOW.toISOString()),
  ]);
}

async function startFrozenExecution(
  registry: ExecutorPluginRegistry,
): Promise<void> {
  const store = new ExecutorControlStore(env.DB_CONTROL, registry);
  await store.registerProfile(profile, 'active', NOW);
  await store.installRoute({
    routeId: 'route-cloudflare-analysis-v1',
    repository: REPOSITORY,
    attemptMode: 'analysis',
    executionRole: 'work',
    profileId: profile.profileId,
    routeVersion: 1,
  }, NOW);
  await store.freezeExecution({
    spec: spec(),
    expectedAttemptVersion: 0,
    outboxId: 'outbox-agent-executor-control',
    now: NOW,
  });
  await new AgentExecutorOutboxProcessor(env.DB_CONTROL, registry, {
    now: () => NOW,
    generateLeaseToken: () => crypto.randomUUID(),
  }).deliver('outbox-agent-executor-control');
}

beforeEach(async () => {
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM executor_cancellations'),
    env.DB_CONTROL.prepare('DELETE FROM executor_reconciliation_failures'),
    env.DB_CONTROL.prepare('DELETE FROM executor_observations'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_execution_instances'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM executor_routes'),
    env.DB_CONTROL.prepare(
      `DELETE FROM executor_profiles WHERE profile_id <> 'legacy-github-actions-v1'`,
    ),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
  await seedAttempt();
});

describe('provider-neutral executor control store', () => {
  it('freezes one routed execution and semantic outbox under 20 consumers', async () => {
    const registry = new ExecutorPluginRegistry([
      new CloudflareSandboxExecutorPlugin(effects),
    ]);
    const store = new ExecutorControlStore(env.DB_CONTROL, registry);
    await expect(store.registerProfile(profile, 'active', NOW)).resolves.toMatchObject({
      created: true,
      capabilities: {
        networkIsolation: 'default_deny',
        supportsPublisherRole: true,
      },
    });
    await store.installRoute({
      routeId: 'route-cloudflare-analysis-v1',
      repository: REPOSITORY,
      attemptMode: 'analysis',
      executionRole: 'work',
      profileId: profile.profileId,
      routeVersion: 1,
    }, NOW);

    const results = await Promise.all(Array.from({ length: 20 }, async () =>
      await store.freezeExecution({
        spec: spec(),
        expectedAttemptVersion: 0,
        outboxId: 'outbox-agent-executor-control',
        now: NOW,
      })));

    expect(new Set(results.map((result) => result.executionId))).toEqual(
      new Set(['execution-control-1']),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempt_execution_instances`,
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT destination, kind, payload_ref, delivery_state
       FROM outbox WHERE outbox_id = 'outbox-agent-executor-control'`,
    ).first()).toEqual({
      destination: 'agent_executor',
      kind: 'agent_execution_start',
      payload_ref: 'd1://attempt-executions/execution-control-1',
      delivery_state: 'pending',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT executor_profile_id, executor_route_version
       FROM attempts WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first()).toEqual({
      executor_profile_id: profile.profileId,
      executor_route_version: 1,
    });
    expect(JSON.stringify(await env.DB_CONTROL.prepare(
      `SELECT spec_json, validated_handle_json
       FROM attempt_execution_instances WHERE execution_id = 'execution-control-1'`,
    ).first())).not.toMatch(/token|secret|password|credential/i);
  });

  it('keeps the frozen Attempt on its original profile after a route changes', async () => {
    const registry = new ExecutorPluginRegistry([
      new CloudflareSandboxExecutorPlugin(effects),
    ]);
    const store = new ExecutorControlStore(env.DB_CONTROL, registry);
    await store.registerProfile(profile, 'active', NOW);
    await store.installRoute({
      routeId: 'route-cloudflare-analysis-v1',
      repository: REPOSITORY,
      attemptMode: 'analysis',
      executionRole: 'work',
      profileId: profile.profileId,
      routeVersion: 1,
    }, NOW);
    await store.freezeExecution({
      spec: spec(),
      expectedAttemptVersion: 0,
      outboxId: 'outbox-agent-executor-control',
      now: NOW,
    });

    await expect(env.DB_CONTROL.prepare(
      `UPDATE attempts SET executor_route_version = 2 WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).run()).rejects.toThrow('attempt executor binding is immutable');
    const replacementProfile = cloudflareSandboxExecutorProfile({
      profileId: 'cloudflare-sandbox-control-v2',
      workerOrigin: 'https://agent-executor.example.workers.dev',
      imageRef: 'registry.example/delivery-agent@sha256:replacement',
      releaseDigest: `sha256:${'d'.repeat(64)}`,
    });
    await store.registerProfile(replacementProfile, 'active', NOW);
    await store.installRoute({
      routeId: 'route-cloudflare-analysis-v2',
      repository: REPOSITORY,
      attemptMode: 'analysis',
      executionRole: 'work',
      profileId: replacementProfile.profileId,
      routeVersion: 2,
    }, NOW);
    await expect(store.freezeExecution({
      spec: {
        ...spec(),
        executionId: 'execution-control-2',
        leaseGeneration: 2,
        profile: replacementProfile,
      },
      expectedAttemptVersion: 0,
      outboxId: 'outbox-agent-executor-control-2',
      now: NOW,
    })).rejects.toBeInstanceOf(ExecutorControlError);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempt_execution_instances`,
    ).first()).toEqual({ count: 1 });
  });

  it('starts the semantic outbox once and persists a provider-neutral handle', async () => {
    let starts = 0;
    const runtimeEffects: CloudflareSandboxExecutorEffects = {
      async ensureSandbox(_origin, request) {
        starts += 1;
        return {
          disposition: starts === 1 ? 'created' : 'existing',
          sandboxId: `sandbox-${request.executionId}`,
          containerId: 'container-control-1',
        };
      },
      async observeSandbox() {
        throw new Error('start does not observe');
      },
      async cancelSandbox() {
        throw new Error('start does not cancel');
      },
      async verifySandboxIdentity() {
        throw new Error('start does not verify identity');
      },
    };
    const registry = new ExecutorPluginRegistry([
      new CloudflareSandboxExecutorPlugin(runtimeEffects),
    ]);
    const store = new ExecutorControlStore(env.DB_CONTROL, registry);
    await store.registerProfile(profile, 'active', NOW);
    await store.installRoute({
      routeId: 'route-cloudflare-analysis-v1',
      repository: REPOSITORY,
      attemptMode: 'analysis',
      executionRole: 'work',
      profileId: profile.profileId,
      routeVersion: 1,
    }, NOW);
    await store.freezeExecution({
      spec: spec(),
      expectedAttemptVersion: 0,
      outboxId: 'outbox-agent-executor-control',
      now: NOW,
    });
    const processor = new AgentExecutorOutboxProcessor(env.DB_CONTROL, registry, {
      now: () => NOW,
      generateLeaseToken: () => crypto.randomUUID(),
    });

    const results = await Promise.all(Array.from({ length: 20 }, async () =>
      await processor.deliver('outbox-agent-executor-control')));

    expect(starts).toBe(1);
    expect(results).toContain('settled');
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, version, lease_generation, executor_profile_id,
              executor_route_version
       FROM attempts WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first()).toEqual({
      status: 'starting',
      version: 1,
      lease_generation: 1,
      executor_profile_id: profile.profileId,
      executor_route_version: 1,
    });
    const instance = await env.DB_CONTROL.prepare(
      `SELECT status, provider_external_id, validated_handle_json
       FROM attempt_execution_instances WHERE execution_id = 'execution-control-1'`,
    ).first<{
      status: string;
      provider_external_id: string;
      validated_handle_json: string;
    }>();
    expect(instance).toMatchObject({
      status: 'starting',
      provider_external_id: 'sandbox-execution-control-1',
    });
    expect(JSON.parse(instance!.validated_handle_json)).toMatchObject({
      kind: 'cloudflare_sandbox',
      attemptId: ATTEMPT_ID,
      leaseGeneration: 1,
      attributes: { containerId: 'container-control-1' },
    });
  });

  it('delivers the semantic outbox through the authenticated Executor Worker binding', async () => {
    let executorRequest: Request | undefined;
    const registry = new ExecutorPluginRegistry([
      new CloudflareSandboxExecutorPlugin(new CloudflareSandboxWorkerEffects({
        binding: {
          async fetch(request: Request) {
            executorRequest = request;
            return Response.json({
              schemaVersion: '1',
              disposition: 'created',
              sandboxId: 'execution-control-1',
              containerId: 'container-control-binding-1',
            });
          },
        } as unknown as Fetcher,
        controlToken: 'executor-control-token-for-workerd',
      })),
    ]);

    await startFrozenExecution(registry);

    expect(executorRequest?.url).toBe(
      'https://agent-executor.example.workers.dev/v1/executions/ensure',
    );
    expect(executorRequest?.headers.get('authorization')).toBe(
      'Bearer executor-control-token-for-workerd',
    );
    expect(await executorRequest?.json()).toMatchObject({
      executionId: 'execution-control-1',
      attemptId: ATTEMPT_ID,
      profileId: profile.profileId,
      releaseDigest: profile.releaseDigest,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, provider_external_id
       FROM attempt_execution_instances WHERE execution_id = 'execution-control-1'`,
    ).first()).toEqual({
      status: 'starting',
      provider_external_id: 'execution-control-1',
    });
  });

  it('exchanges one Worker-injected executor identity for short-lived scoped tokens', async () => {
    const callbackToken = 'executor-callback-token-for-workerd';
    const registry = new ExecutorPluginRegistry([
      new CloudflareSandboxExecutorPlugin(new CloudflareSandboxWorkerEffects({
        binding: {
          async fetch() {
            return Response.json({
              schemaVersion: '1',
              disposition: 'created',
              sandboxId: 'execution-control-1',
              containerId: 'container-control-identity-1',
            });
          },
        } as unknown as Fetcher,
        controlToken: 'executor-control-token-for-workerd',
        callbackToken,
      })),
    ]);
    await startFrozenExecution(registry);
    const provider = new RegistryExecutorIdentityProvider(env.DB_CONTROL, registry);
    const api = attemptApi({
      executorIdentityProvider: provider,
      now: () => new Date('2026-08-14T02:00:01.000Z'),
    });
    const invoke = async (authorization = `Bearer ${callbackToken}`) => await api.request(
      `https://control.example.test/v1/attempts/${ATTEMPT_ID}/executor-exchange`,
      {
        method: 'POST',
        headers: {
          authorization,
          'x-delivery-execution-id': 'execution-control-1',
          'x-delivery-executor-container-id': 'container-control-identity-1',
        },
      },
      env as unknown as Bindings,
    );

    const responses = await Promise.all(Array.from({ length: 20 }, async () => await invoke()));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(19);
    const winner = responses.find((response) => response.status === 200);
    const result = await winner?.json() as {
      attemptToken: string;
      attemptVersion: number;
      leaseGeneration: number;
      grant: { toolBridgeToken: string; scopes: string[] };
    };
    expect(result.attemptToken).not.toBe(result.grant.toolBridgeToken);
    expect(result.attemptVersion).toBe(2);
    expect(result.leaseGeneration).toBe(1);
    expect(result.grant.scopes).toContain('repo:read');
    expect(await env.DB_CONTROL.prepare(
      `SELECT identity_kind, execution_id, oidc_token_digest, token_digest,
              tool_token_digest, revoked_at
       FROM attempt_tokens WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first()).toMatchObject({
      identity_kind: 'executor',
      execution_id: 'execution-control-1',
      revoked_at: null,
    });
    expect(JSON.stringify(await env.DB_CONTROL.prepare(
      `SELECT oidc_token_digest, token_digest, tool_token_digest
       FROM attempt_tokens WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first())).not.toContain(result.attemptToken);
    const forged = await invoke(`Bearer ${'wrong-callback-token-value'}`);
    expect(forged.status).toBe(401);
    expect(await forged.text()).not.toContain('wrong-callback-token-value');
  });

  it('records monotonic provider facts and projects a terminal execution without completing the Attempt', async () => {
    let providerFact: CloudflareSandboxProviderFact = {
      status: 'running',
      externalUpdatedAt: '2026-08-14T02:01:00.000Z',
      exitCode: null,
      imageDigest: `sha256:${'d'.repeat(64)}`,
    };
    const runtimeEffects: CloudflareSandboxExecutorEffects = {
      async ensureSandbox(_origin, request) {
        return {
          disposition: 'created',
          sandboxId: `sandbox-${request.executionId}`,
          containerId: 'container-control-1',
        };
      },
      async observeSandbox() {
        return providerFact;
      },
      async cancelSandbox() {
        throw new Error('observation does not cancel');
      },
      async verifySandboxIdentity() {
        throw new Error('observation does not verify identity');
      },
    };
    const registry = new ExecutorPluginRegistry([
      new CloudflareSandboxExecutorPlugin(runtimeEffects),
    ]);
    await startFrozenExecution(registry);
    const observer = new ExecutorObservationService(env.DB_CONTROL, registry, {
      now: () => new Date('2026-08-14T02:01:05.000Z'),
    });

    await expect(observer.observe('execution-control-1')).resolves.toMatchObject({
      disposition: 'applied',
      sequence: 1,
      status: 'running',
    });
    providerFact = {
      status: 'succeeded',
      externalUpdatedAt: '2026-08-14T02:02:00.000Z',
      exitCode: 0,
      imageDigest: `sha256:${'d'.repeat(64)}`,
    };
    await expect(observer.observe('execution-control-1')).resolves.toMatchObject({
      disposition: 'applied',
      sequence: 2,
      status: 'succeeded',
    });

    expect(await env.DB_CONTROL.prepare(
      `SELECT status, observation_sequence, external_updated_at, terminal_at
       FROM attempt_execution_instances WHERE execution_id = 'execution-control-1'`,
    ).first()).toEqual({
      status: 'succeeded',
      observation_sequence: 2,
      external_updated_at: '2026-08-14T02:02:00.000Z',
      terminal_at: '2026-08-14T02:02:00.000Z',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, version, lease_generation
       FROM attempts WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first()).toEqual({
      status: 'starting',
      version: 1,
      lease_generation: 1,
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT sequence, status, external_updated_at
       FROM executor_observations
       WHERE execution_id = 'execution-control-1' ORDER BY sequence`,
    ).all()).toMatchObject({
      results: [
        {
          sequence: 1,
          status: 'running',
          external_updated_at: '2026-08-14T02:01:00.000Z',
        },
        {
          sequence: 2,
          status: 'succeeded',
          external_updated_at: '2026-08-14T02:02:00.000Z',
        },
      ],
    });
  });

  it('deduplicates concurrent facts and rejects stale, regressive, or conflicting terminal projections', async () => {
    let providerFact: CloudflareSandboxProviderFact = {
      status: 'running',
      externalUpdatedAt: '2026-08-14T02:01:00.000Z',
      exitCode: null,
      imageDigest: `sha256:${'d'.repeat(64)}`,
    };
    const registry = new ExecutorPluginRegistry([
      new CloudflareSandboxExecutorPlugin({
        async ensureSandbox(_origin, request) {
          return {
            disposition: 'created',
            sandboxId: `sandbox-${request.executionId}`,
            containerId: 'container-control-1',
          };
        },
        async observeSandbox() {
          return providerFact;
        },
        async cancelSandbox() {
          throw new Error('observation does not cancel');
        },
        async verifySandboxIdentity() {
          throw new Error('observation does not verify identity');
        },
      }),
    ]);
    await startFrozenExecution(registry);
    const observer = new ExecutorObservationService(env.DB_CONTROL, registry, {
      now: () => new Date('2026-08-14T02:03:00.000Z'),
    });

    const concurrent = await Promise.all(Array.from({ length: 20 }, async () =>
      await observer.observe('execution-control-1')));
    expect(concurrent.filter((result) => result.disposition === 'applied')).toHaveLength(1);
    expect(concurrent.filter((result) => result.disposition === 'duplicate')).toHaveLength(19);

    providerFact = {
      ...providerFact,
      status: 'queued',
      externalUpdatedAt: '2026-08-14T02:02:00.000Z',
    };
    await expect(observer.observe('execution-control-1')).resolves.toMatchObject({
      disposition: 'ignored',
      reason: 'status_regression',
    });
    providerFact = {
      ...providerFact,
      status: 'failed',
      externalUpdatedAt: '2026-08-14T02:03:00.000Z',
      exitCode: 1,
    };
    await expect(observer.observe('execution-control-1')).resolves.toMatchObject({
      disposition: 'applied',
      sequence: 2,
      status: 'failed',
    });
    providerFact = {
      ...providerFact,
      status: 'succeeded',
      externalUpdatedAt: '2026-08-14T02:04:00.000Z',
      exitCode: 0,
    };
    await expect(observer.observe('execution-control-1')).resolves.toMatchObject({
      disposition: 'ignored',
      reason: 'terminal_conflict',
    });
    providerFact = {
      ...providerFact,
      status: 'failed',
      externalUpdatedAt: '2026-08-14T02:00:00.000Z',
      exitCode: 1,
    };
    await expect(observer.observe('execution-control-1')).resolves.toMatchObject({
      disposition: 'ignored',
      reason: 'stale_external_fact',
    });

    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM executor_observations
       WHERE execution_id = 'execution-control-1'`,
    ).first()).toEqual({ count: 2 });
  });

  it('rejects an external fact that is not bound to the immutable execution identity', async () => {
    const registry = new ExecutorPluginRegistry([
      new CloudflareSandboxExecutorPlugin({
        async ensureSandbox(_origin, request) {
          return {
            disposition: 'created',
            sandboxId: `sandbox-${request.executionId}`,
            containerId: 'container-control-1',
          };
        },
        async observeSandbox() {
          throw new Error('direct store record does not observe');
        },
        async cancelSandbox() {
          throw new Error('direct store record does not cancel');
        },
        async verifySandboxIdentity() {
          throw new Error('direct store record does not verify identity');
        },
      }),
    ]);
    await startFrozenExecution(registry);
    const store = new ExecutorObservationStore(env.DB_CONTROL);
    await expect(store.record({
      fact: {
        schemaVersion: '1',
        kind: 'cloudflare_sandbox',
        profileId: profile.profileId,
        externalId: 'sandbox-execution-control-1',
        executionId: 'execution-control-1',
        attemptId: 'attempt-other',
        leaseGeneration: 1,
        status: 'running',
        externalUpdatedAt: '2026-08-14T02:01:00.000Z',
        facts: {},
      },
      observedAt: '2026-08-14T02:01:05.000Z',
    })).rejects.toMatchObject({
      code: 'execution_binding_conflict',
    } satisfies Partial<ExecutorObservationError>);
  });

  it('backs off fixed observation failures and clears them after provider recovery', async () => {
    let current = new Date('2026-08-14T02:01:00.000Z');
    let unavailable = true;
    const registry = new ExecutorPluginRegistry([
      new CloudflareSandboxExecutorPlugin({
        async ensureSandbox(_origin, request) {
          return {
            disposition: 'created',
            sandboxId: `sandbox-${request.executionId}`,
            containerId: 'container-reconcile-1',
          };
        },
        async observeSandbox() {
          if (unavailable) throw new Error('provider canary must not persist');
          return {
            status: 'running',
            externalUpdatedAt: '2026-08-14T02:01:01.000Z',
            exitCode: null,
            imageDigest: `sha256:${'e'.repeat(64)}`,
          };
        },
        async cancelSandbox() {
          throw new Error('observation does not cancel');
        },
        async verifySandboxIdentity() {
          throw new Error('observation does not verify identity');
        },
      }),
    ]);
    await startFrozenExecution(registry);
    const reconciler = new ExecutorReconciler(env.DB_CONTROL, registry, {
      now: () => current,
      retryBaseMs: 1,
    });
    await expect(reconciler.reconcileObservations(1)).resolves.toEqual([{
      executionId: 'execution-control-1',
      operation: 'observe',
      disposition: 'retry',
    }]);
    expect(await env.DB_CONTROL.prepare(
      `SELECT consecutive_failures, last_error_code
       FROM executor_reconciliation_failures WHERE execution_id = ?`,
    ).bind('execution-control-1').first()).toEqual({
      consecutive_failures: 1,
      last_error_code: 'provider_unavailable',
    });
    expect(JSON.stringify(await env.DB_CONTROL.prepare(
      `SELECT * FROM executor_reconciliation_failures WHERE execution_id = ?`,
    ).bind('execution-control-1').first())).not.toContain('provider canary');
    unavailable = false;
    current = new Date('2026-08-14T02:01:00.002Z');
    await expect(reconciler.reconcileObservations(1)).resolves.toMatchObject([{
      operation: 'observe',
      disposition: 'applied',
    }]);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM executor_reconciliation_failures`,
    ).first()).toEqual({ count: 0 });
  });

  it('delivers one provider cancellation after Attempt fencing under 20 reconcilers', async () => {
    let cancelCalls = 0;
    const registry = new ExecutorPluginRegistry([
      new CloudflareSandboxExecutorPlugin({
        async ensureSandbox(_origin, request) {
          return {
            disposition: 'created',
            sandboxId: `sandbox-${request.executionId}`,
            containerId: 'container-cancel-1',
          };
        },
        async observeSandbox() {
          throw new Error('cancel does not observe');
        },
        async cancelSandbox(_origin, _id, reason) {
          expect(reason).toBe('lease_expired');
          cancelCalls += 1;
          return 'cancelled';
        },
        async verifySandboxIdentity() {
          throw new Error('cancel does not verify identity');
        },
      }),
    ]);
    await startFrozenExecution(registry);
    await env.DB_CONTROL.prepare(
      `UPDATE attempts SET status = 'lost', version = version + 1,
         lease_generation = lease_generation + 1, lease_expires_at = NULL,
         updated_at = ? WHERE attempt_id = ?`,
    ).bind('2026-08-14T02:11:00.000Z', ATTEMPT_ID).run();
    const reconciler = new ExecutorReconciler(env.DB_CONTROL, registry, {
      now: () => new Date('2026-08-14T02:11:01.000Z'),
    });
    await Promise.all(Array.from({ length: 20 }, async () =>
      await reconciler.reconcileCancellations(1)));
    expect(cancelCalls).toBe(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT reason, delivery_state, outcome FROM executor_cancellations`,
    ).first()).toEqual({
      reason: 'lease_expired',
      delivery_state: 'settled',
      outcome: 'cancelled',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, terminal_at FROM attempt_execution_instances
       WHERE execution_id = 'execution-control-1'`,
    ).first()).toMatchObject({ status: 'cancelled' });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, lease_generation FROM attempts WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first()).toEqual({ status: 'lost', lease_generation: 2 });
  });

  it('hands one immutable work patch to a clean publisher execution without changing Attempt authority', async () => {
    const runtimeEffects: CloudflareSandboxExecutorEffects = {
      async ensureSandbox(_origin, request) {
        return {
          disposition: 'created',
          sandboxId: `sandbox-${request.executionId}`,
          containerId: `container-${request.role}`,
        };
      },
      async observeSandbox() {
        throw new Error('publication does not observe');
      },
      async cancelSandbox() {
        throw new Error('publication does not cancel');
      },
      async verifySandboxIdentity() {
        throw new Error('publication does not exchange work grant');
      },
    };
    const registry = new ExecutorPluginRegistry([
      new CloudflareSandboxExecutorPlugin(runtimeEffects),
    ]);
    await startFrozenExecution(registry);
    await env.DB_CONTROL.batch([
      env.DB_CONTROL.prepare(
        `UPDATE attempts SET status = 'running', version = 2, heartbeat_at = ?, updated_at = ?
         WHERE attempt_id = ? AND status = 'starting' AND version = 1`,
      ).bind(NOW.toISOString(), NOW.toISOString(), ATTEMPT_ID),
      env.DB_CONTROL.prepare(
        `UPDATE attempt_execution_instances SET status = 'running', updated_at = ?
         WHERE execution_id = 'execution-control-1' AND status = 'starting'`,
      ).bind(NOW.toISOString()),
    ]);
    const control = new ExecutorControlStore(env.DB_CONTROL, registry);
    await control.registerProfile(publisherProfile, 'active', NOW);
    await control.installRoute({
      routeId: 'route-cloudflare-publisher-v1',
      repository: REPOSITORY,
      attemptMode: 'analysis',
      executionRole: 'publisher',
      profileId: publisherProfile.profileId,
      routeVersion: 1,
    }, NOW);
    const publication = new ExecutorPatchPublicationStore(env.DB_CONTROL, registry);
    const patchDigest = `sha256:${'7'.repeat(64)}`;
    await expect(publication.recordWorkPatch({
      patchId: 'patch-control-1',
      workExecutionId: 'execution-control-1',
      attemptId: ATTEMPT_ID,
      leaseGeneration: 1,
      repository: REPOSITORY,
      baseSha: SHA,
      checkoutSha: SHA,
      patchDigest,
      changedPathsDigest: `sha256:${'8'.repeat(64)}`,
      patchRef: 'r2://executor-patches/patch-control-1',
      byteLength: 512,
      now: NOW,
    })).resolves.toEqual({ created: true });
    const publisherSpec: FrozenExecutionSpec = {
      ...spec(),
      executionId: 'execution-publisher-1',
      role: 'publisher',
      profile: publisherProfile,
      patchArtifactId: 'patch-control-1',
    };
    const scheduled = await Promise.all(Array.from({ length: 20 }, async () =>
      await publication.schedulePublisher({
        publicationId: 'publication-control-1',
        spec: publisherSpec,
        expectedAttemptVersion: 2,
        targetBranch: 'agent/task-executor-control/attempt-executor-control',
        outboxId: 'outbox-publisher-control-1',
        now: NOW,
      })));
    expect(scheduled.filter((result) => result.created)).toHaveLength(1);
    const publisherDelivery = await new AgentExecutorOutboxProcessor(env.DB_CONTROL, registry, {
      now: () => NOW,
      generateLeaseToken: () => crypto.randomUUID(),
    }).deliver('outbox-publisher-control-1');
    expect({
      publisherDelivery,
      outbox: await env.DB_CONTROL.prepare(
        `SELECT delivery_state, last_error_code FROM outbox WHERE outbox_id = ?`,
      ).bind('outbox-publisher-control-1').first(),
    }).toEqual({
      publisherDelivery: 'settled',
      outbox: { delivery_state: 'settled', last_error_code: null },
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, provider_external_id, execution_role
       FROM attempt_execution_instances WHERE execution_id = 'execution-publisher-1'`,
    ).first()).toEqual({
      status: 'starting',
      provider_external_id: 'sandbox-execution-publisher-1',
      execution_role: 'publisher',
    });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, version, lease_generation, executor_profile_id
       FROM attempts WHERE attempt_id = ?`,
    ).bind(ATTEMPT_ID).first()).toEqual({
      status: 'running',
      version: 2,
      lease_generation: 1,
      executor_profile_id: profile.profileId,
    });
    await expect(publication.schedulePublisher({
      publicationId: 'publication-control-conflict',
      spec: { ...publisherSpec, executionId: 'execution-publisher-conflict' },
      expectedAttemptVersion: 2,
      targetBranch: 'agent/task-executor-control/attempt-executor-control',
      outboxId: 'outbox-publisher-control-conflict',
      now: NOW,
    })).rejects.toBeInstanceOf(ExecutorPatchPublicationError);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox
       WHERE outbox_id = 'outbox-publisher-control-conflict'`,
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempt_execution_instances
       WHERE execution_id = 'execution-publisher-conflict'`,
    ).first()).toEqual({ count: 0 });
    await expect(publication.completePublication({
      publicationId: 'publication-control-1',
      publisherExecutionId: 'execution-publisher-1',
      recomputedPatchDigest: `sha256:${'9'.repeat(64)}`,
      headSha: 'b'.repeat(40),
      now: NOW,
    })).rejects.toBeInstanceOf(ExecutorPatchPublicationError);
    await publication.completePublication({
      publicationId: 'publication-control-1',
      publisherExecutionId: 'execution-publisher-1',
      recomputedPatchDigest: patchDigest,
      headSha: 'b'.repeat(40),
      now: NOW,
    });
    await expect(publication.completePublication({
      publicationId: 'publication-control-1',
      publisherExecutionId: 'execution-publisher-1',
      recomputedPatchDigest: patchDigest,
      headSha: 'b'.repeat(40),
      now: new Date(NOW.getTime() + 1_000),
    })).resolves.toBeUndefined();
    await expect(publication.recordWorkPatch({
      patchId: 'patch-control-1',
      workExecutionId: 'execution-control-1',
      attemptId: ATTEMPT_ID,
      leaseGeneration: 1,
      repository: REPOSITORY,
      baseSha: SHA,
      checkoutSha: SHA,
      patchDigest,
      changedPathsDigest: `sha256:${'8'.repeat(64)}`,
      patchRef: 'r2://executor-patches/patch-control-1',
      byteLength: 512,
      now: new Date(NOW.getTime() + 1_000),
    })).resolves.toEqual({ created: false });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, expected_patch_digest, recomputed_patch_digest, head_sha
       FROM executor_patch_publications WHERE publication_id = 'publication-control-1'`,
    ).first()).toEqual({
      status: 'published',
      expected_patch_digest: patchDigest,
      recomputed_patch_digest: patchDigest,
      head_sha: 'b'.repeat(40),
    });
  });
});
