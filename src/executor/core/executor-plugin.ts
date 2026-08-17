export type ExecutorRole = 'work' | 'publisher';
export type ExecutorMode = 'analysis' | 'implement' | 'review_fix';
export type ExecutorStatus =
  | 'requested'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type ExecutorProfileValue = string | number | boolean;

/** Immutable, Secret-free provider selection frozen by the control plane. */
export interface ExecutorProfile {
  schemaVersion: '1';
  profileId: string;
  kind: string;
  pluginSchemaVersion: string;
  releaseDigest: string;
  configuration: Readonly<Record<string, ExecutorProfileValue>>;
}

export interface ExecutorCapabilities {
  workspaceIsolation: 'ephemeral' | 'provider_managed';
  networkIsolation: 'provider_managed' | 'default_deny';
  supportsCancellation: boolean;
  supportsReconciliation: boolean;
  supportsSemanticResume: boolean;
  supportsPublisherRole: boolean;
  maxExecutionSeconds: number;
}

/**
 * Provider-neutral execution input. It intentionally has no generic metadata
 * escape hatch: only control-plane-selected, Secret-free values can cross the
 * executor boundary.
 */
export interface FrozenExecutionSpec {
  schemaVersion: '1';
  executionId: string;
  runId: string;
  attemptId: string;
  leaseGeneration: number;
  role: ExecutorRole;
  mode: ExecutorMode;
  profile: ExecutorProfile;
  taskDigest: string;
  repository: string;
  baseSha: string;
  checkoutSha: string;
  targetBaseBranch: string;
  controlPlaneUrl: string;
  planVersion?: number;
  planItemId?: string;
  modelProfileId?: string;
  dispatchGeneration?: 0 | 1;
  /** Present only for a clean publisher execution consuming one frozen work patch. */
  patchArtifactId?: string;
}

/** Opaque provider attributes are constrained to a small Secret-free string map. */
export interface ExecutionHandle {
  schemaVersion: '1';
  kind: string;
  pluginSchemaVersion: string;
  profileId: string;
  releaseDigest: string;
  externalId: string;
  executionId: string;
  attemptId: string;
  leaseGeneration: number;
  role: ExecutorRole;
  repository: string;
  attributes: Readonly<Record<string, string>>;
}

export interface EnsureExecutionResult {
  disposition: 'created' | 'existing';
  handle: ExecutionHandle;
}

export interface ExecutionFact {
  schemaVersion: '1';
  kind: string;
  profileId: string;
  externalId: string;
  executionId: string;
  attemptId: string;
  leaseGeneration: number;
  status: ExecutorStatus;
  externalUpdatedAt: string;
  facts: Readonly<Record<string, string>>;
}

export type ExecutorCancelReason =
  | 'lease_expired'
  | 'run_cancelled'
  | 'superseded'
  | 'policy_revoked';

/** Provider credentials/assertions remain transient and must never be persisted. */
export interface ExecutorIdentityAssertion {
  schemaVersion: '1';
  profile: ExecutorProfile;
  handle: ExecutionHandle;
  payload: unknown;
}

export interface VerifiedExecutorIdentity {
  schemaVersion: '1';
  kind: string;
  executionId: string;
  attemptId: string;
  leaseGeneration: number;
  role: ExecutorRole;
  repository: string;
  providerSubject: string;
}

export interface ProviderEvidence {
  schemaVersion: '1';
  kind: string;
  profileId: string;
  externalId: string;
  executionId: string;
  attemptId: string;
  leaseGeneration: number;
  status: ExecutorStatus;
  observedAt: string;
  releaseDigest: string;
  facts: Readonly<Record<string, string>>;
}

/**
 * Providers implement lifecycle mechanics only. Approval, scope selection,
 * retry policy, Attempt fencing, and D1 mutations remain control-plane duties.
 */
export interface ExecutorPlugin {
  readonly kind: string;
  readonly schemaVersion: string;
  capabilities(profile: ExecutorProfile): ExecutorCapabilities;
  ensureStarted(spec: FrozenExecutionSpec): Promise<EnsureExecutionResult>;
  observe(handle: ExecutionHandle): Promise<ExecutionFact>;
  cancel(
    handle: ExecutionHandle,
    reason: ExecutorCancelReason,
  ): Promise<'cancelled' | 'already_terminal'>;
  verifyIdentity(assertion: ExecutorIdentityAssertion): Promise<VerifiedExecutorIdentity>;
  providerEvidence(handle: ExecutionHandle): Promise<ProviderEvidence>;
}
