import {
  FencedOutboxProcessor,
  OutboxEffectError,
  type FencedOutboxRecord,
  type OutboxDeliveryResult,
  type OutboxEffectOutcome,
} from './fenced-outbox.js';
import {
  QuotaControlError,
  QuotaControlStore,
} from '../storage/quota-control-store.js';
import type {
  GitHubWorkflowRunFact,
  GitHubWorkflowRunStatus,
} from '../storage/github-run-observation-store.js';
import { GITHUB_API_USER_AGENT, githubApiFetch } from '../github-api.js';

export const DELIVERY_AGENT_WORKFLOW_FILE = '.github/workflows/delivery-agent.yml';
export const TEST_ACCEPTANCE_WORKFLOW_FILE =
  '.github/workflows/delivery-test-acceptance.yml';
export const TEST_ROLLBACK_WORKFLOW_FILE =
  '.github/workflows/delivery-test-rollback.yml';
export type TrustedGitHubWorkflowFile =
  | typeof DELIVERY_AGENT_WORKFLOW_FILE
  | typeof TEST_ACCEPTANCE_WORKFLOW_FILE
  | typeof TEST_ROLLBACK_WORKFLOW_FILE;

export interface GitHubDispatchRequest {
  repository: string;
  workflowFile: TrustedGitHubWorkflowFile;
  ref: string;
  inputs: Record<string, string>;
}

export interface GitHubDispatchResult {
  disposition: 'created' | 'existing';
  githubRunId: string;
  githubHeadSha: string;
}

/** Production adapter must reconcile by attempt ID/run-name before retrying an ambiguous dispatch. */
export interface GitHubDispatchEffects {
  ensureDispatch(request: GitHubDispatchRequest): Promise<GitHubDispatchResult>;
}

export interface GitHubInstallationTokenProvider {
  getInstallationToken(repository: string): Promise<string>;
  /** Optional read-only credential for deployment-triggered workflow observation. */
  getDeploymentObservationToken?(repository: string): Promise<string>;
  /** Optional production-scoped read-only credential for deployment-triggered workflow observation. */
  getProductionDeploymentObservationToken?(repository: string): Promise<string>;
  getAcceptanceToken?(repository: string): Promise<string>;
  getRollbackToken?(repository: string): Promise<string>;
  getRollbackObservationToken?(repository: string): Promise<string>;
}

export interface GitHubActionsApiClientOptions {
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  reconciliationAttempts?: number;
}

interface GitHubWorkflowRunRow {
  id: unknown;
  event?: unknown;
  display_title?: unknown;
  path?: unknown;
  head_branch?: unknown;
  head_sha?: unknown;
}

interface ReconciledWorkflowRun {
  githubRunId: string;
  githubHeadSha: string;
}

const WORKFLOW_RUN_STATUSES = [
  'requested',
  'queued',
  'waiting',
  'in_progress',
  'completed',
] as const;
const WORKFLOW_RUN_CONCLUSIONS = new Set([
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
  'stale',
  'startup_failure',
]);
const MAX_WORKFLOW_RUN_RESPONSE_BYTES = 1 * 1024 * 1024;

function httpsOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS origin`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new Error(`${label} must be a valid HTTPS origin`);
  }
  return url.origin;
}

function workflowRunId(value: unknown): string | null {
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

function normalizedDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/**
 * GitHub Actions REST adapter using a short-lived App installation token.
 * The target workflow must set `run-name: delivery-loop/${attempt_id}` so an
 * ambiguous 204/timeout can be reconciled before another dispatch is attempted.
 */
export class GitHubActionsApiClient implements GitHubDispatchEffects {
  private readonly apiBaseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly reconciliationAttempts: number;

  constructor(
    private readonly tokenProvider: GitHubInstallationTokenProvider,
    options: GitHubActionsApiClientOptions = {},
  ) {
    this.apiBaseUrl = httpsOrigin(options.apiBaseUrl ?? 'https://api.github.com', 'GitHub API URL');
    this.fetcher = githubApiFetch(options.fetch);
    this.reconciliationAttempts = options.reconciliationAttempts ?? 3;
    if (
      !Number.isSafeInteger(this.reconciliationAttempts) ||
      this.reconciliationAttempts <= 0 ||
      this.reconciliationAttempts > 10
    ) {
      throw new Error('GitHub reconciliation attempts must be between 1 and 10');
    }
  }

  async ensureDispatch(request: GitHubDispatchRequest): Promise<GitHubDispatchResult> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository)) {
      throw new Error('GitHub repository is invalid');
    }
    if (
      request.workflowFile !== DELIVERY_AGENT_WORKFLOW_FILE &&
      request.workflowFile !== TEST_ACCEPTANCE_WORKFLOW_FILE &&
      request.workflowFile !== TEST_ROLLBACK_WORKFLOW_FILE
    ) {
      throw new Error('GitHub workflow file is not trusted');
    }
    if (!request.ref.startsWith('refs/heads/') || request.ref.length <= 'refs/heads/'.length) {
      throw new Error('GitHub workflow ref must be a branch ref');
    }
    const identity = request.workflowFile === DELIVERY_AGENT_WORKFLOW_FILE
      ? request.inputs.attempt_id
      : request.workflowFile === TEST_ACCEPTANCE_WORKFLOW_FILE
        ? request.inputs.acceptance_id
        : request.inputs.rollback_id;
    if (identity === undefined || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(identity)) {
      throw new Error('GitHub dispatch identity is invalid');
    }
    const installationToken = request.workflowFile === TEST_ACCEPTANCE_WORKFLOW_FILE
      ? await this.acceptanceToken(request.repository)
      : request.workflowFile === TEST_ROLLBACK_WORKFLOW_FILE
        ? await this.rollbackToken(request.repository)
        : await this.tokenProvider.getInstallationToken(request.repository);
    if (installationToken.length < 1 || installationToken.length > 2_000) {
      throw new Error('GitHub installation token is unavailable');
    }
    const headers = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${installationToken}`,
      'content-type': 'application/json',
      'user-agent': GITHUB_API_USER_AGENT,
      'x-github-api-version': '2022-11-28',
    };

    const existing = await this.findRun(request, headers);
    if (existing !== null) return { disposition: 'existing', ...existing };

    const response = await this.fetcher(this.dispatchUrl(request), {
      method: 'POST',
      headers,
      body: JSON.stringify({ ref: request.ref, inputs: request.inputs }),
    });
    if (response.status !== 204) throw new Error('GitHub workflow dispatch was rejected');

    for (let attempt = 0; attempt < this.reconciliationAttempts; attempt += 1) {
      const run = await this.findRun(request, headers);
      if (run !== null) return { disposition: 'created', ...run };
    }
    throw new Error('GitHub workflow dispatch result is not yet observable');
  }

  async getWorkflowRun(
    repository: string,
    githubRunId: string,
    expectedEvent: 'workflow_dispatch' | 'push' | 'pull_request' | 'deployment' = 'workflow_dispatch',
  ): Promise<GitHubWorkflowRunFact> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error('GitHub repository is invalid');
    }
    if (!/^[0-9]+$/.test(githubRunId)) throw new Error('GitHub workflow run ID is invalid');
    const installationToken = await this.tokenProvider.getInstallationToken(repository);
    return await this.queryWorkflowRun(repository, githubRunId, installationToken, expectedEvent);
  }

  /** Acceptance reconciliation keeps the dedicated Actions credential lifecycle. */
  async getAcceptanceWorkflowRun(
    repository: string,
    githubRunId: string,
  ): Promise<GitHubWorkflowRunFact> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error('GitHub repository is invalid');
    }
    if (!/^[0-9]+$/.test(githubRunId)) throw new Error('GitHub workflow run ID is invalid');
    const installationToken = await this.acceptanceToken(repository);
    return await this.queryWorkflowRun(repository, githubRunId, installationToken);
  }

  /** Reads the workflow run emitted by a GitHub Deployment event with a separate read token. */
  async getTestDeploymentWorkflowRun(
    repository: string,
    githubRunId: string,
  ): Promise<GitHubWorkflowRunFact> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error('GitHub repository is invalid');
    }
    if (!/^[0-9]+$/.test(githubRunId)) throw new Error('GitHub workflow run ID is invalid');
    if (this.tokenProvider.getDeploymentObservationToken === undefined) {
      throw new Error('GitHub deployment observation token provider is unavailable');
    }
    const installationToken = await this.tokenProvider.getDeploymentObservationToken(repository);
    return await this.queryWorkflowRun(repository, githubRunId, installationToken, 'deployment');
  }

  /** Reads the production Deployment-triggered Action with the isolated production read token. */
  async getProductionDeploymentWorkflowRun(
    repository: string,
    githubRunId: string,
  ): Promise<GitHubWorkflowRunFact> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error('GitHub repository is invalid');
    }
    if (!/^[0-9]+$/.test(githubRunId)) throw new Error('GitHub workflow run ID is invalid');
    if (this.tokenProvider.getProductionDeploymentObservationToken === undefined) {
      throw new Error('GitHub production deployment observation token provider is unavailable');
    }
    const installationToken = await this.tokenProvider.getProductionDeploymentObservationToken(
      repository,
    );
    return await this.queryWorkflowRun(repository, githubRunId, installationToken, 'deployment');
  }

  /** Rollback reconciliation never reuses the Agent or acceptance credential cache. */
  async getRollbackWorkflowRun(
    repository: string,
    githubRunId: string,
  ): Promise<GitHubWorkflowRunFact> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error('GitHub repository is invalid');
    }
    if (!/^[0-9]+$/.test(githubRunId)) throw new Error('GitHub workflow run ID is invalid');
    const installationToken = await this.rollbackObservationToken(repository);
    return await this.queryWorkflowRun(repository, githubRunId, installationToken);
  }

  private async queryWorkflowRun(
    repository: string,
    githubRunId: string,
    installationToken: string,
    expectedEvent: 'workflow_dispatch' | 'push' | 'pull_request' | 'deployment' = 'workflow_dispatch',
  ): Promise<GitHubWorkflowRunFact> {
    if (installationToken.length < 1 || installationToken.length > 2_000) {
      throw new Error('GitHub installation token is unavailable');
    }
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.apiBaseUrl}/repos/${repository}/actions/runs/${githubRunId}`,
        {
          method: 'GET',
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${installationToken}`,
            'user-agent': GITHUB_API_USER_AGENT,
            'x-github-api-version': '2022-11-28',
          },
        },
      );
    } catch {
      throw new Error('GitHub workflow run query failed');
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error('GitHub workflow run query failed');
    }
    if (/\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
      await response.body?.cancel();
      throw new Error('GitHub workflow run response is invalid');
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_WORKFLOW_RUN_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new Error('GitHub workflow run response is invalid');
    }
    if (response.body === null) throw new Error('GitHub workflow run response is invalid');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_WORKFLOW_RUN_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('GitHub workflow run response is invalid');
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new Error('GitHub workflow run response is invalid');
    }
    return parseWorkflowRunFact(body, repository, githubRunId, expectedEvent);
  }

  private dispatchUrl(request: GitHubDispatchRequest): string {
    return `${this.apiBaseUrl}/repos/${request.repository}/actions/workflows/${encodeURIComponent(request.workflowFile)}/dispatches`;
  }

  private async acceptanceToken(repository: string): Promise<string> {
    if (this.tokenProvider.getAcceptanceToken === undefined) {
      throw new Error('GitHub acceptance token provider is unavailable');
    }
    return await this.tokenProvider.getAcceptanceToken(repository);
  }

  private async rollbackToken(repository: string): Promise<string> {
    if (this.tokenProvider.getRollbackToken === undefined) {
      throw new Error('GitHub rollback token provider is unavailable');
    }
    return await this.tokenProvider.getRollbackToken(repository);
  }

  private async rollbackObservationToken(repository: string): Promise<string> {
    if (this.tokenProvider.getRollbackObservationToken === undefined) {
      throw new Error('GitHub rollback observation token provider is unavailable');
    }
    return await this.tokenProvider.getRollbackObservationToken(repository);
  }

  private async findRun(
    request: GitHubDispatchRequest,
    headers: Record<string, string>,
  ): Promise<ReconciledWorkflowRun | null> {
    const branch = request.ref.slice('refs/heads/'.length);
    const url =
      `${this.apiBaseUrl}/repos/${request.repository}/actions/workflows/` +
      `${encodeURIComponent(request.workflowFile)}/runs?event=workflow_dispatch&` +
      `branch=${encodeURIComponent(branch)}&per_page=50`;
    const response = await this.fetcher(url, { method: 'GET', headers });
    if (response.status !== 200) throw new Error('GitHub workflow run reconciliation failed');
    const body = (await response.json()) as { workflow_runs?: unknown };
    if (!Array.isArray(body.workflow_runs)) {
      throw new Error('GitHub workflow run response is invalid');
    }
    const expectedTitle = request.workflowFile === DELIVERY_AGENT_WORKFLOW_FILE
      ? `delivery-loop/${request.inputs.attempt_id}` +
        (request.inputs.dispatch_generation === undefined
          ? ''
          : `/redispatch-${request.inputs.dispatch_generation}`)
      : request.workflowFile === TEST_ACCEPTANCE_WORKFLOW_FILE
        ? `delivery-loop/acceptance/${request.inputs.acceptance_id}`
        : `delivery-loop/rollback/${request.inputs.rollback_id}`;
    for (const candidate of body.workflow_runs as GitHubWorkflowRunRow[]) {
      const pathMatches =
        candidate.path === request.workflowFile ||
        (typeof candidate.path === 'string' &&
          candidate.path.startsWith(`${request.workflowFile}@`));
      if (
        candidate.event === 'workflow_dispatch' &&
        candidate.display_title === expectedTitle &&
        candidate.head_branch === branch &&
        pathMatches
      ) {
        const id = workflowRunId(candidate.id);
        if (
          id === null ||
          typeof candidate.head_sha !== 'string' ||
          !/^[a-f0-9]{40}$/.test(candidate.head_sha)
        ) {
          throw new Error('GitHub workflow run response is invalid');
        }
        return { githubRunId: id, githubHeadSha: candidate.head_sha };
      }
    }
    return null;
  }
}

