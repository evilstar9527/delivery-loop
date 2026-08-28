import { Hono } from 'hono';
import { z } from 'zod';
import { AnalysisPlanContentV1Schema } from '../domain/analysis-plan.js';
import { AgentCheckpointV1Schema } from '../domain/checkpoint.js';
import { RawAgentArtifactRequestBodySchema } from '../domain/raw-agent-artifact.js';
import { ExecutorPatchUploadRequestSchema } from '../domain/executor-patch-artifact.js';
import { AttemptFailureReportV1Schema } from '../domain/attempt-failure.js';
import { DiagnosticEvidenceV1Schema } from '../domain/diagnostic-evidence.js';
import { ProtectedPathChangeReportV1Schema } from '../domain/protected-path-change.js';
import {
  VerificationCommandResultV1Schema,
  VerificationSuiteManifestV1Schema,
} from '../domain/verification-evidence.js';
import { ExecutionPlanValidationError } from '../domain/plan.js';
import {
  boundedToolCallDuration,
  TOOL_CALL_RESULT_CATEGORIES,
  toolActionFor,
  trustedToolSpec,
  type ToolCallResultCategory,
} from '../domain/tool-bridge.js';
import {
  GitHubOidcConfigurationError,
  GitHubOidcVerificationError,
  GitHubOidcVerifier,
} from '../auth/github-oidc.js';
import type { Bindings } from '../env.js';
import type { ExecutorIdentityProvider } from
  '../executor/core/executor-identity-provider.js';
import type { ExecutorPluginRegistry } from '../executor/core/executor-registry.js';
import type { VerifiedExecutorIdentity } from '../executor/core/executor-plugin.js';
import {
  executorIdentityProviderFromEnv,
  executorPluginRegistryFromEnv,
} from '../outbox/agent-executor-runtime.js';
import { configuredSecrets } from '../security/runtime-secrets.js';
import {
  AttemptExchangeError,
  AttemptExchangeStore,
} from '../storage/attempt-exchange-store.js';
import {
  AnalysisAttemptContextStore,
  AnalysisAttemptError,
  AnalysisPlanProposalStore,
} from '../storage/analysis-attempt-store.js';
import {
  AutomatedReviewContextStore,
  AutomatedReviewError,
  AutomatedReviewResultStore,
} from '../storage/automated-review-store.js';
import {
  ExecutionAttemptContextStore,
  ExecutionAttemptError,
} from '../storage/execution-attempt-store.js';
import {
  ExecutionHeadError,
  ExecutionHeadStore,
} from '../storage/execution-head-store.js';
import { ExecutionPlanPersistenceError } from '../storage/execution-plan-store.js';
import {
  AgentCheckpointError,
  AgentCheckpointStore,
} from '../storage/agent-checkpoint-store.js';
import { errorResponse } from './errors.js';
import {
  RunnerAttemptError,
  RunnerAttemptStore,
} from '../storage/runner-attempt-store.js';
import {
  RUNNER_STARTUP_STAGES,
  RunnerStartupStageStore,
} from '../storage/runner-startup-stage-store.js';
import {
  ToolCallTraceStore,
  ToolCallTraceStoreError,
} from '../storage/tool-call-trace-store.js';
import {
  DiagnosticEvidenceError,
  DiagnosticEvidenceStore,
} from '../storage/diagnostic-evidence-store.js';
import {
  RawAgentArtifactError,
  RawAgentArtifactStore,
} from '../storage/raw-agent-artifact-store.js';
import {
  ExecutorPatchArtifactError,
  ExecutorPatchArtifactStore,
} from '../storage/executor-patch-artifact-store.js';
import {
  ExecutorRepositoryAuthorizationError,
  ExecutorRepositoryAuthorizationStore,
  type ExecutorRepositoryAuthorization,
} from '../storage/executor-repository-authorization-store.js';
import {
  ExecutorRepositoryProxyError,
  proxyExecutorPublisherRepositoryWrite,
  proxyExecutorRepositoryRequest,
  publisherGitToken,
  type GitHubRepositoryReadTokenProvider,
} from './executor-repository-proxy.js';
import {
  QuotaControlError,
  QuotaControlStore,
} from '../storage/quota-control-store.js';
import {
  AttemptFailureError,
  AttemptFailureStore,
} from '../storage/attempt-failure-store.js';
import {
  RepoWriteCredentialError,
  RepoWriteCredentialStore,
} from '../storage/repo-write-credential-store.js';
import {
  ExecutorPublisherCredentialError,
  ExecutorPublisherCredentialStore,
} from '../storage/executor-publisher-credential-store.js';
import {
  ExecutorPatchPublicationError,
  ExecutorPatchPublicationStore,
} from '../storage/executor-patch-publication-store.js';
import {
  ProtectedPathApprovalError,
  ProtectedPathApprovalStore,
} from '../storage/protected-path-approval-store.js';
import {
  VerificationEvidenceError,
  VerificationEvidenceStore,
} from '../storage/verification-evidence-store.js';
import {
  PlanRevisionError,
  PlanRevisionStore,
  ReviewPlanRevisionRequestSchema,
} from '../storage/plan-revision-store.js';
import {
  BaseRebaseAttemptError,
  BaseRebaseAttemptStore,
  BaseRebaseCompletionReportSchema,
  BaseRebaseConflictReportSchema,
} from '../storage/base-rebase-attempt-store.js';
import {
  repoWriteCredentialRuntimeFromEnv,
  type RepoWriteCredentialRuntime,
} from '../reconciliation/repo-write-credential-runtime.js';
import {
  toolBridgeClientFromEnv,
  type ToolBridgeCallResult,
  type ToolBridgeClient,
  type ToolBridgeFailureCategory,
} from '../tools/tool-bridge-client.js';
import { githubActionsRuntimeFromEnv } from
  '../reconciliation/github-run-reconciliation-runtime.js';
import {
  ExecutorModelProxyError,
  executorModelProxyRuntimeFromEnv,
  proxyExecutorModelResponse,
  type ExecutorModelProxyRuntime,
} from './executor-model-proxy.js';
import {
  ExecutorModelGrantError,
  ExecutorModelGrantStore,
} from '../storage/executor-model-grant-store.js';

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const EXECUTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const MAX_OIDC_TOKEN_LENGTH = 20_000;
const MAX_RUNNER_BODY_LENGTH = 16 * 1_024;
const MAX_PLAN_BODY_LENGTH = 256 * 1_024;
const MAX_CHECKPOINT_BODY_LENGTH = 256 * 1_024;
const MAX_ARTIFACT_BODY_LENGTH = 1_100_000;
const MAX_EXECUTOR_PATCH_BODY_LENGTH = 1_100_000;
const MAX_TOOL_CALL_BODY_LENGTH = 64 * 1_024;
const MAX_DIAGNOSTIC_EVIDENCE_BODY_LENGTH = 32 * 1_024;

const ModelReservationBodySchema = z.object({
  reservationId: z.string().regex(ATTEMPT_ID_PATTERN),
  profileId: z.string().regex(ATTEMPT_ID_PATTERN),
  expectedVersion: z.number().int().nonnegative(),
  leaseGeneration: z.number().int().positive(),
}).strict();

const ModelUsageBodySchema = z.object({
  reservationId: z.string().regex(ATTEMPT_ID_PATTERN),
  usageId: z.string().regex(ATTEMPT_ID_PATTERN),
  expectedVersion: z.number().int().nonnegative(),
  leaseGeneration: z.number().int().positive(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
}).strict();

const ModelGrantBodySchema = z.object({
  executionId: z.string().regex(EXECUTOR_ID_PATTERN),
  reservationId: z.string().regex(ATTEMPT_ID_PATTERN),
  expectedVersion: z.number().int().nonnegative(),
  leaseGeneration: z.number().int().positive(),
}).strict();

const HeartbeatBodySchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    leaseGeneration: z.number().int().positive(),
  })
  .strict();

const RunnerStageBodySchema = z
  .object({ stage: z.enum(RUNNER_STARTUP_STAGES) })
  .strict();

const CompletionBodySchema = z
  .object({
    schemaVersion: z.literal('1'),
    eventId: z.string().min(1).max(128),
    sequence: z.number().int().positive(),
    payloadRef: z
      .string()
      .min(1)
      .max(500)
      .regex(/^d1:\/\/execution-plans\/[A-Za-z0-9_-]+$/),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    occurredAt: z.iso.datetime({ offset: true }),
    expectedVersion: z.number().int().nonnegative(),
    leaseGeneration: z.number().int().positive(),
  })
  .strict();

const RepoWriteCredentialBodySchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    leaseGeneration: z.number().int().positive(),
  })
  .strict();

const ExecutionHeadBodySchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    leaseGeneration: z.number().int().positive(),
    parentSha: z.string().regex(/^[a-f0-9]{40}$/),
    headSha: z.string().regex(/^[a-f0-9]{40}$/),
    branch: z.string().min(1).max(240),
  })
  .strict();

const ProtectedPathChangeBodySchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    leaseGeneration: z.number().int().positive(),
    report: ProtectedPathChangeReportV1Schema,
  })
  .strict();

const VerificationStartBodySchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    leaseGeneration: z.number().int().positive(),
    manifest: VerificationSuiteManifestV1Schema,
  })
  .strict();

const VerificationResultBodySchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    leaseGeneration: z.number().int().positive(),
    result: VerificationCommandResultV1Schema,
  })
  .strict();

const PublisherIdentityBodySchema = z.object({
  publicationId: z.string().regex(EXECUTOR_ID_PATTERN),
}).strict();

