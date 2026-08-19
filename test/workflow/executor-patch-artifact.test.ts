/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../src/domain/digest.js';
import { EXECUTION_TOOL_ACTIONS } from '../../src/domain/tool-bridge.js';
import { ExecutorPluginRegistry } from '../../src/executor/core/executor-registry.js';
import type {
  FrozenExecutionSpec,
  VerifiedExecutorIdentity,
} from '../../src/executor/core/executor-plugin.js';
import {
  CloudflareSandboxExecutorPlugin,
  cloudflareSandboxExecutorProfile,
  type CloudflareSandboxExecutorEffects,
} from '../../src/executor/plugins/cloudflare-sandbox/cloudflare-sandbox-plugin.js';
import type { ExecutorIdentityProvider } from
  '../../src/executor/core/executor-identity-provider.js';
import { attemptApi } from '../../src/http/attempt-api.js';
import { AgentExecutorOutboxProcessor } from '../../src/outbox/agent-executor.js';
import { executorPatchArtifactId } from
  '../../src/storage/executor-patch-artifact-store.js';
import { ExecutorPublisherCredentialStore } from
  '../../src/storage/executor-publisher-credential-store.js';
import type {
  GitHubWriteCredentialProvider,
} from '../../src/storage/repo-write-credential-store.js';

const NOW = new Date('2026-08-17T05:00:00.000Z');
const ATTEMPT_ID = 'attempt-executor-patch';
const RUN_ID = 'run-executor-patch';
const PLAN_ID = 'plan-executor-patch';
const ITEM_ID = 'change';
const WORK_EXECUTION_ID = 'execution-executor-patch-work';
const PUBLISHER_EXECUTION_ID = 'execution-executor-patch-publisher';
const PATCH_ID = await executorPatchArtifactId(WORK_EXECUTION_ID);
const REPOSITORY = 'example/delivery-target';
const BASE_SHA = 'a'.repeat(40);
const PLAN_DIGEST = `sha256:${'b'.repeat(64)}`;
const RUNNER_TOKEN = 'executor-patch-short-runner-token';
const CALLBACK_TOKEN = 'executor-patch-callback-token';
const MODEL_PROFILE_ID = 'codex-gpt-5p6-terra-medium-tool-loop-20260811';
const MODEL_GRANT_ENCRYPTION_KEY = btoa('executor-model-grant-key-32bytes');

const workProfile = cloudflareSandboxExecutorProfile({
  profileId: 'cloudflare-executor-patch-work-v1',
  workerOrigin: 'https://agent-executor.example.test',
  imageRef: 'registry.example/work@sha256:immutable',
  releaseDigest: `sha256:${'c'.repeat(64)}`,
});

const publisherProfile = cloudflareSandboxExecutorProfile({
  profileId: 'cloudflare-executor-patch-publisher-v1',
  workerOrigin: 'https://agent-executor.example.test',
  imageRef: 'registry.example/publisher@sha256:immutable',
  releaseDigest: `sha256:${'d'.repeat(64)}`,
});

function workSpec(): FrozenExecutionSpec {
  return {
    schemaVersion: '1',
    executionId: WORK_EXECUTION_ID,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    leaseGeneration: 1,
    role: 'work',
    mode: 'implement',
    profile: workProfile,
    taskDigest: `sha256:${'e'.repeat(64)}`,
    repository: REPOSITORY,
    baseSha: BASE_SHA,
    checkoutSha: BASE_SHA,
    targetBaseBranch: 'main',
    controlPlaneUrl: 'https://control.example.test',
    planVersion: 1,
    planItemId: ITEM_ID,
    modelProfileId: MODEL_PROFILE_ID,
  };
}

const effects: CloudflareSandboxExecutorEffects = {
  async ensureSandbox(_origin, request) {
    return {
      disposition: 'created',
      sandboxId: `sandbox-${request.executionId}`,
      containerId: `container-${request.role}`,
    };
  },
  async observeSandbox() {
    throw new Error('patch test does not observe');
  },
  async cancelSandbox() {
    throw new Error('patch test does not cancel');
  },
  async verifySandboxIdentity() {
    throw new Error('patch test injects identity provider');
  },
};

const registry = new ExecutorPluginRegistry([
  new CloudflareSandboxExecutorPlugin(effects),
]);

function identityProvider(
  publisherExecutionId: () => string = () => PUBLISHER_EXECUTION_ID,
): ExecutorIdentityProvider {
  return {
    async verify(request): Promise<VerifiedExecutorIdentity> {
      const payload = request.payload as { authorization?: string; containerId?: string };
      if (
        payload.authorization !== `Bearer ${CALLBACK_TOKEN}` ||
        payload.containerId !== 'container-publisher' ||
        request.executionId !== publisherExecutionId()
      ) throw new Error('identity rejected');
      return {
        schemaVersion: '1',
        kind: 'cloudflare_sandbox',
        executionId: publisherExecutionId(),
        attemptId: ATTEMPT_ID,
        leaseGeneration: 1,
        role: 'publisher',
        repository: REPOSITORY,
        providerSubject: 'cloudflare-sandbox:container-publisher',
      };
    },
  };
}

const proposal = {
  schemaVersion: '1' as const,
  changes: [{
    path: 'src/executor.ts',
    baseDigest: null,
    content: 'export const executor = "cloudflare";\n',
  }],
};

async function clearBucket(): Promise<void> {
  const listed = await env.EXECUTOR_PATCH_OBJECTS.list();
  if (listed.objects.length > 0) {
    await env.EXECUTOR_PATCH_OBJECTS.delete(listed.objects.map((object) => object.key));
  }
}

