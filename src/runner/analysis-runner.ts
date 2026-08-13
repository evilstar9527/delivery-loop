import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  CodexAnalysisAdapter,
  CodexAnalysisAdapterError,
  bindWritableDiagnosticRequirement,
  type CodexAnalysisFailureKind,
  type CodexAnalysisFailureStage,
  type DiagnosticAnalysisMediation,
  type CodexAnalysisStartInput,
} from '../agent/codex-analysis-adapter.js';
import {
  ANALYSIS_AGENT_OUTPUT_V1_JSON_SCHEMA,
  AnalysisPlanContentV1Schema,
  DIAGNOSTIC_ROOT_CAUSE_RESULT_V1_JSON_SCHEMA,
  DIAGNOSTIC_EVIDENCE_REF_PATTERN,
  DIAGNOSTIC_LOG_SEARCH_REQUEST_V1_JSON_SCHEMA,
  DIAGNOSTIC_TRACE_REQUEST_V1_JSON_SCHEMA,
  DiagnosticLogSearchRequestV1Schema,
  DiagnosticTraceRequestV1Schema,
  createAnalysisContextFileV1,
  deriveAnalysisPlanId,
  type AnalysisPlanContentV1,
  type DiagnosticLogSearchRequestV1,
  type DiagnosticTraceRequestV1,
} from '../domain/analysis-plan.js';
import { canonicalSha256 } from '../domain/digest.js';
import {
  DiagnosticEvidenceV1Schema,
  DiagnosticRootCauseV1Schema,
  computeDiagnosticEvidenceDigest,
  computeDiagnosticRootCauseDigest,
  type DiagnosticEvidenceV1,
} from '../domain/diagnostic-evidence.js';
import {
  computeExecutionPlanDigest,
  ExecutionPlanValidationError,
  ExecutionPlanV1Schema,
  PlanEffectSchema,
  validateExecutionPlanProposal,
  type ExecutionPlanV1,
  type ExecutionPlanValidationIssueCode,
  type PlanItemV1,
} from '../domain/plan.js';
import type {
  AttemptedPath,
  FailureCode,
  FailureSite,
  HumanInputCode,
} from '../domain/attempt-failure.js';
import { TaskEnvelopeSchema, taskRevisionDigest } from '../domain/task.js';
import { AnalysisRevisionSourceSchema } from '../domain/revision-source.js';
import {
  TRIAGE_TOOL_ACTIONS,
  isExactTriageToolActions,
} from '../domain/tool-bridge.js';
import { isSensitiveFieldName, SecretScanner } from '../security/redaction.js';
import type { CodexModelUsage } from '../domain/quota.js';
import { deriveAnalysisPlanPolicy } from '../domain/analysis-plan-policy.js';
import type { AnalysisProviderProcessFailureCode } from
  '../agent/provider-preflight-failure.js';
import {
  CodexReviewAdapter,
  CodexReviewAdapterError,
  type CodexReviewStartInput,
} from '../agent/codex-review-adapter.js';
import {
  AUTOMATED_REVIEW_RESULT_V1_JSON_SCHEMA,
  AutomatedReviewContextV1Schema,
  type AutomatedReviewResultV1,
} from '../domain/automated-review.js';
import { listAnalysisWritableRepositoryPaths } from './analysis-repository-paths.js';

const OIDC_AUDIENCE = 'delivery-loop-control-plane';
const HEARTBEAT_INTERVAL_MS = 45_000;
const ANALYSIS_TIMEOUT_MS = 50 * 60_000;
const DIAGNOSTIC_TOOL_TIMEOUT_MS = 20_000;
const MAX_DIAGNOSTIC_CONTEXT_BYTES = 256 * 1_024;
const MAX_RESPONSE_BYTES = 512 * 1_024;
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BASE_SHA_PATTERN = /^[a-f0-9]{40}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

const OidcResponseSchema = z.object({ value: z.string().min(1).max(20_000) }).strict();
const ExchangeResponseSchema = z
  .object({
    attemptToken: z.string().min(1).max(4_096),
    expiresAt: z.iso.datetime({ offset: true }),
    attemptVersion: z.number().int().nonnegative(),
    leaseGeneration: z.number().int().positive(),
    grant: z
      .object({
        toolBridgeToken: z.string().min(1).max(4_096),
        expiresAt: z.iso.datetime({ offset: true }),
        scopes: z
          .array(z.string().min(1).max(100))
          .length(TRIAGE_TOOL_ACTIONS.length),
      })
      .strict(),
  })
  .strict();
const ContextResponseSchema = z
  .object({
    schemaVersion: z.literal('1'),
    attempt: z
      .object({
        id: z.string().regex(ID_PATTERN),
        runId: z.string().min(1).max(64),
        mode: z.literal('analysis'),
        version: z.number().int().nonnegative(),
        leaseGeneration: z.number().int().positive(),
        baseSha: z.string().regex(BASE_SHA_PATTERN),
      })
      .strict(),
    task: TaskEnvelopeSchema,
    revisionSource: AnalysisRevisionSourceSchema.optional(),
    carriedDiagnosticEvidenceRef: z
      .string()
      .max(220)
      .regex(DIAGNOSTIC_EVIDENCE_REF_PATTERN)
      .optional(),
    planPolicy: z
      .object({
        version: z.number().int().positive(),
        allowedEffects: z.array(PlanEffectSchema).max(20),
        allowedCommandRefs: z.array(z.string().min(1).max(200)).max(100),
        verificationCommandRefs: z.array(z.string().min(1).max(200)).max(100).default([]),
        requiresRepositoryChange: z.boolean().default(false),
        requiresTestDeployment: z.boolean().default(false),
      })
      .strict(),
  })
  .strict();
