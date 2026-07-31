import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { GitHubAppCredentialError } from '../auth/github-app-installation-token.js';
import { canonicalSha256 } from '../domain/digest.js';
import { VERIFY_ANALYSIS_REPLAY_STEP } from '../domain/workflow-replay.js';
import {
  TaskEnvelopeSchema,
  taskRevisionDigest,
  taskRevisionIds,
} from '../domain/task.js';
import type { Bindings } from '../env.js';
import {
  GitHubBaseResolutionError,
  type GitHubBaseResolutionErrorCode,
  type GitHubBaseShaResolver,
} from '../reconciliation/github-base-observation-reconciler.js';
import { githubBaseShaResolverFromEnv } from '../reconciliation/github-base-observation-runtime.js';
import { SecretScanner } from '../security/redaction.js';
import { configuredSecrets } from '../security/runtime-secrets.js';
import {
  AttemptLifecycleError,
  AttemptLifecycleStore,
} from '../storage/attempt-lifecycle-store.js';
import {
  PlanItemEvidenceVerificationError,
  PlanItemEvidenceVerifier,
  VerifyPlanItemRequestBodySchema,
} from '../storage/plan-item-evidence-verifier.js';
import {
  PreparePullRequestDraftRequestBodySchema,
  PullRequestDraftStore,
  PullRequestDraftStoreError,
} from '../storage/pull-request-draft-store.js';
import {
  PullRequestPublicationError,
  PullRequestPublicationStore,
  SchedulePullRequestPublicationRequestBodySchema,
} from '../storage/pull-request-publication-store.js';
import { TaskQueryStore } from '../storage/task-query-store.js';
import {
  RecoveryAttemptError,
  RecoveryAttemptStore,
} from '../storage/recovery-attempt-store.js';
import {
  IdempotencyConflictError,
  TaskIntakeStore,
  TaskRevisionConflictError,
  type TaskIntakeResult,
} from '../storage/task-intake-store.js';
import {
  SupplementalContextRevisionError,
  SupplementalContextRevisionInputSchema,
  SupplementalContextRevisionStore,
} from '../storage/supplemental-context-revision-store.js';
import {
  WorkflowReplayError,
  WorkflowReplayStore,
} from '../storage/workflow-replay-store.js';
import { errorResponse, requestCorrelationId } from './errors.js';
import { operationsAuthenticated } from './operations-auth.js';

const TASK_API_SCOPE = 'POST /v1/tasks';
const MAX_REQUEST_BODY_BYTES = 256 * 1024;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const BASE_SHA_PATTERN = /^[a-f0-9]{40}$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_BASE_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const CancelRunBodySchema = z
  .object({ expectedRunVersion: z.number().int().nonnegative() })
  .strict();
const RetryRunBodySchema = z
  .object({
    expectedRunVersion: z.number().int().nonnegative(),
    planVersion: z.number().int().positive(),
    planItemId: z.string().regex(RESOURCE_ID_PATTERN),
  })
  .strict();
const ReplayRunBodySchema = z
  .object({
    expectedRunVersion: z.number().int().nonnegative(),
    from: z.union([
      z
        .object({
          stepName: z.literal(VERIFY_ANALYSIS_REPLAY_STEP),
          stepCount: z.literal(1).optional(),
        })
        .strict(),
      z
        .object({
          planVersion: z.number().int().positive(),
          planItemId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
        })
        .strict(),
    ]),
    reason: z.string().min(2).max(1_000).refine((value) => /\S/.test(value)),
  })
  .strict();
const SupplementalContextBodySchema = z.discriminatedUnion('applyToCurrentRun', [
  SupplementalContextRevisionInputSchema.options[0].omit({ priorTaskId: true }),
  SupplementalContextRevisionInputSchema.options[1]
    .omit({ priorTaskId: true })
    .extend({
      currentRun: SupplementalContextRevisionInputSchema.options[1].shape.currentRun.omit({
        runId: true,
      }),
    })
    .strict(),
]);

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function isAuthenticated(configuredToken: string | undefined, authorization: string | undefined): boolean {
  return (
    configuredToken !== undefined &&
    authorization !== undefined &&
    authorization.startsWith('Bearer ') &&
    constantTimeEqual(authorization.slice('Bearer '.length), configuredToken)
  );
}

type TaskApiContext = Context<{ Bindings: Bindings }>;
type GitHubBaseReadinessFailureReason =
  | 'configuration_unavailable'
  | GitHubBaseResolutionErrorCode;

function safeGitHubBaseBranch(value: string): boolean {
  return GITHUB_BASE_BRANCH_PATTERN.test(value) &&
    !value.includes('..') &&
    !value.includes('//');
}

