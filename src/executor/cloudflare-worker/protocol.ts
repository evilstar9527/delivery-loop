import type {
  ExecutionFact,
  ExecutorCancelReason,
} from '../core/executor-plugin.js';

export interface CloudflareSandboxStartRequest {
  schemaVersion: '1';
  profileId: string;
  releaseDigest: string;
  executionId: string;
  runId: string;
  attemptId: string;
  leaseGeneration: number;
  role: 'work' | 'publisher';
  mode: 'analysis' | 'implement' | 'review_fix';
  imageRef: string;
  taskDigest: string;
  repository: string;
  baseSha: string;
  checkoutSha: string;
  targetBaseBranch: string;
  controlPlaneUrl: string;
  planVersion?: number | undefined;
  planItemId?: string | undefined;
  modelProfileId?: string | undefined;
  patchArtifactId?: string | undefined;
}

export interface CloudflareSandboxStartResult {
  disposition: 'created' | 'existing';
  sandboxId: string;
  containerId: string;
}

export interface CloudflareSandboxProviderFact {
  status: ExecutionFact['status'];
  externalUpdatedAt: string;
  exitCode: number | null;
  imageDigest: string;
}

export interface CloudflareSandboxCancelRequest {
  reason: ExecutorCancelReason;
}