const HeartbeatResponseSchema = z
  .object({
    attemptToken: z.string().min(1).max(4_096),
    toolBridgeToken: z.string().min(1).max(4_096),
    version: z.number().int().nonnegative(),
    leaseGeneration: z.number().int().positive(),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
const PlanResponseSchema = z
  .object({
    planId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    version: z.number().int().positive(),
    digest: z.string().regex(SHA256_DIGEST_PATTERN),
    status: z.literal('validated'),
    payloadRef: z.string().min(1).max(500),
  })
  .strict();
const CompletionResponseSchema = z
  .object({
    accepted: z.literal(true),
    signalId: z.string().min(1).max(128),
    outboxId: z.string().min(1).max(128),
  })
  .strict();
const FailureResponseSchema = z.object({ accepted: z.literal(true) });
const ModelReservationResponseSchema = z.object({
  reservationId: z.string().regex(ID_PATTERN),
  attemptId: z.string().regex(ID_PATTERN),
  runId: z.string().min(1).max(64),
  provider: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  reservedTokens: z.number().int().positive(),
  reservedCostMicrousd: z.number().int().nonnegative(),
  expiresAt: z.iso.datetime({ offset: true }),
  overrideId: z.string().regex(ID_PATTERN).nullable(),
  disposition: z.enum(['created', 'existing']),
}).strict();
const ModelUsageResponseSchema = z.object({
  usageId: z.string().regex(ID_PATTERN),
  reservationId: z.string().regex(ID_PATTERN),
  totalTokens: z.number().int().nonnegative(),
  costMicrousd: z.number().int().nonnegative(),
  disposition: z.enum(['created', 'existing']),
}).strict();
const AutomatedReviewCompletionResponseSchema = z.object({
  accepted: z.literal(true),
  reviewId: z.string().regex(ID_PATTERN),
  status: z.enum(['approved', 'changes_requested', 'blocked']),
  fixAttemptId: z.string().regex(ID_PATTERN).optional(),
  created: z.boolean(),
}).strict();
const ToolCallResponseSchema = z.object({
  ok: z.literal(true),
  traceId: z.string().regex(ID_PATTERN),
  result: z.unknown(),
}).strict();
const DiagnosticEvidenceResponseSchema = z.object({
  evidenceId: z.string().regex(ID_PATTERN),
  evidenceRef: z.string().regex(/^d1:\/\/evidence\/[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/),
  evidenceDigest: z.string().regex(SHA256_DIGEST_PATTERN),
  rootCauseDigest: z.string().regex(SHA256_DIGEST_PATTERN),
  created: z.boolean(),
}).strict();

interface RunnerConfiguration {
  schemaVersion: '1';
  runId: string;
  attemptId: string;
  taskDigest: string;
  baseSha: string;
  mode: 'analysis';
  modelProfileId?: string;
  controlPlaneUrl: string;
  oidcRequestUrl: string;
  oidcRequestToken: string;
  workspacePath: string;
  runnerTempPath: string;
}

interface MutableFencing {
  token: string;
  toolToken: string;
  version: number;
  leaseGeneration: number;
}

export interface AnalysisAgent {
  readonly usesMeteredModel?: boolean;
  start(input: CodexAnalysisStartInput): Promise<ExecutionPlanV1>;
}

export interface AutomatedReviewAgent {
  readonly usesMeteredModel?: boolean;
  start(input: CodexReviewStartInput): Promise<AutomatedReviewResultV1>;
}

export interface RunAnalysisAttemptOptions {
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  agent?: AnalysisAgent;
  reviewAgent?: AutomatedReviewAgent;
  heartbeatIntervalMs?: number;
  snapshotWorkspace?: (workspacePath: string) => Promise<string>;
  listWritableRepositoryPaths?: (
    workspacePath: string,
    baseSha: string,
  ) => Promise<readonly string[]>;
  now?: () => Date;
}

export interface AnalysisAttemptResult {
  planId: string;
  version: number;
  digest: string;
  payloadRef: string;
}

export interface AutomatedReviewAttemptResult {
  reviewId: string;
  status: 'approved' | 'changes_requested' | 'blocked';
  fixAttemptId?: string;
}

export interface AnalysisRunnerFailure {
  failureCode: FailureCode;
  failureSite: FailureSite;
  attemptedPaths: AttemptedPath[];
  neededHumanInput: HumanInputCode;
}

export interface AnalysisFailureClassification {
  kind: CodexAnalysisFailureKind;
  stage: CodexAnalysisFailureStage;
  providerFailureCode?: AnalysisProviderProcessFailureCode;
}

export class AnalysisRunnerError extends Error {
  constructor(
    message: string,
    readonly failure?: AnalysisRunnerFailure,
    readonly analysisFailure?: AnalysisFailureClassification,
  ) {
    super(message);
    this.name = 'AnalysisRunnerError';
  }
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key];
  if (value === undefined || value.length === 0) {
    throw new AnalysisRunnerError('analysis Runner configuration is incomplete');
  }
  return value;
}

function trustedHttpsUrl(raw: string, kind: 'origin' | 'request'): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AnalysisRunnerError('analysis Runner URL configuration is invalid');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new AnalysisRunnerError('analysis Runner URL configuration is invalid');
  }
  if (kind === 'origin' && (url.pathname !== '/' || url.search !== '' || url.hash !== '')) {
    throw new AnalysisRunnerError('analysis Runner URL configuration is invalid');
  }
  return url;
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function configuration(environment: NodeJS.ProcessEnv): RunnerConfiguration {
  const schemaVersion = requiredEnvironment(environment, 'DELIVERY_SCHEMA_VERSION');
  const runId = requiredEnvironment(environment, 'DELIVERY_RUN_ID');
  const attemptId = requiredEnvironment(environment, 'DELIVERY_ATTEMPT_ID');
  const taskDigest = requiredEnvironment(environment, 'DELIVERY_TASK_DIGEST');
  const baseSha = requiredEnvironment(environment, 'DELIVERY_BASE_SHA');
  const mode = requiredEnvironment(environment, 'DELIVERY_ATTEMPT_MODE');
  const modelProfileId = environment.DELIVERY_MODEL_PROFILE_ID;
  const controlPlane = trustedHttpsUrl(
    requiredEnvironment(environment, 'DELIVERY_CONTROL_PLANE_URL'),
    'origin',
  );
  const oidcRequest = trustedHttpsUrl(
    requiredEnvironment(environment, 'ACTIONS_ID_TOKEN_REQUEST_URL'),
    'request',
  );
  const workspacePath = resolve(requiredEnvironment(
    environment,
    environment.DELIVERY_REPOSITORY_PATH === undefined
      ? 'GITHUB_WORKSPACE'
      : 'DELIVERY_REPOSITORY_PATH',
  ));
  const runnerTempPath = resolve(requiredEnvironment(environment, 'RUNNER_TEMP'));
  if (
    schemaVersion !== '1' ||
    !ID_PATTERN.test(attemptId) ||
    runId.length === 0 ||
    runId.length > 64 ||
    !SHA256_DIGEST_PATTERN.test(taskDigest) ||
    !BASE_SHA_PATTERN.test(baseSha) ||
    mode !== 'analysis' ||
    (modelProfileId !== undefined && !ID_PATTERN.test(modelProfileId)) ||
    isWithin(workspacePath, runnerTempPath)
  ) {
    throw new AnalysisRunnerError('analysis Runner configuration is invalid');
  }
  return {
    schemaVersion: '1',
    runId,
    attemptId,
    taskDigest,
    baseSha,
    mode: 'analysis',
    ...(modelProfileId === undefined ? {} : { modelProfileId }),
    controlPlaneUrl: controlPlane.origin,
    oidcRequestUrl: oidcRequest.toString(),
    oidcRequestToken: requiredEnvironment(environment, 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'),
    workspacePath,
    runnerTempPath,
  };
}

async function readJsonResponse(
  response: Response,
  expectedStatuses: readonly number[],
  operation: string,
): Promise<unknown> {
  if (!expectedStatuses.includes(response.status)) {
    await response.body?.cancel();
    throw new AnalysisRunnerError(`${operation} failed with status ${response.status}`);
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new AnalysisRunnerError(`${operation} returned an unreadable response`);
  }
  if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) {
    throw new AnalysisRunnerError(`${operation} returned an oversized response`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AnalysisRunnerError(`${operation} returned an invalid response`);
  }
}

async function fetchJson(
  fetchImplementation: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  expectedStatuses: readonly number[],
  operation: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(url, init);
  } catch {
    throw new AnalysisRunnerError(`${operation} request failed`);
  }
  return await readJsonResponse(response, expectedStatuses, operation);
}

async function controlPlaneJson(
  fetchImplementation: typeof globalThis.fetch,
  config: RunnerConfiguration,
  path: string,
  token: string,
  operation: string,
  expectedStatuses: readonly number[],
  body?: unknown,
): Promise<unknown> {
  return await fetchJson(
    fetchImplementation,
    `${config.controlPlaneUrl}${path}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    expectedStatuses,
    operation,
  );
}

async function controlPlaneContextJson(
  fetchImplementation: typeof globalThis.fetch,
  config: RunnerConfiguration,
  token: string,
): Promise<unknown> {
  const retryableStatuses = new Set([409, 500, 502, 503, 504]);
  const url = `${config.controlPlaneUrl}/v1/attempts/${config.attemptId}/context`;
  for (let request = 1; request <= 3; request += 1) {
    let response: Response;
    try {
      response = await fetchImplementation(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
        },
      });
    } catch {
      if (request === 3) throw new AnalysisRunnerError('analysis context request failed');
      await delay(250 * request);
      continue;
    }
    if (response.status === 200) {
      return await readJsonResponse(response, [200], 'analysis context');
    }
    if (!retryableStatuses.has(response.status) || request === 3) {
      return await readJsonResponse(response, [200], 'analysis context');
    }
    await response.body?.cancel();
    await delay(250 * request);
  }
  throw new AnalysisRunnerError('analysis context request failed');
}

async function obtainGitHubOidcToken(
  fetchImplementation: typeof globalThis.fetch,
  config: RunnerConfiguration,
): Promise<string> {
  const url = new URL(config.oidcRequestUrl);
  url.searchParams.set('audience', OIDC_AUDIENCE);
  const raw = await fetchJson(
    fetchImplementation,
    url.toString(),
    {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.oidcRequestToken}`,
      },
    },
    [200],
    'GitHub OIDC token request',
  );
  const parsed = OidcResponseSchema.safeParse(raw);
  if (!parsed.success) throw new AnalysisRunnerError('GitHub OIDC token response is invalid');
  return parsed.data.value;
}

