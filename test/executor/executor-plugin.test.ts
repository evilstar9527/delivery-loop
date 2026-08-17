import { describe, expect, it } from 'vitest';
import {
  ExecutorPluginRegistry,
  type ExecutorPlugin,
} from '../../src/executor/core/executor-registry.js';
import type {
  ExecutionFact,
  ExecutionHandle,
  ExecutorIdentityAssertion,
  ExecutorProfile,
  FrozenExecutionSpec,
  ProviderEvidence,
  VerifiedExecutorIdentity,
} from '../../src/executor/core/executor-plugin.js';
import {
  GitHubActionsExecutorPlugin,
  githubActionsExecutorProfile,
  type GitHubActionsExecutorEffects,
} from '../../src/executor/plugins/github-actions/github-actions-plugin.js';
import {
  CloudflareSandboxExecutorPlugin,
  cloudflareSandboxExecutorProfile,
  type CloudflareSandboxExecutorEffects,
} from '../../src/executor/plugins/cloudflare-sandbox/cloudflare-sandbox-plugin.js';

const SHA = 'a'.repeat(40);
const RELEASE_DIGEST = `sha256:${'b'.repeat(64)}`;

function profile(): ExecutorProfile {
  return githubActionsExecutorProfile({
    profileId: 'github-actions-v1',
    executorRepository: 'control/executor',
    executorRef: 'refs/heads/main',
    releaseDigest: RELEASE_DIGEST,
  });
}

function spec(overrides: Partial<FrozenExecutionSpec> = {}): FrozenExecutionSpec {
  return {
    schemaVersion: '1',
    executionId: 'execution-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    leaseGeneration: 3,
    role: 'work',
    mode: 'implement',
    profile: profile(),
    taskDigest: `sha256:${'c'.repeat(64)}`,
    repository: 'business/repository',
    baseSha: SHA,
    checkoutSha: SHA,
    targetBaseBranch: 'main',
    controlPlaneUrl: 'https://control.example.test',
    planVersion: 2,
    planItemId: 'change',
    modelProfileId: 'codex-profile-1',
    dispatchGeneration: 1,
    ...overrides,
  };
}

class FakeGitHubEffects implements GitHubActionsExecutorEffects {
  readonly requests: unknown[] = [];
  readonly cancellations: string[] = [];

  async ensureDispatch(request: unknown) {
    this.requests.push(request);
    return {
      disposition: this.requests.length === 1 ? 'created' as const : 'existing' as const,
      githubRunId: '123456789',
      githubHeadSha: SHA,
    };
  }

  async getWorkflowRun() {
    return {
      repository: 'control/executor',
      githubRunId: '123456789',
      event: 'workflow_dispatch' as const,
      status: 'completed' as const,
      conclusion: 'success',
      headSha: SHA,
      headBranch: 'main',
      workflowPath: '.github/workflows/delivery-agent.yml',
      displayTitle: 'delivery-loop/attempt-1/redispatch-1',
      runAttempt: 1,
      externalUpdatedAt: '2026-08-14T01:00:00.000Z',
    };
  }

  async cancelWorkflowRun(_repository: string, githubRunId: string) {
    this.cancellations.push(githubRunId);
    return 'cancelled' as const;
  }

  async verifyExecutorIdentity(
    _profile: ExecutorProfile,
    handle: ExecutionHandle,
    payload: unknown,
  ): Promise<VerifiedExecutorIdentity> {
    expect(payload).toEqual({ oidc: 'transient-test-assertion' });
    return {
      schemaVersion: '1',
      kind: 'github_actions',
      executionId: handle.executionId,
      attemptId: handle.attemptId,
      leaseGeneration: handle.leaseGeneration,
      role: handle.role,
      repository: handle.repository,
      providerSubject: 'repo:control/executor:ref:refs/heads/main',
    };
  }
}

