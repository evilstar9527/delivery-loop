import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  CodexExecutionAdapter,
  CodexExecutionAdapterError,
  type ExecutionAgent,
  type ExecutionAgentDecision,
} from '../agent/codex-execution-adapter.js';
import { EXECUTOR_CODEX_COMMAND } from '../agent/executor-codex-command.js';
import { BoundedEditRecoveryAgent } from '../agent/bounded-edit-recovery-agent.js';
import {
  CodexExecutionActivityAccumulator,
  type CodexExecutionActivity,
} from '../agent/codex-execution-activity.js';
import { EvidenceKindSchema, PlanEffectSchema } from '../domain/plan.js';
import { AutomatedReviewIdSchema } from '../domain/automated-review.js';
import { canonicalSha256 } from '../domain/digest.js';
import { resolveDeliveryCommand } from '../domain/delivery-policy.js';
import { taskRevisionDigest, TaskEnvelopeSchema } from '../domain/task.js';
import { EXECUTION_TOOL_ACTIONS, isExactExecutionToolActions } from '../domain/tool-bridge.js';
import { SecretScanner, isSensitiveFieldName } from '../security/redaction.js';
import type { CodexModelUsage } from '../domain/quota.js';
import { executorModelProviderBaseUrl } from '../agent/provider-base-url.js';
import {
  ControlPlaneExecutionFailureReporter,
  ControlPlaneExecutionHeadReporter,
  ControlPlaneBaseRebaseReporter,
  ControlPlanePlanRevisionReporter,
  type MutableExecutionReporterAuthorization,
} from './execution-control-plane-reporters.js';
import {
  ExecutionAttemptRunner,
  type ExecutionAttemptResult,
} from './execution-attempt-runner.js';
import {
  GitRepositoryWriter,
  executeGitCommand,
} from './git-repository-writer.js';
import { loadDeliveryPolicyAtCommit } from './delivery-policy-loader.js';
import { BaseRebaseRunner } from './base-rebase-runner.js';
import { DeliveryCommandRunner } from './delivery-command-runner.js';
import { ControlPlaneProtectedPathApprovalReporter } from './protected-path-approval-reporter.js';
import { validateExecutionPatchProposal } from './execution-patch-policy.js';
import {
  buildOptionalExecutionPatchSnapshot,
  type ExecutionPatchSnapshotV1,
} from './execution-patch-snapshot.js';
import {
  ControlPlaneVerificationEvidenceReporter,
  type VerificationReporterAuthorization,
} from './verification-evidence-reporter.js';
import { checkoutExecutorRepository } from './executor-repository-checkout.js';
import { uploadExecutorWorkPatch } from './executor-patch-client.js';
import {
  ExecutorWorkAttemptRunner,
  type ExecutorWorkAttemptResult,
} from './executor-work-runner.js';

const OIDC_AUDIENCE = 'delivery-loop-control-plane';
const HEARTBEAT_INTERVAL_MS = 45_000;
// Heartbeats keep the Attempt lease live; the writer reauthorizes the same
// repository token after the model turn and before any durable Git write.
const AGENT_TIMEOUT_MS = 10 * 60_000;
const MAX_RESPONSE_BYTES = 512 * 1_024;
const MAX_RAW_TRANSCRIPT_BYTES = 512 * 1_024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

const OidcResponseSchema = z.object({ value: z.string().min(1).max(20_000) }).strict();
const ExchangeResponseSchema = z.object({
  attemptToken: z.string().min(1).max(4_096),
  expiresAt: z.iso.datetime({ offset: true }),
  attemptVersion: z.number().int().nonnegative(),
  leaseGeneration: z.number().int().positive(),
  grant: z.object({
    toolBridgeToken: z.string().min(1).max(4_096),
    expiresAt: z.iso.datetime({ offset: true }),
    scopes: z.array(z.string().min(1).max(100)).length(EXECUTION_TOOL_ACTIONS.length),
  }).strict(),
}).strict();

const ContextResponseSchema = z.object({
  schemaVersion: z.literal('1'),
  attempt: z.object({
    id: z.string().regex(ID_PATTERN),
    runId: z.string().min(1).max(64),
    taskId: z.string().regex(ID_PATTERN),
    mode: z.enum(['implement', 'review_fix']),
    version: z.number().int().nonnegative(),
    leaseGeneration: z.number().int().positive(),
    baseSha: z.string().regex(SHA_PATTERN),
    checkoutSha: z.string().regex(SHA_PATTERN),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    baseBranch: z.string().min(1).max(240),
    planId: z.string().regex(ID_PATTERN),
    planVersion: z.number().int().positive(),
    planItemId: z.string().regex(ID_PATTERN),
    targetBranch: z.string().min(1).max(240),
    targetBranchMode: z.enum(['new', 'existing_fast_forward']),
  }).strict(),
  task: TaskEnvelopeSchema,
  item: z.object({
    id: z.string().regex(ID_PATTERN),
    kind: z.enum(['investigation', 'change', 'verification', 'delivery']),
    title: z.string().min(1).max(500),
    objective: z.string().min(1).max(5_000),
    required: z.literal(true),
    doneWhen: z.array(z.string().min(1).max(2_000)).min(1).max(50),
    commandRefs: z.array(z.string().min(1).max(80)).min(2).max(100),
    evidenceKinds: z.array(EvidenceKindSchema).min(1).max(20),
    effects: z.array(PlanEffectSchema).min(1).max(20),
  }).strict(),
  repair: z.object({
    failedAttemptId: z.string().regex(ID_PATTERN),
    sourceSuiteId: z.string().regex(ID_PATTERN),
    sourceEvidenceId: z.string().regex(ID_PATTERN),
    sourceHeadSha: z.string().regex(SHA_PATTERN),
    failureFactDigest: z.string().regex(DIGEST_PATTERN),
    phase: z.enum(['targeted', 'required_verify']),
    commandRef: z.string().min(1).max(80),
    exitCode: z.number().int().positive().max(255),
  }).strict().optional(),
  reviewFeedback: z.object({
    reviewId: z.union([z.string().regex(/^[0-9]+$/), AutomatedReviewIdSchema]),
    body: z.string().min(1).max(65_536),
    bodyDigest: z.string().regex(DIGEST_PATTERN),
    sourceHeadSha: z.string().regex(SHA_PATTERN),
    branch: z.string().min(1).max(240),
    url: z.url().max(2_000),
    submittedAt: z.iso.datetime({ offset: true }),
  }).strict().optional(),
  baseRebase: z.object({
    sourceAttemptId: z.string().regex(ID_PATTERN),
    sourceBranch: z.string().min(1).max(240),
    sourceHeadSha: z.string().regex(SHA_PATTERN),
    oldBaseSha: z.string().regex(SHA_PATTERN),
    newBaseSha: z.string().regex(SHA_PATTERN),
  }).strict().optional(),
  reviewApprovalRecovery: z.object({
    sourceAttemptId: z.string().regex(ID_PATTERN),
    sourceHeadSha: z.string().regex(SHA_PATTERN),
    sourceKind: z.enum(['failed_dependency', 'lost_pre_effect']),
  }).strict().optional(),
}).strict();