async function exchangeAttemptToken(
  fetchImplementation: typeof globalThis.fetch,
  config: RunnerConfiguration,
  oidcToken: string,
): Promise<MutableFencing> {
  const raw = await fetchJson(
    fetchImplementation,
    `${config.controlPlaneUrl}/v1/attempts/${config.attemptId}/exchange`,
    {
      method: 'POST',
      headers: { accept: 'application/json', authorization: `Bearer ${oidcToken}` },
    },
    [200],
    'attempt token exchange',
  );
  const parsed = ExchangeResponseSchema.safeParse(raw);
  if (
    !parsed.success ||
    !isExactTriageToolActions(parsed.data.grant.scopes) ||
    parsed.data.grant.expiresAt !== parsed.data.expiresAt ||
    parsed.data.grant.toolBridgeToken === parsed.data.attemptToken
  ) {
    throw new AnalysisRunnerError('attempt token exchange response is invalid');
  }
  return {
    token: parsed.data.attemptToken,
    toolToken: parsed.data.grant.toolBridgeToken,
    version: parsed.data.attemptVersion,
    leaseGeneration: parsed.data.leaseGeneration,
  };
}

async function reportAttemptFailure(
  fetchImplementation: typeof globalThis.fetch,
  config: RunnerConfiguration,
  fencing: MutableFencing,
  failure: AnalysisRunnerFailure,
  now: Date,
): Promise<void> {
  const identityDigest = await canonicalSha256({
    attemptId: config.attemptId,
    failureCode: failure.failureCode,
    failureSite: failure.failureSite,
  });
  const body = {
    schemaVersion: '1' as const,
    eventId: `attempt_failure_${identityDigest.slice('sha256:'.length, 'sha256:'.length + 56)}`,
    sequence: 1,
    type: 'attempt_failed' as const,
    ...failure,
    occurredAt: now.toISOString(),
    expectedVersion: fencing.version,
    leaseGeneration: fencing.leaseGeneration,
  };
  for (let request = 1; request <= 2; request += 1) {
    try {
      const raw = await controlPlaneJson(
        fetchImplementation,
        config,
        `/v1/attempts/${config.attemptId}/events`,
        fencing.token,
        'attempt failure report',
        [202],
        body,
      );
      if (!FailureResponseSchema.safeParse(raw).success) {
        throw new AnalysisRunnerError('attempt failure response is invalid');
      }
      return;
    } catch {
      if (request === 2) throw new AnalysisRunnerError('attempt failure report failed');
    }
  }
}

const UNKNOWN_TERMINAL_FAILURE: AnalysisRunnerFailure = {
  failureCode: 'unknown_failure',
  failureSite: 'external_reconciliation',
  attemptedPaths: ['external_reconciliation'],
  neededHumanInput: 'manual_investigation',
};

function terminalAnalysisRunnerError(error: unknown): AnalysisRunnerError {
  if (error instanceof AnalysisRunnerError && error.failure !== undefined) return error;
  return new AnalysisRunnerError(
    error instanceof AnalysisRunnerError ? error.message : 'analysis Runner failed',
    UNKNOWN_TERMINAL_FAILURE,
    error instanceof AnalysisRunnerError && error.analysisFailure !== undefined
      ? error.analysisFailure
      : { kind: 'runner_internal_failure', stage: 'runner_boundary' },
  );
}

class FencingRequestLock {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

async function heartbeatLoop(
  fetchImplementation: typeof globalThis.fetch,
  config: RunnerConfiguration,
  fencing: MutableFencing,
  intervalMs: number,
  signal: AbortSignal,
  runtimeSecrets: Set<string>,
  requestLock: FencingRequestLock,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await delay(intervalMs, undefined, { signal });
    } catch {
      if (signal.aborted) return;
      throw new AnalysisRunnerError('attempt heartbeat wait failed');
    }
    if (signal.aborted) return;
    await requestLock.run(async () => {
      const raw = await controlPlaneJson(
        fetchImplementation,
        config,
        `/v1/attempts/${config.attemptId}/heartbeat`,
        fencing.token,
        'attempt heartbeat',
        [200],
        {
          expectedVersion: fencing.version,
          leaseGeneration: fencing.leaseGeneration,
        },
      );
      const parsed = HeartbeatResponseSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.version !== fencing.version + 1 ||
        parsed.data.leaseGeneration !== fencing.leaseGeneration ||
        parsed.data.toolBridgeToken === parsed.data.attemptToken
      ) {
        throw new AnalysisRunnerError('attempt heartbeat response is invalid');
      }
      runtimeSecrets.add(parsed.data.attemptToken);
      runtimeSecrets.add(parsed.data.toolBridgeToken);
      fencing.token = parsed.data.attemptToken;
      fencing.toolToken = parsed.data.toolBridgeToken;
      fencing.version = parsed.data.version;
    });
  }
}