const PublisherHeadBodySchema = PublisherIdentityBodySchema.extend({
  parentSha: z.string().regex(/^[a-f0-9]{40}$/),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  branch: z.string().min(1).max(240),
}).strict();

const PublisherVerificationStartBodySchema = PublisherIdentityBodySchema.extend({
  manifest: VerificationSuiteManifestV1Schema,
}).strict();

const PublisherVerificationResultBodySchema = PublisherIdentityBodySchema.extend({
  result: VerificationCommandResultV1Schema,
}).strict();

const PublisherCompletionBodySchema = PublisherIdentityBodySchema.extend({
  recomputedPatchDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  branch: z.string().min(1).max(240),
  suiteId: z.string().regex(ATTEMPT_ID_PATTERN),
  evidenceIds: z.array(z.string().regex(ATTEMPT_ID_PATTERN)).min(2).max(100),
}).strict();

const CheckpointBodySchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    leaseGeneration: z.number().int().positive(),
    checkpoint: AgentCheckpointV1Schema,
  })
  .strict();

const ToolPathSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/);

const ToolCallBodySchema = z
  .object({
    toolPath: ToolPathSchema,
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

const ToolAuthorizationBodySchema = z.object({
  toolPath: ToolPathSchema,
}).strict();

const ToolObservationBodySchema = z.object({
  traceId: z.string().regex(ATTEMPT_ID_PATTERN),
  toolPath: ToolPathSchema,
  durationMs: z.number().int().min(0).max(60_000),
  resultCategory: z.enum(TOOL_CALL_RESULT_CATEGORIES),
  occurredAt: z.iso.datetime({ offset: true }),
}).strict();

function directToolTraceId(toolPath: string): string {
  return `tooltrace_${toolPath.replaceAll('/', '_')}_${crypto.randomUUID()}`;
}

function directToolTraceMatches(traceId: string, toolPath: string): boolean {
  return traceId.startsWith(`tooltrace_${toolPath.replaceAll('/', '_')}_`);
}

function runnerToken(authorization: string | undefined): string | null {
  if (
    authorization === undefined ||
    !authorization.startsWith('Bearer ') ||
    authorization.length > MAX_OIDC_TOKEN_LENGTH
  ) {
    return null;
  }
  const token = authorization.slice('Bearer '.length);
  return token.length === 0 ? null : token;
}

async function runnerBody(
  c: Parameters<typeof errorResponse>[0],
  maximum = MAX_RUNNER_BODY_LENGTH,
): Promise<unknown> {
  const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new Error('invalid_runner_body');
  const text = await c.req.text();
  if (new TextEncoder().encode(text).length > maximum) {
    throw new Error('invalid_runner_body');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('invalid_runner_body');
  }
}

function runnerError(c: Parameters<typeof errorResponse>[0], error: RunnerAttemptError): Response {
  if (error.code === 'invalid_token') {
    return errorResponse(c, 401, 'unauthenticated', 'attempt token invalid', false);
  }
  return errorResponse(c, 409, 'conflict', 'attempt state changed', false);
}

function analysisError(
  c: Parameters<typeof errorResponse>[0],
  error: AnalysisAttemptError,
): Response {
  switch (error.code) {
    case 'task_payload_unavailable':
    case 'revision_source_unavailable':
      return errorResponse(c, 503, 'unavailable', 'task context unavailable', true);
    case 'plan_policy_denied':
      return errorResponse(c, 403, 'policy_denied', 'analysis Plan effect denied', false);
    case 'plan_secret_detected':
      return errorResponse(c, 403, 'policy_denied', 'analysis Plan contains sensitive material', false);
    case 'plan_evidence_conflict':
      return errorResponse(c, 409, 'conflict', 'analysis Plan Evidence binding changed', false);
    case 'attempt_context_mismatch':
    case 'task_payload_conflict':
    case 'revision_source_conflict':
      return errorResponse(c, 409, 'conflict', 'analysis context conflict', false);
  }
}

function automatedReviewError(
  c: Parameters<typeof errorResponse>[0],
  error: AutomatedReviewError,
): Response {
  switch (error.code) {
    case 'invalid_request':
      return errorResponse(c, 400, 'invalid_argument', 'invalid automated review result', false);
    case 'not_found':
      return errorResponse(c, 404, 'not_found', 'automated review not found', false);
    case 'approval_required':
      return errorResponse(c, 403, 'policy_denied', 'repository write approval required', false);
    case 'secret_detected':
      return errorResponse(c, 403, 'policy_denied', 'automated review contains sensitive material', false);
    case 'task_payload_unavailable':
    case 'storage_unavailable':
      return errorResponse(c, 503, 'unavailable', 'automated review storage unavailable', true);
    case 'state_conflict':
    case 'task_payload_conflict':
      return errorResponse(c, 409, 'conflict', 'automated review state changed', false);
  }
}

function diagnosticEvidenceError(
  c: Parameters<typeof errorResponse>[0],
  error: DiagnosticEvidenceError,
): Response {
  switch (error.code) {
    case 'invalid_request':
      return errorResponse(c, 400, 'invalid_argument', 'invalid diagnostic Evidence body', false);
    case 'secret_detected':
      return errorResponse(c, 403, 'policy_denied', 'diagnostic Evidence contains sensitive material', false);
    case 'state_conflict':
    case 'source_trace_conflict':
    case 'evidence_conflict':
      return errorResponse(c, 409, 'conflict', 'diagnostic Evidence binding changed', false);
  }
}

function executionError(
  c: Parameters<typeof errorResponse>[0],
  error: ExecutionAttemptError,
): Response {
  switch (error.code) {
    case 'task_payload_unavailable':
    case 'review_payload_unavailable':
      return errorResponse(c, 503, 'unavailable', 'task context unavailable', true);
    case 'attempt_context_mismatch':
    case 'task_payload_conflict':
    case 'review_payload_conflict':
    case 'plan_item_conflict':
      return errorResponse(c, 409, 'conflict', 'execution context conflict', false);
  }
}

function planRevisionError(
  c: Parameters<typeof errorResponse>[0],
  error: PlanRevisionError,
): Response {
  switch (error.code) {
    case 'invalid_request':
      return errorResponse(c, 400, 'invalid_argument', 'invalid Plan revision body', false);
    case 'not_found':
      return errorResponse(c, 404, 'not_found', 'Plan revision source not found', false);
    case 'state_conflict':
    case 'no_change':
      return errorResponse(c, 409, 'conflict', 'Plan revision state changed', false);
  }
}

function checkpointError(
  c: Parameters<typeof errorResponse>[0],
  error: AgentCheckpointError,
): Response {
  switch (error.code) {
    case 'invalid_token':
      return errorResponse(c, 401, 'unauthenticated', 'attempt token invalid', false);
    case 'secret_detected':
      return errorResponse(c, 403, 'policy_denied', 'checkpoint contains sensitive material', false);
    case 'policy_denied':
      return errorResponse(c, 403, 'policy_denied', 'checkpoint write scope denied', false);
    case 'storage_unavailable':
      return errorResponse(c, 503, 'unavailable', 'checkpoint storage unavailable', true);
    case 'state_conflict':
    case 'sequence_conflict':
    case 'binding_conflict':
    case 'evidence_conflict':
    case 'payload_conflict':
      return errorResponse(c, 409, 'conflict', 'checkpoint state changed', false);
  }
}

function executorPatchError(
  c: Parameters<typeof errorResponse>[0],
  error: ExecutorPatchArtifactError,
): Response {
  switch (error.code) {
    case 'invalid_request':
      return errorResponse(c, 400, 'invalid_argument', 'invalid executor patch body', false);
    case 'invalid_token':
      return errorResponse(c, 401, 'unauthenticated', 'executor patch token rejected', false);
    case 'policy_denied':
    case 'secret_detected':
      return errorResponse(c, 403, 'policy_denied', 'executor patch operation denied', false);
    case 'not_found':
      return errorResponse(c, 404, 'not_found', 'executor patch not found', false);
    case 'state_conflict':
    case 'payload_conflict':
      return errorResponse(c, 409, 'conflict', 'executor patch state changed', false);
    case 'storage_unavailable':
      return errorResponse(c, 503, 'unavailable', 'executor patch storage unavailable', true);
  }
}

function toolBridgeFailureResponse(
  c: Parameters<typeof errorResponse>[0],
  category: ToolBridgeFailureCategory,
  retryable: boolean,
): Response {
  switch (category) {
    case 'timeout':
      return errorResponse(c, 504, 'timeout', 'tool call timed out', true);
    case 'unavailable':
      return errorResponse(c, 503, 'unavailable', 'tool bridge unavailable', true);
    case 'upstream_error':
      return errorResponse(c, 502, 'upstream_error', 'tool call failed', retryable);
    case 'invalid_response':
      return errorResponse(c, 502, 'invalid_response', 'tool response invalid', false);
  }
}

function quotaError(c: Parameters<typeof errorResponse>[0], error: QuotaControlError): Response {
  switch (error.code) {
    case 'invalid_request':
      return errorResponse(c, 400, 'invalid_argument', 'invalid quota request', false);
    case 'not_found':
    case 'profile_unavailable':
      return errorResponse(c, 404, 'not_found', 'quota target not found', false);
    case 'quota_exceeded':
      return errorResponse(c, 429, 'rate_limited', 'model quota exceeded', true);
    case 'state_conflict':
    case 'usage_exceeds_reservation':
      return errorResponse(c, 409, 'conflict', 'model quota state changed', false);
  }
}

export interface AttemptApiOptions {
  toolBridgeClient?: ToolBridgeClient;
  monotonicNow?: (() => number) | undefined;
  repoWriteCredentialRuntime?: RepoWriteCredentialRuntime;
  now?: () => Date;
  executorIdentityProvider?: ExecutorIdentityProvider;
  executorPluginRegistry?: ExecutorPluginRegistry;
  executorRepositoryAuthorizer?: {
    authorize(
      attemptId: string,
      rawToken: string,
      executionId: string,
      now?: Date,
    ): Promise<ExecutorRepositoryAuthorization>;
  };
  executorRepositoryTokenProvider?: GitHubRepositoryReadTokenProvider;
  executorRepositoryFetch?: typeof globalThis.fetch;
  githubGitOrigin?: string;
  executorModelProxyRuntime?: ExecutorModelProxyRuntime;
  executorModelGrantEncryptionKey?: string;
}

export function attemptApi(options: AttemptApiOptions = {}): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const publisherIdentity = async (
    c: Parameters<typeof errorResponse>[0],
    attemptId: string,
  ): Promise<VerifiedExecutorIdentity | Response> => {
    const authorization = c.req.header('authorization');
    const executionId = c.req.header('x-delivery-execution-id');
    const containerId = c.req.header('x-delivery-executor-container-id');
    if (
      authorization === undefined || !authorization.startsWith('Bearer ') ||
      authorization.length > 4_103 || executionId === undefined ||
      !EXECUTOR_ID_PATTERN.test(executionId) || containerId === undefined ||
      containerId.length < 1 || containerId.length > 500
    ) return errorResponse(c, 401, 'unauthenticated', 'publisher identity required', false);
    const provider = options.executorIdentityProvider ?? executorIdentityProviderFromEnv(c.env);
    if (provider === null) {
      return errorResponse(c, 503, 'unavailable', 'publisher identity unavailable', true);
    }
    try {
      const identity = await provider.verify({
        executionId,
        attemptId,
        payload: { authorization, executionId, containerId },
      });
      if (identity.role !== 'publisher') throw new Error('publisher role required');
      return identity;
    } catch {
      return errorResponse(c, 401, 'unauthenticated', 'publisher identity invalid', false);
    }
  };

  app.post('/v1/attempts/:attemptId/exchange', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (attemptId === undefined || !ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const authorization = c.req.header('authorization');
    if (
      authorization === undefined ||
      !authorization.startsWith('Bearer ') ||
      authorization.length > MAX_OIDC_TOKEN_LENGTH
    ) {
      return errorResponse(c, 401, 'unauthenticated', 'GitHub OIDC token required', false);
    }
    const oidcToken = authorization.slice('Bearer '.length);

    let verifier: GitHubOidcVerifier;
    try {
      verifier = new GitHubOidcVerifier({
        ...(c.env.GITHUB_OIDC_AUDIENCE === undefined
          ? {}
          : { audience: c.env.GITHUB_OIDC_AUDIENCE }),
        ...(c.env.GITHUB_OIDC_JWKS === undefined
          ? {}
          : { jwksJson: c.env.GITHUB_OIDC_JWKS }),
        ...(c.env.GITHUB_OIDC_JWKS_URL === undefined
          ? {}
          : { jwksUrl: c.env.GITHUB_OIDC_JWKS_URL }),
      });
    } catch (error) {
      if (error instanceof GitHubOidcConfigurationError) {
        return errorResponse(c, 503, 'unavailable', 'OIDC verifier unavailable', true);
      }
      throw error;
    }

    let claims;
    try {
      claims = await verifier.verify(oidcToken);
    } catch (error) {
      if (error instanceof GitHubOidcVerificationError) {
        return errorResponse(c, 401, 'unauthenticated', 'GitHub OIDC token invalid', false);
      }
      throw error;
    }

    try {
      const result = await new AttemptExchangeStore(c.env.DB_CONTROL).exchange(
        attemptId,
        oidcToken,
        claims,
      );
      c.header('cache-control', 'no-store');
      return c.json(result);
    } catch (error) {
      if (error instanceof AttemptExchangeError) {
        switch (error.code) {
          case 'attempt_not_found':
            return errorResponse(c, 404, 'not_found', 'attempt not found', false);
          case 'attempt_binding_mismatch':
          case 'attempt_lease_inactive':
            return errorResponse(c, 403, 'policy_denied', 'attempt binding rejected', false);
          case 'oidc_replayed':
            return errorResponse(c, 409, 'conflict', 'OIDC exchange already consumed', false);
          case 'identity_replayed':
            return errorResponse(c, 409, 'conflict', 'executor exchange already consumed', false);
        }
      }
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/executor-exchange', async (c) => {
    const attemptId = c.req.param('attemptId');
    const authorization = c.req.header('authorization');
    const executionId = c.req.header('x-delivery-execution-id');
    const containerId = c.req.header('x-delivery-executor-container-id');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    if (
      authorization === undefined || !authorization.startsWith('Bearer ') ||
      authorization.length > 4_103 || executionId === undefined ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(executionId) ||
      containerId === undefined || containerId.length < 1 || containerId.length > 500
    ) return errorResponse(c, 401, 'unauthenticated', 'executor identity required', false);
    const provider = options.executorIdentityProvider ?? executorIdentityProviderFromEnv(c.env);
    if (provider === null) {
      return errorResponse(c, 503, 'unavailable', 'executor identity unavailable', true);
    }
    let identity;
    try {
      identity = await provider.verify({
        executionId,
        attemptId,
        payload: { authorization, executionId, containerId },
      });
    } catch {
      return errorResponse(c, 401, 'unauthenticated', 'executor identity invalid', false);
    }
    try {
      const result = await new AttemptExchangeStore(c.env.DB_CONTROL)
        .exchangeExecutorIdentity(attemptId, identity, options.now?.() ?? new Date());
      c.header('cache-control', 'no-store');
      return c.json(result);
    } catch (error) {
      if (error instanceof AttemptExchangeError) {
        switch (error.code) {
          case 'attempt_not_found':
            return errorResponse(c, 404, 'not_found', 'attempt not found', false);
          case 'attempt_binding_mismatch':
          case 'attempt_lease_inactive':
            return errorResponse(c, 403, 'policy_denied', 'attempt binding rejected', false);
          case 'identity_replayed':
          case 'oidc_replayed':
            return errorResponse(c, 409, 'conflict', 'executor exchange already consumed', false);
        }
      }
      throw error;
    }
  });

  app.get('/v1/attempts/:attemptId/context', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    }
    try {
      const authorization = await new RunnerAttemptStore(c.env.DB_CONTROL).authorize(
        attemptId,
        token,
      );
      const context = authorization.mode === 'analysis'
        ? await new AutomatedReviewContextStore(
          c.env.DB_CONTROL,
          c.env.TASK_OBJECTS,
        ).get(authorization) ?? await new AnalysisAttemptContextStore(
          c.env.DB_CONTROL,
          c.env.TASK_OBJECTS,
        ).get(authorization)
        : await new ExecutionAttemptContextStore(
          c.env.DB_CONTROL,
          c.env.TASK_OBJECTS,
          c.env.TASK_OBJECTS,
        ).get(authorization);
      c.header('cache-control', 'no-store');
      return c.json(context);
    } catch (error) {
      if (error instanceof RunnerAttemptError) return runnerError(c, error);
      if (error instanceof AutomatedReviewError) return automatedReviewError(c, error);
      if (error instanceof AnalysisAttemptError) return analysisError(c, error);
      if (error instanceof ExecutionAttemptError) return executionError(c, error);
      throw error;
    }
  });

  const repositoryProxy = async (c: Parameters<typeof errorResponse>[0]): Promise<Response> => {
    const attemptId = c.req.param('attemptId');
    const executionId = c.req.header('x-delivery-execution-id');
    if (attemptId === undefined || !ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null || executionId === undefined || !EXECUTOR_ID_PATTERN.test(executionId)) {
      return errorResponse(c, 401, 'unauthenticated', 'executor repository identity required', false);
    }
    try {
      const authorization = await (
        options.executorRepositoryAuthorizer ??
        new ExecutorRepositoryAuthorizationStore(c.env.DB_CONTROL)
      ).authorize(attemptId, token, executionId, options.now?.() ?? new Date());
      const tokenProvider = options.executorRepositoryTokenProvider ??
        githubActionsRuntimeFromEnv(c.env)?.provider;
      if (tokenProvider === undefined) {
        return errorResponse(c, 503, 'unavailable', 'repository source unavailable', true);
      }
      const githubGitOrigin = options.githubGitOrigin ?? c.env.GITHUB_GIT_BASE_URL;
      return await proxyExecutorRepositoryRequest({
        request: c.req.raw,
        authorization,
        tokenProvider,
        ...(options.executorRepositoryFetch === undefined
          ? {} : { fetch: options.executorRepositoryFetch }),
        ...(githubGitOrigin === undefined ? {} : { githubGitOrigin }),
      });
    } catch (error) {
      if (error instanceof ExecutorRepositoryAuthorizationError) {
        return errorResponse(
          c,
          error.code === 'invalid_token' ? 401 : 409,
          error.code === 'invalid_token' ? 'unauthenticated' : 'conflict',
          error.code === 'invalid_token'
            ? 'executor repository token rejected'
            : 'executor repository state changed',
          false,
        );
      }
      if (error instanceof ExecutorRepositoryProxyError) {
        if (error.code === 'invalid_request') {
          return errorResponse(c, 400, 'invalid_argument', 'invalid repository request', false);
        }
        if (error.code === 'upstream_rejected') {
          return errorResponse(c, 403, 'policy_denied', 'repository source rejected', false);
        }
        return errorResponse(c, 503, 'unavailable', 'repository source unavailable', true);
      }
      throw error;
    }
  };

  app.get('/v1/attempts/:attemptId/repository.git/info/refs', repositoryProxy);
  app.post('/v1/attempts/:attemptId/repository.git/git-upload-pack', repositoryProxy);

  const publisherRepositoryProxy = async (
    c: Parameters<typeof errorResponse>[0],
  ): Promise<Response> => {
    const attemptId = c.req.param('attemptId');
    const executionId = c.req.header('x-delivery-execution-id');
    if (
      attemptId === undefined || !ATTEMPT_ID_PATTERN.test(attemptId) ||
      executionId === undefined || !EXECUTOR_ID_PATTERN.test(executionId)
    ) return errorResponse(c, 400, 'invalid_argument', 'invalid publisher repository identity', false);
    const runtime = options.repoWriteCredentialRuntime ?? repoWriteCredentialRuntimeFromEnv(c.env);
    if (runtime === null) {
      return errorResponse(c, 503, 'unavailable', 'publisher repository unavailable', true);
    }
    const credentials = new ExecutorPublisherCredentialStore(
      c.env.DB_CONTROL,
      runtime.provider,
      { encryptionKey: runtime.encryptionKey },
    );
    const isReceivePack = c.req.path.endsWith('/git-receive-pack') ||
      c.req.query('service') === 'git-receive-pack';
    try {
      if (isReceivePack) {
        const token = publisherGitToken(c.req.header('authorization'));
        if (token === null) {
          return errorResponse(c, 401, 'unauthenticated', 'publisher write token required', false);
        }
        const authorization = await credentials.authorizePush({
          attemptId,
          publisherExecutionId: executionId,
          rawToken: token,
          now: options.now?.() ?? new Date(),
        });
        return await proxyExecutorPublisherRepositoryWrite({
          request: c.req.raw,
          authorization,
          token,
          ...(options.executorRepositoryFetch === undefined
            ? {} : { fetch: options.executorRepositoryFetch }),
          ...((options.githubGitOrigin ?? c.env.GITHUB_GIT_BASE_URL) === undefined
            ? {}
            : { githubGitOrigin: options.githubGitOrigin ?? c.env.GITHUB_GIT_BASE_URL }),
        });
      }
      const identity = await publisherIdentity(c, attemptId);
      if (identity instanceof Response) return identity;
      const authorization = await credentials.authorizeRepositoryRead(
        identity,
        options.now?.() ?? new Date(),
      );
      const tokenProvider = options.executorRepositoryTokenProvider ??
        githubActionsRuntimeFromEnv(c.env)?.provider;
      if (tokenProvider === undefined) {
        return errorResponse(c, 503, 'unavailable', 'publisher repository unavailable', true);
      }
      return await proxyExecutorRepositoryRequest({
        request: c.req.raw,
        authorization,
        tokenProvider,
        ...(options.executorRepositoryFetch === undefined
          ? {} : { fetch: options.executorRepositoryFetch }),
        ...((options.githubGitOrigin ?? c.env.GITHUB_GIT_BASE_URL) === undefined
          ? {}
          : { githubGitOrigin: options.githubGitOrigin ?? c.env.GITHUB_GIT_BASE_URL }),
      });
    } catch (error) {
      if (error instanceof ExecutorPublisherCredentialError) {
        if (error.code === 'invalid_request') {
          return errorResponse(c, 400, 'invalid_argument', 'invalid publisher repository request', false);
        }
        if (error.code === 'provider_unavailable') {
          return errorResponse(c, 503, 'unavailable', 'publisher repository unavailable', true);
        }
        return errorResponse(c, 403, 'policy_denied', 'publisher repository denied', false);
      }
      if (error instanceof ExecutorRepositoryProxyError) {
        if (error.code === 'invalid_request') {
          return errorResponse(c, 400, 'invalid_argument', 'invalid publisher repository request', false);
        }
        if (error.code === 'upstream_rejected') {
          return errorResponse(c, 403, 'policy_denied', 'publisher repository rejected', false);
        }
        return errorResponse(c, 503, 'unavailable', 'publisher repository unavailable', true);
      }
      throw error;
    }
  };

  app.get(
    '/v1/attempts/:attemptId/executor-publisher/repository.git/info/refs',
    publisherRepositoryProxy,
  );
  app.post(
    '/v1/attempts/:attemptId/executor-publisher/repository.git/git-upload-pack',
    publisherRepositoryProxy,
  );
  app.post(
    '/v1/attempts/:attemptId/executor-publisher/repository.git/git-receive-pack',
    publisherRepositoryProxy,
  );

  app.post('/v1/attempts/:attemptId/executor-model/grants', async (c) => {
    const attemptId = c.req.param('attemptId');
    const executionId = c.req.header('x-delivery-execution-id');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (
      token === null || executionId === undefined ||
      !EXECUTOR_ID_PATTERN.test(executionId)
    ) return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    let body: unknown;
    try {
      body = await runnerBody(c);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid executor model grant body', false);
    }
    const parsed = ModelGrantBodySchema.safeParse(body);
    if (!parsed.success || parsed.data.executionId !== executionId) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid executor model grant body', false);
    }
    const encryptionKey = options.executorModelGrantEncryptionKey ??
      c.env.EXECUTOR_MODEL_GRANT_ENCRYPTION_KEY;
    if (encryptionKey === undefined) {
      return errorResponse(c, 503, 'unavailable', 'executor model grant unavailable', true);
    }
    try {
      const now = options.now?.() ?? new Date();
      const authorization = await new RunnerAttemptStore(c.env.DB_CONTROL).authorize(
        attemptId,
        token,
        now,
      );
      if (
        authorization.version !== parsed.data.expectedVersion ||
        authorization.leaseGeneration !== parsed.data.leaseGeneration
      ) return errorResponse(c, 409, 'conflict', 'attempt fencing changed', false);
      const result = await new ExecutorModelGrantStore(
        c.env.DB_CONTROL,
        encryptionKey,
      ).issue({
        authorization,
        executionId,
        reservationId: parsed.data.reservationId,
        now,
      });
      c.header('cache-control', 'no-store');
      return c.json(result, result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof RunnerAttemptError) return runnerError(c, error);
      if (error instanceof ExecutorModelGrantError) {
        if (error.code === 'invalid_request') {
          return errorResponse(c, 400, 'invalid_argument', 'invalid executor model grant body', false);
        }
        if (error.code === 'not_found') {
          return errorResponse(c, 404, 'not_found', 'executor model reservation unavailable', false);
        }
        return errorResponse(c, 409, 'conflict', 'executor model grant state changed', false);
      }
      return errorResponse(c, 503, 'unavailable', 'executor model grant unavailable', true);
    }
  });

  app.post('/v1/attempts/:attemptId/executor-model/v1/responses', async (c) => {
    const attemptId = c.req.param('attemptId');
    const executionId = c.req.header('x-delivery-execution-id');
    const containerId = c.req.header('x-delivery-executor-container-id');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    if (
      executionId === undefined ||
      !EXECUTOR_ID_PATTERN.test(executionId) || containerId === undefined ||
      containerId.length < 1 || containerId.length > 500
    ) return errorResponse(c, 401, 'unauthenticated', 'executor model identity required', false);
    const token = runnerToken(c.req.header('authorization'));
    if (token === null || token.length > 2_000) {
      return errorResponse(c, 401, 'unauthenticated', 'executor model grant required', false);
    }
    const runtime = options.executorModelProxyRuntime ?? executorModelProxyRuntimeFromEnv(c.env);
    const encryptionKey = options.executorModelGrantEncryptionKey ??
      c.env.EXECUTOR_MODEL_GRANT_ENCRYPTION_KEY;
    if (runtime === null || encryptionKey === undefined) {
      return errorResponse(c, 503, 'unavailable', 'executor model unavailable', true);
    }
    try {
      const authorized = await new ExecutorModelGrantStore(
        c.env.DB_CONTROL,
        encryptionKey,
      ).authorize({
        attemptId,
        executionId,
        rawToken: token,
        now: options.now?.() ?? new Date(),
      });
      return await proxyExecutorModelResponse({ request: c.req.raw, authorization: authorized, runtime });
    } catch (error) {
      if (error instanceof ExecutorModelGrantError) {
        return errorResponse(
          c,
          error.code === 'invalid_request' ? 400 : error.code === 'not_found' ? 401 : 409,
          error.code === 'invalid_request'
            ? 'invalid_argument'
            : error.code === 'not_found' ? 'unauthenticated' : 'conflict',
          error.code === 'not_found'
            ? 'executor model grant invalid'
            : 'executor model reservation unavailable',
          false,
        );
      }
      if (error instanceof ExecutorModelProxyError) {
        if (error.code === 'invalid_request') {
          return errorResponse(c, 400, 'invalid_argument', 'invalid executor model request', false);
        }
        if (error.code === 'policy_denied') {
          return errorResponse(c, 403, 'policy_denied', 'executor model request denied', false);
        }
        return errorResponse(c, 502, 'unavailable', 'executor model provider unavailable', true);
      }
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/automated-review-result', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c, MAX_PLAN_BODY_LENGTH);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid automated review result', false);
    }
    const store = new AutomatedReviewResultStore(
      c.env.DB_CONTROL,
      c.env.TASK_OBJECTS,
      configuredSecrets(c.env),
    );
    try {
      const now = options.now?.() ?? new Date();
      const authorization = await new RunnerAttemptStore(c.env.DB_CONTROL).authorize(
        attemptId,
        token,
        now,
      );
      const result = await store.complete(authorization, body, now);
      c.header('cache-control', 'no-store');
      return c.json({ accepted: true, ...result }, result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof RunnerAttemptError) {
        try {
          const replay = await store.replay(attemptId, token, body);
          c.header('cache-control', 'no-store');
          return c.json({ accepted: true, ...replay }, 200);
        } catch (replayError) {
          if (replayError instanceof AutomatedReviewError) {
            if (replayError.code === 'not_found') return runnerError(c, error);
            return automatedReviewError(c, replayError);
          }
          throw replayError;
        }
      }
      if (error instanceof AutomatedReviewError) return automatedReviewError(c, error);
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/head', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid execution head body', false);
    }
    const parsed = ExecutionHeadBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid execution head body', false);
    }
    try {
      const now = options.now?.() ?? new Date();
      const authorization = await new RunnerAttemptStore(c.env.DB_CONTROL).authorize(
        attemptId,
        token,
        now,
      );
      const result = await new ExecutionHeadStore(c.env.DB_CONTROL).record(
        authorization,
        parsed.data,
        now,
      );
      c.header('cache-control', 'no-store');
      return result.created ? c.json(result, 201) : c.json(result, 200);
    } catch (error) {
      if (error instanceof RunnerAttemptError) return runnerError(c, error);
      if (error instanceof ExecutionHeadError) {
        if (error.code === 'invalid_request') {
          return errorResponse(c, 400, 'invalid_argument', 'invalid execution head body', false);
        }
        return errorResponse(c, 409, 'conflict', 'execution head state changed', false);
      }
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/base-rebase/conflict', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid base rebase conflict body', false);
    }
    const parsed = BaseRebaseConflictReportSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid base rebase conflict body', false);
    }
    try {
      const now = options.now?.() ?? new Date();
      const store = new BaseRebaseAttemptStore(c.env.DB_CONTROL);
      let authorization;
      try {
        authorization = await new RunnerAttemptStore(c.env.DB_CONTROL).authorize(
          attemptId,
          token,
          now,
        );
      } catch (error) {
        if (error instanceof RunnerAttemptError) {
          const replay = await store.replayBlockedContentConflict(
            attemptId,
            token,
            parsed.data,
            now,
          );
          if (replay !== null) {
            c.header('cache-control', 'no-store');
            return c.json({ accepted: true, ...replay }, 200);
          }
        }
        throw error;
      }
      const result = await store.blockContentConflict(
        authorization,
        parsed.data,
        now,
      );
      c.header('cache-control', 'no-store');
      return c.json({ accepted: true, ...result }, result.created ? 202 : 200);
    } catch (error) {
      if (error instanceof RunnerAttemptError) return runnerError(c, error);
      if (error instanceof BaseRebaseAttemptError) {
        if (error.code === 'invalid_request') {
          return errorResponse(c, 400, 'invalid_argument', 'invalid base rebase conflict body', false);
        }
        if (error.code === 'not_found') {
          return errorResponse(c, 404, 'not_found', 'base rebase Attempt not found', false);
        }
        return errorResponse(c, 409, 'conflict', 'base rebase state changed', false);
      }
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/base-rebase/complete', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid base rebase completion body', false);
    }
    const parsed = BaseRebaseCompletionReportSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid base rebase completion body', false);
    }
    try {
      const now = options.now?.() ?? new Date();
      const authorization = await new RunnerAttemptStore(c.env.DB_CONTROL).authorize(
        attemptId,
        token,
        now,
      );
      const result = await new BaseRebaseAttemptStore(c.env.DB_CONTROL).complete(
        authorization,
        parsed.data,
        now,
      );
      c.header('cache-control', 'no-store');
      return result.created
        ? c.json({ accepted: true, ...result }, 201)
        : c.json({ accepted: true, ...result }, 200);
    } catch (error) {
      if (error instanceof RunnerAttemptError) return runnerError(c, error);
      if (error instanceof BaseRebaseAttemptError) {
        if (error.code === 'invalid_request') {
          return errorResponse(c, 400, 'invalid_argument', 'invalid base rebase completion body', false);
        }
        if (error.code === 'not_found') {
          return errorResponse(c, 404, 'not_found', 'base rebase Attempt not found', false);
        }
        return errorResponse(c, 409, 'conflict', 'base rebase state changed', false);
      }
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/tools/authorize', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'tool token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c, MAX_TOOL_CALL_BODY_LENGTH);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid tool authorization body', false);
    }
    const parsed = ToolAuthorizationBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid tool authorization body', false);
    }
    try {
      const authorization = await new RunnerAttemptStore(c.env.DB_CONTROL).authorizeTool(
        attemptId,
        token,
      );
      const spec = trustedToolSpec(parsed.data.toolPath);
      if (spec === null) {
        return errorResponse(c, 403, 'policy_denied', 'tool path denied', false);
      }
      const action = toolActionFor(spec.scope);
      if (!authorization.scopes.includes(action) || spec.effect !== 'read') {
        return errorResponse(c, 403, 'policy_denied', 'tool call scope denied', false);
      }
      const traceId = directToolTraceId(spec.path);
      await new QuotaControlStore(c.env.DB_CONTROL).admitToolCall({
        traceId,
        attemptId: authorization.attemptId,
        occurredAt: (options.now?.() ?? new Date()).toISOString(),
      });
      c.header('cache-control', 'no-store');
      return c.json({
        authorized: true,
        traceId,
        toolPath: spec.path,
        action,
        effect: spec.effect,
      });
    } catch (error) {
      if (error instanceof RunnerAttemptError) return runnerError(c, error);
      if (error instanceof QuotaControlError && error.code === 'quota_exceeded') {
        c.header('cache-control', 'no-store');
        return errorResponse(c, 429, 'rate_limited', 'tool call quota exceeded', true);
      }
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/tools/observe', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'tool token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c, MAX_TOOL_CALL_BODY_LENGTH);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid tool observation body', false);
    }
    const parsed = ToolObservationBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid tool observation body', false);
    }
    try {
      const authorization = await new RunnerAttemptStore(c.env.DB_CONTROL).authorizeTool(
        attemptId,
        token,
      );
      const spec = trustedToolSpec(parsed.data.toolPath);
      if (spec === null) {
        return errorResponse(c, 403, 'policy_denied', 'tool path denied', false);
      }
      if (!directToolTraceMatches(parsed.data.traceId, spec.path)) {
        return errorResponse(c, 409, 'conflict', 'tool observation state changed', false);
      }
      const action = toolActionFor(spec.scope);
      if (!authorization.scopes.includes(action) || spec.effect !== 'read') {
        return errorResponse(c, 403, 'policy_denied', 'tool call scope denied', false);
      }
      const disposition = await new ToolCallTraceStore(c.env.DB_CONTROL).writeAuthorized({
        traceId: parsed.data.traceId,
        runId: authorization.runId,
        attemptId: authorization.attemptId,
        toolPath: spec.path,
        action,
        effect: spec.effect,
        durationMs: parsed.data.durationMs,
        resultCategory: parsed.data.resultCategory,
        occurredAt: parsed.data.occurredAt,
      });
      c.header('cache-control', 'no-store');
      return c.json({ accepted: true, traceId: parsed.data.traceId, disposition });
    } catch (error) {
      if (error instanceof RunnerAttemptError) return runnerError(c, error);
      if (error instanceof ToolCallTraceStoreError) {
        return errorResponse(c, 409, 'conflict', 'tool observation state changed', false);
      }
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/tools/call', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'tool token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c, MAX_TOOL_CALL_BODY_LENGTH);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid tool call body', false);
    }
    const parsed = ToolCallBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid tool call body', false);
    }

    try {
      const authorization = await new RunnerAttemptStore(c.env.DB_CONTROL).authorizeTool(
        attemptId,
        token,
      );
      const spec = trustedToolSpec(parsed.data.toolPath);
      if (spec === null) {
        return errorResponse(c, 403, 'policy_denied', 'tool path denied', false);
      }

      const traceId = `tooltrace_${crypto.randomUUID()}`;
      const action = toolActionFor(spec.scope);
      const startedAt = monotonicNow();
      const traces = new ToolCallTraceStore(c.env.DB_CONTROL);
      const record = async (resultCategory: ToolCallResultCategory): Promise<void> => {
        await traces.write({
          traceId,
          runId: authorization.runId,
          attemptId: authorization.attemptId,
          toolPath: spec.path,
          action,
          effect: spec.effect,
          durationMs: boundedToolCallDuration(startedAt, monotonicNow()),
          resultCategory,
          occurredAt: new Date().toISOString(),
        });
      };

      // Phase 3 triage is read-only. A future non-read catalog entry still fails closed here.
      if (!authorization.scopes.includes(action) || spec.effect !== 'read') {
        await record('policy_denied');
        c.header('cache-control', 'no-store');
        return errorResponse(c, 403, 'policy_denied', 'tool call scope denied', false);
      }

      await new QuotaControlStore(c.env.DB_CONTROL).admitToolCall({
        traceId,
        attemptId: authorization.attemptId,
        occurredAt: (options.now?.() ?? new Date()).toISOString(),
      });

      const client = options.toolBridgeClient ?? toolBridgeClientFromEnv(c.env);
      let result: ToolBridgeCallResult;
      if (client === null) {
        result = { ok: false, category: 'unavailable', retryable: true };
      } else {
        try {
          result = await client.call({
            traceId,
            runId: authorization.runId,
            attemptId: authorization.attemptId,
            toolPath: spec.path,
            arguments: parsed.data.arguments,
          });
        } catch {
          result = { ok: false, category: 'unavailable', retryable: true };
        }
      }

      const category = result.ok ? 'success' : result.category;
      await record(category);
      c.header('cache-control', 'no-store');
      if (!result.ok) {
        return toolBridgeFailureResponse(c, result.category, result.retryable);
      }
      return c.json({ ok: true, traceId, result: result.result });
    } catch (error) {
      if (error instanceof RunnerAttemptError) return runnerError(c, error);
      if (error instanceof QuotaControlError && error.code === 'quota_exceeded') {
        c.header('cache-control', 'no-store');
        return errorResponse(c, 429, 'rate_limited', 'tool call quota exceeded', true);
      }
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/diagnostic-evidence', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c, MAX_DIAGNOSTIC_EVIDENCE_BODY_LENGTH);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid diagnostic Evidence body', false);
    }
    const parsed = DiagnosticEvidenceV1Schema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid diagnostic Evidence body', false);
    }
    try {
      const now = options.now?.() ?? new Date();
      const authorization = await new RunnerAttemptStore(c.env.DB_CONTROL).authorize(
        attemptId,
        token,
        now,
      );
      const result = await new DiagnosticEvidenceStore(c.env.DB_CONTROL).create(
        authorization,
        parsed.data,
        now,
        [token, ...configuredSecrets(c.env)],
      );
      c.header('cache-control', 'no-store');
      return result.created ? c.json(result, 201) : c.json(result, 200);
    } catch (error) {
      if (error instanceof RunnerAttemptError) return runnerError(c, error);
      if (error instanceof DiagnosticEvidenceError) return diagnosticEvidenceError(c, error);
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/model-reservations', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid model reservation body', false);
    }
    const parsed = ModelReservationBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid model reservation body', false);
    }
    try {
      const now = options.now?.() ?? new Date();
      const authorization = await new RunnerAttemptStore(c.env.DB_CONTROL).authorize(
        attemptId,
        token,
        now,
      );
      if (
        authorization.version !== parsed.data.expectedVersion ||
        authorization.leaseGeneration !== parsed.data.leaseGeneration
      ) return errorResponse(c, 409, 'conflict', 'attempt fencing changed', false);
      const result = await new QuotaControlStore(c.env.DB_CONTROL).reserveModelCall({
        reservationId: parsed.data.reservationId,
        attemptId,
        profileId: parsed.data.profileId,
        occurredAt: now.toISOString(),
      });
      c.header('cache-control', 'no-store');
      return c.json(result, result.disposition === 'created' ? 201 : 200);
    } catch (error) {
      if (error instanceof RunnerAttemptError) return runnerError(c, error);
      if (error instanceof QuotaControlError) return quotaError(c, error);
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/model-usage', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid model usage body', false);
    }
    const parsed = ModelUsageBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid model usage body', false);
    }
    try {
      const now = options.now?.() ?? new Date();
      const authorization = await new RunnerAttemptStore(c.env.DB_CONTROL).authorize(
        attemptId,
        token,
        now,
      );
      if (
        authorization.version !== parsed.data.expectedVersion ||
        authorization.leaseGeneration !== parsed.data.leaseGeneration
      ) return errorResponse(c, 409, 'conflict', 'attempt fencing changed', false);
      const result = await new QuotaControlStore(c.env.DB_CONTROL).settleModelCall({
        reservationId: parsed.data.reservationId,
        usageId: parsed.data.usageId,
        attemptId,
        inputTokens: parsed.data.inputTokens,
        cachedInputTokens: parsed.data.cachedInputTokens,
        outputTokens: parsed.data.outputTokens,
        reasoningOutputTokens: parsed.data.reasoningOutputTokens,
        occurredAt: now.toISOString(),
      });
      c.header('cache-control', 'no-store');
      return c.json(result, result.disposition === 'created' ? 201 : 200);
    } catch (error) {
      if (error instanceof RunnerAttemptError) return runnerError(c, error);
      if (error instanceof QuotaControlError) return quotaError(c, error);
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/events', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt event body', false);
    }
    const parsed = AttemptFailureReportV1Schema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt event body', false);
    }
    const now = options.now?.() ?? new Date();
    const failures = new AttemptFailureStore(c.env.DB_CONTROL);
    try {
      let result;
      try {
        const authorization = await new RunnerAttemptStore(c.env.DB_CONTROL).authorize(
          attemptId,
          token,
          now,
        );
        result = await failures.report(authorization, token, parsed.data, now);
      } catch (error) {
        if (!(error instanceof RunnerAttemptError)) throw error;
        const replay = await failures.replayAnalysis(attemptId, token, parsed.data, now);
        if (replay === null) throw error;
        result = replay;
      }
      c.header('cache-control', 'no-store');
      return c.json({ accepted: true, ...result }, 202);
    } catch (error) {
      if (error instanceof RunnerAttemptError) return runnerError(c, error);
      if (error instanceof AttemptFailureError) {
        return errorResponse(c, 409, 'conflict', 'attempt failure state changed', false);
      }
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/plan-revision', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid Plan revision body', false);
    }
    const parsed = ReviewPlanRevisionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid Plan revision body', false);
    }
    try {
      const now = options.now?.() ?? new Date();
      const revisions = new PlanRevisionStore(c.env.DB_CONTROL);
      let result;
      try {
        const authorization = await new RunnerAttemptStore(c.env.DB_CONTROL).authorize(
          attemptId,
          token,
          now,
        );
        result = await revisions.beginFromReviewFeedback(authorization, parsed.data, now);
      } catch (error) {
        if (!(error instanceof RunnerAttemptError)) throw error;
        const replay = await revisions.replayFromReviewFeedback(
          attemptId,
          token,
          parsed.data,
          now,
        );
        if (replay === null) throw error;
        result = replay;
      }
      c.header('cache-control', 'no-store');
      const response = { accepted: true, ...result };
      return result.created ? c.json(response, 202) : c.json(response, 200);
    } catch (error) {
      if (error instanceof RunnerAttemptError) return runnerError(c, error);
      if (error instanceof PlanRevisionError) return planRevisionError(c, error);
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/plan', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c, MAX_PLAN_BODY_LENGTH);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid analysis Plan body', false);
    }
    const parsed = AnalysisPlanContentV1Schema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid analysis Plan body', false);
    }
    try {
      const authorization = await new RunnerAttemptStore(c.env.DB_CONTROL).authorize(
        attemptId,
        token,
      );
      const result = await new AnalysisPlanProposalStore(c.env.DB_CONTROL).save(
        authorization,
        parsed.data,
        new Date().toISOString(),
        [token, ...configuredSecrets(c.env)],
      );
      const response = {
        planId: result.plan.id,
        version: result.plan.version,
        digest: result.plan.digest,
        status: result.plan.status,
        payloadRef: `d1://execution-plans/${result.plan.id}`,
      };
      c.header('cache-control', 'no-store');
      return result.created ? c.json(response, 201) : c.json(response, 200);
    } catch (error) {
      if (error instanceof RunnerAttemptError) return runnerError(c, error);
      if (error instanceof AnalysisAttemptError) return analysisError(c, error);
      if (error instanceof ExecutionPlanValidationError) {
        return errorResponse(c, 400, 'invalid_argument', 'analysis Plan validation failed', false);
      }
      if (error instanceof ExecutionPlanPersistenceError) {
        return errorResponse(c, 409, 'conflict', 'analysis Plan persistence conflict', false);
      }
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/heartbeat', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid heartbeat body', false);
    }
    const parsed = HeartbeatBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid heartbeat body', false);
    }
    try {
      const result = await new RunnerAttemptStore(c.env.DB_CONTROL).heartbeat(
        attemptId,
        token,
        parsed.data,
      );
      c.header('cache-control', 'no-store');
      return c.json(result);
    } catch (error) {
      if (error instanceof RunnerAttemptError) return runnerError(c, error);
      throw error;
    }
  });

  // Diagnostic breadcrumb: the runner reports crossing each pre-heartbeat
  // startup stage. Because the analysis runner's stderr is not captured by the
  // sandbox logs, this control-plane row is the only durable signal of where an
  // intermittent startup freeze stalls. Fire-and-forget from the runner; a 202
  // acknowledges receipt without implying any state transition.
  app.post('/v1/attempts/:attemptId/runner-stage', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid runner stage body', false);
    }
    const parsed = RunnerStageBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid runner stage body', false);
    }
    try {
      await new RunnerStartupStageStore(c.env.DB_CONTROL).record(
        attemptId,
        token,
        parsed.data.stage,
        options.now?.() ?? new Date(),
      );
      c.header('cache-control', 'no-store');
      return c.body(null, 202);
    } catch (error) {
      if (error instanceof RunnerAttemptError) return runnerError(c, error);
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/github/write-token', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid repo_write credential body', false);
    }
    const parsed = RepoWriteCredentialBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid repo_write credential body', false);
    }
    try {
      const now = options.now?.() ?? new Date();
      const authorization = await new RunnerAttemptStore(c.env.DB_CONTROL).authorize(
        attemptId,
        token,
        now,
      );
      if (
        authorization.version !== parsed.data.expectedVersion ||
        authorization.leaseGeneration !== parsed.data.leaseGeneration
      ) {
        return errorResponse(c, 409, 'conflict', 'attempt state changed', false);
      }
      const runtime = options.repoWriteCredentialRuntime ??
        repoWriteCredentialRuntimeFromEnv(c.env);
      if (runtime === null) {
        return errorResponse(c, 503, 'unavailable', 'repo_write credential broker unavailable', true);
      }
      const result = await new RepoWriteCredentialStore(
        c.env.DB_CONTROL,
        runtime.provider,
        { encryptionKey: runtime.encryptionKey },
      ).issue(authorization, now);
      c.header('cache-control', 'no-store');
      return result.created ? c.json(result, 201) : c.json(result, 200);
    } catch (error) {
      if (error instanceof RunnerAttemptError) return runnerError(c, error);
      if (error instanceof RepoWriteCredentialError) {
        switch (error.code) {
          case 'not_found':
            return errorResponse(c, 404, 'not_found', 'attempt not found', false);
          case 'policy_denied':
          case 'approval_required':
            return errorResponse(c, 403, 'policy_denied', 'repo_write approval required', false);
          case 'provider_unavailable':
            return errorResponse(c, 503, 'unavailable', 'GitHub credential unavailable', true);
          case 'credential_issuing':
            return errorResponse(c, 409, 'conflict', 'GitHub credential issuance in progress', true);
          case 'state_conflict':
          case 'credential_conflict':
            return errorResponse(c, 409, 'conflict', 'repo_write credential state changed', false);
        }
      }
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/protected-path-changes', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c, MAX_TOOL_CALL_BODY_LENGTH);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid protected path report', false);
    }
    const parsed = ProtectedPathChangeBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid protected path report', false);
    }
    try {
      const now = options.now?.() ?? new Date();
      const authorization = await new RunnerAttemptStore(c.env.DB_CONTROL).authorize(
        attemptId,
        token,
        now,
      );
      if (
        authorization.version !== parsed.data.expectedVersion ||
        authorization.leaseGeneration !== parsed.data.leaseGeneration
      ) {
        return errorResponse(c, 409, 'conflict', 'attempt state changed', false);
      }
      const result = await new ProtectedPathApprovalStore(c.env.DB_CONTROL).request(
        authorization,
        parsed.data.report,
        now,
      );
      c.header('cache-control', 'no-store');
      return c.json(result, 202);
    } catch (error) {
      if (error instanceof RunnerAttemptError) return runnerError(c, error);
      if (error instanceof ProtectedPathApprovalError) {
        if (error.code === 'invalid_request') {
          return errorResponse(c, 400, 'invalid_argument', 'invalid protected path report', false);
        }
        return errorResponse(c, 409, 'conflict', 'protected path gate state changed', false);
      }
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/verifications', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c, MAX_TOOL_CALL_BODY_LENGTH);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid verification manifest', false);
    }
    const parsed = VerificationStartBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid verification manifest', false);
    }
    try {
      const now = options.now?.() ?? new Date();
      const authorization = await new RunnerAttemptStore(c.env.DB_CONTROL).authorize(
        attemptId,
        token,
        now,
      );
      if (
        authorization.version !== parsed.data.expectedVersion ||
        authorization.leaseGeneration !== parsed.data.leaseGeneration
      ) {
        return errorResponse(c, 409, 'conflict', 'attempt state changed', false);
      }
      const result = await new VerificationEvidenceStore(c.env.DB_CONTROL).start(
        authorization,
        parsed.data.manifest,
        now,
      );
      c.header('cache-control', 'no-store');
      return result.created ? c.json(result, 201) : c.json(result, 200);
    } catch (error) {
      if (error instanceof RunnerAttemptError) return runnerError(c, error);
      if (error instanceof VerificationEvidenceError) {
        if (error.code === 'invalid_request') {
          return errorResponse(c, 400, 'invalid_argument', 'invalid verification manifest', false);
        }
        return errorResponse(c, 409, 'conflict', 'verification state changed', false);
      }
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/verifications/:suiteId/results', async (c) => {
    const attemptId = c.req.param('attemptId');
    const suiteId = c.req.param('suiteId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId) || !ATTEMPT_ID_PATTERN.test(suiteId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid verification identity', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c, MAX_TOOL_CALL_BODY_LENGTH);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid verification result', false);
    }
    const parsed = VerificationResultBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid verification result', false);
    }
    try {
      const now = options.now?.() ?? new Date();
      const authorization = await new RunnerAttemptStore(c.env.DB_CONTROL).authorize(
        attemptId,
        token,
        now,
      );
      if (
        authorization.version !== parsed.data.expectedVersion ||
        authorization.leaseGeneration !== parsed.data.leaseGeneration
      ) {
        return errorResponse(c, 409, 'conflict', 'attempt state changed', false);
      }
      const result = await new VerificationEvidenceStore(c.env.DB_CONTROL).record(
        authorization,
        suiteId,
        parsed.data.result,
        now,
      );
      c.header('cache-control', 'no-store');
      return result.created ? c.json(result, 201) : c.json(result, 200);
    } catch (error) {
      if (error instanceof RunnerAttemptError) return runnerError(c, error);
      if (error instanceof VerificationEvidenceError) {
        if (error.code === 'invalid_request') {
          return errorResponse(c, 400, 'invalid_argument', 'invalid verification result', false);
        }
        return errorResponse(c, 409, 'conflict', 'verification state changed', false);
      }
      throw error;
    }
  });

  app.put('/v1/attempts/:attemptId/checkpoint', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c, MAX_CHECKPOINT_BODY_LENGTH);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid checkpoint body', false);
    }
    const parsed = CheckpointBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid checkpoint body', false);
    }
    const registeredSecrets = configuredSecrets(c.env);
    try {
      const result = await new AgentCheckpointStore(
        c.env.DB_CONTROL,
        c.env.CHECKPOINT_OBJECTS,
      ).save(attemptId, token, {
        ...parsed.data,
        registeredSecrets,
      });
      c.header('cache-control', 'no-store');
      return result.created ? c.json(result, 201) : c.json(result, 200);
    } catch (error) {
      if (error instanceof AgentCheckpointError) return checkpointError(c, error);
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/artifacts', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c, MAX_ARTIFACT_BODY_LENGTH);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid artifact body', false);
    }
    const parsed = RawAgentArtifactRequestBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid artifact body', false);
    }
    if (c.env.RAW_AGENT_ARTIFACT_ENCRYPTION_KEY === undefined) {
      return errorResponse(c, 503, 'unavailable', 'artifact storage unavailable', true);
    }
    try {
      const result = await new RawAgentArtifactStore(
        c.env.DB_CONTROL,
        c.env.RAW_AGENT_OBJECTS,
        c.env.RAW_AGENT_ARTIFACT_ENCRYPTION_KEY,
        { secrets: configuredSecrets(c.env) },
      ).save(attemptId, token, parsed.data);
      c.header('cache-control', 'no-store');
      if (result.status === 'uploading') {
        return c.json({ accepted: true, ...result }, 202);
      }
      return c.json({ accepted: true, ...result }, result.created ? 201 : 200);
    } catch (error) {
      if (!(error instanceof RawAgentArtifactError)) throw error;
      if (error.code === 'invalid_request') {
        return errorResponse(c, 400, 'invalid_argument', 'invalid artifact body', false);
      }
      if (error.code === 'invalid_token') {
        return errorResponse(c, 401, 'unauthenticated', 'attempt token rejected', false);
      }
      if (error.code === 'policy_denied' || error.code === 'secret_detected') {
        return errorResponse(c, 403, 'policy_denied', 'artifact write denied', false);
      }
      if (error.code === 'state_conflict' || error.code === 'payload_conflict') {
        return errorResponse(c, 409, 'conflict', 'artifact state changed', false);
      }
      return errorResponse(c, 503, 'unavailable', 'artifact storage unavailable', true);
    }
  });

  app.post('/v1/attempts/:attemptId/executor-patches', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c, MAX_EXECUTOR_PATCH_BODY_LENGTH);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid executor patch body', false);
    }
    if (!ExecutorPatchUploadRequestSchema.safeParse(body).success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid executor patch body', false);
    }
    const registry = options.executorPluginRegistry ?? executorPluginRegistryFromEnv(c.env);
    if (registry === null) {
      return errorResponse(c, 503, 'unavailable', 'executor patch storage unavailable', true);
    }
    try {
      const result = await new ExecutorPatchArtifactStore(
        c.env.DB_CONTROL,
        c.env.EXECUTOR_PATCH_OBJECTS,
        registry,
        { secrets: configuredSecrets(c.env), ...(options.now === undefined ? {} : { now: options.now }) },
      ).saveWorkPatch(attemptId, token, body);
      c.header('cache-control', 'no-store');
      return c.json(result, result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof ExecutorPatchArtifactError) return executorPatchError(c, error);
      throw error;
    }
  });

  app.get('/v1/attempts/:attemptId/executor-patches/:patchId', async (c) => {
    const attemptId = c.req.param('attemptId');
    const patchId = c.req.param('patchId');
    const authorization = c.req.header('authorization');
    const executionId = c.req.header('x-delivery-execution-id');
    const containerId = c.req.header('x-delivery-executor-container-id');
    if (!ATTEMPT_ID_PATTERN.test(attemptId) || !EXECUTOR_ID_PATTERN.test(patchId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid executor patch identity', false);
    }
    if (
      authorization === undefined || !authorization.startsWith('Bearer ') ||
      authorization.length > 4_103 || executionId === undefined ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(executionId) ||
      containerId === undefined || containerId.length < 1 || containerId.length > 500
    ) return errorResponse(c, 401, 'unauthenticated', 'executor identity required', false);
    const provider = options.executorIdentityProvider ?? executorIdentityProviderFromEnv(c.env);
    const registry = options.executorPluginRegistry ?? executorPluginRegistryFromEnv(c.env);
    if (provider === null || registry === null) {
      return errorResponse(c, 503, 'unavailable', 'executor patch storage unavailable', true);
    }
    let identity;
    try {
      identity = await provider.verify({
        executionId,
        attemptId,
        payload: { authorization, executionId, containerId },
      });
    } catch {
      return errorResponse(c, 401, 'unauthenticated', 'executor identity invalid', false);
    }
    try {
      const result = await new ExecutorPatchArtifactStore(
        c.env.DB_CONTROL,
        c.env.EXECUTOR_PATCH_OBJECTS,
        registry,
        { secrets: configuredSecrets(c.env), ...(options.now === undefined ? {} : { now: options.now }) },
      ).loadPublisherPatch(identity, patchId);
      c.header('cache-control', 'no-store');
      return c.json(result);
    } catch (error) {
      if (error instanceof ExecutorPatchArtifactError) return executorPatchError(c, error);
      throw error;
    }
  });

  const publisherCredentialError = (
    c: Parameters<typeof errorResponse>[0],
    error: ExecutorPublisherCredentialError,
  ): Response => {
    if (error.code === 'invalid_request') {
      return errorResponse(c, 400, 'invalid_argument', 'invalid publisher request', false);
    }
    if (error.code === 'not_found') {
      return errorResponse(c, 404, 'not_found', 'publisher authority not found', false);
    }
    if (error.code === 'policy_denied' || error.code === 'approval_required') {
      return errorResponse(c, 403, 'policy_denied', 'publisher authority denied', false);
    }
    if (error.code === 'provider_unavailable') {
      return errorResponse(c, 503, 'unavailable', 'publisher authority unavailable', true);
    }
    return errorResponse(c, 409, 'conflict', 'publisher authority state changed', false);
  };

  app.post('/v1/attempts/:attemptId/executor-publisher/write-token', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    let body: unknown;
    try { body = await runnerBody(c); } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid publisher credential body', false);
    }
    const parsed = PublisherIdentityBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid publisher credential body', false);
    }
    const identity = await publisherIdentity(c, attemptId);
    if (identity instanceof Response) return identity;
    const runtime = options.repoWriteCredentialRuntime ?? repoWriteCredentialRuntimeFromEnv(c.env);
    if (runtime === null) {
      return errorResponse(c, 503, 'unavailable', 'publisher authority unavailable', true);
    }
    try {
      const result = await new ExecutorPublisherCredentialStore(
        c.env.DB_CONTROL,
        runtime.provider,
        { encryptionKey: runtime.encryptionKey },
      ).issue(identity, parsed.data.publicationId, options.now?.() ?? new Date());
      c.header('cache-control', 'no-store');
      return c.json(result, result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof ExecutorPublisherCredentialError) {
        return publisherCredentialError(c, error);
      }
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/executor-publisher/head', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    let body: unknown;
    try { body = await runnerBody(c); } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid publisher head body', false);
    }
    const parsed = PublisherHeadBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid publisher head body', false);
    }
    const identity = await publisherIdentity(c, attemptId);
    if (identity instanceof Response) return identity;
    const runtime = options.repoWriteCredentialRuntime ?? repoWriteCredentialRuntimeFromEnv(c.env);
    if (runtime === null) {
      return errorResponse(c, 503, 'unavailable', 'publisher authority unavailable', true);
    }
    try {
      const authorization = await new ExecutorPublisherCredentialStore(
        c.env.DB_CONTROL,
        runtime.provider,
        { encryptionKey: runtime.encryptionKey },
      ).authorizeAttempt(identity, parsed.data.publicationId, options.now?.() ?? new Date());
      const result = await new ExecutionHeadStore(c.env.DB_CONTROL).record(authorization, {
        expectedVersion: authorization.version,
        leaseGeneration: authorization.leaseGeneration,
        parentSha: parsed.data.parentSha,
        headSha: parsed.data.headSha,
        branch: parsed.data.branch,
      }, options.now?.() ?? new Date());
      c.header('cache-control', 'no-store');
      return c.json(result, result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof ExecutorPublisherCredentialError) {
        return publisherCredentialError(c, error);
      }
      if (error instanceof ExecutionHeadError) {
        return errorResponse(c, 409, 'conflict', 'publisher head state changed', false);
      }
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/executor-publisher/verifications', async (c) => {
    const attemptId = c.req.param('attemptId');
    let body: unknown;
    try { body = await runnerBody(c, MAX_TOOL_CALL_BODY_LENGTH); } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid publisher verification', false);
    }
    const parsed = PublisherVerificationStartBodySchema.safeParse(body);
    if (!ATTEMPT_ID_PATTERN.test(attemptId) || !parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid publisher verification', false);
    }
    const identity = await publisherIdentity(c, attemptId);
    if (identity instanceof Response) return identity;
    const runtime = options.repoWriteCredentialRuntime ?? repoWriteCredentialRuntimeFromEnv(c.env);
    if (runtime === null) return errorResponse(c, 503, 'unavailable', 'publisher unavailable', true);
    try {
      const authorization = await new ExecutorPublisherCredentialStore(
        c.env.DB_CONTROL, runtime.provider, { encryptionKey: runtime.encryptionKey },
      ).authorizeAttempt(identity, parsed.data.publicationId, options.now?.() ?? new Date());
      const result = await new VerificationEvidenceStore(c.env.DB_CONTROL).start(
        authorization,
        parsed.data.manifest,
        options.now?.() ?? new Date(),
      );
      c.header('cache-control', 'no-store');
      return c.json(result, result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof ExecutorPublisherCredentialError) return publisherCredentialError(c, error);
      if (error instanceof VerificationEvidenceError) {
        return errorResponse(c, 409, 'conflict', 'publisher verification changed', false);
      }
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/executor-publisher/verifications/:suiteId/results', async (c) => {
    const attemptId = c.req.param('attemptId');
    const suiteId = c.req.param('suiteId');
    let body: unknown;
    try { body = await runnerBody(c, MAX_TOOL_CALL_BODY_LENGTH); } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid publisher verification', false);
    }
    const parsed = PublisherVerificationResultBodySchema.safeParse(body);
    if (
      !ATTEMPT_ID_PATTERN.test(attemptId) || !ATTEMPT_ID_PATTERN.test(suiteId) || !parsed.success
    ) return errorResponse(c, 400, 'invalid_argument', 'invalid publisher verification', false);
    const identity = await publisherIdentity(c, attemptId);
    if (identity instanceof Response) return identity;
    const runtime = options.repoWriteCredentialRuntime ?? repoWriteCredentialRuntimeFromEnv(c.env);
    if (runtime === null) return errorResponse(c, 503, 'unavailable', 'publisher unavailable', true);
    try {
      const authorization = await new ExecutorPublisherCredentialStore(
        c.env.DB_CONTROL, runtime.provider, { encryptionKey: runtime.encryptionKey },
      ).authorizeAttempt(identity, parsed.data.publicationId, options.now?.() ?? new Date());
      const result = await new VerificationEvidenceStore(c.env.DB_CONTROL).record(
        authorization,
        suiteId,
        parsed.data.result,
        options.now?.() ?? new Date(),
      );
      c.header('cache-control', 'no-store');
      return c.json(result, result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof ExecutorPublisherCredentialError) return publisherCredentialError(c, error);
      if (error instanceof VerificationEvidenceError) {
        return errorResponse(c, 409, 'conflict', 'publisher verification changed', false);
      }
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/executor-publisher/complete', async (c) => {
    const attemptId = c.req.param('attemptId');
    let body: unknown;
    try { body = await runnerBody(c, MAX_TOOL_CALL_BODY_LENGTH); } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid publisher completion', false);
    }
    const parsed = PublisherCompletionBodySchema.safeParse(body);
    if (!ATTEMPT_ID_PATTERN.test(attemptId) || !parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid publisher completion', false);
    }
    const identity = await publisherIdentity(c, attemptId);
    if (identity instanceof Response) return identity;
    const registry = options.executorPluginRegistry ?? executorPluginRegistryFromEnv(c.env);
    const runtime = options.repoWriteCredentialRuntime ?? repoWriteCredentialRuntimeFromEnv(c.env);
    if (registry === null || runtime === null) {
      return errorResponse(c, 503, 'unavailable', 'publisher completion unavailable', true);
    }
    const credentials = new ExecutorPublisherCredentialStore(
      c.env.DB_CONTROL, runtime.provider, { encryptionKey: runtime.encryptionKey },
    );
    try {
      await credentials.revoke(
        parsed.data.publicationId,
        identity.executionId,
        options.now?.() ?? new Date(),
      );
      await new ExecutorPatchPublicationStore(c.env.DB_CONTROL, registry)
        .completeVerifiedPublication({
          ...parsed.data,
          publisherExecutionId: identity.executionId,
          now: options.now?.() ?? new Date(),
        });
      c.header('cache-control', 'no-store');
      return c.json({ accepted: true });
    } catch (error) {
      if (error instanceof ExecutorPublisherCredentialError) return publisherCredentialError(c, error);
      if (error instanceof ExecutorPatchPublicationError) {
        return errorResponse(c, 409, 'conflict', 'publisher completion changed', false);
      }
      throw error;
    }
  });

  app.post('/v1/attempts/:attemptId/complete', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid attempt id', false);
    }
    const token = runnerToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'attempt token required', false);
    }
    let body: unknown;
    try {
      body = await runnerBody(c);
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid completion body', false);
    }
    const parsed = CompletionBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid completion body', false);
    }
    try {
      const result = await new RunnerAttemptStore(c.env.DB_CONTROL).complete(
        attemptId,
        token,
        parsed.data,
      );
      c.header('cache-control', 'no-store');
      return c.json({ accepted: true, ...result }, 202);
    } catch (error) {
      if (error instanceof RunnerAttemptError) return runnerError(c, error);
      throw error;
    }
  });

  return app;
}