describe('executor plugin contract', () => {
  it('maps a frozen provider-neutral spec to an idempotent GitHub Actions start', async () => {
    const effects = new FakeGitHubEffects();
    const registry = new ExecutorPluginRegistry([
      new GitHubActionsExecutorPlugin(effects),
    ]);

    const first = await registry.ensureStarted(spec());
    const second = await registry.ensureStarted(spec());

    expect(first.disposition).toBe('created');
    expect(second.disposition).toBe('existing');
    expect(first.handle).toMatchObject({
      kind: 'github_actions',
      externalId: '123456789',
      executionId: 'execution-1',
      attemptId: 'attempt-1',
      leaseGeneration: 3,
      repository: 'business/repository',
      attributes: {
        executorHeadSha: SHA,
        workflowRef:
          'control/executor/.github/workflows/delivery-agent.yml@refs/heads/main',
      },
    });
    expect(effects.requests).toEqual([
      expect.objectContaining({
        repository: 'control/executor',
        workflowFile: '.github/workflows/delivery-agent.yml',
        ref: 'refs/heads/main',
        inputs: {
          schema_version: '1',
          run_id: 'run-1',
          attempt_id: 'attempt-1',
          task_digest: `sha256:${'c'.repeat(64)}`,
          base_sha: SHA,
          checkout_sha: SHA,
          target_repository: 'business/repository',
          control_plane_url: 'https://control.example.test',
          mode: 'implement',
          model_profile_id: 'codex-profile-1',
          dispatch_generation: '1',
          plan_version: '2',
          plan_item_id: 'change',
        },
      }),
      expect.anything(),
    ]);
  });

  it('normalizes observe, cancel, identity, and provider evidence behind one contract', async () => {
    const effects = new FakeGitHubEffects();
    const registry = new ExecutorPluginRegistry([
      new GitHubActionsExecutorPlugin(effects),
    ]);
    const handle = (await registry.ensureStarted(spec())).handle;

    await expect(registry.observe(handle)).resolves.toMatchObject({
      status: 'succeeded',
      externalId: '123456789',
      externalUpdatedAt: '2026-08-14T01:00:00.000Z',
    });
    await expect(registry.cancel(handle, 'lease_expired')).resolves.toBe('cancelled');
    expect(effects.cancellations).toEqual(['123456789']);

    const assertion: ExecutorIdentityAssertion = {
      schemaVersion: '1',
      profile: profile(),
      handle,
      payload: { oidc: 'transient-test-assertion' },
    };
    await expect(registry.verifyIdentity(assertion)).resolves.toMatchObject({
      kind: 'github_actions',
      attemptId: 'attempt-1',
      leaseGeneration: 3,
      repository: 'business/repository',
    });
    await expect(registry.providerEvidence(handle)).resolves.toMatchObject({
      kind: 'github_actions',
      externalId: '123456789',
      status: 'succeeded',
      facts: {
        conclusion: 'success',
        executorHeadSha: SHA,
        runAttempt: '1',
      },
    });
  });

  it('rejects duplicate kinds, unsafe profile config, and plugin binding drift', async () => {
    const effects = new FakeGitHubEffects();
    const plugin = new GitHubActionsExecutorPlugin(effects);
    expect(() => new ExecutorPluginRegistry([plugin, plugin])).toThrow(
      'executor plugin kind is already registered',
    );

    const unsafeProfile: ExecutorProfile = {
      ...profile(),
      configuration: {
        ...profile().configuration,
        apiToken: 'must-never-enter-a-profile',
      },
    };
    const registry = new ExecutorPluginRegistry([plugin]);
    await expect(registry.ensureStarted(spec({ profile: unsafeProfile }))).rejects.toThrow(
      'executor profile configuration is unsafe',
    );

    const driftingPlugin: ExecutorPlugin = {
      ...plugin,
      kind: 'drifting',
      schemaVersion: '1',
      capabilities: () => plugin.capabilities(profile()),
      ensureStarted: async (input) => ({
        disposition: 'created',
        handle: {
          schemaVersion: '1',
          kind: 'drifting',
          pluginSchemaVersion: '1',
          profileId: input.profile.profileId,
          releaseDigest: input.profile.releaseDigest,
          externalId: 'external-1',
          executionId: input.executionId,
          attemptId: input.attemptId,
          leaseGeneration: input.leaseGeneration + 1,
          role: input.role,
          repository: input.repository,
          attributes: {},
        },
      }),
      observe: async () => ({}) as ExecutionFact,
      cancel: async () => 'cancelled',
      verifyIdentity: async () => ({}) as VerifiedExecutorIdentity,
      providerEvidence: async () => ({}) as ProviderEvidence,
    };
    const driftingProfile: ExecutorProfile = {
      ...profile(),
      kind: 'drifting',
    };
    await expect(
      new ExecutorPluginRegistry([driftingPlugin]).ensureStarted(
        spec({ profile: driftingProfile }),
      ),
    ).rejects.toThrow('executor handle does not match frozen execution spec');
  });

  it('switches the same frozen execution contract to Cloudflare Sandbox without GitHub fields', async () => {
    const requests: unknown[] = [];
    const effects: CloudflareSandboxExecutorEffects = {
      async ensureSandbox(workerOrigin, request) {
        requests.push({ workerOrigin, request });
        return {
          disposition: 'created',
          sandboxId: 'sandbox-1',
          containerId: 'container-1',
        };
      },
      async observeSandbox() {
        return {
          status: 'running',
          externalUpdatedAt: '2026-08-14T01:00:00.000Z',
          exitCode: null,
          imageDigest: `sha256:${'d'.repeat(64)}`,
        };
      },
      async cancelSandbox() {
        return 'cancelled';
      },
      async verifySandboxIdentity(_profile, handle) {
        return {
          schemaVersion: '1',
          kind: 'cloudflare_sandbox',
          executionId: handle.executionId,
          attemptId: handle.attemptId,
          leaseGeneration: handle.leaseGeneration,
          role: handle.role,
          repository: handle.repository,
          providerSubject: 'cloudflare-container:container-1',
        };
      },
    };
    const sandboxProfile = cloudflareSandboxExecutorProfile({
      profileId: 'cloudflare-sandbox-v1',
      workerOrigin: 'https://agent-executor.example.workers.dev',
      imageRef: 'registry.example/delivery-agent@sha256:immutable',
      releaseDigest: `sha256:${'e'.repeat(64)}`,
    });
    const registry = new ExecutorPluginRegistry([
      new GitHubActionsExecutorPlugin(new FakeGitHubEffects()),
      new CloudflareSandboxExecutorPlugin(effects),
    ]);

    const started = await registry.ensureStarted(spec({ profile: sandboxProfile }));

    expect(started.handle).toMatchObject({
      kind: 'cloudflare_sandbox',
      externalId: 'sandbox-1',
      attributes: {
        containerId: 'container-1',
        imageRef: 'registry.example/delivery-agent@sha256:immutable',
      },
    });
    expect(requests).toEqual([{
      workerOrigin: 'https://agent-executor.example.workers.dev',
      request: expect.objectContaining({
        executionId: 'execution-1',
        attemptId: 'attempt-1',
        repository: 'business/repository',
        checkoutSha: SHA,
        imageRef: 'registry.example/delivery-agent@sha256:immutable',
      }),
    }]);
    expect(JSON.stringify(requests)).not.toMatch(/workflowFile|githubRunId|token|secret/i);
  });
});
