import type {
  EnsureExecutionResult,
  ExecutionFact,
  ExecutionHandle,
  ExecutorCancelReason,
  ExecutorIdentityAssertion,
  ExecutorPlugin,
  ExecutorProfile,
  FrozenExecutionSpec,
  ProviderEvidence,
  VerifiedExecutorIdentity,
} from './executor-plugin.js';

export type { ExecutorPlugin } from './executor-plugin.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const UNSAFE_CONFIGURATION_KEY =
  /(?:secret|token|password|passwd|credential|private.?key|api.?key|authorization)/i;

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function assertSafeStringMap(
  value: Readonly<Record<string, string>>,
  label: string,
): void {
  const entries = Object.entries(value);
  if (entries.length > 32) throw new Error(`${label} is invalid`);
  for (const [key, entry] of entries) {
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ||
      UNSAFE_CONFIGURATION_KEY.test(key) ||
      entry.length > 1_000
    ) {
      throw new Error(`${label} is unsafe`);
    }
  }
}

export function assertExecutorProfile(profile: ExecutorProfile): void {
  if (
    profile.schemaVersion !== '1' ||
    !ID_PATTERN.test(profile.profileId) ||
    !ID_PATTERN.test(profile.kind) ||
    !ID_PATTERN.test(profile.pluginSchemaVersion) ||
    !DIGEST_PATTERN.test(profile.releaseDigest)
  ) {
    throw new Error('executor profile is invalid');
  }
  const entries = Object.entries(profile.configuration);
  if (entries.length > 32) throw new Error('executor profile configuration is invalid');
  for (const [key, value] of entries) {
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ||
      UNSAFE_CONFIGURATION_KEY.test(key) ||
      (typeof value === 'string' && value.length > 1_000) ||
      (typeof value === 'number' && !Number.isFinite(value))
    ) {
      throw new Error('executor profile configuration is unsafe');
    }
  }
}

export function assertFrozenExecutionSpec(spec: FrozenExecutionSpec): void {
  assertExecutorProfile(spec.profile);
  let controlPlaneUrl: URL;
  try {
    controlPlaneUrl = new URL(spec.controlPlaneUrl);
  } catch {
    throw new Error('frozen execution spec is invalid');
  }
  if (
    spec.schemaVersion !== '1' ||
    !ID_PATTERN.test(spec.executionId) ||
    !ID_PATTERN.test(spec.runId) ||
    !ID_PATTERN.test(spec.attemptId) ||
    !Number.isSafeInteger(spec.leaseGeneration) ||
    spec.leaseGeneration <= 0 ||
    !REPOSITORY_PATTERN.test(spec.repository) ||
    !SHA_PATTERN.test(spec.baseSha) ||
    !SHA_PATTERN.test(spec.checkoutSha) ||
    spec.targetBaseBranch.length < 1 ||
    spec.targetBaseBranch.length > 255 ||
    spec.targetBaseBranch.includes('..') ||
    controlPlaneUrl.protocol !== 'https:' ||
    controlPlaneUrl.username !== '' ||
    controlPlaneUrl.password !== '' ||
    controlPlaneUrl.search !== '' ||
    controlPlaneUrl.hash !== '' ||
    !DIGEST_PATTERN.test(spec.taskDigest) ||
    (spec.planVersion !== undefined &&
      (!Number.isSafeInteger(spec.planVersion) || spec.planVersion <= 0)) ||
    (spec.planItemId !== undefined && !ID_PATTERN.test(spec.planItemId)) ||
    (spec.modelProfileId !== undefined && !ID_PATTERN.test(spec.modelProfileId)) ||
    (spec.dispatchGeneration !== undefined &&
      spec.dispatchGeneration !== 0 && spec.dispatchGeneration !== 1) ||
    (spec.patchArtifactId !== undefined && !ID_PATTERN.test(spec.patchArtifactId)) ||
    (spec.role === 'publisher') !== (spec.patchArtifactId !== undefined)
  ) {
    throw new Error('frozen execution spec is invalid');
  }
}

function assertHandle(handle: ExecutionHandle): void {
  if (
    handle.schemaVersion !== '1' ||
    !ID_PATTERN.test(handle.kind) ||
    !ID_PATTERN.test(handle.pluginSchemaVersion) ||
    !ID_PATTERN.test(handle.profileId) ||
    !DIGEST_PATTERN.test(handle.releaseDigest) ||
    handle.externalId.length < 1 ||
    handle.externalId.length > 500 ||
    !ID_PATTERN.test(handle.executionId) ||
    !ID_PATTERN.test(handle.attemptId) ||
    !Number.isSafeInteger(handle.leaseGeneration) ||
    handle.leaseGeneration <= 0 ||
    !REPOSITORY_PATTERN.test(handle.repository)
  ) {
    throw new Error('executor handle is invalid');
  }
  assertSafeStringMap(handle.attributes, 'executor handle attributes');
}

function handleMatchesSpec(handle: ExecutionHandle, spec: FrozenExecutionSpec): boolean {
  return (
    handle.kind === spec.profile.kind &&
    handle.pluginSchemaVersion === spec.profile.pluginSchemaVersion &&
    handle.profileId === spec.profile.profileId &&
    handle.releaseDigest === spec.profile.releaseDigest &&
    handle.executionId === spec.executionId &&
    handle.attemptId === spec.attemptId &&
    handle.leaseGeneration === spec.leaseGeneration &&
    handle.role === spec.role &&
    handle.repository === spec.repository
  );
}