function safeGitHubRepository(value: string): boolean {
  if (!GITHUB_REPOSITORY_PATTERN.test(value)) return false;
  const [owner, repository] = value.split('/');
  return owner !== '.' && owner !== '..' && repository !== '.' && repository !== '..';
}

function githubBaseReadinessUnavailable(
  c: TaskApiContext,
  reason: GitHubBaseReadinessFailureReason,
): Response {
  return c.json({
    schemaVersion: '1',
    ready: false,
    reason,
    code: 'unavailable',
    message: 'GitHub base readiness check failed',
    retryable: true,
    correlationId: requestCorrelationId(c),
  }, 503);
}

export interface TaskApiOptions {
  baseShaResolverFromEnv?: (env: Bindings) => GitHubBaseShaResolver | null;
}

export function taskApi(options: TaskApiOptions = {}): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  const baseShaResolver = options.baseShaResolverFromEnv ?? githubBaseShaResolverFromEnv;

  app.get('/v1/operations/github-base/readiness', async (c) => {
    c.header('cache-control', 'no-store');
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const params = new URL(c.req.url).searchParams;
    if (
      [...params.keys()].some((key) => key !== 'repository' && key !== 'baseBranch') ||
      params.getAll('repository').length !== 1 ||
      params.getAll('baseBranch').length !== 1
    ) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid GitHub base readiness query', false);
    }
    const repository = params.get('repository') ?? '';
    const baseBranch = params.get('baseBranch') ?? '';
    if (
      !safeGitHubRepository(repository) ||
      !safeGitHubBaseBranch(baseBranch)
    ) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid GitHub base readiness query', false);
    }

    let resolver: GitHubBaseShaResolver | null;
    try {
      resolver = baseShaResolver(c.env);
    } catch (error) {
      return githubBaseReadinessUnavailable(
        c,
        error instanceof GitHubAppCredentialError
          ? error.code
          : 'configuration_unavailable',
      );
    }
    if (resolver === null) {
      return githubBaseReadinessUnavailable(c, 'configuration_unavailable');
    }

    let baseSha: string;
    try {
      baseSha = await resolver.resolveBaseSha(repository, baseBranch);
    } catch (error) {
      return githubBaseReadinessUnavailable(
        c,
        error instanceof GitHubBaseResolutionError
          ? error.code
          : 'reference_unavailable',
      );
    }
    if (!BASE_SHA_PATTERN.test(baseSha)) {
      return githubBaseReadinessUnavailable(c, 'reference_invalid');
    }
    return c.json({
      schemaVersion: '1',
      ready: true,
      repository,
      baseBranch,
      baseSha,
    });
  });

  app.get('/v1/tasks/:taskId', async (c) => {
    if (!isAuthenticated(c.env.TASK_INTAKE_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const taskId = c.req.param('taskId');
    if (!RESOURCE_ID_PATTERN.test(taskId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid task id', false);
    }
    const view = await new TaskQueryStore(c.env.DB_CONTROL).getTaskStatus(taskId);
    if (view === null) return errorResponse(c, 404, 'not_found', 'task not found', false);
    return c.json(view);
  });

  app.get('/v1/runs/:runId/plan', async (c) => {
    if (!isAuthenticated(c.env.TASK_INTAKE_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const runId = c.req.param('runId');
    if (!RESOURCE_ID_PATTERN.test(runId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid run id', false);
    }
    const view = await new TaskQueryStore(c.env.DB_CONTROL).getRunPlanStatus(runId);
    if (view === null) return errorResponse(c, 404, 'not_found', 'run not found', false);
    return c.json(view);
  });

  app.post('/v1/runs/:runId/context', async (c) => {
    if (!isAuthenticated(c.env.TASK_INTAKE_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const runId = c.req.param('runId');
    if (!RESOURCE_ID_PATTERN.test(runId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid run id', false);
    }
    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 400, 'invalid_argument', 'invalid context revision request', false);
    }
    let body: unknown;
    try {
      const text = await c.req.text();
      if (new TextEncoder().encode(text).length > MAX_REQUEST_BODY_BYTES) {
        throw new Error('oversized');
      }
      body = JSON.parse(text) as unknown;
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid context revision request', false);
    }
    const parsed = SupplementalContextBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid context revision request', false);
    }
    const prior = await c.env.DB_CONTROL.prepare(
      'SELECT task_id FROM runs WHERE run_id = ?',
    ).bind(runId).first<{ task_id: string }>();
    if (prior === null) return errorResponse(c, 404, 'not_found', 'run not found', false);
    const input = parsed.data.applyToCurrentRun
      ? {
        ...parsed.data,
        priorTaskId: prior.task_id,
        currentRun: { ...parsed.data.currentRun, runId },
      }
      : { ...parsed.data, priorTaskId: prior.task_id };
    const secrets = configuredSecrets(c.env);
    try {
      const result = await new SupplementalContextRevisionStore(
        c.env.DB_CONTROL,
        c.env.TASK_OBJECTS,
        { secrets },
      ).accept(input);
      c.header('cache-control', 'no-store');
      c.header('location', `/v1/tasks/${result.taskId}`);
      return c.json({ accepted: true, ...result }, result.created ? 202 : 200);
    } catch (error) {
      if (error instanceof SupplementalContextRevisionError) {
        switch (error.code) {
          case 'invalid_request':
            return errorResponse(c, 400, 'invalid_argument', 'invalid context revision request', false);
          case 'not_found':
            return errorResponse(c, 404, 'not_found', 'context revision source not found', false);
          case 'secret_detected':
            return errorResponse(c, 403, 'policy_denied', 'context contains sensitive material', false);
          case 'storage_unavailable':
            return errorResponse(c, 503, 'unavailable', 'context storage unavailable', true);
          case 'revision_conflict':
            return errorResponse(c, 409, 'stale_revision', 'task revision conflicts', false);
          case 'state_conflict':
            return errorResponse(c, 409, 'conflict', 'context revision state changed', false);
        }
      }
      throw error;
    }
  });

  app.post('/v1/runs/:runId/items/:itemId/verify', async (c) => {
    if (!isAuthenticated(c.env.TASK_INTAKE_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const runId = c.req.param('runId');
    const planItemId = c.req.param('itemId');
    if (!RESOURCE_ID_PATTERN.test(runId) || !RESOURCE_ID_PATTERN.test(planItemId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid verification target', false);
    }
    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 400, 'invalid_argument', 'invalid verification request', false);
    }
    let body: unknown;
    try {
      const text = await c.req.text();
      if (new TextEncoder().encode(text).length > MAX_REQUEST_BODY_BYTES) {
        throw new Error('oversized');
      }
      body = JSON.parse(text) as unknown;
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid verification request', false);
    }
    const parsed = VerifyPlanItemRequestBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid verification request', false);
    }
    try {
      const result = await new PlanItemEvidenceVerifier(c.env.DB_CONTROL).verify({
        runId,
        planItemId,
        ...parsed.data,
      });
      c.header('cache-control', 'no-store');
      return c.json(result, result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof PlanItemEvidenceVerificationError) {
        if (error.code === 'invalid_request') {
          return errorResponse(c, 400, 'invalid_argument', 'invalid verification request', false);
        }
        if (error.code === 'not_found') {
          return errorResponse(c, 404, 'not_found', 'verification target not found', false);
        }
        return errorResponse(c, 409, 'conflict', 'verification state or evidence changed', false);
      }
      throw error;
    }
  });

  app.post('/v1/runs/:runId/pull-request-draft', async (c) => {
    if (!isAuthenticated(c.env.TASK_INTAKE_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const runId = c.req.param('runId');
    if (!RESOURCE_ID_PATTERN.test(runId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid run id', false);
    }
    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 400, 'invalid_argument', 'invalid PR draft request', false);
    }
    let body: unknown;
    try {
      const text = await c.req.text();
      if (new TextEncoder().encode(text).length > 4_096) throw new Error('oversized');
      body = JSON.parse(text) as unknown;
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid PR draft request', false);
    }
    const parsed = PreparePullRequestDraftRequestBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid PR draft request', false);
    }
    const secrets = configuredSecrets(c.env);
    try {
      const result = await new PullRequestDraftStore(
        c.env.DB_CONTROL,
        c.env.TASK_OBJECTS,
        { secrets },
      ).prepare({ runId, ...parsed.data });
      c.header('cache-control', 'no-store');
      return c.json(result, result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof PullRequestDraftStoreError) {
        switch (error.code) {
          case 'invalid_request':
            return errorResponse(c, 400, 'invalid_argument', 'invalid PR draft request', false);
          case 'not_found':
            return errorResponse(c, 404, 'not_found', 'PR draft target not found', false);
          case 'task_payload_unavailable':
            return errorResponse(c, 503, 'unavailable', 'task context unavailable', true);
          case 'secret_detected':
            return errorResponse(c, 403, 'policy_denied', 'PR draft contains sensitive material', false);
          case 'body_too_large':
            return errorResponse(c, 413, 'invalid_argument', 'PR draft body is too large', false);
          case 'state_conflict':
          case 'task_payload_conflict':
            return errorResponse(c, 409, 'conflict', 'PR draft state changed', false);
        }
      }
      throw error;
    }
  });

  app.post('/v1/runs/:runId/pull-request', async (c) => {
    if (!isAuthenticated(c.env.TASK_INTAKE_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const runId = c.req.param('runId');
    if (!RESOURCE_ID_PATTERN.test(runId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid run id', false);
    }
    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 400, 'invalid_argument', 'invalid PR publication request', false);
    }
    let body: unknown;
    try {
      const text = await c.req.text();
      if (new TextEncoder().encode(text).length > 4_096) throw new Error('oversized');
      body = JSON.parse(text) as unknown;
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid PR publication request', false);
    }
    const parsed = SchedulePullRequestPublicationRequestBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid PR publication request', false);
    }
    try {
      const result = await new PullRequestPublicationStore(c.env.DB_CONTROL).schedule({
        runId,
        ...parsed.data,
      });
      c.header('cache-control', 'no-store');
      return c.json(result, result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof PullRequestPublicationError) {
        if (error.code === 'invalid_request') {
          return errorResponse(c, 400, 'invalid_argument', 'invalid PR publication request', false);
        }
        if (error.code === 'not_found') {
          return errorResponse(c, 404, 'not_found', 'PR publication target not found', false);
        }
        return errorResponse(c, 409, 'conflict', 'PR publication state or approval changed', false);
      }
      throw error;
    }
  });

  app.post('/v1/runs/:runId/cancel', async (c) => {
    if (!isAuthenticated(c.env.TASK_INTAKE_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const runId = c.req.param('runId');
    if (!RESOURCE_ID_PATTERN.test(runId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid run id', false);
    }
    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 400, 'invalid_argument', 'invalid cancel request', false);
    }
    let body: unknown;
    try {
      const text = await c.req.text();
      if (new TextEncoder().encode(text).length > 4_096) throw new Error('oversized');
      body = JSON.parse(text) as unknown;
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid cancel request', false);
    }
    const parsed = CancelRunBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid cancel request', false);
    }
    try {
      const result = await new AttemptLifecycleStore(c.env.DB_CONTROL).cancelRun(
        runId,
        parsed.data.expectedRunVersion,
      );
      return c.json({ accepted: true, ...result }, 202);
    } catch (error) {
      if (error instanceof AttemptLifecycleError) {
        if (error.code === 'not_found') {
          return errorResponse(c, 404, 'not_found', 'run not found', false);
        }
        return errorResponse(c, 409, 'conflict', 'run state changed', false);
      }
      throw error;
    }
  });

  app.post('/v1/runs/:runId/retry', async (c) => {
    if (!isAuthenticated(c.env.TASK_INTAKE_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const runId = c.req.param('runId');
    if (!RESOURCE_ID_PATTERN.test(runId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid run id', false);
    }
    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 400, 'invalid_argument', 'invalid retry request', false);
    }
    let body: unknown;
    try {
      const text = await c.req.text();
      if (new TextEncoder().encode(text).length > 4_096) throw new Error('oversized');
      body = JSON.parse(text) as unknown;
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid retry request', false);
    }
    const parsed = RetryRunBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid retry request', false);
    }
    try {
      const result = await new RecoveryAttemptStore(
        c.env.DB_CONTROL,
        c.env.CHECKPOINT_OBJECTS,
      ).schedule({ runId, ...parsed.data });
      c.header('cache-control', 'no-store');
      return c.json({ accepted: true, ...result }, 202);
    } catch (error) {
      if (error instanceof RecoveryAttemptError) {
        if (error.code === 'not_found') {
          return errorResponse(c, 404, 'not_found', 'recovery target not found', false);
        }
        return errorResponse(c, 409, 'conflict', 'recovery state changed', false);
      }
      throw error;
    }
  });

  app.post('/v1/runs/:runId/replay', async (c) => {
    if (!isAuthenticated(c.env.TASK_INTAKE_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const runId = c.req.param('runId');
    if (!RESOURCE_ID_PATTERN.test(runId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid run id', false);
    }
    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 400, 'invalid_argument', 'invalid replay request', false);
    }
    let body: unknown;
    try {
      const text = await c.req.text();
      if (new TextEncoder().encode(text).length > 4_096) throw new Error('oversized');
      body = JSON.parse(text) as unknown;
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid replay request', false);
    }
    const parsed = ReplayRunBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid replay request', false);
    }
    try {
      const result = await new WorkflowReplayStore(c.env.DB_CONTROL).schedule({
        runId,
        ...parsed.data,
      });
      c.header('cache-control', 'no-store');
      return c.json({ accepted: true, ...result }, 202);
    } catch (error) {
      if (error instanceof WorkflowReplayError) {
        if (error.code === 'not_found') {
          return errorResponse(c, 404, 'not_found', 'replay target not found', false);
        }
        if (error.code === 'approval_required') {
          return errorResponse(c, 403, 'policy_denied', 'replay approval required', false);
        }
        return errorResponse(c, 409, 'conflict', 'replay state changed', false);
      }
      throw error;
    }
  });

  app.post('/v1/tasks', async (c) => {
    const configuredToken = c.env.TASK_INTAKE_TOKEN;
    const authorization = c.req.header('authorization');
    if (!isAuthenticated(configuredToken, authorization)) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }

    const idempotencyKey = c.req.header('idempotency-key');
    if (idempotencyKey === undefined || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return errorResponse(
        c,
        400,
        'invalid_argument',
        'a valid Idempotency-Key header is required',
        false,
      );
    }

    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 400, 'invalid_argument', 'content-type must be application/json', false);
    }

    let requestText: string;
    try {
      requestText = await c.req.text();
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'request body must be JSON', false);
    }
    if (new TextEncoder().encode(requestText).length > MAX_REQUEST_BODY_BYTES) {
      return errorResponse(c, 413, 'invalid_argument', 'request body is too large', false);
    }

    let requestBody: unknown;
    try {
      requestBody = JSON.parse(requestText) as unknown;
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'request body must be JSON', false);
    }
    const parsed = TaskEnvelopeSchema.safeParse(requestBody);
    if (!parsed.success) {
      return errorResponse(
        c,
        400,
        'invalid_argument',
        'request body must be a valid TaskEnvelope v1',
        false,
      );
    }
    const task = parsed.data;
    if (new SecretScanner({ secrets: configuredSecrets(c.env) }).scan(task).length > 0) {
      return errorResponse(
        c,
        403,
        'policy_denied',
        'Task contains sensitive credential material',
        false,
      );
    }
    const requestDigest = await canonicalSha256(task);
    const keyDigest = await canonicalSha256({ scope: TASK_API_SCOPE, key: idempotencyKey });
    const idempotency = {
      scope: TASK_API_SCOPE,
      keyDigest,
      requestDigest,
    };
    const store = new TaskIntakeStore(c.env.DB_CONTROL);
    let result: TaskIntakeResult | null;
    try {
      result = await store.findIdempotentTaskRevision(idempotency);
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return errorResponse(
          c,
          409,
          'conflict',
          'Idempotency-Key is already bound to another request',
          false,
        );
      }
      throw error;
    }
    let baseSha: string;
    try {
      if (result !== null) {
        baseSha = result.baseSha ?? '';
      } else {
        const resolver = baseShaResolver(c.env);
        if (resolver === null) throw new Error('base SHA resolver is unavailable');
        baseSha = await resolver.resolveBaseSha(
          `${task.target.owner}/${task.target.repo}`,
          task.target.baseBranch,
        );
        if (!BASE_SHA_PATTERN.test(baseSha)) {
          throw new Error('base SHA resolver returned an invalid commit');
        }
      }
    } catch {
      return errorResponse(
        c,
        503,
        'unavailable',
        'target repository base is unavailable',
        true,
      );
    }
    const ids = await taskRevisionIds(task);
    const taskDigest = await taskRevisionDigest(task);
    const objectKey = `tasks/${ids.taskId}/${taskDigest.slice('sha256:'.length)}.json`;
    const payloadRef = `r2://${objectKey}`;

    if (result === null) {
      try {
        result = await store.acceptIdempotentTaskRevision(
          {
            task,
            baseSha,
            payloadRef,
            now: new Date().toISOString(),
          },
          idempotency,
        );
      } catch (error) {
        if (error instanceof IdempotencyConflictError) {
          return errorResponse(
            c,
            409,
            'conflict',
            'Idempotency-Key is already bound to another request',
            false,
          );
        }
        if (error instanceof TaskRevisionConflictError) {
          return errorResponse(
            c,
            409,
            'stale_revision',
            'source revision content conflicts with the stored snapshot',
            false,
          );
        }
        throw error;
      }
    }

    try {
      await c.env.TASK_OBJECTS.put(objectKey, JSON.stringify(task), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        customMetadata: { taskDigest },
      });
    } catch {
      return errorResponse(c, 503, 'unavailable', 'task payload storage is unavailable', true);
    }

    c.header('location', `/v1/tasks/${result.taskId}`);
    return c.json(
      {
        accepted: true,
        taskId: result.taskId,
        runId: result.runId,
      },
      202,
    );
  });

  return app;
}
