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
import type {
  CloudflareSandboxProviderFact,
  CloudflareSandboxStartRequest,
  CloudflareSandboxStartResult,
} from '../../cloudflare-worker/protocol.js';

export type {
  CloudflareSandboxProviderFact,
  CloudflareSandboxStartRequest,
  CloudflareSandboxStartResult,
} from '../../cloudflare-worker/protocol.js';

export const CLOUDFLARE_SANDBOX_EXECUTOR_KIND = 'cloudflare_sandbox';
export const CLOUDFLARE_SANDBOX_EXECUTOR_SCHEMA_VERSION = '1';

export interface CloudflareSandboxExecutorProfileOptions {
  profileId: string;
  workerOrigin: string;
  imageRef: string;
  releaseDigest: string;
  maxExecutionSeconds?: number;
}

/**
 * Transport adapter for the independent executor Worker. Implementations own
 * Cloudflare API calls and trusted container identity, never D1 authority.
 */
export interface CloudflareSandboxExecutorEffects {
  ensureSandbox(
    workerOrigin: string,
    request: CloudflareSandboxStartRequest,
  ): Promise<CloudflareSandboxStartResult>;
  observeSandbox(
    workerOrigin: string,
    sandboxId: string,
  ): Promise<CloudflareSandboxProviderFact>;
  cancelSandbox(
    workerOrigin: string,
    sandboxId: string,
    reason: ExecutorCancelReason,
  ): Promise<'cancelled' | 'already_terminal'>;
  verifySandboxIdentity(
    profile: ExecutorProfile,
    handle: ExecutionHandle,
    payload: unknown,
  ): Promise<VerifiedExecutorIdentity>;
}

interface ParsedProfile {
  workerOrigin: string;
  imageRef: string;
  maxExecutionSeconds: number;
}

function httpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Cloudflare Sandbox worker origin is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new Error('Cloudflare Sandbox worker origin is invalid');
  }
  return url.origin;
}

function parseProfile(profile: ExecutorProfile): ParsedProfile {
  const rawOrigin = profile.configuration.workerOrigin;
  const imageRef = profile.configuration.imageRef;
  const maxExecutionSeconds = profile.configuration.maxExecutionSeconds;
  if (
    profile.kind !== CLOUDFLARE_SANDBOX_EXECUTOR_KIND ||
    profile.pluginSchemaVersion !== CLOUDFLARE_SANDBOX_EXECUTOR_SCHEMA_VERSION ||
    typeof rawOrigin !== 'string' ||
    typeof imageRef !== 'string' ||
    imageRef.length < 1 ||
    imageRef.length > 500 ||
    typeof maxExecutionSeconds !== 'number' ||
    !Number.isSafeInteger(maxExecutionSeconds) ||
    maxExecutionSeconds < 60 ||
    maxExecutionSeconds > 6 * 60 * 60
  ) {
    throw new Error('Cloudflare Sandbox executor profile is invalid');
  }
  return {
    workerOrigin: httpsOrigin(rawOrigin),
    imageRef,
    maxExecutionSeconds,
  };
}

export function cloudflareSandboxExecutorProfile(
  options: CloudflareSandboxExecutorProfileOptions,
): ExecutorProfile {
  return {
    schemaVersion: '1',
    profileId: options.profileId,
    kind: CLOUDFLARE_SANDBOX_EXECUTOR_KIND,
    pluginSchemaVersion: CLOUDFLARE_SANDBOX_EXECUTOR_SCHEMA_VERSION,
    releaseDigest: options.releaseDigest,
    configuration: {
      workerOrigin: httpsOrigin(options.workerOrigin),
      imageRef: options.imageRef,
      maxExecutionSeconds: options.maxExecutionSeconds ?? 60 * 60,
    },
  };
}

function profileFromHandle(handle: ExecutionHandle): ExecutorProfile {
  const workerOrigin = handle.attributes.workerOrigin;
  const imageRef = handle.attributes.imageRef;
  const maxExecutionSeconds = Number(handle.attributes.maxExecutionSeconds);
  if (workerOrigin === undefined || imageRef === undefined) {
    throw new Error('Cloudflare Sandbox execution handle is invalid');
  }
  return cloudflareSandboxExecutorProfile({
    profileId: handle.profileId,
    workerOrigin,
    imageRef,
    releaseDigest: handle.releaseDigest,
    maxExecutionSeconds,
  });
}