function factMatchesHandle(fact: ExecutionFact, handle: ExecutionHandle): boolean {
  assertExecutionFact(fact);
  return (
    fact.kind === handle.kind &&
    fact.profileId === handle.profileId &&
    fact.externalId === handle.externalId &&
    fact.executionId === handle.executionId &&
    fact.attemptId === handle.attemptId &&
    fact.leaseGeneration === handle.leaseGeneration
  );
}

export function assertExecutionFact(fact: ExecutionFact): void {
  if (
    fact.schemaVersion !== '1' ||
    !ID_PATTERN.test(fact.kind) ||
    !ID_PATTERN.test(fact.profileId) ||
    fact.externalId.length < 1 ||
    fact.externalId.length > 500 ||
    !ID_PATTERN.test(fact.executionId) ||
    !ID_PATTERN.test(fact.attemptId) ||
    !Number.isSafeInteger(fact.leaseGeneration) ||
    fact.leaseGeneration <= 0 ||
    !['requested', 'queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(
      fact.status,
    ) ||
    !validTimestamp(fact.externalUpdatedAt)
  ) {
    throw new Error('executor fact is invalid');
  }
  assertSafeStringMap(fact.facts, 'executor fact attributes');
}

export class ExecutorPluginRegistry {
  private readonly plugins = new Map<string, ExecutorPlugin>();

  constructor(plugins: readonly ExecutorPlugin[] = []) {
    for (const plugin of plugins) this.register(plugin);
  }

  register(plugin: ExecutorPlugin): void {
    if (!ID_PATTERN.test(plugin.kind) || !ID_PATTERN.test(plugin.schemaVersion)) {
      throw new Error('executor plugin identity is invalid');
    }
    if (this.plugins.has(plugin.kind)) {
      throw new Error('executor plugin kind is already registered');
    }
    this.plugins.set(plugin.kind, plugin);
  }

  resolve(profile: ExecutorProfile): ExecutorPlugin {
    assertExecutorProfile(profile);
    const plugin = this.plugins.get(profile.kind);
    if (plugin === undefined) throw new Error('executor plugin is not registered');
    if (plugin.schemaVersion !== profile.pluginSchemaVersion) {
      throw new Error('executor plugin schema version does not match profile');
    }
    return plugin;
  }

  async ensureStarted(spec: FrozenExecutionSpec): Promise<EnsureExecutionResult> {
    assertFrozenExecutionSpec(spec);
    const result = await this.resolve(spec.profile).ensureStarted(spec);
    assertHandle(result.handle);
    if (!handleMatchesSpec(result.handle, spec)) {
      throw new Error('executor handle does not match frozen execution spec');
    }
    return result;
  }

  async observe(handle: ExecutionHandle): Promise<ExecutionFact> {
    assertHandle(handle);
    const plugin = this.resolveHandle(handle);
    const fact = await plugin.observe(handle);
    if (!factMatchesHandle(fact, handle)) {
      throw new Error('executor fact does not match execution handle');
    }
    return fact;
  }

  async cancel(
    handle: ExecutionHandle,
    reason: ExecutorCancelReason,
  ): Promise<'cancelled' | 'already_terminal'> {
    assertHandle(handle);
    return await this.resolveHandle(handle).cancel(handle, reason);
  }

  async verifyIdentity(
    assertion: ExecutorIdentityAssertion,
  ): Promise<VerifiedExecutorIdentity> {
    assertExecutorProfile(assertion.profile);
    assertHandle(assertion.handle);
    if (
      assertion.profile.profileId !== assertion.handle.profileId ||
      assertion.profile.kind !== assertion.handle.kind
    ) {
      throw new Error('executor identity assertion binding is invalid');
    }
    const identity = await this.resolve(assertion.profile).verifyIdentity(assertion);
    if (
      identity.schemaVersion !== '1' ||
      identity.kind !== assertion.handle.kind ||
      identity.executionId !== assertion.handle.executionId ||
      identity.attemptId !== assertion.handle.attemptId ||
      identity.leaseGeneration !== assertion.handle.leaseGeneration ||
      identity.role !== assertion.handle.role ||
      identity.repository !== assertion.handle.repository ||
      identity.providerSubject.length < 1 ||
      identity.providerSubject.length > 1_000
    ) {
      throw new Error('verified executor identity does not match execution handle');
    }
    return identity;
  }

  async providerEvidence(handle: ExecutionHandle): Promise<ProviderEvidence> {
    assertHandle(handle);
    const evidence = await this.resolveHandle(handle).providerEvidence(handle);
    if (
      evidence.schemaVersion !== '1' ||
      evidence.kind !== handle.kind ||
      evidence.profileId !== handle.profileId ||
      evidence.externalId !== handle.externalId ||
      evidence.executionId !== handle.executionId ||
      evidence.attemptId !== handle.attemptId ||
      evidence.leaseGeneration !== handle.leaseGeneration ||
      !validTimestamp(evidence.observedAt) ||
      !DIGEST_PATTERN.test(evidence.releaseDigest)
    ) {
      throw new Error('provider evidence does not match execution handle');
    }
    assertSafeStringMap(evidence.facts, 'provider evidence facts');
    return evidence;
  }

  private resolveHandle(handle: ExecutionHandle): ExecutorPlugin {
    const plugin = this.plugins.get(handle.kind);
    if (plugin === undefined) throw new Error('executor plugin is not registered');
    if (plugin.schemaVersion !== handle.pluginSchemaVersion) {
      throw new Error('executor plugin schema version does not match handle');
    }
    return plugin;
  }
}