function parseWorkflowRunFact(
  input: unknown,
  expectedRepository: string,
  expectedRunId: string,
  expectedEvent: 'workflow_dispatch' | 'push' | 'pull_request' | 'deployment' = 'workflow_dispatch',
): GitHubWorkflowRunFact {
  if (typeof input !== 'object' || input === null) {
    throw new Error('GitHub workflow run response is invalid');
  }
  const body = input as Record<string, unknown>;
  const id = workflowRunId(body.id);
  const repository =
    typeof body.repository === 'object' && body.repository !== null
      ? (body.repository as Record<string, unknown>).full_name
      : null;
  const status = body.status;
  const conclusion = body.conclusion;
  const externalUpdatedAt = normalizedDate(body.updated_at);
  const statusAllowed =
    typeof status === 'string' &&
    WORKFLOW_RUN_STATUSES.includes(status as GitHubWorkflowRunStatus);
  const conclusionAllowed =
    conclusion === null ||
    (typeof conclusion === 'string' && WORKFLOW_RUN_CONCLUSIONS.has(conclusion));
  if (
    id !== expectedRunId ||
    repository !== expectedRepository ||
    body.event !== expectedEvent ||
    !statusAllowed ||
    !conclusionAllowed ||
    (status === 'completed' && conclusion === null) ||
    (status !== 'completed' && conclusion !== null) ||
    typeof body.head_sha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(body.head_sha) ||
    typeof body.head_branch !== 'string' ||
    body.head_branch.length < 1 ||
    body.head_branch.length > 255 ||
    typeof body.path !== 'string' ||
    body.path.length < 1 ||
    body.path.length > 500 ||
    typeof body.display_title !== 'string' ||
    body.display_title.length < 1 ||
    body.display_title.length > 300 ||
    typeof body.run_attempt !== 'number' ||
    !Number.isSafeInteger(body.run_attempt) ||
    body.run_attempt <= 0 ||
    externalUpdatedAt === null
  ) {
    throw new Error('GitHub workflow run response is invalid');
  }
  return {
    repository: expectedRepository,
    githubRunId: expectedRunId,
    event: expectedEvent,
    status: status as GitHubWorkflowRunStatus,
    conclusion: conclusion as string | null,
    headSha: body.head_sha,
    headBranch: body.head_branch,
    workflowPath: body.path,
    displayTitle: body.display_title,
    runAttempt: body.run_attempt,
    externalUpdatedAt,
  };
}

