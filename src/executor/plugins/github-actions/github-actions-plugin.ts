import {
  DELIVERY_AGENT_WORKFLOW_FILE,
  githubAgentExecutorBinding,
} from '../../../domain/github-agent-executor.js';
import type { GitHubWorkflowRunFact } from '../../../storage/github-run-observation-store.js';
import type {
  EnsureExecutionResult,
  ExecutionFact,
  ExecutionHandle,
  ExecutorCancelReason,
  ExecutorCapabilities,
  ExecutorIdentityAssertion,
  ExecutorPlugin,
  ExecutorProfile,
  FrozenExecutionSpec,
  ProviderEvidence,
  VerifiedExecutorIdentity,
} from '../../core/executor-plugin.js';

export const GITHUB_ACTIONS_EXECUTOR_KIND = 'github_actions';
export const GITHUB_ACTIONS_EXECUTOR_SCHEMA_VERSION = '1';
export const GITHUB_ACTIONS_EXECUTOR_RELEASE_DIGEST_V1 =
  'sha256:071a9c98264ad5059cd55a8bf4392c7804539df384e379e771b265607638e6cd';

export interface GitHubAgentDispatchRequest {
  repository: string;
  workflowFile: typeof DELIVERY_AGENT_WORKFLOW_FILE;
  ref: string;
  inputs: Record<string, string>;
}

export interface GitHubAgentDispatchResult {
  disposition: 'created' | 'existing';
  githubRunId: string;
  githubHeadSha: string;
}

/** Production adapter reconciles by Attempt run-name before retrying an ambiguous start. */
export interface GitHubAgentDispatchEffects {
  ensureDispatch(request: GitHubAgentDispatchRequest): Promise<GitHubAgentDispatchResult>;
}

interface GitHubActionsExecutorProfileOptions {
  profileId: string;
  executorRepository: string;
  executorRef: string;
  releaseDigest: string;
}

export interface GitHubActionsExecutorEffects extends GitHubAgentDispatchEffects {
  getWorkflowRun?(
    repository: string,
    githubRunId: string,
  ): Promise<GitHubWorkflowRunFact>;
  cancelWorkflowRun?(
    repository: string,
    githubRunId: string,
  ): Promise<'cancelled' | 'already_terminal'>;
  verifyExecutorIdentity?(
    profile: ExecutorProfile,
    handle: ExecutionHandle,
    payload: unknown,
  ): Promise<VerifiedExecutorIdentity>;
}

interface ParsedGitHubProfile {
  executorRepository: string;
  executorRef: string;
  workflowRef: string;
}

export function githubActionsExecutorProfile(
  options: GitHubActionsExecutorProfileOptions,
): ExecutorProfile {
  const binding = githubAgentExecutorBinding(
    options.executorRepository,
    options.executorRef,
  );
  return {
    schemaVersion: '1',
    profileId: options.profileId,
    kind: GITHUB_ACTIONS_EXECUTOR_KIND,
    pluginSchemaVersion: GITHUB_ACTIONS_EXECUTOR_SCHEMA_VERSION,
    releaseDigest: options.releaseDigest,
    configuration: {
      executorRepository: binding.repository,
      executorRef: binding.ref,
    },
  };
}

function parseProfile(profile: ExecutorProfile): ParsedGitHubProfile {
  const repository = profile.configuration.executorRepository;
  const ref = profile.configuration.executorRef;
  if (
    profile.kind !== GITHUB_ACTIONS_EXECUTOR_KIND ||
    profile.pluginSchemaVersion !== GITHUB_ACTIONS_EXECUTOR_SCHEMA_VERSION ||
    typeof repository !== 'string' ||
    typeof ref !== 'string'
  ) {
    throw new Error('GitHub Actions executor profile is invalid');
  }
  const binding = githubAgentExecutorBinding(repository, ref);
  return {
    executorRepository: binding.repository,
    executorRef: binding.ref,
    workflowRef: binding.workflowRef,
  };
}

function inputsFor(spec: FrozenExecutionSpec): Record<string, string> {
  const inputs: Record<string, string> = {
    schema_version: '1',
    run_id: spec.runId,
    attempt_id: spec.attemptId,
    task_digest: spec.taskDigest,
    base_sha: spec.baseSha,
    checkout_sha: spec.checkoutSha,
    target_repository: spec.repository,
    control_plane_url: spec.controlPlaneUrl,
    mode: spec.mode,
  };
  if (spec.modelProfileId !== undefined) inputs.model_profile_id = spec.modelProfileId;
  if (spec.dispatchGeneration === 1) inputs.dispatch_generation = '1';
  if (spec.planVersion !== undefined) inputs.plan_version = String(spec.planVersion);
  if (spec.planItemId !== undefined) inputs.plan_item_id = spec.planItemId;
  return inputs;
}

function githubStatus(fact: GitHubWorkflowRunFact): ExecutionFact['status'] {
  if (fact.status === 'requested') return 'requested';
  if (fact.status === 'queued' || fact.status === 'waiting') return 'queued';
  if (fact.status === 'in_progress') return 'running';
  if (fact.conclusion === 'success') return 'succeeded';
  if (fact.conclusion === 'cancelled') return 'cancelled';
  return 'failed';
}

export class GitHubActionsExecutorPlugin implements ExecutorPlugin {
  readonly kind = GITHUB_ACTIONS_EXECUTOR_KIND;
  readonly schemaVersion = GITHUB_ACTIONS_EXECUTOR_SCHEMA_VERSION;