const HeartbeatResponseSchema = z.object({
  attemptToken: z.string().min(1).max(4_096),
  toolBridgeToken: z.string().min(1).max(4_096),
  version: z.number().int().nonnegative(),
  leaseGeneration: z.number().int().positive(),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();

const CredentialResponseSchema = z.object({
  credentialId: z.string().regex(ID_PATTERN),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  token: z.string().min(1).max(2_000),
  expiresAt: z.iso.datetime({ offset: true }),
  githubExpiresAt: z.iso.datetime({ offset: true }),
  approvalId: z.string().regex(ID_PATTERN),
  permissions: z.object({
    contents: z.literal('write'),
    pullRequests: z.literal('write'),
  }).strict(),
  created: z.boolean(),
}).strict();

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

const ModelGrantResponseSchema = z.object({
  grantId: z.string().regex(ID_PATTERN),
  reservationId: z.string().regex(ID_PATTERN),
  token: z.string().min(16).max(2_000),
  expiresAt: z.iso.datetime({ offset: true }),
  created: z.boolean(),
}).strict();

const RawTranscriptArtifactResponseSchema = z.discriminatedUnion('status', [
  z.object({
    accepted: z.literal(true),
    status: z.literal('ready'),
    artifactId: z.uuid(),
    category: z.literal('raw_transcript'),
    objectIdentityDigest: z.string().regex(DIGEST_PATTERN),
    ciphertextDigest: z.string().regex(DIGEST_PATTERN),
    sizeBytes: z.number().int().positive(),
    expiresAt: z.iso.datetime({ offset: true }),
    created: z.boolean(),
  }).strict(),
  z.object({
    accepted: z.literal(true),
    status: z.literal('uploading'),
    artifactId: z.uuid(),
    category: z.literal('raw_transcript'),
    objectIdentityDigest: z.string().regex(DIGEST_PATTERN),
    created: z.literal(false),
  }).strict(),
]);

interface RunnerConfiguration {
  schemaVersion: '1';
  runId: string;
  attemptId: string;
  taskDigest: string;
  baseSha: string;
  checkoutSha: string;
  mode: 'implement' | 'review_fix';
  planVersion: number;
  planItemId: string;
  modelProfileId?: string;
  repository: string;
  controlPlaneUrl: string;
  identityKind: 'github_oidc' | 'executor_proxy';
  executionId?: string;
  oidcRequestUrl?: string;
  oidcRequestToken?: string;
  workspacePath: string;
  runnerTempPath: string;
}

export interface RunExecutionAttemptOptions {
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  agent?: ExecutionAgent;
  heartbeatIntervalMs?: number;
  now?: () => Date;
  onAgentActivity?: (activity: CodexExecutionActivity) => void;
  checkoutRepository?: typeof checkoutExecutorRepository;
}

export type ExecutionRunnerFailureKind =
  | 'checkout_invalid'
  | 'oidc_exchange_failed'
  | 'context_invalid'
  | 'policy_invalid'
  | 'quota_unavailable'
  | 'credential_unavailable'
  | 'unknown';

export class ExecutionRunnerError extends Error {
  constructor(
    message: string,
    readonly kind: ExecutionRunnerFailureKind = 'unknown',
  ) {
    super(message);
    this.name = 'ExecutionRunnerError';
  }
}

class RawTranscriptBuffer {
  private readonly lines: string[] = [];
  private readonly activity = new CodexExecutionActivityAccumulator();
  private sizeBytes = 0;

  constructor(private readonly runtimeSecrets: Set<string>) {}

  accept(line: string): void {
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      throw new CodexExecutionAdapterError('transcript_invalid');
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new CodexExecutionAdapterError('transcript_invalid');
    }
    if (
      new SecretScanner({ secrets: [...this.runtimeSecrets] })
        .scanText(line, '$.agent_transcript').length > 0
    ) {
      throw new CodexExecutionAdapterError('transcript_invalid');
    }
    const sizeBytes = new TextEncoder().encode(`${line}\n`).length;
    if (this.sizeBytes + sizeBytes > MAX_RAW_TRANSCRIPT_BYTES) {
      throw new CodexExecutionAdapterError('transcript_invalid');
    }
    this.activity.accept(event);
    this.lines.push(line);
    this.sizeBytes += sizeBytes;
  }

  content(): string | null {
    return this.lines.length === 0 ? null : `${this.lines.join('\n')}\n`;
  }

  activitySummary(): CodexExecutionActivity {
    return this.activity.result();
  }
}

/**
 * Shortest gap between progress activity snapshots. An Agent turn can run for
 * minutes without producing a terminal record, and a session view that stays
 * empty for that long is indistinguishable from a wedged container. Throttling
 * keeps the counter-only projection useful as a liveness signal without
 * emitting a log line per transcript event.
 */
const ACTIVITY_PROGRESS_INTERVAL_MS = 5_000;

export interface RawTranscriptArtifactAgentOptions {
  agent: ExecutionAgent;
  runtimeSecrets: ReadonlySet<string>;
  persist(content: string): Promise<void>;
  onActivity?(activity: CodexExecutionActivity): void;
  validateDecision?(decision: ExecutionAgentDecision): ExecutionAgentDecision;
  now?: () => number;
}

/**
 * Persists the encrypted raw transcript without allowing that secondary
 * artifact operation to erase the Agent's primary typed failure.
 */
export function createRawTranscriptArtifactAgent(
  options: RawTranscriptArtifactAgentOptions,
): ExecutionAgent {
  return {
    ...(options.agent.usesMeteredModel === undefined
      ? {}
      : { usesMeteredModel: options.agent.usesMeteredModel }),
    apply: async (input) => {
      const transcript = new RawTranscriptBuffer(new Set(options.runtimeSecrets));
      const now = options.now ?? Date.now;
      let decision: ExecutionAgentDecision | undefined;
      let agentFailure: unknown;
      let lastActivityAt = now();
      let lastActivityCount = 0;
      try {
        const applied = await options.agent.apply({
          ...input,
          onTranscriptLine: (line) => {
            transcript.accept(line);
            const at = now();
            if (at - lastActivityAt < ACTIVITY_PROGRESS_INTERVAL_MS) return;
            const summary = transcript.activitySummary();
            // A snapshot identical to the last one carries no new evidence.
            if (summary.jsonlEventCount === lastActivityCount) return;
            lastActivityAt = at;
            lastActivityCount = summary.jsonlEventCount;
            try {
              options.onActivity?.(summary);
            } catch {
              // Diagnostic logging cannot change the delivery Attempt outcome.
            }
          },
        });
        decision = options.validateDecision?.(applied) ?? applied;
      } catch (error) {
        agentFailure = error;
      } finally {
        try {
          options.onActivity?.(transcript.activitySummary());
        } catch {
          // Diagnostic logging cannot change the delivery Attempt outcome.
        }
      }

      let transcriptFailure: CodexExecutionAdapterError | undefined;
      try {
        const content = transcript.content();
        if (content === null) {
          if (options.agent.usesMeteredModel === true) {
            throw new CodexExecutionAdapterError('transcript_invalid');
          }
        } else {
          await options.persist(content);
        }
      } catch {
        transcriptFailure = new CodexExecutionAdapterError('transcript_invalid');
      }

      if (agentFailure !== undefined) throw agentFailure;
      if (transcriptFailure !== undefined) throw transcriptFailure;
      if (decision === undefined) {
        throw new CodexExecutionAdapterError('decision_invalid', 'invalid_output');
      }
      return decision;
    },
  };
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key];
  if (value === undefined || value.length === 0) {
    throw new ExecutionRunnerError('execution Runner configuration is incomplete');
  }
  return value;
}