export interface GitHubDispatchProcessorOptions {
  allowedRepositories: readonly string[];
  controlPlaneUrl: string;
  modelProfileId?: string;
  now?: () => Date;
  generateLeaseToken?: () => string;
  outboxLeaseMs?: number;
  attemptLeaseMs?: number;
}

interface DispatchAttemptRow {
  attempt_id: string;
  run_id: string;
  mode: string;
  status: string;
  base_sha: string;
  repository: string | null;
  workflow_ref: string | null;
  plan_id: string | null;
  plan_version: number | null;
  plan_item_id: string | null;
  version: number;
  lease_generation: number;
  github_run_id: string | null;
  head_sha: string | null;
  target_base_branch: string;
  task_digest: string;
  run_state: string;
  active_plan_id: string | null;
  active_plan_version: number | null;
  plan_status: string | null;
  progress_status: string | null;
  active_attempt_id: string | null;
  protected_path_gate_id: string | null;
  repair_id: string | null;
  review_feedback_id: string | null;
  automated_review_id: string | null;
  automated_review_redispatch_id: string | null;
  base_rebase_id: string | null;
}

function controlPlaneOrigin(value: string): string {
  return httpsOrigin(value, 'control plane URL');
}

/** D1-backed GitHub workflow dispatcher; Task/R2 bodies are not part of its input surface. */
export class GitHubDispatchOutboxProcessor {
  private readonly allowedRepositories: ReadonlySet<string>;
  private readonly controlPlaneUrl: string;
  private readonly modelProfileId: string | undefined;
  private readonly now: () => Date;
  private readonly attemptLeaseMs: number;
  private readonly fenced: FencedOutboxProcessor;