  constructor(private readonly effects: GitHubActionsExecutorEffects) {}

  capabilities(profile: ExecutorProfile): ExecutorCapabilities {
    parseProfile(profile);
    return {
      workspaceIsolation: 'ephemeral',
      networkIsolation: 'provider_managed',
      supportsCancellation: true,
      supportsReconciliation: true,
      supportsSemanticResume: true,
      supportsPublisherRole: false,
      maxExecutionSeconds: 6 * 60 * 60,
    };
  }

  async ensureStarted(spec: FrozenExecutionSpec): Promise<EnsureExecutionResult> {
    const parsed = parseProfile(spec.profile);
    if (spec.role !== 'work') {
      throw new Error('GitHub Actions executor does not support publisher role');
    }
    const request: GitHubAgentDispatchRequest = {
      repository: parsed.executorRepository,
      workflowFile: DELIVERY_AGENT_WORKFLOW_FILE,
      ref: parsed.executorRef,
      inputs: inputsFor(spec),
    };
    const result = await this.effects.ensureDispatch(request);
    return {
      disposition: result.disposition,
      handle: {
        schemaVersion: '1',
        kind: this.kind,
        pluginSchemaVersion: this.schemaVersion,
        profileId: spec.profile.profileId,
        releaseDigest: spec.profile.releaseDigest,
        externalId: result.githubRunId,
        executionId: spec.executionId,
        attemptId: spec.attemptId,
        leaseGeneration: spec.leaseGeneration,
        role: spec.role,
        repository: spec.repository,
        attributes: {
          executorHeadSha: result.githubHeadSha,
          displayTitle: `delivery-loop/${spec.attemptId}` +
            (spec.dispatchGeneration === 1 ? '/redispatch-1' : ''),
          workflowRef: parsed.workflowRef,
        },
      },
    };
  }

  async observe(handle: ExecutionHandle): Promise<ExecutionFact> {
    if (this.effects.getWorkflowRun === undefined) {
      throw new Error('GitHub Actions executor observation is unavailable');
    }
    const profile = this.profileFromHandle(handle);
    const parsed = parseProfile(profile);
    const fact = await this.effects.getWorkflowRun(parsed.executorRepository, handle.externalId);
    if (
      fact.repository !== parsed.executorRepository ||
      fact.githubRunId !== handle.externalId ||
      fact.headSha !== handle.attributes.executorHeadSha ||
      fact.displayTitle !== handle.attributes.displayTitle
    ) {
      throw new Error('GitHub Actions execution fact does not match handle');
    }
    return {
      schemaVersion: '1',
      kind: this.kind,
      profileId: handle.profileId,
      externalId: handle.externalId,
      executionId: handle.executionId,
      attemptId: handle.attemptId,
      leaseGeneration: handle.leaseGeneration,
      status: githubStatus(fact),
      externalUpdatedAt: fact.externalUpdatedAt,
      facts: {
        conclusion: fact.conclusion ?? 'none',
        executorHeadSha: fact.headSha,
        runAttempt: String(fact.runAttempt),
        workflowPath: fact.workflowPath,
      },
    };
  }

  async cancel(
    handle: ExecutionHandle,
    reason: ExecutorCancelReason,
  ): Promise<'cancelled' | 'already_terminal'> {
    void reason;
    if (this.effects.cancelWorkflowRun === undefined) {
      throw new Error('GitHub Actions executor cancellation is unavailable');
    }
    const parsed = parseProfile(this.profileFromHandle(handle));
    return await this.effects.cancelWorkflowRun(parsed.executorRepository, handle.externalId);
  }

  async verifyIdentity(
    assertion: ExecutorIdentityAssertion,
  ): Promise<VerifiedExecutorIdentity> {
    parseProfile(assertion.profile);
    if (this.effects.verifyExecutorIdentity === undefined) {
      throw new Error('GitHub Actions executor identity verifier is unavailable');
    }
    return await this.effects.verifyExecutorIdentity(
      assertion.profile,
      assertion.handle,
      assertion.payload,
    );
  }

  async providerEvidence(handle: ExecutionHandle): Promise<ProviderEvidence> {
    const fact = await this.observe(handle);
    return {
      schemaVersion: '1',
      kind: this.kind,
      profileId: handle.profileId,
      externalId: handle.externalId,
      executionId: handle.executionId,
      attemptId: handle.attemptId,
      leaseGeneration: handle.leaseGeneration,
      status: fact.status,
      observedAt: fact.externalUpdatedAt,
      releaseDigest: handle.releaseDigest,
      facts: fact.facts,
    };
  }

  private profileFromHandle(handle: ExecutionHandle): ExecutorProfile {
    const workflowRef = handle.attributes.workflowRef;
    if (workflowRef === undefined) {
      throw new Error('GitHub Actions execution handle is invalid');
    }
    const marker = `/${DELIVERY_AGENT_WORKFLOW_FILE}@`;
    const index = workflowRef.indexOf(marker);
    if (index <= 0) throw new Error('GitHub Actions execution handle is invalid');
    return githubActionsExecutorProfile({
      profileId: handle.profileId,
      executorRepository: workflowRef.slice(0, index),
      executorRef: workflowRef.slice(index + marker.length),
      releaseDigest: handle.releaseDigest,
    });
  }
}