function httpsUrl(raw: string, kind: 'origin' | 'request'): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ExecutionRunnerError('execution Runner URL configuration is invalid');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new ExecutionRunnerError('execution Runner URL configuration is invalid');
  }
  if (kind === 'origin' && (url.pathname !== '/' || url.search !== '' || url.hash !== '')) {
    throw new ExecutionRunnerError('execution Runner URL configuration is invalid');
  }
  return url;
}

function controlPlaneUrl(raw: string, executorProxy: boolean): URL {
  if (executorProxy && raw === 'http://control.delivery-loop.internal') {
    return new URL(raw);
  }
  return httpsUrl(raw, 'origin');
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function configuration(environment: NodeJS.ProcessEnv): RunnerConfiguration {
  const schemaVersion = requiredEnvironment(environment, 'DELIVERY_SCHEMA_VERSION');
  const runId = requiredEnvironment(environment, 'DELIVERY_RUN_ID');
  const attemptId = requiredEnvironment(environment, 'DELIVERY_ATTEMPT_ID');
  const taskDigest = requiredEnvironment(environment, 'DELIVERY_TASK_DIGEST');
  const baseSha = requiredEnvironment(environment, 'DELIVERY_BASE_SHA');
  const checkoutSha = requiredEnvironment(environment, 'DELIVERY_CHECKOUT_SHA');
  const mode = requiredEnvironment(environment, 'DELIVERY_ATTEMPT_MODE');
  const rawPlanVersion = requiredEnvironment(environment, 'DELIVERY_PLAN_VERSION');
  const planVersion = Number(rawPlanVersion);
  const planItemId = requiredEnvironment(environment, 'DELIVERY_PLAN_ITEM_ID');
  const modelProfileId = environment.DELIVERY_MODEL_PROFILE_ID;
  const repository = environment.DELIVERY_TARGET_REPOSITORY ??
    requiredEnvironment(environment, 'GITHUB_REPOSITORY');
  const executorIdentity = environment.DELIVERY_EXECUTOR_IDENTITY_KIND ===
    'cloudflare_sandbox_proxy';
  const controlPlane = controlPlaneUrl(
    requiredEnvironment(environment, 'DELIVERY_CONTROL_PLANE_URL'),
    executorIdentity,
  );
  const executionId = environment.DELIVERY_EXECUTION_ID;
  const oidcRequest = executorIdentity ? undefined : httpsUrl(
    requiredEnvironment(environment, 'ACTIONS_ID_TOKEN_REQUEST_URL'), 'request',
  );
  const rawWorkspace = environment.DELIVERY_REPOSITORY_PATH ??
    requiredEnvironment(environment, 'GITHUB_WORKSPACE');
  const rawRunnerTemp = requiredEnvironment(environment, 'RUNNER_TEMP');
  if (!isAbsolute(rawWorkspace) || !isAbsolute(rawRunnerTemp)) {
    throw new ExecutionRunnerError('execution Runner path configuration is invalid');
  }
  const workspacePath = resolve(rawWorkspace);
  const runnerTempPath = resolve(rawRunnerTemp);
  if (
    schemaVersion !== '1' ||
    runId.length > 64 ||
    !ID_PATTERN.test(attemptId) ||
    !DIGEST_PATTERN.test(taskDigest) ||
    !SHA_PATTERN.test(baseSha) ||
    !SHA_PATTERN.test(checkoutSha) ||
    (mode !== 'implement' && mode !== 'review_fix') ||
    !Number.isSafeInteger(planVersion) ||
    planVersion <= 0 ||
    String(planVersion) !== rawPlanVersion ||
    !ID_PATTERN.test(planItemId) ||
    (modelProfileId !== undefined && !ID_PATTERN.test(modelProfileId)) ||
    (executorIdentity && (executionId === undefined || !ID_PATTERN.test(executionId))) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    within(workspacePath, runnerTempPath)
  ) {
    throw new ExecutionRunnerError('execution Runner configuration is invalid');
  }
  return {
    schemaVersion: '1',
    runId,
    attemptId,
    taskDigest,
    baseSha,
    checkoutSha,
    mode,
    planVersion,
    planItemId,
    ...(modelProfileId === undefined ? {} : { modelProfileId }),
    repository,
    controlPlaneUrl: controlPlane.origin,
    identityKind: executorIdentity ? 'executor_proxy' : 'github_oidc',
    ...(executionId === undefined ? {} : { executionId }),
    ...(oidcRequest === undefined ? {} : {
      oidcRequestUrl: oidcRequest.toString(),
      oidcRequestToken: requiredEnvironment(environment, 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'),
    }),
    workspacePath,
    runnerTempPath,
  };
}

async function responseJson(
  response: Response,
  statuses: readonly number[],
  operation: string,
): Promise<unknown> {
  if (!statuses.includes(response.status)) {
    await response.body?.cancel();
    throw new ExecutionRunnerError(`${operation} failed with status ${response.status}`);
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ExecutionRunnerError(`${operation} returned an unreadable response`);
  }
  if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) {
    throw new ExecutionRunnerError(`${operation} returned an oversized response`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ExecutionRunnerError(`${operation} returned an invalid response`);
  }
}

async function fetchJson(
  fetcher: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  statuses: readonly number[],
  operation: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: 'error' });
  } catch {
    throw new ExecutionRunnerError(`${operation} request failed`);
  }
  return await responseJson(response, statuses, operation);
}