  constructor(
    private readonly db: D1Database,
    private readonly effects: GitHubDispatchEffects,
    options: GitHubDispatchProcessorOptions,
  ) {
    this.allowedRepositories = new Set(options.allowedRepositories);
    this.controlPlaneUrl = controlPlaneOrigin(options.controlPlaneUrl);
    this.modelProfileId = options.modelProfileId;
    this.now = options.now ?? (() => new Date());
    this.attemptLeaseMs = options.attemptLeaseMs ?? 10 * 60_000;
    if (this.allowedRepositories.size === 0) {
      throw new Error('GitHub repository allowlist must not be empty');
    }
    if (!Number.isSafeInteger(this.attemptLeaseMs) || this.attemptLeaseMs <= 0) {
      throw new Error('attempt lease duration must be a positive integer');
    }
    if (
      this.modelProfileId !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(this.modelProfileId)
    ) {
      throw new Error('model profile id is invalid');
    }
    this.fenced = new FencedOutboxProcessor(
      db,
      'github_actions',
      async (outbox) => await this.perform(outbox),
      {
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.generateLeaseToken === undefined
          ? {}
          : { generateLeaseToken: options.generateLeaseToken }),
        ...(options.outboxLeaseMs === undefined ? {} : { leaseMs: options.outboxLeaseMs }),
        unavailableErrorCode: 'github_unavailable',
      },
    );
  }

  async deliver(outboxId: string): Promise<OutboxDeliveryResult> {
    return await this.fenced.deliver(outboxId);
  }

  async drain(limit = 25): Promise<OutboxDeliveryResult[]> {
    return await this.fenced.drain(limit);
  }

  private async perform(
    outbox: FencedOutboxRecord,
  ): Promise<OutboxEffectOutcome | void> {
    if (outbox.kind !== 'analysis_dispatch' && outbox.kind !== 'execution_dispatch') {
      throw new OutboxEffectError('unsupported_dispatch_kind');
    }
    const prefix = 'd1://attempts/';
    if (!outbox.payloadRef.startsWith(prefix)) {
      throw new OutboxEffectError('attempt_ref_invalid');
    }
    const attemptId = outbox.payloadRef.slice(prefix.length);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(attemptId)) {
      throw new OutboxEffectError('attempt_ref_invalid');
    }
    const attempt = await this.db
      .prepare(
        `SELECT attempts.attempt_id, attempts.run_id, attempts.mode, attempts.status,
                attempts.base_sha, attempts.repository, attempts.workflow_ref,
                attempts.plan_id, attempts.plan_version, attempts.plan_item_id, attempts.version,
                attempts.lease_generation, attempts.github_run_id, attempts.head_sha,
                tasks.target_base_branch, runs.task_digest,
                runs.state AS run_state, runs.active_plan_id, runs.active_plan_version,
                execution_plans.status AS plan_status,
                plan_item_progress.status AS progress_status,
                plan_item_progress.active_attempt_id,
                plan_item_progress.protected_path_gate_id,
                attempt_repairs.repair_id,
                review_feedback_attempts.feedback_id AS review_feedback_id,
                automated_review_fix_attempts.review_id AS automated_review_id,
                automated_review_replacement_redispatches.redispatch_id
                  AS automated_review_redispatch_id,
                base_rebase_attempts.rebase_id AS base_rebase_id
         FROM attempts
         JOIN runs ON runs.run_id = attempts.run_id
         JOIN tasks ON tasks.task_id = runs.task_id
         LEFT JOIN execution_plans ON execution_plans.plan_id = attempts.plan_id
         LEFT JOIN plan_item_progress
           ON plan_item_progress.plan_id = attempts.plan_id
          AND plan_item_progress.item_id = attempts.plan_item_id
         LEFT JOIN attempt_repairs
           ON attempt_repairs.repair_attempt_id = attempts.attempt_id
         LEFT JOIN review_feedback_attempts
           ON review_feedback_attempts.review_attempt_id =
              COALESCE(attempts.recovered_from_attempt_id, attempts.attempt_id)
         LEFT JOIN automated_review_fix_attempts
           ON automated_review_fix_attempts.fix_attempt_id = attempts.attempt_id
         LEFT JOIN automated_review_replacement_redispatches
           ON automated_review_replacement_redispatches.replacement_attempt_id = attempts.attempt_id
          AND automated_review_replacement_redispatches.outbox_id = ?
         LEFT JOIN base_rebase_attempts
           ON base_rebase_attempts.rebase_attempt_id = attempts.attempt_id
         WHERE attempts.attempt_id = ? AND attempts.run_id = ?`,
      )
      .bind(outbox.outboxId, attemptId, outbox.runId)
      .first<DispatchAttemptRow>();
    if (attempt === null) throw new OutboxEffectError('attempt_missing');
    if (attempt.repository === null || !this.allowedRepositories.has(attempt.repository)) {
      throw new OutboxEffectError('repository_not_allowed');
    }
    const executionDispatch = outbox.kind === 'execution_dispatch';
    if (
      (!executionDispatch && attempt.mode !== 'analysis') ||
      (executionDispatch && attempt.mode !== 'implement' && attempt.mode !== 'review_fix')
    ) {
      throw new OutboxEffectError('dispatch_mode_not_allowed');
    }
    if (executionDispatch) {
      const sourceCount = Number(attempt.repair_id !== null) +
        Number(attempt.review_feedback_id !== null) +
        Number(attempt.automated_review_id !== null) +
        Number(attempt.base_rebase_id !== null);
      const validSource = attempt.mode === 'implement'
        ? sourceCount === 0
        : sourceCount === 1;
      const activeExecution =
        validSource &&
        (attempt.run_state === 'executing' || attempt.run_state === 'verifying') &&
        attempt.plan_version !== null &&
        attempt.plan_item_id !== null &&
        attempt.active_plan_id !== null &&
        attempt.active_plan_id === attempt.plan_id &&
        attempt.active_plan_version === attempt.plan_version &&
        attempt.plan_status === 'active' &&
        attempt.progress_status === 'in_progress' &&
        attempt.active_attempt_id === attempt.attempt_id &&
        attempt.protected_path_gate_id === null &&
        (attempt.status === 'pending' || attempt.status === 'starting');
      if (!activeExecution) return { settledCode: 'repair_dispatch_stale' };
    }
    const ref = `refs/heads/${attempt.target_base_branch}`;
    const expectedWorkflowRef =
      `${attempt.repository}/${DELIVERY_AGENT_WORKFLOW_FILE}@${ref}`;
    if (attempt.workflow_ref !== expectedWorkflowRef) {
      throw new OutboxEffectError('workflow_ref_mismatch');
    }

    const inputs: Record<string, string> = {
      schema_version: '1',
      run_id: attempt.run_id,
      attempt_id: attempt.attempt_id,
      task_digest: attempt.task_digest,
      base_sha: attempt.base_sha,
      checkout_sha: executionDispatch
        ? (attempt.head_sha ?? attempt.base_sha)
        : attempt.base_sha,
      control_plane_url: this.controlPlaneUrl,
      mode: attempt.mode,
    };
    if (this.modelProfileId !== undefined) inputs.model_profile_id = this.modelProfileId;
    if (attempt.automated_review_redispatch_id !== null) inputs.dispatch_generation = '1';
    if (attempt.plan_version !== null) inputs.plan_version = String(attempt.plan_version);
    if (attempt.plan_item_id !== null) inputs.plan_item_id = attempt.plan_item_id;
    const quota = new QuotaControlStore(this.db);
    const now = this.now();
    try {
      await quota.reserveAttemptConcurrency(attempt.attempt_id, now);
    } catch (error) {
      if (error instanceof QuotaControlError && error.code === 'quota_exceeded') {
        throw new OutboxEffectError('quota_concurrency_exceeded');
      }
      throw error;
    }
    // A transport failure can mean GitHub accepted the dispatch but the response
    // was lost. Keep the slot until stable reconciliation, terminal Attempt, or TTL.
    const dispatch: GitHubDispatchResult = await this.effects.ensureDispatch({
      repository: attempt.repository,
      workflowFile: DELIVERY_AGENT_WORKFLOW_FILE,
      ref,
      inputs,
    });
    if (!/^[0-9]+$/.test(dispatch.githubRunId)) {
      throw new OutboxEffectError('github_run_id_invalid');
    }
    if (!/^[a-f0-9]{40}$/.test(dispatch.githubHeadSha)) {
      throw new OutboxEffectError('github_run_head_sha_invalid');
    }

    const nowIso = now.toISOString();
    const attemptLeaseExpiresAt = new Date(now.getTime() + this.attemptLeaseMs).toISOString();
    await this.db
      .prepare(
        `UPDATE attempts
         SET status = 'starting',
             version = version + 1,
             lease_generation = lease_generation + 1,
             lease_expires_at = ?,
             github_run_id = ?,
             github_head_sha = ?,
             github_status = 'requested',
             github_observed_at = ?,
             updated_at = ?
         WHERE attempt_id = ?
           AND run_id = ?
           AND status = 'pending'
           AND version = ?
           AND lease_generation = ?
           AND github_run_id IS NULL
           AND github_head_sha IS NULL
           AND (
             (? = 'analysis_dispatch' AND mode = 'analysis')
             OR (
               ? = 'execution_dispatch'
               AND mode IN ('implement', 'review_fix')
               AND EXISTS (
                 SELECT 1
                 FROM runs
                 JOIN execution_plans ON execution_plans.plan_id = attempts.plan_id
                 JOIN plan_item_progress
                   ON plan_item_progress.plan_id = attempts.plan_id
                  AND plan_item_progress.item_id = attempts.plan_item_id
                 WHERE runs.state IN ('executing', 'verifying')
                   AND runs.active_plan_id = attempts.plan_id
                   AND runs.active_plan_version = attempts.plan_version
                   AND execution_plans.status = 'active'
                   AND plan_item_progress.status = 'in_progress'
                   AND plan_item_progress.active_attempt_id = attempts.attempt_id
                   AND plan_item_progress.protected_path_gate_id IS NULL
                   AND (
                     (
                       attempts.mode = 'implement'
                       AND NOT EXISTS (
                         SELECT 1 FROM attempt_repairs
                         WHERE attempt_repairs.repair_attempt_id = attempts.attempt_id
                       )
                       AND NOT EXISTS (
                         SELECT 1 FROM review_feedback_attempts
                         WHERE review_feedback_attempts.review_attempt_id = attempts.attempt_id
                       )
                       AND NOT EXISTS (
                         SELECT 1 FROM base_rebase_attempts
                         WHERE base_rebase_attempts.rebase_attempt_id = attempts.attempt_id
                       )
                     )
                     OR (
                       attempts.mode = 'review_fix'
                       AND (
                     (
                       EXISTS (
                         SELECT 1 FROM attempt_repairs
                         WHERE attempt_repairs.repair_attempt_id = attempts.attempt_id
                       )
                       AND NOT EXISTS (
                         SELECT 1 FROM review_feedback_attempts
                         WHERE review_feedback_attempts.review_attempt_id = attempts.attempt_id
                       )
                       AND NOT EXISTS (
                         SELECT 1 FROM base_rebase_attempts
                         WHERE base_rebase_attempts.rebase_attempt_id = attempts.attempt_id
                       )
                     )
                     OR (
                       EXISTS (
                         SELECT 1
                         FROM review_feedback_attempts
                         JOIN github_review_feedbacks
                           ON github_review_feedbacks.feedback_id = review_feedback_attempts.feedback_id
                         WHERE review_feedback_attempts.review_attempt_id =
                               COALESCE(attempts.recovered_from_attempt_id, attempts.attempt_id)
                           AND github_review_feedbacks.run_id = attempts.run_id
                           AND github_review_feedbacks.plan_id = attempts.plan_id
                           AND github_review_feedbacks.plan_version = attempts.plan_version
                           AND github_review_feedbacks.plan_item_id = attempts.plan_item_id
                           AND github_review_feedbacks.source_head_sha = attempts.head_sha
                       )
                       AND NOT EXISTS (
                         SELECT 1 FROM attempt_repairs
                         WHERE attempt_repairs.repair_attempt_id = attempts.attempt_id
                       )
                       AND NOT EXISTS (
                         SELECT 1 FROM base_rebase_attempts
                         WHERE base_rebase_attempts.rebase_attempt_id = attempts.attempt_id
                       )
                     )
                     OR (
                       EXISTS (
                         SELECT 1 FROM base_rebase_attempts
                         WHERE base_rebase_attempts.rebase_attempt_id = attempts.attempt_id
                           AND base_rebase_attempts.run_id = attempts.run_id
                           AND base_rebase_attempts.target_plan_id = attempts.plan_id
                           AND base_rebase_attempts.target_plan_version = attempts.plan_version
                           AND base_rebase_attempts.plan_item_id = attempts.plan_item_id
                           AND base_rebase_attempts.source_head_sha = attempts.head_sha
                           AND base_rebase_attempts.status = 'scheduled'
                       )
                       AND NOT EXISTS (
                         SELECT 1 FROM attempt_repairs
                         WHERE attempt_repairs.repair_attempt_id = attempts.attempt_id
                       )
                       AND NOT EXISTS (
                         SELECT 1 FROM review_feedback_attempts
                         WHERE review_feedback_attempts.review_attempt_id = attempts.attempt_id
                       )
                     )
                     OR (
                       EXISTS (
                         SELECT 1
                         FROM automated_review_fix_attempts AS automated_fix
                         JOIN automated_reviews AS automated_review
                           ON automated_review.review_id = automated_fix.review_id
                         WHERE automated_fix.fix_attempt_id = attempts.attempt_id
                           AND automated_review.run_id = attempts.run_id
                           AND automated_review.plan_id = attempts.plan_id
                           AND automated_review.plan_version = attempts.plan_version
                           AND automated_review.plan_item_id = attempts.plan_item_id
                           AND automated_review.source_head_sha = attempts.head_sha
                           AND automated_review.status = 'changes_requested'
                       )
                       AND NOT EXISTS (
                         SELECT 1 FROM attempt_repairs
                         WHERE attempt_repairs.repair_attempt_id = attempts.attempt_id
                       )
                       AND NOT EXISTS (
                         SELECT 1 FROM review_feedback_attempts
                         WHERE review_feedback_attempts.review_attempt_id = attempts.attempt_id
                       )
                       AND NOT EXISTS (
                         SELECT 1 FROM base_rebase_attempts
                         WHERE base_rebase_attempts.rebase_attempt_id = attempts.attempt_id
                       )
                     )
                       )
                     )
                   )
               )
             )
           )`,
      )
      .bind(
        attemptLeaseExpiresAt,
        dispatch.githubRunId,
        dispatch.githubHeadSha,
        nowIso,
        nowIso,
        attempt.attempt_id,
        attempt.run_id,
        attempt.version,
        attempt.lease_generation,
        outbox.kind,
        outbox.kind,
      )
      .run();

    const persisted = await this.db
      .prepare(
        `SELECT status, version, lease_generation, lease_expires_at,
                github_run_id, github_head_sha, github_status, github_observed_at
         FROM attempts WHERE attempt_id = ? AND run_id = ?`,
      )
      .bind(attempt.attempt_id, attempt.run_id)
      .first<{
        status: string;
        version: number;
        lease_generation: number;
        lease_expires_at: string | null;
        github_run_id: string | null;
        github_head_sha: string | null;
        github_status: string | null;
        github_observed_at: string | null;
      }>();
    if (
      persisted === null ||
      persisted.status !== 'starting' ||
      persisted.github_run_id !== dispatch.githubRunId ||
      persisted.github_head_sha !== dispatch.githubHeadSha ||
      persisted.github_status !== 'requested' ||
      persisted.github_observed_at === null ||
      persisted.lease_expires_at === null ||
      persisted.version < 1 ||
      persisted.lease_generation < 1
    ) {
      if (executionDispatch) return { settledCode: 'repair_fenced_after_dispatch' };
      throw new OutboxEffectError('dispatch_projection_conflict');
    }
  }
}