async function reset(): Promise<void> {
  await clearBucket();
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare('DELETE FROM executor_publisher_write_credentials'),
    env.DB_CONTROL.prepare('DELETE FROM executor_patch_publications'),
    env.DB_CONTROL.prepare('DELETE FROM executor_patch_artifacts'),
    env.DB_CONTROL.prepare('DELETE FROM executor_cancellations'),
    env.DB_CONTROL.prepare('DELETE FROM executor_reconciliation_failures'),
    env.DB_CONTROL.prepare('DELETE FROM executor_observations'),
    env.DB_CONTROL.prepare('DELETE FROM executor_model_grants'),
    env.DB_CONTROL.prepare('DELETE FROM quota_model_reservations'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suite_commands'),
    env.DB_CONTROL.prepare('DELETE FROM verification_suites'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_head_updates'),
    env.DB_CONTROL.prepare('DELETE FROM evidence'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_tokens'),
    env.DB_CONTROL.prepare('DELETE FROM attempt_execution_instances'),
    env.DB_CONTROL.prepare('DELETE FROM outbox'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_command_refs'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_evidence_kinds'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_effects'),
    env.DB_CONTROL.prepare('DELETE FROM plan_item_progress'),
    env.DB_CONTROL.prepare('DELETE FROM plan_items'),
    env.DB_CONTROL.prepare('DELETE FROM execution_plans'),
    env.DB_CONTROL.prepare('DELETE FROM attempts'),
    env.DB_CONTROL.prepare('DELETE FROM executor_routes'),
    env.DB_CONTROL.prepare(
      `DELETE FROM executor_profiles WHERE profile_id <> 'legacy-github-actions-v1'`,
    ),
    env.DB_CONTROL.prepare('DELETE FROM runs'),
    env.DB_CONTROL.prepare('DELETE FROM tasks'),
  ]);
}

async function seed(): Promise<void> {
  const nowIso = NOW.toISOString();
  for (const profile of [workProfile, publisherProfile]) {
    const capabilities = registry.resolve(profile).capabilities(profile);
    await env.DB_CONTROL.prepare(
      `INSERT INTO executor_profiles (
         profile_id, schema_version, provider_kind, plugin_schema_version,
         release_digest, configuration_json, capabilities_json, status,
         created_at, activated_at
       ) VALUES (?, '1', ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).bind(
      profile.profileId,
      profile.kind,
      profile.pluginSchemaVersion,
      profile.releaseDigest,
      JSON.stringify(profile.configuration),
      JSON.stringify(capabilities),
      nowIso,
      nowIso,
    ).run();
  }
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO executor_routes (
         route_id, repository, attempt_mode, execution_role, profile_id,
         route_version, status, created_at, updated_at
       ) VALUES ('route-executor-patch-work', ?, 'implement', 'work', ?, 1,
                 'active', ?, ?)`,
    ).bind(REPOSITORY, workProfile.profileId, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO executor_routes (
         route_id, repository, attempt_mode, execution_role, profile_id,
         route_version, status, created_at, updated_at
       ) VALUES ('route-executor-patch-publisher', ?, 'implement', 'publisher', ?, 1,
                 'active', ?, ?)`,
    ).bind(REPOSITORY, publisherProfile.profileId, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO tasks (
         task_id, source_system, tenant_key, source_task_key, task_revision,
         task_digest, payload_ref, actor_type, actor_id, target_repository,
         target_base_branch, target_environment, intent_kind, title, priority,
         acceptance_criteria_count, allow_repository_write, allow_test_deploy,
         allow_production_deploy, require_human_approval, created_at, updated_at
       ) VALUES ('task-executor-patch', 'manual', 'executor-patch', 'executor-patch',
                 '1', ?, 'r2://tasks/executor-patch', 'system', 'executor-patch', ?,
                 'main', 'none', 'bug', 'Executor patch', 'p1', 1, 1, 0, 0, 1, ?, ?)`,
    ).bind(workSpec().taskDigest, REPOSITORY, nowIso, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO runs (
         run_id, task_id, task_revision, task_digest, base_sha,
         workflow_instance_id, state, version, active_plan_id,
         active_plan_version, active_plan_digest, created_at, updated_at
       ) VALUES (?, 'task-executor-patch', '1', ?, ?, ?, 'executing', 3,
                 ?, 1, ?, ?, ?)`,
    ).bind(
      RUN_ID,
      workSpec().taskDigest,
      BASE_SHA,
      RUN_ID,
      PLAN_ID,
      PLAN_DIGEST,
      nowIso,
      nowIso,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO attempts (
         attempt_id, run_id, ordinal, mode, status, base_sha, repository,
         plan_id, plan_version, plan_item_id, claimed_progress_version,
         version, lease_generation, lease_expires_at, heartbeat_at,
         executor_profile_id, executor_route_version, created_at, updated_at
       ) VALUES (?, ?, 1, 'implement', 'running', ?, ?, ?, 1, ?, 1,
                 2, 1, ?, ?, ?, 1, ?, ?)`,
    ).bind(
      ATTEMPT_ID,
      RUN_ID,
      BASE_SHA,
      REPOSITORY,
      PLAN_ID,
      ITEM_ID,
      '2026-08-17T05:10:00.000Z',
      nowIso,
      workProfile.profileId,
      nowIso,
      nowIso,
    ),
    env.DB_CONTROL.prepare(
      `INSERT INTO execution_plans (
         plan_id, run_id, plan_version, task_revision, base_sha, digest, status,
         created_by_attempt_id, objective, created_at, updated_at
       ) VALUES (?, ?, 1, '1', ?, ?, 'active', ?, 'Apply patch.', ?, ?)`,
    ).bind(PLAN_ID, RUN_ID, BASE_SHA, PLAN_DIGEST, ATTEMPT_ID, nowIso, nowIso),
  ]);
  await env.DB_CONTROL.batch([
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_items (plan_id, item_id, kind, title, objective, required, position)
       VALUES (?, ?, 'change', 'Apply patch', 'Apply exact patch.', 1, 0)`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_effects (plan_id, item_id, effect)
       VALUES (?, ?, 'repo_write')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
       VALUES (?, ?, 'test:unit')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_command_refs (plan_id, item_id, command_ref)
       VALUES (?, ?, 'verify:required')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_evidence_kinds (plan_id, item_id, evidence_kind)
       VALUES (?, ?, 'test')`,
    ).bind(PLAN_ID, ITEM_ID),
    env.DB_CONTROL.prepare(
      `INSERT INTO plan_item_progress (
         plan_id, item_id, status, active_attempt_id, version, updated_at
       ) VALUES (?, ?, 'in_progress', ?, 1, ?)`,
    ).bind(PLAN_ID, ITEM_ID, ATTEMPT_ID, nowIso),
    env.DB_CONTROL.prepare(
      `INSERT INTO outbox (
         outbox_id, run_id, kind, destination, payload_ref, dedupe_key,
         delivery_state, created_at, updated_at
       ) VALUES ('outbox-executor-patch-work', ?, 'agent_execution_start',
                 'agent_executor', ?, ?, 'settled', ?, ?)`,
    ).bind(
      RUN_ID,
      `d1://attempt-executions/${WORK_EXECUTION_ID}`,
      `agent-executor:${WORK_EXECUTION_ID}`,
      nowIso,
      nowIso,
    ),
  ]);
  const spec = workSpec();
  await env.DB_CONTROL.prepare(
    `INSERT INTO attempt_execution_instances (
       execution_id, attempt_id, attempt_version, lease_generation, execution_role,
       executor_profile_id, executor_route_version, spec_digest, spec_json,
       release_digest, provider_kind, plugin_schema_version, status,
       provider_external_id, validated_handle_json, outbox_id,
       created_at, started_at, updated_at
     ) VALUES (?, ?, 0, 1, 'work', ?, 1, ?, ?, ?, ?, ?, 'running',
               'sandbox-work', ?, 'outbox-executor-patch-work', ?, ?, ?)`,
  ).bind(
    WORK_EXECUTION_ID,
    ATTEMPT_ID,
    workProfile.profileId,
    await canonicalSha256(spec),
    JSON.stringify(spec),
    workProfile.releaseDigest,
    workProfile.kind,
    workProfile.pluginSchemaVersion,
    JSON.stringify({
      schemaVersion: '1',
      kind: workProfile.kind,
      pluginSchemaVersion: workProfile.pluginSchemaVersion,
      profileId: workProfile.profileId,
      releaseDigest: workProfile.releaseDigest,
      externalId: 'sandbox-work',
      executionId: WORK_EXECUTION_ID,
      attemptId: ATTEMPT_ID,
      leaseGeneration: 1,
      role: 'work',
      repository: REPOSITORY,
      attributes: { containerId: 'container-work' },
    }),
    nowIso,
    nowIso,
    nowIso,
  ).run();
  await env.DB_CONTROL.prepare(
    `INSERT INTO attempt_tokens (
       token_id, attempt_id, oidc_token_digest, token_digest, tool_token_digest,
       lease_generation, scopes_json, expires_at, created_at, identity_kind, execution_id
     ) VALUES ('token-executor-patch', ?, ?, ?, ?, 1, ?, ?, ?, 'executor', ?)`,
  ).bind(
    ATTEMPT_ID,
    `sha256:${'f'.repeat(64)}`,
    await canonicalSha256(RUNNER_TOKEN),
    `sha256:${'1'.repeat(64)}`,
    JSON.stringify(EXECUTION_TOOL_ACTIONS),
    '2026-08-17T05:10:00.000Z',
    nowIso,
    WORK_EXECUTION_ID,
  ).run();
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe('executor patch R2 handoff', () => {
  it('proxies only the live work execution repository through a contents-read credential', async () => {
    const upstreamRequests: Request[] = [];
    let upstreamAuthorization: string | null = null;
    const api = attemptApi({
      now: () => NOW,
      executorRepositoryTokenProvider: {
        async getBaseObservationToken(repository) {
          expect(repository).toBe(REPOSITORY);
          return 'repository-read-credential';
        },
      },
      githubGitOrigin: 'https://github.example.test',
      executorRepositoryFetch: async (input, init) => {
        upstreamAuthorization = new Headers(init?.headers).get('authorization');
        const request = new Request(input, init);
        upstreamRequests.push(request);
        return new Response(
          request.method === 'GET' ? '001e# service=git-upload-pack\n0000' : '0008NAK\n',
          {
            headers: {
              'content-type': request.method === 'GET'
                ? 'application/x-git-upload-pack-advertisement'
                : 'application/x-git-upload-pack-result',
            },
          },
        );
      },
    });
    const read = async (executionId = WORK_EXECUTION_ID, token = RUNNER_TOKEN) =>
      await api.fetch(new Request(
        `https://control.test/v1/attempts/${ATTEMPT_ID}/repository.git/info/refs?service=git-upload-pack`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            'git-protocol': 'version=2',
            'x-delivery-execution-id': executionId,
            'x-delivery-executor-container-id': 'container-work',
          },
        },
      ), env);
    const response = await read();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const responseBody = new TextDecoder().decode(await response.arrayBuffer());
    expect(responseBody).toContain('git-upload-pack');
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]!.url).toBe(
      'https://github.example.test/example/delivery-target.git/info/refs?service=git-upload-pack',
    );
    expect(String(upstreamAuthorization)).toMatch(/^Basic /);
    expect(String(upstreamAuthorization)).not.toContain(RUNNER_TOKEN);
    const upload = await api.fetch(new Request(
      `https://control.test/v1/attempts/${ATTEMPT_ID}/repository.git/git-upload-pack`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${RUNNER_TOKEN}`,
          'content-type': 'application/x-git-upload-pack-request',
          'git-protocol': 'version=2',
          'x-delivery-execution-id': WORK_EXECUTION_ID,
          'x-delivery-executor-container-id': 'container-work',
        },
        body: '0000',
      },
    ), env);
    expect(upload.status).toBe(200);
    expect(upstreamRequests[1]!.method).toBe('POST');
    expect(upstreamRequests[1]!.headers.get('authorization')).not.toBe(
      `Bearer ${RUNNER_TOKEN}`,
    );
    expect((await read('execution-other')).status).toBe(401);
    expect((await read(WORK_EXECUTION_ID, 'wrong-short-grant')).status).toBe(401);
    expect(upstreamRequests).toHaveLength(2);
  });

  it('converges 20 work uploads and only serves the frozen patch to its publisher', async () => {
    let expectedPublisherExecutionId = PUBLISHER_EXECUTION_ID;
    const api = attemptApi({
      executorPluginRegistry: registry,
      executorIdentityProvider: identityProvider(() => expectedPublisherExecutionId),
      now: () => NOW,
    });
    const uploadBody = {
      schemaVersion: '1',
      workExecutionId: WORK_EXECUTION_ID,
      expectedVersion: 2,
      leaseGeneration: 1,
      proposal,
    };
    const upload = async (body: unknown = uploadBody): Promise<Response> => await api.fetch(
      new Request(`https://control.test/v1/attempts/${ATTEMPT_ID}/executor-patches`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${RUNNER_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
      env,
    );
    const uploaded = await Promise.all(Array.from({ length: 20 }, async () => await upload()));
    expect(uploaded.filter((response) => response.status === 201)).toHaveLength(1);
    expect(uploaded.filter((response) => response.status === 200)).toHaveLength(19);
    const uploadResults = await Promise.all(uploaded.map(async (response) => await response.json<{
      patchDigest: string;
      changedPathsDigest: string;
      patchRef: string;
      publicationId: string;
      publisherExecutionId: string;
      publisherOutboxId: string;
      targetBranch: string;
    }>()));
    const uploadResult = uploadResults[0]!;
    expectedPublisherExecutionId = uploadResult.publisherExecutionId;
    expect(uploadResult).toMatchObject({
      patchRef: `r2://executor-patches/${PATCH_ID}`,
      targetBranch: 'agent/task-executor-patch/attempt-executor-patch',
    });
    expect((await env.EXECUTOR_PATCH_OBJECTS.list()).objects).toHaveLength(1);
    expect(await env.DB_CONTROL.prepare(
      `SELECT patch_digest, changed_paths_digest, patch_ref, status
       FROM executor_patch_artifacts WHERE patch_id = ?`,
    ).bind(PATCH_ID).first()).toEqual({
      patch_digest: uploadResult.patchDigest,
      changed_paths_digest: uploadResult.changedPathsDigest,
      patch_ref: `r2://executor-patches/${PATCH_ID}`,
      status: 'prepared',
    });
    expect(new Set(uploadResults.map((result) => result.publisherExecutionId)))
      .toEqual(new Set([uploadResult.publisherExecutionId]));
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM executor_patch_publications`,
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempt_execution_instances
       WHERE execution_role = 'publisher'`,
    ).first()).toEqual({ count: 1 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE destination = 'agent_executor'
       AND payload_ref = ?`,
    ).bind(`d1://attempt-executions/${uploadResult.publisherExecutionId}`).first())
      .toEqual({ count: 1 });
    await new AgentExecutorOutboxProcessor(env.DB_CONTROL, registry, {
      now: () => NOW,
      generateLeaseToken: () => crypto.randomUUID(),
    }).deliver(uploadResult.publisherOutboxId);

    const download = async (authorization = `Bearer ${CALLBACK_TOKEN}`): Promise<Response> =>
      await api.fetch(new Request(
        `https://control.test/v1/attempts/${ATTEMPT_ID}/executor-patches/${PATCH_ID}`,
        {
          headers: {
            authorization,
            'x-delivery-execution-id': uploadResult.publisherExecutionId,
            'x-delivery-executor-container-id': 'container-publisher',
          },
        },
      ), env);
    const downloaded = await download();
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('cache-control')).toBe('no-store');
    await expect(downloaded.json()).resolves.toMatchObject({
      schemaVersion: '1',
      patchId: PATCH_ID,
      publisherExecutionId: uploadResult.publisherExecutionId,
      repository: REPOSITORY,
      checkoutSha: BASE_SHA,
      targetBranch: 'agent/task-executor-patch/attempt-executor-patch',
      patchDigest: uploadResult.patchDigest,
      proposal,
    });
    const forged = await download('Bearer wrong-callback-value');
    expect(forged.status).toBe(401);
    expect(await forged.text()).not.toContain('wrong-callback-value');
  });

  it('rolls back every D1 publication record when the publisher route is unavailable', async () => {
    await env.DB_CONTROL.prepare(
      `UPDATE executor_routes SET status = 'disabled'
       WHERE repository = ? AND attempt_mode = 'implement'
         AND execution_role = 'publisher'`,
    ).bind(REPOSITORY).run();
    const api = attemptApi({ executorPluginRegistry: registry, now: () => NOW });
    const response = await api.fetch(new Request(
      `https://control.test/v1/attempts/${ATTEMPT_ID}/executor-patches`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${RUNNER_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          schemaVersion: '1',
          workExecutionId: WORK_EXECUTION_ID,
          expectedVersion: 2,
          leaseGeneration: 1,
          proposal,
        }),
      },
    ), env);
    expect(response.status).toBe(409);
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM executor_patch_artifacts`,
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM executor_patch_publications`,
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM attempt_execution_instances
       WHERE execution_role = 'publisher'`,
    ).first()).toEqual({ count: 0 });
    expect(await env.DB_CONTROL.prepare(
      `SELECT COUNT(*) AS count FROM outbox
       WHERE payload_ref LIKE 'd1://attempt-executions/execution-publisher-%'`,
    ).first()).toEqual({ count: 0 });
  });

  it('issues one encrypted publisher-only branch authority and revokes it after use', async () => {
    let expectedPublisherExecutionId = PUBLISHER_EXECUTION_ID;
    const api = attemptApi({
      executorPluginRegistry: registry,
      executorIdentityProvider: identityProvider(() => expectedPublisherExecutionId),
      now: () => NOW,
    });
    const uploaded = await api.fetch(new Request(
      `https://control.test/v1/attempts/${ATTEMPT_ID}/executor-patches`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${RUNNER_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          schemaVersion: '1',
          workExecutionId: WORK_EXECUTION_ID,
          expectedVersion: 2,
          leaseGeneration: 1,
          proposal,
        }),
      },
    ), env);
    const scheduled = await uploaded.json<{
      publicationId: string;
      publisherExecutionId: string;
      publisherOutboxId: string;
      targetBranch: string;
    }>();
    expectedPublisherExecutionId = scheduled.publisherExecutionId;
    await new AgentExecutorOutboxProcessor(env.DB_CONTROL, registry, {
      now: () => NOW,
    }).deliver(scheduled.publisherOutboxId);
    await env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version,
         plan_digest, base_sha, effect, actor_id, decision, nonce_digest,
         expires_at, created_at
       ) VALUES ('approval-publisher', ?, '1', ?, 1, ?, ?, 'repo_write',
                 'user:approver', 'approve', ?, '2026-08-17T05:09:00.000Z', ?)`,
    ).bind(
      RUN_ID,
      PLAN_ID,
      PLAN_DIGEST,
      BASE_SHA,
      `sha256:${'6'.repeat(64)}`,
      NOW.toISOString(),
    ).run();
    const issuedTokens: string[] = [];
    const revokedTokens: string[] = [];
    const provider: GitHubWriteCredentialProvider = {
      async issueWriteCredential(repository) {
        expect(repository).toBe(REPOSITORY);
        issuedTokens.push('publisher-github-token');
        return {
          token: 'publisher-github-token',
          expiresAt: '2026-08-17T05:08:00.000Z',
        };
      },
      async revokeWriteCredential(token) { revokedTokens.push(token); },
    };
    const store = new ExecutorPublisherCredentialStore(env.DB_CONTROL, provider, {
      encryptionKey: btoa('0123456789abcdef0123456789abcdef'),
      generateLeaseToken: () => 'publisher-issue-lease',
    });
    const identity: VerifiedExecutorIdentity = {
      schemaVersion: '1',
      kind: 'cloudflare_sandbox',
      executionId: scheduled.publisherExecutionId,
      attemptId: ATTEMPT_ID,
      leaseGeneration: 1,
      role: 'publisher',
      repository: REPOSITORY,
      providerSubject: 'cloudflare-sandbox:container-publisher',
    };
    // A provider-reference (PAT) provider must issue a publisher credential the
    // same way the App path does: mint the reference token, persist it
    // encrypted, and let the push proxy authorize with it. The credential-free
    // work lane already supports PAT this way, and the publisher lane must too
    // or a PAT-configured deployment can never open a pull request.
    let providerReferenceIssued = 0;
    const providerReferenceStore = new ExecutorPublisherCredentialStore(env.DB_CONTROL, {
      writeCredentialPersistence: 'provider_reference',
      async issueWriteCredential(repository) {
        expect(repository).toBe(REPOSITORY);
        providerReferenceIssued += 1;
        return { token: 'publisher-pat-reference', expiresAt: '2026-08-17T05:08:00.000Z' };
      },
      async revokeWriteCredential() { /* PAT reference is not revocable */ },
    }, {
      encryptionKey: btoa('0123456789abcdef0123456789abcdef'),
      generateLeaseToken: () => 'publisher-pat-lease',
    });
    const referenceCredential = await providerReferenceStore.issue(
      identity, scheduled.publicationId, NOW,
    );
    expect(referenceCredential).toMatchObject({
      created: true,
      token: 'publisher-pat-reference',
      targetBranch: scheduled.targetBranch,
      publisherExecutionId: scheduled.publisherExecutionId,
    });
    expect(providerReferenceIssued).toBe(1);
    await expect(providerReferenceStore.authorizePush({
      attemptId: ATTEMPT_ID,
      publisherExecutionId: scheduled.publisherExecutionId,
      rawToken: 'publisher-pat-reference',
      now: NOW,
    })).resolves.toMatchObject({ repository: REPOSITORY, targetBranch: scheduled.targetBranch });
    // The persisted reference must never store the raw token in plaintext.
    expect(JSON.stringify(await env.DB_CONTROL.prepare(
      `SELECT token_digest, token_ciphertext, token_iv
       FROM executor_publisher_write_credentials`,
    ).first())).not.toContain('publisher-pat-reference');
    // Clean up so the App-path assertions below start from an empty table.
    await providerReferenceStore.revoke(
      scheduled.publicationId, scheduled.publisherExecutionId, NOW,
    );
    await env.DB_CONTROL.prepare(
      `DELETE FROM executor_publisher_write_credentials`,
    ).run();
    const settled = await Promise.allSettled(Array.from({ length: 20 }, async () =>
      await store.issue(identity, scheduled.publicationId, NOW)));
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(issuedTokens).toEqual(['publisher-github-token']);
    const replayed = await store.issue(identity, scheduled.publicationId, NOW);
    expect(replayed).toMatchObject({
      created: false,
      token: 'publisher-github-token',
      targetBranch: scheduled.targetBranch,
      publisherExecutionId: scheduled.publisherExecutionId,
    });
    expect(JSON.stringify(await env.DB_CONTROL.prepare(
      `SELECT token_digest, token_ciphertext, token_iv
       FROM executor_publisher_write_credentials`,
    ).first())).not.toContain('publisher-github-token');
    await expect(store.authorizePush({
      attemptId: ATTEMPT_ID,
      publisherExecutionId: scheduled.publisherExecutionId,
      rawToken: 'publisher-github-token',
      now: NOW,
    })).resolves.toEqual({
      repository: REPOSITORY,
      checkoutSha: BASE_SHA,
      targetBranch: scheduled.targetBranch,
      targetBranchMode: 'new',
    });
    await store.revoke(scheduled.publicationId, scheduled.publisherExecutionId, NOW);
    expect(revokedTokens).toEqual(['publisher-github-token']);
    await expect(store.authorizePush({
      attemptId: ATTEMPT_ID,
      publisherExecutionId: scheduled.publisherExecutionId,
      rawToken: 'publisher-github-token',
      now: NOW,
    })).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('proxies only the frozen publisher branch and completes from exact head Evidence', async () => {
    let expectedPublisherExecutionId = PUBLISHER_EXECUTION_ID;
    const issuedTokens: string[] = [];
    const revokedTokens: string[] = [];
    const upstream: Request[] = [];
    const provider: GitHubWriteCredentialProvider = {
      async issueWriteCredential(repository) {
        expect(repository).toBe(REPOSITORY);
        issuedTokens.push('publisher-http-token');
        return { token: 'publisher-http-token', expiresAt: '2026-08-17T05:08:00.000Z' };
      },
      async revokeWriteCredential(token) { revokedTokens.push(token); },
    };
    const api = attemptApi({
      executorPluginRegistry: registry,
      executorIdentityProvider: identityProvider(() => expectedPublisherExecutionId),
      executorRepositoryTokenProvider: {
        async getBaseObservationToken(repository) {
          expect(repository).toBe(REPOSITORY);
          return 'publisher-read-token';
        },
      },
      repoWriteCredentialRuntime: {
        provider,
        encryptionKey: btoa('0123456789abcdef0123456789abcdef'),
      },
      githubGitOrigin: 'https://github.example.test',
      executorRepositoryFetch: async (input, init) => {
        const request = new Request(input, init);
        upstream.push(request);
        const receive = request.url.includes('git-receive-pack');
        const advertisement = request.method === 'GET';
        return new Response(advertisement ? '001e# service=git\n0000' : '0008NAK\n', {
          headers: {
            'content-type': `application/x-git-${receive ? 'receive' : 'upload'}-pack-${
              advertisement ? 'advertisement' : 'result'
            }`,
          },
        });
      },
      now: () => NOW,
    });
    const uploaded = await api.fetch(new Request(
      `https://control.test/v1/attempts/${ATTEMPT_ID}/executor-patches`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNNER_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: '1',
          workExecutionId: WORK_EXECUTION_ID,
          expectedVersion: 2,
          leaseGeneration: 1,
          proposal,
        }),
      },
    ), env);
    const scheduled = await uploaded.json<{
      publicationId: string;
      publisherExecutionId: string;
      publisherOutboxId: string;
      targetBranch: string;
    }>();
    expectedPublisherExecutionId = scheduled.publisherExecutionId;
    await new AgentExecutorOutboxProcessor(env.DB_CONTROL, registry, { now: () => NOW })
      .deliver(scheduled.publisherOutboxId);
    await env.DB_CONTROL.prepare(
      `INSERT INTO approvals (
         approval_id, run_id, task_revision, plan_id, plan_version,
         plan_digest, base_sha, effect, actor_id, decision, nonce_digest,
         expires_at, created_at
       ) VALUES ('approval-publisher-http', ?, '1', ?, 1, ?, ?, 'repo_write',
                 'user:approver', 'approve', ?, '2026-08-17T05:09:00.000Z', ?)`,
    ).bind(
      RUN_ID, PLAN_ID, PLAN_DIGEST, BASE_SHA, `sha256:${'8'.repeat(64)}`, NOW.toISOString(),
    ).run();
    const callbackHeaders = {
      authorization: `Bearer ${CALLBACK_TOKEN}`,
      'content-type': 'application/json',
      'x-delivery-execution-id': scheduled.publisherExecutionId,
      'x-delivery-executor-container-id': 'container-publisher',
    };
    const credentialResponse = await api.fetch(new Request(
      `https://control.test/v1/attempts/${ATTEMPT_ID}/executor-publisher/write-token`,
      {
        method: 'POST',
        headers: callbackHeaders,
        body: JSON.stringify({ publicationId: scheduled.publicationId }),
      },
    ), env);
    expect(credentialResponse.status).toBe(201);
    const credential = await credentialResponse.json<{ token: string }>();
    expect(credential.token).toBe('publisher-http-token');
    expect(issuedTokens).toEqual(['publisher-http-token']);

    const read = await api.fetch(new Request(
      `https://control.test/v1/attempts/${ATTEMPT_ID}/executor-publisher/repository.git/` +
        'info/refs?service=git-upload-pack',
      { headers: { ...callbackHeaders, 'git-protocol': 'version=2' } },
    ), env);
    expect(read.status).toBe(200);
    const basic = `Basic ${btoa(`x-access-token:${credential.token}`)}`;
    const advertisement = await api.fetch(new Request(
      `https://control.test/v1/attempts/${ATTEMPT_ID}/executor-publisher/repository.git/` +
        'info/refs?service=git-receive-pack',
      {
        headers: {
          authorization: basic,
          'x-delivery-execution-id': scheduled.publisherExecutionId,
        },
      },
    ), env);
    expect(advertisement.status).toBe(200);
    const headSha = 'c'.repeat(40);
    const command = `${'0'.repeat(40)} ${headSha} refs/heads/${scheduled.targetBranch}` +
      '\0report-status\n';
    const packet = `${(Buffer.byteLength(command) + 4).toString(16).padStart(4, '0')}${command}` +
      '0000PACK';
    const pushed = await api.fetch(new Request(
      `https://control.test/v1/attempts/${ATTEMPT_ID}/executor-publisher/repository.git/` +
        'git-receive-pack',
      {
        method: 'POST',
        headers: {
          authorization: basic,
          'content-type': 'application/x-git-receive-pack-request',
          'x-delivery-execution-id': scheduled.publisherExecutionId,
        },
        body: packet,
      },
    ), env);
    expect(pushed.status).toBe(200);
    expect(upstream).toHaveLength(3);
    expect(upstream[0]!.headers.get('authorization')).not.toContain('publisher-http-token');
    expect(upstream[1]!.headers.get('authorization')).toBe(basic);
    expect(upstream[2]!.headers.get('authorization')).toBe(basic);
    // A shallow (`--depth=1`) checkout prefixes its push with one or more
    // `shallow <oid>` pkt-lines before the ref-update command. The proxy must
    // skip them and still accept the single authorized branch update.
    const shallowLine = `shallow ${'d'.repeat(40)}\n`;
    const shallowPacket =
      `${(Buffer.byteLength(shallowLine) + 4).toString(16).padStart(4, '0')}${shallowLine}` +
      `${(Buffer.byteLength(command) + 4).toString(16).padStart(4, '0')}${command}` +
      '0000PACK';
    const shallowPush = await api.fetch(new Request(
      `https://control.test/v1/attempts/${ATTEMPT_ID}/executor-publisher/repository.git/` +
        'git-receive-pack',
      {
        method: 'POST',
        headers: {
          authorization: basic,
          'content-type': 'application/x-git-receive-pack-request',
          'x-delivery-execution-id': scheduled.publisherExecutionId,
        },
        body: shallowPacket,
      },
    ), env);
    expect(shallowPush.status).toBe(200);
    const wrongBranch = packet.replace(
      `refs/heads/${scheduled.targetBranch}`,
      'refs/heads/agent/other/branch',
    );
    const rejectedPush = await api.fetch(new Request(
      `https://control.test/v1/attempts/${ATTEMPT_ID}/executor-publisher/repository.git/` +
        'git-receive-pack',
      {
        method: 'POST',
        headers: {
          authorization: basic,
          'content-type': 'application/x-git-receive-pack-request',
          'x-delivery-execution-id': scheduled.publisherExecutionId,
        },
        body: wrongBranch,
      },
    ), env);
    expect(rejectedPush.status).toBe(400);
    // 3 original forwards + the shallow-prefixed push (the wrong-branch push is
    // rejected before any upstream forward).
    expect(upstream).toHaveLength(4);

    const head = await api.fetch(new Request(
      `https://control.test/v1/attempts/${ATTEMPT_ID}/executor-publisher/head`,
      {
        method: 'POST',
        headers: callbackHeaders,
        body: JSON.stringify({
          publicationId: scheduled.publicationId,
          parentSha: BASE_SHA,
          headSha,
          branch: scheduled.targetBranch,
        }),
      },
    ), env);
    expect(head.status).toBe(201);
    const manifest = {
      schemaVersion: '1',
      headSha,
      policyDigest: `sha256:${'9'.repeat(64)}`,
      targetedCommandRefs: ['test:unit'],
      requiredVerifyCommandRefs: ['verify:required'],
    };
    const suiteResponse = await api.fetch(new Request(
      `https://control.test/v1/attempts/${ATTEMPT_ID}/executor-publisher/verifications`,
      {
        method: 'POST',
        headers: callbackHeaders,
        body: JSON.stringify({ publicationId: scheduled.publicationId, manifest }),
      },
    ), env);
    expect(suiteResponse.status).toBe(201);
    const suite = await suiteResponse.json<{ suiteId: string }>();
    const evidenceIds: string[] = [];
    for (const result of [
      { position: 0, phase: 'targeted', commandRef: 'test:unit' },
      { position: 1, phase: 'required_verify', commandRef: 'verify:required' },
    ] as const) {
      const response = await api.fetch(new Request(
        `https://control.test/v1/attempts/${ATTEMPT_ID}/executor-publisher/verifications/` +
          `${suite.suiteId}/results`,
        {
          method: 'POST',
          headers: callbackHeaders,
          body: JSON.stringify({
            publicationId: scheduled.publicationId,
            result: { schemaVersion: '1', ...result, exitCode: 0, durationMs: 10, headSha },
          }),
        },
      ), env);
      expect(response.status).toBe(201);
      evidenceIds.push((await response.json<{ evidenceId: string }>()).evidenceId);
    }
    const completionBody = JSON.stringify({
      publicationId: scheduled.publicationId,
      recomputedPatchDigest: (await env.DB_CONTROL.prepare(
        `SELECT expected_patch_digest FROM executor_patch_publications WHERE publication_id = ?`,
      ).bind(scheduled.publicationId).first<{ expected_patch_digest: string }>())!
        .expected_patch_digest,
      headSha,
      branch: scheduled.targetBranch,
      suiteId: suite.suiteId,
      evidenceIds,
    });
    const complete = async (): Promise<Response> => await api.fetch(new Request(
      `https://control.test/v1/attempts/${ATTEMPT_ID}/executor-publisher/complete`,
      { method: 'POST', headers: callbackHeaders, body: completionBody },
    ), env);
    expect((await complete()).status).toBe(200);
    expect((await complete()).status).toBe(200);
    expect(revokedTokens).toEqual(['publisher-http-token']);
    const afterCompletion = await api.fetch(new Request(
      `https://control.test/v1/attempts/${ATTEMPT_ID}/executor-publisher/repository.git/` +
        'info/refs?service=git-receive-pack',
      {
        headers: {
          authorization: basic,
          'x-delivery-execution-id': scheduled.publisherExecutionId,
        },
      },
    ), env);
    expect(afterCompletion.status).toBe(403);
    expect(await env.DB_CONTROL.prepare(
      `SELECT status, head_sha FROM executor_patch_publications WHERE publication_id = ?`,
    ).bind(scheduled.publicationId).first()).toEqual({ status: 'published', head_sha: headSha });
    expect(await env.DB_CONTROL.prepare(
      `SELECT status FROM attempt_execution_instances WHERE execution_id = ?`,
    ).bind(scheduled.publisherExecutionId).first()).toEqual({ status: 'succeeded' });
  });

  it('relays only the D1-reserved exact model without exposing provider credentials', async () => {
    await env.DB_CONTROL.prepare(
      `INSERT INTO quota_model_reservations (
         reservation_id, attempt_id, run_id, profile_id, reserved_tokens,
         reserved_cost_microusd, override_id, status, expires_at, usage_id,
         created_at, updated_at
       ) VALUES ('model-reservation-executor', ?, ?, ?, 2040000, 5600000,
                 NULL, 'reserved', '2026-08-17T05:05:00.000Z', NULL, ?, ?)`,
    ).bind(ATTEMPT_ID, RUN_ID, MODEL_PROFILE_ID, NOW.toISOString(), NOW.toISOString()).run();
    const upstream: Request[] = [];
    let rejectProvider = false;
    const api = attemptApi({
      executorModelGrantEncryptionKey: MODEL_GRANT_ENCRYPTION_KEY,
      executorModelProxyRuntime: {
        provider: 'delivery_loop_relay',
        baseUrl: 'https://relay.example.test/v1',
        upstreamModel: 'openai/gpt-5.6-terra',
        apiKey: 'provider-model-canary-value',
        fetch: async (input, init) => {
          const request = new Request(input, init);
          upstream.push(request);
          if (rejectProvider) return new Response('RAW_PROVIDER_CANARY', { status: 401 });
          return new Response('data: {"type":"response.completed"}\n\n', {
            headers: { 'content-type': 'text/event-stream; charset=utf-8' },
          });
        },
      },
      now: () => NOW,
    });
    const issueGrant = async () => await api.fetch(new Request(
      `https://control.test/v1/attempts/${ATTEMPT_ID}/executor-model/grants`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${RUNNER_TOKEN}`,
          'content-type': 'application/json',
          'x-delivery-execution-id': WORK_EXECUTION_ID,
          'x-delivery-executor-container-id': 'container-work',
        },
        body: JSON.stringify({
          executionId: WORK_EXECUTION_ID,
          reservationId: 'model-reservation-executor',
          expectedVersion: 2,
          leaseGeneration: 1,
        }),
      },
    ), env);
    const issued = await Promise.all(Array.from({ length: 20 }, async () => {
      const response = await issueGrant();
      expect([200, 201]).toContain(response.status);
      return await response.json<{
        grantId: string;
        reservationId: string;
        token: string;
        expiresAt: string;
        created: boolean;
      }>();
    }));
    expect(new Set(issued.map((grant) => grant.token)).size).toBe(1);
    expect(issued.filter((grant) => grant.created)).toHaveLength(1);
    const grantToken = issued[0]!.token;
    const storedGrant = await env.DB_CONTROL.prepare(
      `SELECT token_digest, token_ciphertext, token_iv FROM executor_model_grants`,
    ).first<{ token_digest: string; token_ciphertext: string; token_iv: string }>();
    expect(storedGrant).not.toBeNull();
    expect(JSON.stringify(storedGrant)).not.toContain(grantToken);

    const invoke = async (body: unknown, authorization = `Bearer ${grantToken}`) =>
      await api.fetch(new Request(
        `https://control.test/v1/attempts/${ATTEMPT_ID}/executor-model/v1/responses`,
        {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json',
            'x-delivery-execution-id': WORK_EXECUTION_ID,
            'x-delivery-executor-container-id': 'container-work',
          },
          body: JSON.stringify(body),
        },
      ), env);
    const accepted = await invoke({
      model: 'gpt-5.6-terra',
      stream: true,
      input: [{ role: 'user', content: 'bounded prompt' }],
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('content-type')).toBe('text/event-stream');
    expect(await accepted.text()).toContain('response.completed');
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url).toBe('https://relay.example.test/v1/responses');
    expect(upstream[0]!.headers.get('authorization'))
      .toBe('Bearer provider-model-canary-value');
    await expect(upstream[0]!.clone().json()).resolves.toMatchObject({
      model: 'openai/gpt-5.6-terra',
      stream: true,
    });
    expect((await invoke({
      model: 'gpt-5.6-sol',
      stream: true,
      input: [],
    })).status).toBe(403);
    expect(upstream).toHaveLength(1);
    expect((await invoke({
      model: 'gpt-5.6-terra',
      stream: true,
      input: [],
    }, 'Bearer wrong-model-grant-token')).status).toBe(401);
    expect((await invoke({
      model: 'gpt-5.6-terra',
      stream: true,
      input: [],
    }, `Bearer ${RUNNER_TOKEN}`)).status).toBe(401);
    expect((await invoke({
      model: 'gpt-5.6-terra',
      stream: true,
      input: [],
    }, `Bearer ${CALLBACK_TOKEN}`)).status).toBe(401);
    rejectProvider = true;
    const rejected = await invoke({ model: 'gpt-5.6-terra', stream: true, input: [] });
    expect(rejected.status).toBe(502);
    const rejectedBody = await rejected.text();
    expect(rejectedBody).not.toContain('RAW_PROVIDER_CANARY');
    expect(rejectedBody).not.toContain('provider-model-canary-value');
    rejectProvider = false;
    const settlement = await api.fetch(new Request(
      `https://control.test/v1/attempts/${ATTEMPT_ID}/model-usage`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${RUNNER_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          reservationId: 'model-reservation-executor',
          usageId: 'model-usage-executor',
          expectedVersion: 2,
          leaseGeneration: 1,
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 0,
        }),
      },
    ), env);
    expect(settlement.status).toBe(201);
    expect((await invoke({
      model: 'gpt-5.6-terra',
      stream: true,
      input: [],
    })).status).toBe(401);
  });

  it('rejects wrong execution, Secrets, oversized bodies, and tampered R2 objects', async () => {
    let expectedPublisherExecutionId = PUBLISHER_EXECUTION_ID;
    const api = attemptApi({
      executorPluginRegistry: registry,
      executorIdentityProvider: identityProvider(() => expectedPublisherExecutionId),
      now: () => NOW,
    });
    const invoke = async (body: unknown): Promise<Response> => await api.fetch(new Request(
      `https://control.test/v1/attempts/${ATTEMPT_ID}/executor-patches`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${RUNNER_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    ), env);
    const base = {
      schemaVersion: '1',
      workExecutionId: WORK_EXECUTION_ID,
      expectedVersion: 2,
      leaseGeneration: 1,
      proposal,
    };
    expect((await invoke({ ...base, workExecutionId: 'execution-other' })).status).toBe(409);
    expect((await invoke({
      ...base,
      proposal: {
        ...proposal,
        changes: [{ ...proposal.changes[0], content: 'test-operations-token' }],
      },
    })).status).toBe(403);
    expect((await invoke({
      ...base,
      proposal: {
        ...proposal,
        changes: [{ ...proposal.changes[0], content: 'x'.repeat(1_100_001) }],
      },
    })).status).toBe(400);
    expect((await env.EXECUTOR_PATCH_OBJECTS.list()).objects).toHaveLength(0);

    const accepted = await invoke(base);
    expect(accepted.status).toBe(201);
    const acceptedResult = await accepted.json<{
      publisherExecutionId: string;
      publisherOutboxId: string;
    }>();
    expectedPublisherExecutionId = acceptedResult.publisherExecutionId;
    expect((await invoke({
      ...base,
      proposal: {
        ...proposal,
        changes: [{ ...proposal.changes[0], content: 'export const executor = "e2b";\n' }],
      },
    })).status).toBe(409);
    expect((await env.EXECUTOR_PATCH_OBJECTS.list()).objects).toHaveLength(1);
    const object = await env.EXECUTOR_PATCH_OBJECTS.get(`executor-patches/${PATCH_ID}`);
    if (object === null || object.customMetadata === undefined) {
      throw new Error('patch object missing');
    }
    await env.EXECUTOR_PATCH_OBJECTS.put(`executor-patches/${PATCH_ID}`, '{}', {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: object.customMetadata,
    });
    await new AgentExecutorOutboxProcessor(env.DB_CONTROL, registry, {
      now: () => NOW,
    }).deliver(acceptedResult.publisherOutboxId);
    const response = await api.fetch(new Request(
      `https://control.test/v1/attempts/${ATTEMPT_ID}/executor-patches/${PATCH_ID}`,
      {
        headers: {
          authorization: `Bearer ${CALLBACK_TOKEN}`,
          'x-delivery-execution-id': acceptedResult.publisherExecutionId,
          'x-delivery-executor-container-id': 'container-publisher',
        },
      },
    ), env);
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('export const executor');
  });
});