export async function snapshotGitWorkspace(workspacePath: string): Promise<string> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: workspacePath, shell: false, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) child.kill('SIGTERM');
    });
    child.once('error', () => rejectPromise(new AnalysisRunnerError('repository status failed')));
    child.once('close', (code) => {
      if (code !== 0 || stdout.length > 1024 * 1024) {
        rejectPromise(new AnalysisRunnerError('repository status failed'));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

function planContent(plan: ExecutionPlanV1): AnalysisPlanContentV1 {
  return AnalysisPlanContentV1Schema.parse({
    objective: plan.objective,
    assumptions: plan.assumptions,
    evidenceRefs: plan.evidenceRefs,
    items: plan.items,
  });
}

type DiagnosticStage = 'logs' | 'logs_running' | 'trace' | 'trace_running' | 'root_cause' | 'ready' | 'persisted' | 'failed';

function invalidDiagnosticMediation(attemptedPaths: AttemptedPath[]): AnalysisRunnerError {
  return new AnalysisRunnerError('analysis diagnostic mediation is invalid', {
    failureCode: 'invalid_agent_output',
    failureSite: 'agent_output',
    attemptedPaths,
    neededHumanInput: 'manual_investigation',
  });
}

function invalidDiagnosticPlanShape(): AnalysisRunnerError {
  return new AnalysisRunnerError('analysis diagnostic Plan binding is invalid', {
    failureCode: 'invalid_agent_output',
    failureSite: 'agent_output',
    attemptedPaths: ['repository_inspection', 'log_query', 'trace_query'],
    neededHumanInput: 'manual_investigation',
  }, {
    kind: 'plan_validation_failed',
    stage: 'diagnostic_plan',
  });
}

function diagnosticToolFailure(
  toolPath: 'logs/search' | 'traces/get',
  failureCode: 'tool_unavailable' | 'tool_policy_denied',
): AnalysisRunnerError {
  return new AnalysisRunnerError('analysis diagnostic tool call failed', {
    failureCode,
    failureSite: toolPath === 'logs/search' ? 'tool_logs_search' : 'tool_trace_get',
    attemptedPaths: toolPath === 'logs/search' ? ['log_query'] : ['log_query', 'trace_query'],
    neededHumanInput:
      failureCode === 'tool_policy_denied'
        ? 'grant_context_access'
        : 'resolve_external_dependency',
  });
}

class ControlledDiagnosticMediation implements DiagnosticAnalysisMediation {
  private stage: DiagnosticStage = 'logs';
  private logRequest: DiagnosticLogSearchRequestV1 | null = null;
  private traceRequest: DiagnosticTraceRequestV1 | null = null;
  private logTraceId: string | null = null;
  private requestTraceId: string | null = null;
  private rootCause: z.infer<typeof DiagnosticRootCauseV1Schema> | null = null;

  constructor(
    private readonly fetchImplementation: typeof globalThis.fetch,
    private readonly config: RunnerConfiguration,
    private readonly fencing: MutableFencing,
    private readonly runtimeSecrets: Set<string>,
    private readonly requestLock: FencingRequestLock,
  ) {}

  agentInterface(): DiagnosticAnalysisMediation {
    return Object.freeze({
      searchLogs: async (request: DiagnosticLogSearchRequestV1) => await this.searchLogs(request),
      getTrace: async (request: DiagnosticTraceRequestV1) => await this.getTrace(request),
      finish: async (rootCause: z.infer<typeof DiagnosticRootCauseV1Schema>) =>
        await this.finish(rootCause),
    });
  }

  async searchLogs(rawRequest: DiagnosticLogSearchRequestV1): Promise<unknown> {
    if (this.stage !== 'logs') throw invalidDiagnosticMediation(['log_query']);
    const parsed = DiagnosticLogSearchRequestV1Schema.safeParse(rawRequest);
    if (!parsed.success) throw invalidDiagnosticMediation(['log_query']);
    this.assertSafe(parsed.data.arguments, ['log_query']);
    this.stage = 'logs_running';
    try {
      const response = await this.callTool('logs/search', parsed.data.arguments);
      this.logRequest = parsed.data;
      this.logTraceId = response.traceId;
      this.stage = 'trace';
      return response.result;
    } catch (error) {
      this.stage = 'failed';
      throw error;
    }
  }

  async getTrace(rawRequest: DiagnosticTraceRequestV1): Promise<unknown> {
    if (this.stage !== 'trace') {
      throw invalidDiagnosticMediation(['log_query', 'trace_query']);
    }
    const parsed = DiagnosticTraceRequestV1Schema.safeParse(rawRequest);
    if (!parsed.success) throw invalidDiagnosticMediation(['log_query', 'trace_query']);
    this.assertSafe(parsed.data.arguments, ['log_query', 'trace_query']);
    this.stage = 'trace_running';
    try {
      const response = await this.callTool('traces/get', parsed.data.arguments);
      this.traceRequest = parsed.data;
      this.requestTraceId = response.traceId;
      this.stage = 'root_cause';
      return response.result;
    } catch (error) {
      this.stage = 'failed';
      throw error;
    }
  }

  async finish(rawRootCause: z.infer<typeof DiagnosticRootCauseV1Schema>): Promise<void> {
    if (this.stage !== 'root_cause') {
      throw invalidDiagnosticMediation(['repository_inspection', 'log_query', 'trace_query']);
    }
    const parsed = DiagnosticRootCauseV1Schema.safeParse(rawRootCause);
    if (!parsed.success) {
      throw invalidDiagnosticMediation(['repository_inspection', 'log_query', 'trace_query']);
    }
    this.assertSafe(parsed.data, ['repository_inspection', 'log_query', 'trace_query']);
    this.rootCause = parsed.data;
    this.stage = 'ready';
  }

  isReady(): boolean {
    return this.stage === 'ready';
  }

  async persistEvidence(): Promise<string> {
    if (
      this.stage !== 'ready' || this.logRequest === null || this.traceRequest === null ||
      this.logTraceId === null || this.requestTraceId === null || this.rootCause === null
    ) {
      throw invalidDiagnosticMediation(['repository_inspection', 'log_query', 'trace_query']);
    }
    const evidence: DiagnosticEvidenceV1 = DiagnosticEvidenceV1Schema.parse({
      schemaVersion: '1',
      locatorKinds: this.logRequest.locatorKinds,
      locatorDigest: await canonicalSha256({
        schemaVersion: '1',
        logsSearchArguments: this.logRequest.arguments,
        traceGetArguments: this.traceRequest.arguments,
      }),
      rootCause: this.rootCause,
      sourceTraceIds: [this.logTraceId, this.requestTraceId].sort(),
    });
    const expectedEvidenceDigest = await computeDiagnosticEvidenceDigest(evidence);
    const expectedRootCauseDigest = await computeDiagnosticRootCauseDigest(evidence.rootCause);
    let raw: unknown;
    try {
      raw = await controlPlaneJson(
        this.fetchImplementation,
        this.config,
        `/v1/attempts/${this.config.attemptId}/diagnostic-evidence`,
        this.fencing.token,
        'diagnostic Evidence submission',
        [200, 201],
        evidence,
      );
    } catch {
      this.stage = 'failed';
      throw new AnalysisRunnerError('diagnostic Evidence submission failed', {
        failureCode: 'external_fact_conflict',
        failureSite: 'external_reconciliation',
        attemptedPaths: ['repository_inspection', 'log_query', 'trace_query'],
        neededHumanInput: 'manual_investigation',
      });
    }
    const parsed = DiagnosticEvidenceResponseSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.evidenceRef !== `d1://evidence/${parsed.data.evidenceId}` ||
      !DIAGNOSTIC_EVIDENCE_REF_PATTERN.test(parsed.data.evidenceRef) ||
      parsed.data.evidenceDigest !== expectedEvidenceDigest ||
      parsed.data.rootCauseDigest !== expectedRootCauseDigest
    ) {
      this.stage = 'failed';
      throw new AnalysisRunnerError('diagnostic Evidence response is invalid', {
        failureCode: 'external_fact_conflict',
        failureSite: 'external_reconciliation',
        attemptedPaths: ['repository_inspection', 'log_query', 'trace_query'],
        neededHumanInput: 'manual_investigation',
      });
    }
    this.stage = 'persisted';
    return parsed.data.evidenceRef;
  }

  private async callTool(
    toolPath: 'logs/search' | 'traces/get',
    argumentsValue: Record<string, unknown>,
  ): Promise<z.infer<typeof ToolCallResponseSchema>> {
    let response: Response;
    try {
      response = await this.requestLock.run(async () =>
        await this.fetchImplementation(
          `${this.config.controlPlaneUrl}/v1/attempts/${this.config.attemptId}/tools/call`,
          {
            method: 'POST',
            headers: {
              accept: 'application/json',
              authorization: `Bearer ${this.fencing.toolToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ toolPath, arguments: argumentsValue }),
            signal: AbortSignal.timeout(DIAGNOSTIC_TOOL_TIMEOUT_MS),
          },
        ),
      );
    } catch {
      throw diagnosticToolFailure(toolPath, 'tool_unavailable');
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw diagnosticToolFailure(
        toolPath,
        response.status === 403 ? 'tool_policy_denied' : 'tool_unavailable',
      );
    }
    let raw: unknown;
    try {
      raw = await readJsonResponse(response, [200], `diagnostic ${toolPath}`);
    } catch {
      throw diagnosticToolFailure(toolPath, 'tool_unavailable');
    }
    const parsed = ToolCallResponseSchema.safeParse(raw);
    if (!parsed.success) throw diagnosticToolFailure(toolPath, 'tool_unavailable');
    this.assertSafe(
      parsed.data.result,
      toolPath === 'logs/search' ? ['log_query'] : ['log_query', 'trace_query'],
      toolPath,
    );
    let serialized: string;
    try {
      serialized = JSON.stringify(parsed.data.result);
    } catch {
      throw diagnosticToolFailure(toolPath, 'tool_unavailable');
    }
    if (new TextEncoder().encode(serialized).length > MAX_DIAGNOSTIC_CONTEXT_BYTES) {
      throw diagnosticToolFailure(toolPath, 'tool_unavailable');
    }
    return parsed.data;
  }

  private assertSafe(
    value: unknown,
    attemptedPaths: AttemptedPath[],
    toolPath?: 'logs/search' | 'traces/get',
  ): void {
    if (new SecretScanner({ secrets: [...this.runtimeSecrets] }).scan(value).length === 0) return;
    if (toolPath !== undefined) throw diagnosticToolFailure(toolPath, 'tool_unavailable');
    throw invalidDiagnosticMediation(attemptedPaths);
  }
}

function consumesBoundDiagnosticEvidence(item: PlanItemV1): boolean {
  if (!item.effects.includes('logs_read')) return false;
  if (item.verification.evidenceKinds.includes('diagnostic')) return true;
  const commandRefs = item.verification.commandRefs ?? [];
  return item.kind === 'change' && item.required && item.effects.includes('repo_write') &&
    commandRefs.some((ref) => ref.startsWith('test:')) &&
    commandRefs.some((ref) => ref.startsWith('verify:')) &&
    item.verification.evidenceKinds.length === 2 &&
    item.verification.evidenceKinds.includes('commit') &&
    item.verification.evidenceKinds.includes('test');
}

async function bindDiagnosticEvidence(
  plan: ExecutionPlanV1,
  evidenceRef: string,
  validation: Parameters<typeof validateExecutionPlanProposal>[1],
): Promise<ExecutionPlanV1> {
  const content = planContent(plan);
  if (
    content.evidenceRefs.some((ref) => DIAGNOSTIC_EVIDENCE_REF_PATTERN.test(ref)) ||
    !content.items.some(consumesBoundDiagnosticEvidence)
  ) {
    throw invalidDiagnosticPlanShape();
  }
  const body = {
    schemaVersion: '1' as const,
    id: plan.id,
    runId: plan.runId,
    version: plan.version,
    taskRevision: plan.taskRevision,
    baseSha: plan.baseSha,
    createdByAttemptId: plan.createdByAttemptId,
    ...content,
    evidenceRefs: [...content.evidenceRefs, evidenceRef],
  };
  return await validateExecutionPlanProposal(
    {
      ...body,
      digest: await computeExecutionPlanDigest(body),
      status: 'proposed',
    },
    validation,
  );
}

async function bindCarriedDiagnosticEvidence(
  plan: ExecutionPlanV1,
  evidenceRef: string,
  validation: Parameters<typeof validateExecutionPlanProposal>[1],
): Promise<ExecutionPlanV1> {
  if (!DIAGNOSTIC_EVIDENCE_REF_PATTERN.test(evidenceRef)) {
    throw invalidDiagnosticPlanShape();
  }
  const content = planContent(plan);
  if (content.evidenceRefs.some((ref) => DIAGNOSTIC_EVIDENCE_REF_PATTERN.test(ref))) {
    throw invalidDiagnosticPlanShape();
  }
  const boundContent = bindWritableDiagnosticRequirement(content, true);
  const candidates = boundContent.items.filter((item) => {
    const commandRefs = item.verification.commandRefs ?? [];
    return item.required && item.kind === 'change' && item.effects.includes('repo_write') &&
      item.effects.includes('logs_read') &&
      commandRefs.some((ref) => ref.startsWith('test:')) &&
      commandRefs.some((ref) => ref.startsWith('verify:')) &&
      consumesBoundDiagnosticEvidence(item);
  });
  if (candidates.length !== 1) throw invalidDiagnosticPlanShape();
  const body = {
    schemaVersion: '1' as const,
    id: plan.id,
    runId: plan.runId,
    version: plan.version,
    taskRevision: plan.taskRevision,
    baseSha: plan.baseSha,
    createdByAttemptId: plan.createdByAttemptId,
    ...boundContent,
  };
  const boundPlan = await validateExecutionPlanProposal({
    ...body,
    digest: await computeExecutionPlanDigest(body),
    status: 'proposed',
  }, validation);
  return await bindDiagnosticEvidence(boundPlan, evidenceRef, validation);
}

async function runAutomatedReview(
  context: z.infer<typeof AutomatedReviewContextV1Schema>,
  config: RunnerConfiguration,
  fencing: MutableFencing,
  runtimeSecrets: Set<string>,
  beforeSnapshot: string,
  options: RunAnalysisAttemptOptions,
  fetchImplementation: typeof globalThis.fetch,
  snapshotWorkspace: (workspacePath: string) => Promise<string>,
  heartbeatIntervalMs: number,
  now: () => Date,
  environment: NodeJS.ProcessEnv,
): Promise<AutomatedReviewAttemptResult> {
  if (
    context.attempt.id !== config.attemptId || context.attempt.runId !== config.runId ||
    context.attempt.version !== fencing.version ||
    context.attempt.leaseGeneration !== fencing.leaseGeneration ||
    context.attempt.baseSha !== config.baseSha || context.review.headSha !== config.baseSha ||
    context.task.digest !== config.taskDigest
  ) throw new AnalysisRunnerError('automated review context identity does not match dispatch');
  if (new SecretScanner({ secrets: [...runtimeSecrets] }).scan(context).length > 0) {
    throw new AnalysisRunnerError('automated review context contains a runtime Secret');
  }
  const temporaryRoot = await mkdtemp(join(config.runnerTempPath, 'delivery-loop-review-'));
  await chmod(temporaryRoot, 0o700);
  const contextFilePath = join(temporaryRoot, 'context.json');
  const outputFilePath = join(temporaryRoot, 'result.json');
  const outputSchemaPath = join(temporaryRoot, 'result-schema.json');
  const heartbeatController = new AbortController();
  const requestLock = new FencingRequestLock();
  let heartbeatFailure: unknown;
  let heartbeatTask: Promise<void> = Promise.resolve();
  let reservation: z.infer<typeof ModelReservationResponseSchema> | undefined;
  const measuredUsages: CodexModelUsage[] = [];
  try {
    if (options.reviewAgent === undefined || options.reviewAgent.usesMeteredModel === true) {
      if (config.modelProfileId === undefined) {
        throw new AnalysisRunnerError('automated review model profile is unavailable');
      }
      const reservationDigest = await canonicalSha256({
        attemptId: config.attemptId,
        kind: 'automated_review',
        leaseGeneration: fencing.leaseGeneration,
      });
      const reservationId =
        `model_reservation_${reservationDigest.slice('sha256:'.length, 'sha256:'.length + 48)}`;
      const rawReservation = await controlPlaneJson(
        fetchImplementation,
        config,
        `/v1/attempts/${config.attemptId}/model-reservations`,
        fencing.token,
        'model quota reservation',
        [200, 201],
        {
          reservationId,
          profileId: config.modelProfileId,
          expectedVersion: fencing.version,
          leaseGeneration: fencing.leaseGeneration,
        },
      );
      const parsed = ModelReservationResponseSchema.safeParse(rawReservation);
      if (!parsed.success || parsed.data.reservationId !== reservationId ||
        parsed.data.attemptId !== config.attemptId || parsed.data.runId !== config.runId) {
        throw new AnalysisRunnerError('model quota reservation response is invalid');
      }
      reservation = parsed.data;
    }
    heartbeatTask = heartbeatLoop(
      fetchImplementation,
      config,
      fencing,
      heartbeatIntervalMs,
      heartbeatController.signal,
      runtimeSecrets,
      requestLock,
    ).catch((error: unknown) => {
      heartbeatFailure = error;
    });
    await Promise.all([
      writeFile(contextFilePath, JSON.stringify(context), { mode: 0o600, flag: 'wx' }),
      writeFile(outputFilePath, '', { mode: 0o600, flag: 'wx' }),
      writeFile(
        outputSchemaPath,
        JSON.stringify(AUTOMATED_REVIEW_RESULT_V1_JSON_SCHEMA),
        { mode: 0o600, flag: 'wx' },
      ),
    ]);
    const agent = options.reviewAgent ?? new CodexReviewAdapter({
      outputSchemaPath,
      runtimeSecrets: [...runtimeSecrets],
      ...(environment.OPENAI_BASE_URL === undefined ||
        environment.OPENAI_BASE_URL === ''
        ? {}
        : { providerBaseUrl: environment.OPENAI_BASE_URL }),
    });
    let result: AutomatedReviewResultV1;
    try {
      result = await agent.start({
        workspacePath: config.workspacePath,
        contextFilePath,
        outputFilePath,
        timeoutMs: ANALYSIS_TIMEOUT_MS,
        ...(reservation === undefined
          ? {}
          : {
              model: reservation.model,
              onUsage: (usage: CodexModelUsage) => measuredUsages.push(usage),
            }),
      });
    } catch (error) {
      throw new AnalysisRunnerError('automated review Agent output is invalid', {
        failureCode: 'invalid_agent_output',
        failureSite: 'agent_output',
        attemptedPaths: ['repository_inspection'],
        neededHumanInput: 'manual_investigation',
      }, error instanceof CodexReviewAdapterError
        ? {
            kind: error.kind,
            stage: 'single_pass',
            ...(error.providerFailureCode === undefined
              ? {}
              : { providerFailureCode: error.providerFailureCode }),
          }
        : undefined);
    }
    heartbeatController.abort();
    await heartbeatTask;
    if (heartbeatFailure !== undefined) {
      throw new AnalysisRunnerError('attempt heartbeat failed during automated review');
    }
    if (reservation !== undefined) {
      if (measuredUsages.length !== 1) {
        throw new AnalysisRunnerError('automated review Agent usage is unavailable');
      }
      const usageDigest = await canonicalSha256({
        reservationId: reservation.reservationId,
        attemptId: config.attemptId,
      });
      const usageId =
        `model_usage_${usageDigest.slice('sha256:'.length, 'sha256:'.length + 54)}`;
      const rawUsage = await controlPlaneJson(
        fetchImplementation,
        config,
        `/v1/attempts/${config.attemptId}/model-usage`,
        fencing.token,
        'model usage settlement',
        [200, 201],
        {
          reservationId: reservation.reservationId,
          usageId,
          expectedVersion: fencing.version,
          leaseGeneration: fencing.leaseGeneration,
          ...measuredUsages[0]!,
        },
      );
      if (!ModelUsageResponseSchema.safeParse(rawUsage).success) {
        throw new AnalysisRunnerError('model usage settlement response is invalid');
      }
    }
    if (await snapshotWorkspace(config.workspacePath) !== beforeSnapshot) {
      throw new AnalysisRunnerError('repository workspace changed during automated review', {
        failureCode: 'workspace_changed',
        failureSite: 'repo_snapshot',
        attemptedPaths: ['repository_inspection'],
        neededHumanInput: 'manual_investigation',
      });
    }
    const rawCompletion = await controlPlaneJson(
      fetchImplementation,
      config,
      `/v1/attempts/${config.attemptId}/automated-review-result`,
      fencing.token,
      'automated review result',
      [200, 201],
      result,
    );
    const completion = AutomatedReviewCompletionResponseSchema.safeParse(rawCompletion);
    if (!completion.success || completion.data.reviewId !== context.review.id) {
      throw new AnalysisRunnerError('automated review result response is invalid');
    }
    return {
      reviewId: completion.data.reviewId,
      status: completion.data.status,
      ...(completion.data.fixAttemptId === undefined
        ? {}
        : { fixAttemptId: completion.data.fixAttemptId }),
    };
  } catch (error) {
    heartbeatController.abort();
    await heartbeatTask;
    const terminalError = terminalAnalysisRunnerError(error);
    try {
      await reportAttemptFailure(
        fetchImplementation,
        config,
        fencing,
        terminalError.failure!,
        now(),
      );
    } catch {
      // The original safe classification remains authoritative. GitHub fact
      // reconciliation and the stuck detector retain the durable fallback.
    }
    throw terminalError;
  } finally {
    heartbeatController.abort();
    await heartbeatTask;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/** Runs one analysis-only GitHub attempt without treating the hosted Runner as durable state. */
export async function runAnalysisAttempt(
  options: RunAnalysisAttemptOptions = {},
): Promise<AnalysisAttemptResult | AutomatedReviewAttemptResult> {
  const environment = options.environment ?? process.env;
  const config = configuration(environment);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const snapshotWorkspace = options.snapshotWorkspace ?? snapshotGitWorkspace;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
    throw new AnalysisRunnerError('analysis Runner heartbeat interval is invalid');
  }

  const beforeSnapshot = await snapshotWorkspace(config.workspacePath);
  const oidcToken = await obtainGitHubOidcToken(fetchImplementation, config);
  const fencing = await exchangeAttemptToken(fetchImplementation, config, oidcToken);
  const runtimeSecrets = new Set<string>([
    oidcToken,
    fencing.token,
    fencing.toolToken,
    config.oidcRequestToken,
    ...Object.entries(environment)
      .filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && isSensitiveFieldName(entry[0]),
      )
      .map(([, value]) => value),
  ]);
  let rawContext: unknown;
  try {
    rawContext = await controlPlaneContextJson(
      fetchImplementation,
      config,
      fencing.token,
    );
  } catch (error) {
    const terminalError = terminalAnalysisRunnerError(error);
    try {
      await reportAttemptFailure(
        fetchImplementation,
        config,
        fencing,
        terminalError.failure!,
        now(),
      );
    } catch {
      // GitHub fact reconciliation remains the durable fallback when even the
      // exact failure callback cannot be accepted.
    }
    throw terminalError;
  }
  const automatedReviewContext = AutomatedReviewContextV1Schema.safeParse(rawContext);
  if (automatedReviewContext.success) {
    return await runAutomatedReview(
      automatedReviewContext.data,
      config,
      fencing,
      runtimeSecrets,
      beforeSnapshot,
      options,
      fetchImplementation,
      snapshotWorkspace,
      heartbeatIntervalMs,
      now,
      environment,
    );
  }
  const contextResult = ContextResponseSchema.safeParse(rawContext);
  if (!contextResult.success) throw new AnalysisRunnerError('analysis context response is invalid');
  const context = contextResult.data;
  if (
    context.attempt.id !== config.attemptId ||
    context.attempt.runId !== config.runId ||
    context.attempt.version !== fencing.version ||
    context.attempt.leaseGeneration !== fencing.leaseGeneration ||
    context.attempt.baseSha !== config.baseSha ||
    (await taskRevisionDigest(context.task)) !== config.taskDigest
  ) {
    throw new AnalysisRunnerError('analysis context identity does not match dispatch');
  }
  const carriedDiagnosticEvidenceRef = context.carriedDiagnosticEvidenceRef;
  if (
    carriedDiagnosticEvidenceRef !== undefined &&
    (
      context.revisionSource?.kind !== 'base_update' ||
      context.task.intent.kind !== 'bug' ||
      !context.task.policy.allowRepositoryWrite ||
      !context.planPolicy.requiresRepositoryChange
    )
  ) {
    throw new AnalysisRunnerError('analysis carried diagnostic context is invalid');
  }

  const temporaryRoot = await mkdtemp(join(config.runnerTempPath, 'delivery-loop-analysis-'));
  let workspaceContextRoot: string | undefined;
  try {
    await chmod(temporaryRoot, 0o700);
    workspaceContextRoot = await mkdtemp(
      join(config.workspacePath, '.delivery-loop-analysis-context-'),
    );
    await chmod(workspaceContextRoot, 0o700);
  } catch (error) {
    if (workspaceContextRoot !== undefined) {
      await rm(workspaceContextRoot, { recursive: true, force: true });
    }
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  const contextFilePath = join(workspaceContextRoot, 'context.json');
  const outputFilePath = join(temporaryRoot, 'plan-content.json');
  const analysisOutputSchemaPath = join(temporaryRoot, 'analysis-agent-output-schema.json');
  const mediationContextFilePath = join(temporaryRoot, 'diagnostic-context.json');
  const logRequestOutputFilePath = join(temporaryRoot, 'diagnostic-log-request.json');
  const traceRequestOutputFilePath = join(temporaryRoot, 'diagnostic-trace-request.json');
  const logRequestSchemaPath = join(temporaryRoot, 'diagnostic-log-request-schema.json');
  const traceRequestSchemaPath = join(temporaryRoot, 'diagnostic-trace-request-schema.json');
  const diagnosticRootCauseSchemaPath = join(
    temporaryRoot,
    'diagnostic-root-cause-schema.json',
  );
  const heartbeatController = new AbortController();
  const requestLock = new FencingRequestLock();
  let heartbeatFailure: unknown;
  let heartbeatTask: Promise<void> = Promise.resolve();
  const modelReservations: Array<z.infer<typeof ModelReservationResponseSchema>> = [];
  const measuredUsages: CodexModelUsage[] = [];
  const diagnosticMediation = context.task.intent.kind === 'bug' &&
      carriedDiagnosticEvidenceRef === undefined
    ? new ControlledDiagnosticMediation(
        fetchImplementation,
        config,
        fencing,
        runtimeSecrets,
        requestLock,
      )
    : null;
  let workspaceContextRemoved = false;
  const removeWorkspaceContext = async (): Promise<void> => {
    if (workspaceContextRemoved) return;
    await rm(workspaceContextRoot, { recursive: true, force: true });
    workspaceContextRemoved = true;
  };
  const usesMeteredModel = options.agent === undefined || options.agent.usesMeteredModel === true;
  const reserveModelInvocation = async (invocation: number): Promise<void> => {
    if (!usesMeteredModel) return;
    if (!Number.isSafeInteger(invocation) || invocation !== modelReservations.length + 1) {
      throw new AnalysisRunnerError('analysis model invocation order is invalid');
    }
    if (config.modelProfileId === undefined) {
      throw new AnalysisRunnerError('analysis Runner model profile is unavailable');
    }
    const reservationDigest = await canonicalSha256({
      attemptId: config.attemptId,
      invocation,
    });
    const reservationId =
      `model_reservation_${reservationDigest.slice('sha256:'.length, 'sha256:'.length + 48)}`;
    const rawReservation = await requestLock.run(async () => await controlPlaneJson(
      fetchImplementation,
      config,
      `/v1/attempts/${config.attemptId}/model-reservations`,
      fencing.token,
      'model quota reservation',
      [200, 201],
      {
        reservationId,
        profileId: config.modelProfileId,
        expectedVersion: fencing.version,
        leaseGeneration: fencing.leaseGeneration,
      },
    ));
    const parsedReservation = ModelReservationResponseSchema.safeParse(rawReservation);
    if (
      !parsedReservation.success ||
      parsedReservation.data.reservationId !== reservationId ||
      parsedReservation.data.attemptId !== config.attemptId ||
      parsedReservation.data.runId !== config.runId ||
      (modelReservations[0] !== undefined &&
        (parsedReservation.data.provider !== modelReservations[0].provider ||
          parsedReservation.data.model !== modelReservations[0].model))
    ) throw new AnalysisRunnerError('model quota reservation response is invalid');
    modelReservations.push(parsedReservation.data);
  };

  try {
    if (usesMeteredModel) {
      const invocationCount = diagnosticMediation === null ? 1 : 4;
      for (let invocation = 1; invocation <= invocationCount; invocation += 1) {
        await reserveModelInvocation(invocation);
      }
    }
    heartbeatTask = heartbeatLoop(
      fetchImplementation,
      config,
      fencing,
      heartbeatIntervalMs,
      heartbeatController.signal,
      runtimeSecrets,
      requestLock,
    ).catch((error: unknown) => {
      heartbeatFailure = error;
    });
    if (new SecretScanner({ secrets: [...runtimeSecrets] }).scan(context).length > 0) {
      throw new AnalysisRunnerError('analysis context contains a runtime Secret');
    }
    const agentContext = { ...context };
    delete agentContext.carriedDiagnosticEvidenceRef;
    await writeFile(
      contextFilePath,
      JSON.stringify(await createAnalysisContextFileV1(agentContext)),
      { mode: 0o600, flag: 'wx' },
    );
    await Promise.all([
      writeFile(outputFilePath, '', { mode: 0o600, flag: 'wx' }),
      writeFile(
        analysisOutputSchemaPath,
        JSON.stringify(ANALYSIS_AGENT_OUTPUT_V1_JSON_SCHEMA),
        { mode: 0o600, flag: 'wx' },
      ),
    ]);
    if (diagnosticMediation !== null) {
      await Promise.all([
        writeFile(mediationContextFilePath, '', { mode: 0o600, flag: 'wx' }),
        writeFile(logRequestOutputFilePath, '', { mode: 0o600, flag: 'wx' }),
        writeFile(traceRequestOutputFilePath, '', { mode: 0o600, flag: 'wx' }),
        writeFile(
          logRequestSchemaPath,
          JSON.stringify(DIAGNOSTIC_LOG_SEARCH_REQUEST_V1_JSON_SCHEMA),
          { mode: 0o600, flag: 'wx' },
        ),
        writeFile(
          traceRequestSchemaPath,
          JSON.stringify(DIAGNOSTIC_TRACE_REQUEST_V1_JSON_SCHEMA),
          { mode: 0o600, flag: 'wx' },
        ),
        writeFile(
          diagnosticRootCauseSchemaPath,
          JSON.stringify(DIAGNOSTIC_ROOT_CAUSE_RESULT_V1_JSON_SCHEMA),
          { mode: 0o600, flag: 'wx' },
        ),
      ]);
    }
    const identity = {
      planId: await deriveAnalysisPlanId(
        context.attempt.runId,
        context.attempt.id,
        context.planPolicy.version,
      ),
      runId: context.attempt.runId,
      version: context.planPolicy.version,
      taskRevision: context.task.source.revision,
      baseSha: context.attempt.baseSha,
      attemptId: context.attempt.id,
    };
    const validationBase = {
      runId: identity.runId,
      taskRevision: identity.taskRevision,
      baseSha: identity.baseSha,
      expectedVersion: identity.version,
      acceptanceCriteriaCount: context.task.intent.acceptanceCriteria.length,
      allowedCommandRefs: context.planPolicy.allowedCommandRefs,
      verificationCommandRefs: context.planPolicy.verificationCommandRefs,
      allowedEffects: context.planPolicy.allowedEffects,
      requiresRepositoryChange: context.planPolicy.requiresRepositoryChange,
      requiresTestDeployment: context.planPolicy.requiresTestDeployment,
    };
    const trustedPlanPolicy = deriveAnalysisPlanPolicy(
      context.task.intent.kind,
      context.task.policy.allowRepositoryWrite,
      context.task.policy.allowTestDeploy,
      context.task.target.environment,
    );
    const isUniqueSubset = (actual: readonly string[], trusted: readonly string[]): boolean =>
      new Set(actual).size === actual.length && actual.every((value) => trusted.includes(value));
    if (
      validationBase.requiresRepositoryChange !== trustedPlanPolicy.requiresRepositoryChange ||
      validationBase.requiresTestDeployment !== trustedPlanPolicy.requiresTestDeployment ||
      !isUniqueSubset(
        context.planPolicy.allowedEffects,
        trustedPlanPolicy.allowedEffects,
      ) ||
      !isUniqueSubset(
        context.planPolicy.allowedCommandRefs,
        trustedPlanPolicy.allowedCommandRefs,
      ) ||
      !isUniqueSubset(
        context.planPolicy.verificationCommandRefs,
        trustedPlanPolicy.verificationCommandRefs,
      ) ||
      (trustedPlanPolicy.requiresRepositoryChange && (
        !context.planPolicy.allowedEffects.includes('repo_write') ||
        !trustedPlanPolicy.allowedCommandRefs
          .filter((ref) => /^(?:test|verify):/.test(ref))
          .every((ref) => context.planPolicy.allowedCommandRefs.includes(ref)) ||
        !trustedPlanPolicy.verificationCommandRefs
          .every((ref) => context.planPolicy.verificationCommandRefs.includes(ref))
      ))
    ) {
      throw new AnalysisRunnerError('analysis Plan policy does not match trusted Task');
    }
    let writableRepositoryPaths: readonly string[] | undefined;
    if (validationBase.requiresRepositoryChange) {
      try {
        writableRepositoryPaths = await (
          options.listWritableRepositoryPaths ?? listAnalysisWritableRepositoryPaths
        )(config.workspacePath, config.baseSha);
      } catch {
        throw new AnalysisRunnerError('analysis repository path inventory is unavailable', {
          failureCode: 'unknown_failure',
          failureSite: 'repo_snapshot',
          attemptedPaths: ['repository_inspection'],
          neededHumanInput: 'manual_investigation',
        });
      }
      if (writableRepositoryPaths.length < 1) {
        throw new AnalysisRunnerError('analysis repository path inventory is unavailable', {
          failureCode: 'unknown_failure',
          failureSite: 'repo_snapshot',
          attemptedPaths: ['repository_inspection'],
          neededHumanInput: 'manual_investigation',
        });
      }
    }
    const validation = {
      ...validationBase,
      ...(writableRepositoryPaths === undefined ? {} : { writableRepositoryPaths }),
    };
    const agent =
      options.agent ??
      new CodexAnalysisAdapter({
        outputSchemaPath: analysisOutputSchemaPath,
        runtimeSecrets: [...runtimeSecrets],
        ...(environment.OPENAI_BASE_URL === undefined || environment.OPENAI_BASE_URL === ''
          ? {}
          : { providerBaseUrl: environment.OPENAI_BASE_URL }),
      });
    const canCorrectInitialPlan = diagnosticMediation === null &&
      carriedDiagnosticEvidenceRef === undefined && context.revisionSource === undefined;
    let validatedLocalPlan: ExecutionPlanV1 | undefined;
    let agentError: unknown;
    let correctionIssueCodes: readonly ExecutionPlanValidationIssueCode[] | undefined;
    let correctionReserved = false;
    const analysisDeadline = Date.now() + ANALYSIS_TIMEOUT_MS;
    const admitPlanCorrection = async (
      issueCodes: readonly ExecutionPlanValidationIssueCode[],
    ): Promise<void> => {
      if (correctionReserved || issueCodes.length === 0) {
        throw new AnalysisRunnerError('analysis Plan correction admission is invalid');
      }
      correctionReserved = true;
      await reserveModelInvocation(modelReservations.length + 1);
    };
    try {
      for (const pass of [1, 2] as const) {
        const timeoutMs = Math.floor(analysisDeadline - Date.now());
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
          throw new CodexAnalysisAdapterError('process_timeout', 'single_pass');
        }
        const agentResult = await agent.start({
          workspacePath: config.workspacePath,
          contextFilePath,
          outputFilePath,
          timeoutMs,
          identity,
          validation,
          ...(correctionIssueCodes === undefined ? {} : { correctionIssueCodes }),
          ...(canCorrectInitialPlan && correctionIssueCodes === undefined
            ? { onPlanCorrection: admitPlanCorrection }
            : {}),
          ...(modelReservations[0] === undefined
            ? {}
            : {
                model: modelReservations[0].model,
                onUsage: (usage: CodexModelUsage) => {
                  if (measuredUsages.length >= modelReservations.length) {
                    throw new Error('too many model usage results');
                  }
                  measuredUsages.push(usage);
                },
              }),
          ...(diagnosticMediation === null
            ? {}
            : {
                diagnostic: {
                  mediationContextFilePath,
                  logRequestOutputFilePath,
                  traceRequestOutputFilePath,
                  logRequestSchemaPath,
                  traceRequestSchemaPath,
                  rootCauseSchemaPath: diagnosticRootCauseSchemaPath,
                  mediation: diagnosticMediation.agentInterface(),
                },
              }),
        });
        const localPlan = ExecutionPlanV1Schema.parse(agentResult);
        try {
          validatedLocalPlan = await validateExecutionPlanProposal(localPlan, validation);
          break;
        } catch (error) {
          if (
            pass !== 1 || !canCorrectInitialPlan ||
            !(error instanceof ExecutionPlanValidationError)
          ) throw error;
          correctionIssueCodes = [...new Set(error.issues.map((issue) => issue.code))].sort();
          if (!correctionReserved) await admitPlanCorrection(correctionIssueCodes);
        }
      }
    } catch (error) {
      agentError = error;
    } finally {
      await removeWorkspaceContext();
    }
    heartbeatController.abort();
    await heartbeatTask;
    if (heartbeatFailure !== undefined) {
      throw new AnalysisRunnerError('attempt heartbeat failed during analysis');
    }
    if (modelReservations.length > 0) {
      if (
        measuredUsages.length > modelReservations.length ||
        (agentError === undefined && measuredUsages.length !== modelReservations.length)
      ) {
        throw new AnalysisRunnerError('analysis Agent usage is unavailable');
      }
      for (const [index, usage] of measuredUsages.entries()) {
        const modelReservation = modelReservations[index]!;
        const usageDigest = await canonicalSha256({
          reservationId: modelReservation.reservationId,
          attemptId: config.attemptId,
        });
        const usageId = `model_usage_${usageDigest.slice(
          'sha256:'.length,
          'sha256:'.length + 54,
        )}`;
        const rawUsage = await requestLock.run(async () => await controlPlaneJson(
          fetchImplementation,
          config,
          `/v1/attempts/${config.attemptId}/model-usage`,
          fencing.token,
          'model usage settlement',
          [200, 201],
          {
            reservationId: modelReservation.reservationId,
            usageId,
            expectedVersion: fencing.version,
            leaseGeneration: fencing.leaseGeneration,
            ...usage,
          },
        ));
        const parsedUsage = ModelUsageResponseSchema.safeParse(rawUsage);
        if (
          !parsedUsage.success ||
          parsedUsage.data.usageId !== usageId ||
          parsedUsage.data.reservationId !== modelReservation.reservationId
        ) throw new AnalysisRunnerError('model usage settlement response is invalid');
      }
    }
    if (agentError !== undefined) {
      if (agentError instanceof AnalysisRunnerError) throw agentError;
      throw new AnalysisRunnerError('analysis Agent output is invalid', {
        failureCode: 'invalid_agent_output',
        failureSite: 'agent_output',
        attemptedPaths: ['repository_inspection'],
        neededHumanInput: 'manual_investigation',
      }, agentError instanceof CodexAnalysisAdapterError
        ? {
            kind: agentError.kind,
            stage: agentError.stage,
            ...(agentError.providerFailureCode === undefined
              ? {}
              : { providerFailureCode: agentError.providerFailureCode }),
          }
        : agentError instanceof ExecutionPlanValidationError
          ? { kind: 'plan_validation_failed', stage: 'plan_validation' }
          : undefined);
    }
    if (validatedLocalPlan === undefined) {
      throw new AnalysisRunnerError('analysis Agent did not produce a validated Plan');
    }
    let content = planContent(validatedLocalPlan);
    if (
      carriedDiagnosticEvidenceRef !== undefined &&
      content.evidenceRefs.some((ref) => DIAGNOSTIC_EVIDENCE_REF_PATTERN.test(ref))
    ) {
      throw invalidDiagnosticPlanShape();
    }
    if (new SecretScanner({ secrets: [...runtimeSecrets] }).scan(content).length > 0) {
      throw new AnalysisRunnerError('analysis Agent output contains sensitive material', {
        failureCode: 'invalid_agent_output',
        failureSite: 'agent_output',
        attemptedPaths: ['repository_inspection'],
        neededHumanInput: 'manual_investigation',
      });
    }
    if (diagnosticMediation !== null) {
      if (
        !diagnosticMediation.isReady() ||
        content.evidenceRefs.some((ref) => DIAGNOSTIC_EVIDENCE_REF_PATTERN.test(ref)) ||
        !content.items.some(consumesBoundDiagnosticEvidence)
      ) {
        throw invalidDiagnosticPlanShape();
      }
    }
    const afterSnapshot = await snapshotWorkspace(config.workspacePath);
    if (afterSnapshot !== beforeSnapshot) {
      throw new AnalysisRunnerError('repository workspace changed during analysis', {
        failureCode: 'workspace_changed',
        failureSite: 'repo_snapshot',
        attemptedPaths: ['repository_inspection'],
        neededHumanInput: 'manual_investigation',
      });
    }

    if (diagnosticMediation !== null) {
      validatedLocalPlan = await bindDiagnosticEvidence(
        validatedLocalPlan,
        await diagnosticMediation.persistEvidence(),
        validation,
      );
      content = planContent(validatedLocalPlan);
    } else if (carriedDiagnosticEvidenceRef !== undefined) {
      validatedLocalPlan = await bindCarriedDiagnosticEvidence(
        validatedLocalPlan,
        carriedDiagnosticEvidenceRef,
        validation,
      );
      content = planContent(validatedLocalPlan);
    }

    const rawPlan = await controlPlaneJson(
      fetchImplementation,
      config,
      `/v1/attempts/${config.attemptId}/plan`,
      fencing.token,
      'analysis Plan submission',
      [200, 201],
      content,
    );
    const planResult = PlanResponseSchema.safeParse(rawPlan);
    if (
      !planResult.success ||
      planResult.data.planId !== validatedLocalPlan.id ||
      planResult.data.version !== validatedLocalPlan.version ||
      planResult.data.digest !== validatedLocalPlan.digest ||
      planResult.data.payloadRef !== `d1://execution-plans/${validatedLocalPlan.id}`
    ) {
      throw new AnalysisRunnerError('analysis Plan response does not match local proposal');
    }

    const eventDigest = await canonicalSha256({
      attemptId: config.attemptId,
      planId: planResult.data.planId,
      sequence: 1,
    });
    const rawCompletion = await controlPlaneJson(
      fetchImplementation,
      config,
      `/v1/attempts/${config.attemptId}/complete`,
      fencing.token,
      'attempt completion',
      [202],
      {
        schemaVersion: config.schemaVersion,
        eventId: `attempt_result_${eventDigest.slice('sha256:'.length, 'sha256:'.length + 56)}`,
        sequence: 1,
        payloadRef: planResult.data.payloadRef,
        digest: planResult.data.digest,
        occurredAt: now().toISOString(),
        expectedVersion: fencing.version,
        leaseGeneration: fencing.leaseGeneration,
      },
    );
    if (!CompletionResponseSchema.safeParse(rawCompletion).success) {
      throw new AnalysisRunnerError('attempt completion response is invalid');
    }
    return {
      planId: planResult.data.planId,
      version: planResult.data.version,
      digest: planResult.data.digest,
      payloadRef: planResult.data.payloadRef,
    };
  } catch (error) {
    heartbeatController.abort();
    await heartbeatTask;
    const terminalError = terminalAnalysisRunnerError(error);
    try {
      await reportAttemptFailure(
        fetchImplementation,
        config,
        fencing,
        terminalError.failure!,
        now(),
      );
    } catch {
      // The original safe classification remains authoritative. GitHub fact
      // reconciliation and the stuck detector retain the durable fallback.
    }
    throw terminalError;
  } finally {
    heartbeatController.abort();
    await heartbeatTask;
    try {
      await removeWorkspaceContext();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}
