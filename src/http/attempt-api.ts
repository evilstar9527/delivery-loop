import { Hono } from 'hono';
import { z } from 'zod';
import { AnalysisPlanContentV1Schema } from '../domain/analysis-plan.js';
import { AgentCheckpointV1Schema } from '../domain/checkpoint.js';
import { RawAgentArtifactRequestBodySchema } from '../domain/raw-agent-artifact.js';
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
import { ToolCallTraceStore } from '../storage/tool-call-trace-store.js';
import {
  DiagnosticEvidenceError,
  DiagnosticEvidenceStore,
} from '../storage/diagnostic-evidence-store.js';
import {
  RawAgentArtifactError,
  RawAgentArtifactStore,
} from '../storage/raw-agent-artifact-store.js';
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

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MAX_OIDC_TOKEN_LENGTH = 20_000;
const MAX_RUNNER_BODY_LENGTH = 16 * 1_024;
const MAX_PLAN_BODY_LENGTH = 256 * 1_024;
const MAX_CHECKPOINT_BODY_LENGTH = 256 * 1_024;
const MAX_ARTIFACT_BODY_LENGTH = 1_100_000;
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

const HeartbeatBodySchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    leaseGeneration: z.number().int().positive(),
  })
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

const CheckpointBodySchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    leaseGeneration: z.number().int().positive(),
    checkpoint: AgentCheckpointV1Schema,
  })
  .strict();

const ToolCallBodySchema = z
  .object({
    toolPath: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

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
}

export function attemptApi(options: AttemptApiOptions = {}): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  const monotonicNow = options.monotonicNow ?? (() => performance.now());

  app.post('/v1/attempts/:attemptId/exchange', async (c) => {
    const attemptId = c.req.param('attemptId');
    if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
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
      const authorization = await new RunnerAttemptStore(c.env.DB_CONTROL).authorize(
        attemptId,
        token,
        now,
      );
      const result = await new PlanRevisionStore(c.env.DB_CONTROL).beginFromReviewFeedback(
        authorization,
        parsed.data,
        now,
      );
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