async function controlPlaneJson(
  fetcher: typeof globalThis.fetch,
  config: RunnerConfiguration,
  path: string,
  token: string,
  operation: string,
  statuses: readonly number[],
  body?: unknown,
): Promise<unknown> {
  return await fetchJson(fetcher, `${config.controlPlaneUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, statuses, operation);
}

class MutableFencing implements MutableExecutionReporterAuthorization {
  private gate: Promise<void> = Promise.resolve();

  constructor(
    private token: string,
    private toolToken: string,
    private version: number,
    private readonly generation: number,
    private readonly runtimeSecrets: Set<string>,
  ) {}

  authorization(): VerificationReporterAuthorization {
    return {
      attemptToken: this.token,
      expectedVersion: this.version,
      leaseGeneration: this.generation,
    };
  }

  updateVersion(previousVersion: number, nextVersion: number): void {
    if (this.version !== previousVersion || nextVersion !== previousVersion + 1) {
      throw new ExecutionRunnerError('execution fencing version changed');
    }
    this.version = nextVersion;
  }

  rotate(
    previous: VerificationReporterAuthorization,
    response: z.infer<typeof HeartbeatResponseSchema>,
  ): void {
    if (
      previous.expectedVersion !== this.version ||
      previous.leaseGeneration !== this.generation ||
      response.version !== this.version + 1 ||
      response.leaseGeneration !== this.generation ||
      response.attemptToken === response.toolBridgeToken
    ) {
      throw new ExecutionRunnerError('execution heartbeat fencing changed');
    }
    this.runtimeSecrets.add(response.attemptToken);
    this.runtimeSecrets.add(response.toolBridgeToken);
    this.token = response.attemptToken;
    this.toolToken = response.toolBridgeToken;
    this.version = response.version;
  }

  async withAuthorization<T>(
    operation: (authorization: VerificationReporterAuthorization) => Promise<T>,
  ): Promise<T> {
    const previous = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await previous;
    try {
      return await operation(this.authorization());
    } finally {
      release();
    }
  }
}

async function oidcToken(fetcher: typeof globalThis.fetch, config: RunnerConfiguration): Promise<string> {
  if (config.oidcRequestUrl === undefined || config.oidcRequestToken === undefined) {
    throw new ExecutionRunnerError('GitHub OIDC configuration is unavailable');
  }
  const url = new URL(config.oidcRequestUrl);
  url.searchParams.set('audience', OIDC_AUDIENCE);
  const parsed = OidcResponseSchema.safeParse(await fetchJson(fetcher, url.toString(), {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${config.oidcRequestToken}`,
    },
  }, [200], 'GitHub OIDC token request'));
  if (!parsed.success) throw new ExecutionRunnerError('GitHub OIDC token response is invalid');
  return parsed.data.value;
}

async function exchange(
  fetcher: typeof globalThis.fetch,
  config: RunnerConfiguration,
  token?: string,
): Promise<z.infer<typeof ExchangeResponseSchema>> {
  const executorProxy = config.identityKind === 'executor_proxy';
  if (!executorProxy && token === undefined) {
    throw new ExecutionRunnerError('attempt identity token is unavailable');
  }
  const parsed = ExchangeResponseSchema.safeParse(await fetchJson(
    fetcher,
    `${config.controlPlaneUrl}/v1/attempts/${config.attemptId}/` +
      (executorProxy ? 'executor-exchange' : 'exchange'),
    { method: 'POST', headers: {
      accept: 'application/json',
      authorization: `Bearer ${executorProxy ? 'executor-proxy' : token}`,
    } },
    [200],
    'attempt token exchange',
  ));
  if (
    !parsed.success ||
    !isExactExecutionToolActions(parsed.data.grant.scopes) ||
    parsed.data.grant.expiresAt !== parsed.data.expiresAt ||
    parsed.data.grant.toolBridgeToken === parsed.data.attemptToken
  ) {
    throw new ExecutionRunnerError('attempt token exchange response is invalid');
  }
  return parsed.data;
}

async function heartbeatLoop(
  fetcher: typeof globalThis.fetch,
  config: RunnerConfiguration,
  fencing: MutableFencing,
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await delay(intervalMs, undefined, { signal });
    } catch {
      if (signal.aborted) return;
      throw new ExecutionRunnerError('execution heartbeat wait failed');
    }
    if (signal.aborted) return;
    await fencing.withAuthorization(async (authorization) => {
      const parsed = HeartbeatResponseSchema.safeParse(await controlPlaneJson(
        fetcher,
        config,
        `/v1/attempts/${config.attemptId}/heartbeat`,
        authorization.attemptToken,
        'attempt heartbeat',
        [200],
        {
          expectedVersion: authorization.expectedVersion,
          leaseGeneration: authorization.leaseGeneration,
        },
      ));
      if (!parsed.success) {
        throw new ExecutionRunnerError('attempt heartbeat response is invalid');
      }
      fencing.rotate(authorization, parsed.data);
    });
  }
}