export class CloudflareSandboxExecutorPlugin implements ExecutorPlugin {
  readonly kind = CLOUDFLARE_SANDBOX_EXECUTOR_KIND;
  readonly schemaVersion = CLOUDFLARE_SANDBOX_EXECUTOR_SCHEMA_VERSION;

  constructor(private readonly effects: CloudflareSandboxExecutorEffects) {}

  capabilities(profile: ExecutorProfile): ExecutorCapabilities {
    const parsed = parseProfile(profile);
    return {
      workspaceIsolation: 'ephemeral',
      networkIsolation: 'default_deny',
      supportsCancellation: true,
      supportsReconciliation: true,
      supportsSemanticResume: true,
      supportsPublisherRole: true,
      maxExecutionSeconds: parsed.maxExecutionSeconds,
    };
  }

  async ensureStarted(spec: FrozenExecutionSpec): Promise<EnsureExecutionResult> {
    const parsed = parseProfile(spec.profile);
    const result = await this.effects.ensureSandbox(parsed.workerOrigin, {
      schemaVersion: '1',
      profileId: spec.profile.profileId,
      releaseDigest: spec.profile.releaseDigest,
      executionId: spec.executionId,
      runId: spec.runId,
      attemptId: spec.attemptId,
      leaseGeneration: spec.leaseGeneration,
      role: spec.role,
      mode: spec.mode,
      imageRef: parsed.imageRef,
      taskDigest: spec.taskDigest,
      repository: spec.repository,
      baseSha: spec.baseSha,
      checkoutSha: spec.checkoutSha,
      targetBaseBranch: spec.targetBaseBranch,
      controlPlaneUrl: spec.controlPlaneUrl,
      ...(spec.planVersion === undefined ? {} : { planVersion: spec.planVersion }),
      ...(spec.planItemId === undefined ? {} : { planItemId: spec.planItemId }),
      ...(spec.modelProfileId === undefined ? {} : { modelProfileId: spec.modelProfileId }),
      ...(spec.patchArtifactId === undefined ? {} : { patchArtifactId: spec.patchArtifactId }),
    });
    return {
      disposition: result.disposition,
      handle: {
        schemaVersion: '1',
        kind: this.kind,
        pluginSchemaVersion: this.schemaVersion,
        profileId: spec.profile.profileId,
        releaseDigest: spec.profile.releaseDigest,
        externalId: result.sandboxId,
        executionId: spec.executionId,
        attemptId: spec.attemptId,
        leaseGeneration: spec.leaseGeneration,
        role: spec.role,
        repository: spec.repository,
        attributes: {
          containerId: result.containerId,
          imageRef: parsed.imageRef,
          maxExecutionSeconds: String(parsed.maxExecutionSeconds),
          workerOrigin: parsed.workerOrigin,
        },
      },
    };
  }

  async observe(handle: ExecutionHandle): Promise<ExecutionFact> {
    const parsed = parseProfile(profileFromHandle(handle));
    const fact = await this.effects.observeSandbox(parsed.workerOrigin, handle.externalId);
    return {
      schemaVersion: '1',
      kind: this.kind,
      profileId: handle.profileId,
      externalId: handle.externalId,
      executionId: handle.executionId,
      attemptId: handle.attemptId,
      leaseGeneration: handle.leaseGeneration,
      status: fact.status,
      externalUpdatedAt: fact.externalUpdatedAt,
      facts: {
        containerId: handle.attributes.containerId ?? '',
        exitCode: fact.exitCode === null ? 'none' : String(fact.exitCode),
        imageDigest: fact.imageDigest,
      },
    };
  }

  async cancel(
    handle: ExecutionHandle,
    reason: ExecutorCancelReason,
  ): Promise<'cancelled' | 'already_terminal'> {
    const parsed = parseProfile(profileFromHandle(handle));
    return await this.effects.cancelSandbox(parsed.workerOrigin, handle.externalId, reason);
  }

  async verifyIdentity(
    assertion: ExecutorIdentityAssertion,
  ): Promise<VerifiedExecutorIdentity> {
    parseProfile(assertion.profile);
    return await this.effects.verifySandboxIdentity(
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
}