async function rawTranscriptArtifactId(attemptId: string): Promise<string> {
  const digest = await canonicalSha256({
    schemaVersion: '1',
    attemptId,
    category: 'raw_transcript',
  });
  const bytes = digest.slice('sha256:'.length, 'sha256:'.length + 32).split('');
  bytes[12] = '5';
  bytes[16] = ((Number.parseInt(bytes[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = bytes.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function persistRawTranscript(
  fetcher: typeof globalThis.fetch,
  config: RunnerConfiguration,
  fencing: MutableFencing,
  content: string,
): Promise<void> {
  const artifactId = await rawTranscriptArtifactId(config.attemptId);
  await fencing.withAuthorization(async (authorization) => {
    const parsed = RawTranscriptArtifactResponseSchema.safeParse(await controlPlaneJson(
      fetcher,
      config,
      `/v1/attempts/${config.attemptId}/artifacts`,
      authorization.attemptToken,
      'raw Agent transcript artifact',
      [200, 201, 202],
      {
        schemaVersion: '1',
        artifactId,
        category: 'raw_transcript',
        expectedVersion: authorization.expectedVersion,
        leaseGeneration: authorization.leaseGeneration,
        content,
      },
    ));
    if (
      !parsed.success || parsed.data.artifactId !== artifactId ||
      parsed.data.category !== 'raw_transcript'
    ) throw new ExecutionRunnerError('raw Agent transcript artifact response is invalid');
  });
}

async function assertCheckout(config: RunnerConfiguration): Promise<void> {
  const [head, status] = await Promise.all([
    executeGitCommand({
      repositoryPath: config.workspacePath,
      args: ['rev-parse', '--verify', 'HEAD'],
    }),
    executeGitCommand({
      repositoryPath: config.workspacePath,
      args: ['status', '--porcelain=v1', '--untracked-files=all'],
    }),
  ]);
  if (
    head.exitCode !== 0 ||
    head.stdout.trim() !== config.checkoutSha ||
    status.exitCode !== 0 ||
    status.stdout !== ''
  ) {
    throw new ExecutionRunnerError(
      'execution checkout does not match dispatch',
      'checkout_invalid',
    );
  }
}

async function materializeSourceBranch(
  config: RunnerConfiguration,
  branch: string,
  headSha: string,
): Promise<void> {
  const existing = await executeGitCommand({
    repositoryPath: config.workspacePath,
    args: ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
  });
  if (existing.exitCode === 1) {
    const created = await executeGitCommand({
      repositoryPath: config.workspacePath,
      args: ['branch', branch, headSha],
    });
    if (created.exitCode !== 0) {
      throw new ExecutionRunnerError('base rebase source branch is unavailable');
    }
  } else if (existing.exitCode !== 0) {
    throw new ExecutionRunnerError('base rebase source branch is unavailable');
  }
  const verified = await executeGitCommand({
    repositoryPath: config.workspacePath,
    args: ['rev-parse', '--verify', branch],
  });
  if (verified.exitCode !== 0 || verified.stdout.trim() !== headSha) {
    throw new ExecutionRunnerError('base rebase source branch is unavailable');
  }
}

/** Runs one approved execution Attempt while D1 remains the durable state owner. */
export async function runExecutionAttempt(
  options: RunExecutionAttemptOptions = {},
): Promise<ExecutionAttemptResult | ExecutorWorkAttemptResult> {
  const environment = options.environment ?? process.env;
  const config = configuration(environment);
  const fetcher = options.fetch ?? globalThis.fetch;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
    throw new ExecutionRunnerError('execution heartbeat interval is invalid');
  }
  if (config.identityKind === 'github_oidc') await assertCheckout(config);
  let oidc: string | undefined;
  let exchanged: z.infer<typeof ExchangeResponseSchema>;
  try {
    oidc = config.identityKind === 'github_oidc'
      ? await oidcToken(fetcher, config)
      : undefined;
    exchanged = await exchange(fetcher, config, oidc);
  } catch {
    throw new ExecutionRunnerError(
      'execution identity exchange failed',
      'oidc_exchange_failed',
    );
  }
  if (config.identityKind === 'executor_proxy') {
    try {
      await (options.checkoutRepository ?? checkoutExecutorRepository)({
        controlPlaneUrl: config.controlPlaneUrl,
        attemptId: config.attemptId,
        executionId: config.executionId!,
        attemptToken: exchanged.attemptToken,
        checkoutSha: config.checkoutSha,
        repositoryPath: config.workspacePath,
      });
      await assertCheckout(config);
    } catch {
      throw new ExecutionRunnerError(
        'execution repository checkout is unavailable',
        'checkout_invalid',
      );
    }
  }
  const runtimeSecrets = new Set<string>([
    oidc,
    exchanged.attemptToken,
    exchanged.grant.toolBridgeToken,
    config.oidcRequestToken,
    ...Object.entries(environment)
      .filter((entry): entry is [string, string] =>
        entry[1] !== undefined && isSensitiveFieldName(entry[0]))
      .map(([, value]) => value),
  ].filter((value): value is string => value !== undefined));
  const fencing = new MutableFencing(
    exchanged.attemptToken,
    exchanged.grant.toolBridgeToken,
    exchanged.attemptVersion,
    exchanged.leaseGeneration,
    runtimeSecrets,
  );
  let rawContext: unknown;
  try {
    rawContext = await fencing.withAuthorization(async (authorization) =>
      await controlPlaneJson(
        fetcher,
        config,
        `/v1/attempts/${config.attemptId}/context`,
        authorization.attemptToken,
        'execution context',
        [200],
      ));
  } catch {
    throw new ExecutionRunnerError('execution context is unavailable', 'context_invalid');
  }
  const parsedContext = ContextResponseSchema.safeParse(rawContext);
  if (!parsedContext.success) {
    throw new ExecutionRunnerError('execution context response is invalid', 'context_invalid');
  }
  const context = parsedContext.data;
  const derivedAttemptBranch = `agent/${context.attempt.taskId}/${config.attemptId}`;
  const executionSourceCount = Number(context.repair !== undefined) +
    Number(context.reviewFeedback !== undefined) +
    Number(context.baseRebase !== undefined) +
    Number(context.reviewApprovalRecovery !== undefined);
  if (
    context.attempt.id !== config.attemptId ||
    context.attempt.runId !== config.runId ||
    context.attempt.mode !== config.mode ||
    context.attempt.version !== exchanged.attemptVersion ||
    context.attempt.leaseGeneration !== exchanged.leaseGeneration ||
    context.attempt.baseSha !== config.baseSha ||
    context.attempt.checkoutSha !== config.checkoutSha ||
    context.attempt.repository !== config.repository ||
    context.attempt.planVersion !== config.planVersion ||
    context.attempt.planItemId !== config.planItemId ||
    context.item.id !== config.planItemId ||
    (config.mode === 'review_fix' && (
      executionSourceCount !== 1 ||
      (context.repair !== undefined && (
        context.repair.sourceHeadSha !== config.checkoutSha ||
        context.attempt.targetBranchMode !== 'new' ||
        context.attempt.targetBranch !== derivedAttemptBranch
      )) ||
      (context.reviewFeedback !== undefined && (
        context.reviewFeedback.sourceHeadSha !== config.checkoutSha ||
        context.reviewFeedback.branch !== context.attempt.targetBranch ||
        context.attempt.targetBranchMode !== 'existing_fast_forward'
      )) ||
      (context.baseRebase !== undefined && (
        context.baseRebase.sourceHeadSha !== config.checkoutSha ||
        context.baseRebase.newBaseSha !== config.baseSha ||
        context.baseRebase.oldBaseSha === context.baseRebase.newBaseSha ||
        context.attempt.targetBranchMode !== 'new' ||
        context.attempt.targetBranch !== derivedAttemptBranch ||
        context.baseRebase.sourceBranch !==
        `agent/${context.attempt.taskId}/${context.baseRebase.sourceAttemptId}`
      )) ||
      (context.reviewApprovalRecovery !== undefined && (
        context.reviewApprovalRecovery.sourceHeadSha !== config.checkoutSha ||
        context.attempt.targetBranchMode !== 'new' ||
        context.attempt.targetBranch !== derivedAttemptBranch
      ))
    )) ||
    (config.mode === 'implement' && (
      executionSourceCount !== 0 ||
      context.attempt.targetBranchMode !== 'new' ||
      context.attempt.targetBranch !== derivedAttemptBranch
    )) ||
    await taskRevisionDigest(context.task) !== config.taskDigest
  ) {
    throw new ExecutionRunnerError(
      'execution context identity does not match dispatch',
      'context_invalid',
    );
  }
  const targetedCommandRefs = context.item.commandRefs.filter((ref) => ref.startsWith('test:'));
  if (
    targetedCommandRefs.length === 0 ||
    !context.item.effects.includes('repo_write') ||
    !context.item.evidenceKinds.includes('test')
  ) {
    throw new ExecutionRunnerError('execution Plan Item is not runnable', 'context_invalid');
  }
  let policy: Awaited<ReturnType<typeof loadDeliveryPolicyAtCommit>>;
  try {
    policy = await loadDeliveryPolicyAtCommit(config.workspacePath, config.baseSha);
  } catch {
    throw new ExecutionRunnerError('execution delivery policy is unavailable', 'policy_invalid');
  }
  let repositorySnapshot: ExecutionPatchSnapshotV1 | undefined;
  if (context.baseRebase === undefined) {
    repositorySnapshot = await buildOptionalExecutionPatchSnapshot({
      repositoryPath: config.workspacePath,
      referencedText: [
        context.item.objective,
        ...context.item.doneWhen,
        context.task.intent.description,
        ...context.task.intent.acceptanceCriteria,
      ],
      protectedPaths: policy.policy.protectedPaths,
      runtimeSecrets: [...runtimeSecrets],
    });
  }
  const agentContext = repositorySnapshot === undefined
    ? context
    : { ...context, repositorySnapshot };
  const patchRecoveryAvailable = repositorySnapshot !== undefined;
  const temporaryRoot = await mkdtemp(join(config.runnerTempPath, 'delivery-loop-execution-'));
  await chmod(temporaryRoot, 0o700);
  const contextFilePath = join(temporaryRoot, 'context.json');
  const outputFilePath = join(temporaryRoot, 'agent-output.txt');
  const heartbeatController = new AbortController();
  let heartbeatFailure: unknown;
  let heartbeatTask: Promise<void> = Promise.resolve();
  const modelReservations = new Map<1 | 2, z.infer<typeof ModelReservationResponseSchema>>();
  const modelGrantTokens = new Map<1 | 2, string>();
  const settledModelInvocations = new Set<1 | 2>();
  let currentModelGrantToken: string | undefined;
  const executionAgent = options.agent ?? new CodexExecutionAdapter({
    ...(config.identityKind === 'executor_proxy'
      ? {
          command: EXECUTOR_CODEX_COMMAND,
          executorModelProviderBaseUrl: executorModelProviderBaseUrl(config.attemptId),
          providerApiKey: () => currentModelGrantToken,
        }
      : environment.OPENAI_BASE_URL === undefined || environment.OPENAI_BASE_URL === ''
        ? {}
        : { providerBaseUrl: environment.OPENAI_BASE_URL }),
  });

  const reserveModelInvocation = async (
    invocation: 1 | 2,
  ): Promise<z.infer<typeof ModelReservationResponseSchema>> => {
    const existing = modelReservations.get(invocation);
    if (existing !== undefined) {
      currentModelGrantToken = modelGrantTokens.get(invocation);
      if (config.identityKind === 'executor_proxy' && currentModelGrantToken === undefined) {
        throw new ExecutionRunnerError(
          'execution model grant is unavailable',
          'quota_unavailable',
        );
      }
      return existing;
    }
    if (config.modelProfileId === undefined) {
      throw new ExecutionRunnerError(
        'execution Runner model profile is unavailable',
        'quota_unavailable',
      );
    }
    const reservationDigest = await canonicalSha256({
      attemptId: config.attemptId,
      invocation,
    });
    const reservationId =
      `model_reservation_${reservationDigest.slice('sha256:'.length, 'sha256:'.length + 48)}`;
    const reservation = await fencing.withAuthorization(async (authorization) => {
      const parsed = ModelReservationResponseSchema.safeParse(await controlPlaneJson(
        fetcher,
        config,
        `/v1/attempts/${config.attemptId}/model-reservations`,
        authorization.attemptToken,
        'model quota reservation',
        [200, 201],
        {
          reservationId,
          profileId: config.modelProfileId,
          expectedVersion: authorization.expectedVersion,
          leaseGeneration: authorization.leaseGeneration,
        },
      ));
      const first = modelReservations.get(1);
      if (
        !parsed.success ||
        parsed.data.reservationId !== reservationId ||
        parsed.data.attemptId !== config.attemptId ||
        parsed.data.runId !== config.runId ||
        (first !== undefined && (
          parsed.data.provider !== first.provider || parsed.data.model !== first.model
        ))
      ) {
        throw new ExecutionRunnerError(
          'model quota reservation response is invalid',
          'quota_unavailable',
        );
      }
      return parsed.data;
    });
    if (config.identityKind === 'executor_proxy') {
      const rawGrant = await fencing.withAuthorization(async (authorization) =>
        await controlPlaneJson(
          fetcher,
          config,
          `/v1/attempts/${config.attemptId}/executor-model/grants`,
          authorization.attemptToken,
          'executor model grant',
          [200, 201],
          {
            executionId: config.executionId!,
            reservationId: reservation.reservationId,
            expectedVersion: authorization.expectedVersion,
            leaseGeneration: authorization.leaseGeneration,
          },
        ));
      const parsedGrant = ModelGrantResponseSchema.safeParse(rawGrant);
      if (
        !parsedGrant.success ||
        parsedGrant.data.reservationId !== reservation.reservationId ||
        Date.parse(parsedGrant.data.expiresAt) > Date.parse(reservation.expiresAt)
      ) {
        throw new ExecutionRunnerError(
          'execution model grant response is invalid',
          'quota_unavailable',
        );
      }
      modelGrantTokens.set(invocation, parsedGrant.data.token);
      currentModelGrantToken = parsedGrant.data.token;
      runtimeSecrets.add(parsedGrant.data.token);
    }
    modelReservations.set(invocation, reservation);
    return reservation;
  };

  const settleModelInvocation = async (
    invocation: 1 | 2,
    usage: CodexModelUsage | null,
  ): Promise<void> => {
    const reservation = modelReservations.get(invocation);
    if (
      reservation === undefined || usage === null || settledModelInvocations.has(invocation)
    ) throw new ExecutionRunnerError('execution Agent usage is unavailable');
    const usageDigest = await canonicalSha256({
      reservationId: reservation.reservationId,
      attemptId: config.attemptId,
    });
    const usageId = `model_usage_${usageDigest.slice(
      'sha256:'.length,
      'sha256:'.length + 54,
    )}`;
    let lastFailure: unknown;
    for (let requestAttempt = 1; requestAttempt <= 2; requestAttempt += 1) {
      try {
        await fencing.withAuthorization(async (authorization) => {
          const parsed = ModelUsageResponseSchema.safeParse(await controlPlaneJson(
            fetcher,
            config,
            `/v1/attempts/${config.attemptId}/model-usage`,
            authorization.attemptToken,
            'model usage settlement',
            [200, 201],
            {
              reservationId: reservation.reservationId,
              usageId,
              expectedVersion: authorization.expectedVersion,
              leaseGeneration: authorization.leaseGeneration,
              ...usage,
            },
          ));
          if (
            !parsed.success || parsed.data.usageId !== usageId ||
            parsed.data.reservationId !== reservation.reservationId
          ) throw new ExecutionRunnerError('model usage settlement response is invalid');
        });
        settledModelInvocations.add(invocation);
        if (currentModelGrantToken === modelGrantTokens.get(invocation)) {
          currentModelGrantToken = undefined;
        }
        return;
      } catch (error) {
        lastFailure = error;
      }
    }
    throw lastFailure ?? new ExecutionRunnerError('model usage settlement is unavailable');
  };

  const attemptAgent = executionAgent.usesMeteredModel === true &&
      context.baseRebase === undefined
    ? new BoundedEditRecoveryAgent({
        agent: executionAgent,
        beforeInvocation: async (invocation) => ({
          model: (await reserveModelInvocation(invocation)).model,
        }),
        afterInvocation: settleModelInvocation,
        canRecover: async () => {
          if (!patchRecoveryAvailable) return false;
          const [head, status] = await Promise.all([
            executeGitCommand({
              repositoryPath: config.workspacePath,
              args: ['rev-parse', '--verify', 'HEAD'],
            }),
            executeGitCommand({
              repositoryPath: config.workspacePath,
              args: ['status', '--porcelain=v1', '--untracked-files=all'],
            }),
          ]);
          return head.exitCode === 0 && head.stdout.trim() === config.checkoutSha &&
            status.exitCode === 0 && status.stdout === '';
        },
      })
    : executionAgent;

  try {
    if (
      context.baseRebase === undefined &&
      attemptAgent.usesMeteredModel === true
    ) {
      await reserveModelInvocation(1);
    }
    heartbeatTask = heartbeatLoop(
      fetcher,
      config,
      fencing,
      heartbeatIntervalMs,
      heartbeatController.signal,
    ).catch((error: unknown) => { heartbeatFailure = error; });
    const reporterContext = {
      controlPlaneUrl: config.controlPlaneUrl,
      attemptId: config.attemptId,
      fencing,
    };
    const failureReporter = new ControlPlaneExecutionFailureReporter(
      reporterContext,
      fetcher,
      { now },
    );
    await writeFile(contextFilePath, JSON.stringify(agentContext), { mode: 0o600, flag: 'wx' });
    await writeFile(outputFilePath, '', { mode: 0o600, flag: 'wx' });
    if (new SecretScanner({ secrets: [...runtimeSecrets] }).scan(agentContext).length > 0) {
      throw new ExecutionRunnerError('execution context contains runtime credentials');
    }
    const artifactAgent = createRawTranscriptArtifactAgent({
      agent: attemptAgent,
      runtimeSecrets,
      persist: async (content) => persistRawTranscript(fetcher, config, fencing, content),
      ...(options.onAgentActivity === undefined ? {} : { onActivity: options.onAgentActivity }),
      validateDecision: (decision) => {
        if (decision.action !== 'apply_patch') return decision;
        try {
          return {
            ...decision,
            proposal: validateExecutionPatchProposal(
              decision.proposal,
              policy.policy.protectedPaths,
              [...runtimeSecrets],
            ),
          };
        } catch {
          throw new CodexExecutionAdapterError('decision_invalid', 'invalid_output');
        }
      },
    });
    const executionAgentInput = {
      attemptId: config.attemptId,
      workspacePath: config.workspacePath,
      contextFilePath,
      outputFilePath,
      timeoutMs: AGENT_TIMEOUT_MS,
      allowPlanRevision: context.reviewFeedback !== undefined,
      ...(context.repair === undefined ? {} : (() => {
        const command = resolveDeliveryCommand(
          policy.policy,
          context.repair.commandRef,
          config.workspacePath,
        );
        return {
          repairCommand: {
            ref: command.ref,
            argv: [command.command, ...command.args],
          },
        };
      })()),
    };
    if (config.identityKind === 'executor_proxy') {
      if (context.baseRebase !== undefined) {
        throw new ExecutionRunnerError('executor work base rebase is unavailable');
      }
      const result = await new ExecutorWorkAttemptRunner({
        repositoryPath: config.workspacePath,
        checkoutSha: config.checkoutSha,
        targetedCommandRefs,
        deliveryPolicy: policy,
        runtimeSecrets: [...runtimeSecrets],
        agent: artifactAgent,
        agentInput: executionAgentInput,
        failureReporter,
        uploadPatch: async (proposal) => await fencing.withAuthorization(
          async (authorization) => await uploadExecutorWorkPatch({
            controlPlaneUrl: config.controlPlaneUrl,
            attemptId: config.attemptId,
            executionId: config.executionId!,
            attemptToken: authorization.attemptToken,
            expectedVersion: authorization.expectedVersion,
            leaseGeneration: authorization.leaseGeneration,
            proposal,
          }, fetcher),
        ),
        ...(context.reviewFeedback === undefined ? {} : {
          planRevisionReporter: new ControlPlanePlanRevisionReporter(reporterContext, fetcher),
        }),
      }).run();
      heartbeatController.abort();
      await heartbeatTask;
      if (result.status === 'patch_uploaded' && heartbeatFailure !== undefined) {
        throw new ExecutionRunnerError('attempt heartbeat failed during executor work');
      }
      return result;
    }
    const requestRepoWriteCredential = async (): Promise<
      z.infer<typeof CredentialResponseSchema>
    > => await fencing.withAuthorization(async (authorization) => {
      const parsed = CredentialResponseSchema.safeParse(await controlPlaneJson(
          fetcher,
          config,
          `/v1/attempts/${config.attemptId}/github/write-token`,
          authorization.attemptToken,
          'repo_write credential',
          [200, 201],
          {
            expectedVersion: authorization.expectedVersion,
            leaseGeneration: authorization.leaseGeneration,
          },
      ));
      if (
        !parsed.success ||
        parsed.data.repository !== config.repository ||
        Date.parse(parsed.data.expiresAt) <= now().getTime()
      ) {
        throw new ExecutionRunnerError('repo_write credential response is invalid');
      }
      runtimeSecrets.add(parsed.data.token);
      return parsed.data;
    });
    let credential: z.infer<typeof CredentialResponseSchema>;
    try {
      credential = await requestRepoWriteCredential();
    } catch {
      let reported = false;
      try {
        await failureReporter.report({
          failureCode: 'tool_unavailable',
          failureSite: 'external_reconciliation',
          attemptedPaths: ['external_reconciliation'],
          neededHumanInput: 'resolve_external_dependency',
        });
        reported = true;
      } catch {
        reported = false;
      } finally {
        heartbeatController.abort();
        await heartbeatTask;
      }
      if (!reported) {
        throw new ExecutionRunnerError('repo_write credential dependency report failed');
      }
      throw new ExecutionRunnerError(
        'repo_write credential dependency is unavailable',
        'credential_unavailable',
      );
    }

    const protectedPathReporter = async (report: Parameters<
      ConstructorParameters<typeof GitRepositoryWriter>[0]['onProtectedPathApprovalRequired']
    >[0]): Promise<void> => await fencing.withAuthorization(async (authorization) => {
      await new ControlPlaneProtectedPathApprovalReporter({
        controlPlaneUrl: config.controlPlaneUrl,
        attemptId: config.attemptId,
        attemptToken: authorization.attemptToken,
        expectedVersion: authorization.expectedVersion,
        leaseGeneration: authorization.leaseGeneration,
      }, fetcher).report(report);
    });
    const evidenceReporter = new ControlPlaneVerificationEvidenceReporter({
      controlPlaneUrl: config.controlPlaneUrl,
      attemptId: config.attemptId,
      authorization: () => fencing.authorization(),
      withAuthorization: async (operation) => await fencing.withAuthorization(operation),
    }, fetcher);
    const headReporter = new ControlPlaneExecutionHeadReporter(reporterContext, fetcher);
    if (context.baseRebase !== undefined) {
      const rebase = context.baseRebase;
      await materializeSourceBranch(config, rebase.sourceBranch, rebase.sourceHeadSha);
      const setup = new DeliveryCommandRunner(policy.policy, config.workspacePath);
      for (const id of Object.keys(policy.policy.commands.setup).sort()) {
        if ((await setup.run(`setup:${id}`)).exitCode !== 0) {
          throw new ExecutionRunnerError('base rebase setup command failed');
        }
      }
      const publisher = new GitRepositoryWriter({
        repositoryPath: config.workspacePath,
        repository: config.repository,
        taskId: context.attempt.taskId,
        attemptId: config.attemptId,
        baseSha: rebase.sourceHeadSha,
        baseBranch: context.attempt.baseBranch,
        protectedBranches: [],
        deliveryPolicy: policy,
        onProtectedPathApprovalRequired: protectedPathReporter,
        credential,
        refreshCredential: requestRepoWriteCredential,
      });
      const result = await new BaseRebaseRunner({
        repositoryPath: config.workspacePath,
        taskId: context.attempt.taskId,
        sourceAttemptId: rebase.sourceAttemptId,
        targetAttemptId: config.attemptId,
        sourceBranch: rebase.sourceBranch,
        oldBaseSha: rebase.oldBaseSha,
        newBaseSha: rebase.newBaseSha,
        sourceHeadSha: rebase.sourceHeadSha,
        deliveryPolicy: policy,
        targetedCommandRefs,
        reporter: evidenceReporter,
      }, {
        onRebased: async (rebased) => {
          await publisher.refreshCredential();
          const pushed = await publisher.push({
            targetBranch: rebased.targetBranch,
            force: false,
          });
          if (pushed.commitSha !== rebased.headSha || pushed.branch !== rebased.targetBranch) {
            throw new ExecutionRunnerError('base rebase push binding changed');
          }
          await headReporter.record({
            parentSha: rebased.sourceHeadSha,
            headSha: rebased.headSha,
            branch: rebased.targetBranch,
          });
        },
      }).run();
      const rebaseReporter = new ControlPlaneBaseRebaseReporter(reporterContext, fetcher);
      if (result.status === 'blocked') {
        await rebaseReporter.conflict();
        heartbeatController.abort();
        await heartbeatTask;
        return result;
      }
      if (result.status === 'failed') {
        const targeted = result.failedCommandRef.startsWith('test:');
        await failureReporter.report({
          failureCode: 'verification_nonzero_exit',
          failureSite: targeted ? 'targeted_verification' : 'full_verification',
          attemptedPaths: targeted
            ? ['external_reconciliation', 'targeted_test']
            : ['external_reconciliation', 'targeted_test', 'full_verification'],
          neededHumanInput: 'manual_investigation',
        });
      } else {
        await rebaseReporter.complete({ headSha: result.headSha, suiteId: result.suiteId });
      }
      heartbeatController.abort();
      await heartbeatTask;
      if (result.status === 'passed' && heartbeatFailure !== undefined) {
        throw new ExecutionRunnerError('attempt heartbeat failed during base rebase');
      }
      return {
        ...result,
        branch: result.targetBranch,
      };
    }
    const runner = new ExecutionAttemptRunner({
      repositoryPath: config.workspacePath,
      checkoutSha: config.checkoutSha,
      planVersion: config.planVersion,
      planItemId: config.planItemId,
      targetedCommandRefs,
      deliveryPolicy: policy,
      repositoryWriter: new GitRepositoryWriter({
        repositoryPath: config.workspacePath,
        repository: config.repository,
        taskId: context.attempt.taskId,
        attemptId: config.attemptId,
        baseSha: config.checkoutSha,
        baseBranch: context.attempt.baseBranch,
        targetBranch: context.attempt.targetBranch,
        targetBranchMode: context.attempt.targetBranchMode,
        protectedBranches: [],
        deliveryPolicy: policy,
        onProtectedPathApprovalRequired: protectedPathReporter,
        credential,
        refreshCredential: requestRepoWriteCredential,
      }),
      agent: artifactAgent,
      agentInput: executionAgentInput,
      ...(context.reviewFeedback === undefined ? {} : {
        planRevisionReporter: new ControlPlanePlanRevisionReporter(reporterContext, fetcher),
      }),
      headReporter,
      evidenceReporter,
      failureReporter,
    });
    const result = await runner.run();
    heartbeatController.abort();
    await heartbeatTask;
    if (result.status === 'passed' && heartbeatFailure !== undefined) {
      throw new ExecutionRunnerError('attempt heartbeat failed during execution');
    }
    return result;
  } finally {
    heartbeatController.abort();
    await heartbeatTask;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
