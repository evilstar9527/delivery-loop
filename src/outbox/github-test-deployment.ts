import {
  FencedOutboxProcessor,
  OutboxEffectError,
  type FencedOutboxRecord,
  type OutboxDeliveryResult,
} from './fenced-outbox.js';
import {
  QuotaControlError,
  QuotaControlStore,
} from '../storage/quota-control-store.js';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DEPLOYMENT_TASK = 'delivery-loop:test';

export interface GitHubDeploymentTokenProvider {
  getDeploymentToken(repository: string): Promise<string>;
}

export interface GitHubTestDeploymentRequest {
  deploymentId: string;
  repository: string;
  refSha: string;
  environment: 'test';
}

export interface GitHubTestDeploymentResult {
  disposition: 'created' | 'existing';
  githubDeploymentId: string;
}

export interface GitHubTestDeploymentEffects {
  ensureTestDeployment(
    request: GitHubTestDeploymentRequest,
  ): Promise<GitHubTestDeploymentResult>;
}

export interface GitHubTestDeploymentApiClientOptions {
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('GitHub API URL is invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
  ) throw new Error('GitHub API URL is invalid');
  return url.origin;
}

function githubId(value: unknown): string | null {
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

function assertRequest(request: GitHubTestDeploymentRequest): void {
  if (
    !ID_PATTERN.test(request.deploymentId) || !REPOSITORY_PATTERN.test(request.repository) ||
    !SHA_PATTERN.test(request.refSha) || request.environment !== 'test'
  ) throw new Error('GitHub test deployment request is invalid');
}

function identityMatches(raw: unknown, request: GitHubTestDeploymentRequest): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const deployment = raw as Record<string, unknown>;
  const payload = typeof deployment.payload === 'object' && deployment.payload !== null
    ? deployment.payload as Record<string, unknown>
    : null;
  if (
    deployment.sha !== request.refSha || deployment.task !== DEPLOYMENT_TASK ||
    deployment.environment !== 'test' || payload?.schema_version !== '1' ||
    payload.delivery_deployment_id !== request.deploymentId
  ) return null;
  return githubId(deployment.id);
}

/** Minimal GitHub Deployments adapter; payload is reference-only and never carries credentials. */
export class GitHubTestDeploymentApiClient implements GitHubTestDeploymentEffects {
  private readonly apiBaseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly tokenProvider: GitHubDeploymentTokenProvider,
    options: GitHubTestDeploymentApiClientOptions = {},
  ) {
    this.apiBaseUrl = httpsOrigin(options.apiBaseUrl ?? 'https://api.github.com');
    this.fetcher = options.fetch ?? fetch;
  }

  async ensureTestDeployment(
    request: GitHubTestDeploymentRequest,
  ): Promise<GitHubTestDeploymentResult> {
    assertRequest(request);
    const token = await this.tokenProvider.getDeploymentToken(request.repository);
    if (token.length < 1 || token.length > 2_000 || /[\0\r\n]/.test(token)) {
      throw new Error('GitHub deployment token is unavailable');
    }
    const headers = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    };
    const existing = await this.find(request, headers);
    if (existing !== null) return { disposition: 'existing', githubDeploymentId: existing };
    const body = {
      ref: request.refSha,
      task: DEPLOYMENT_TASK,
      auto_merge: false,
      required_contexts: [],
      environment: 'test',
      description: 'delivery-loop test deployment',
      payload: {
        schema_version: '1',
        delivery_deployment_id: request.deploymentId,
      },
    } as const;
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.apiBaseUrl}/repos/${request.repository}/deployments`,
        { method: 'POST', headers, body: JSON.stringify(body) },
      );
    } catch {
      const reconciled = await this.find(request, headers);
      if (reconciled !== null) {
        return { disposition: 'existing', githubDeploymentId: reconciled };
      }
      throw new Error('GitHub test deployment request failed');
    }
    if (response.status !== 201) {
      await response.body?.cancel();
      throw new Error('GitHub test deployment request failed');
    }
    let created: unknown;
    try {
      created = await response.json();
    } catch {
      throw new Error('GitHub test deployment response is invalid');
    }
    const createdId = githubId(
      typeof created === 'object' && created !== null
        ? (created as Record<string, unknown>).id
        : null,
    );
    if (createdId === null) throw new Error('GitHub test deployment response is invalid');
    return { disposition: 'created', githubDeploymentId: createdId };
  }

  private async find(
    request: GitHubTestDeploymentRequest,
    headers: Record<string, string>,
  ): Promise<string | null> {
    const query = new URLSearchParams({
      sha: request.refSha,
      task: DEPLOYMENT_TASK,
      environment: 'test',
      per_page: '100',
    });
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.apiBaseUrl}/repos/${request.repository}/deployments?${query.toString()}`,
        { method: 'GET', headers },
      );
    } catch {
      throw new Error('GitHub test deployment reconciliation failed');
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error('GitHub test deployment reconciliation failed');
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error('GitHub test deployment response is invalid');
    }
    if (!Array.isArray(body) || body.length > 100) {
      throw new Error('GitHub test deployment response is invalid');
    }
    for (const candidate of body) {
      const id = identityMatches(candidate, request);
      if (id !== null) return id;
    }
    return null;
  }
}

export interface TestDeploymentOutboxProcessorOptions {
  now?: () => Date;
  generateLeaseToken?: () => string;
  outboxLeaseMs?: number;
  attemptLeaseMs?: number;
}

interface DeploymentRow {
  deployment_id: string;
  run_id: string;
  run_version: number;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  plan_item_id: string;
  attempt_id: string;
  approval_id: string;
  repository: string;
  ref_sha: string;
  status: string;
  run_state: string;
  run_current_version: number;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  plan_status: string;
  progress_status: string;
  progress_active_attempt_id: string | null;
  attempt_status: string;
  attempt_version: number;
  attempt_lease_generation: number;
  approval_decision: string | null;
  approval_expires_at: string | null;
  approval_invalidated: number;
  approval_trusted: number;
  approval_latest: number;
}

export class TestDeploymentOutboxProcessor {
  private readonly fenced: FencedOutboxProcessor;
  private readonly now: () => Date;
  private readonly attemptLeaseMs: number;

  constructor(
    private readonly db: D1Database,
    private readonly effects: GitHubTestDeploymentEffects,
    options: TestDeploymentOutboxProcessorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.attemptLeaseMs = options.attemptLeaseMs ?? 60 * 60_000;
    this.fenced = new FencedOutboxProcessor(
      db,
      'github_deployments',
      async (outbox) => await this.perform(outbox),
      {
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.generateLeaseToken === undefined
          ? {}
          : { generateLeaseToken: options.generateLeaseToken }),
        ...(options.outboxLeaseMs === undefined ? {} : { leaseMs: options.outboxLeaseMs }),
        unavailableErrorCode: 'github_deployment_unavailable',
      },
    );
    if (!Number.isSafeInteger(this.attemptLeaseMs) || this.attemptLeaseMs <= 0) {
      throw new Error('test deployment attempt lease is invalid');
    }
  }

  async deliver(outboxId: string): Promise<OutboxDeliveryResult> {
    return await this.fenced.deliver(outboxId);
  }

  async drain(limit = 25): Promise<OutboxDeliveryResult[]> {
    return await this.fenced.drain(limit);
  }

  private async perform(outbox: FencedOutboxRecord): Promise<void> {
    if (outbox.kind !== 'test_deploy') throw new OutboxEffectError('unsupported_deployment_kind');
    const prefix = 'd1://test-deployments/';
    if (!outbox.payloadRef.startsWith(prefix)) {
      throw new OutboxEffectError('test_deployment_ref_invalid');
    }
    const deploymentId = outbox.payloadRef.slice(prefix.length);
    if (!ID_PATTERN.test(deploymentId)) throw new OutboxEffectError('test_deployment_ref_invalid');
    const deployment = await this.context(deploymentId, outbox.runId);
    if (deployment === null) throw new OutboxEffectError('test_deployment_missing');
    if (deployment.status !== 'scheduled') return;
    const now = this.now();
    const effectStartedAt = now.toISOString();
    if (
      deployment.run_state !== 'executing' ||
      deployment.run_current_version !== deployment.run_version ||
      deployment.active_plan_id !== deployment.plan_id ||
      deployment.active_plan_version !== deployment.plan_version ||
      deployment.active_plan_digest !== deployment.plan_digest ||
      deployment.plan_status !== 'active' ||
      deployment.progress_status !== 'in_progress' ||
      deployment.progress_active_attempt_id !== deployment.attempt_id ||
      deployment.attempt_status !== 'pending' || deployment.attempt_version !== 0 ||
      deployment.attempt_lease_generation !== 0 ||
      deployment.approval_decision !== 'approve' ||
      (deployment.approval_expires_at ?? '') <= effectStartedAt ||
      deployment.approval_invalidated !== 0 || deployment.approval_trusted !== 1 ||
      deployment.approval_latest !== 1
    ) throw new OutboxEffectError('test_deployment_stale');
    const quota = new QuotaControlStore(this.db);
    try {
      await quota.reserveAttemptConcurrency(deployment.attempt_id, now);
    } catch (error) {
      if (error instanceof QuotaControlError && error.code === 'quota_exceeded') {
        throw new OutboxEffectError('quota_concurrency_exceeded');
      }
      throw error;
    }
    // The Deployment may exist even when its create response is lost. Retain
    // the reservation until reconciliation/terminal state instead of undercounting.
    const result: GitHubTestDeploymentResult = await this.effects.ensureTestDeployment({
      deploymentId: deployment.deployment_id,
      repository: deployment.repository,
      refSha: deployment.ref_sha,
      environment: 'test',
    });
    if (!/^[0-9]+$/.test(result.githubDeploymentId)) {
      throw new OutboxEffectError('github_deployment_id_invalid');
    }
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + this.attemptLeaseMs).toISOString();
    await this.db.batch([
      this.db.prepare(
        `UPDATE test_deployments
         SET status = 'created_unverified', github_deployment_id = ?, updated_at = ?
         WHERE deployment_id = ? AND status = 'scheduled'
           AND github_deployment_id IS NULL
           AND EXISTS (
             SELECT 1 FROM runs
             JOIN execution_plans ON execution_plans.plan_id = runs.active_plan_id
             JOIN plan_item_progress
               ON plan_item_progress.plan_id = test_deployments.plan_id
              AND plan_item_progress.item_id = test_deployments.plan_item_id
             JOIN attempts ON attempts.attempt_id = test_deployments.attempt_id
             JOIN trusted_effect_approvals AS approvals
               ON approvals.approval_id = test_deployments.approval_id
             WHERE runs.run_id = test_deployments.run_id
               AND runs.version = test_deployments.run_version
               AND runs.state = 'executing'
               AND runs.active_plan_id = test_deployments.plan_id
               AND runs.active_plan_version = test_deployments.plan_version
               AND runs.active_plan_digest = test_deployments.plan_digest
               AND execution_plans.status = 'active'
               AND plan_item_progress.status = 'in_progress'
               AND plan_item_progress.active_attempt_id = test_deployments.attempt_id
               AND attempts.status = 'pending' AND attempts.version = 0
               AND attempts.lease_generation = 0 AND attempts.head_sha = test_deployments.ref_sha
               AND approvals.effect = 'test_deploy' AND approvals.decision = 'approve'
               AND approvals.expires_at > ?
               AND NOT EXISTS (
                 SELECT 1 FROM invalidated_approvals
                 WHERE invalidated_approvals.approval_id = approvals.approval_id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM approvals AS newer
                 WHERE newer.run_id = approvals.run_id
                   AND newer.task_revision = approvals.task_revision
                   AND newer.plan_id = approvals.plan_id
                   AND newer.plan_version = approvals.plan_version
                   AND newer.plan_digest = approvals.plan_digest
                   AND newer.base_sha = approvals.base_sha
                   AND newer.effect = approvals.effect
                   AND (newer.created_at > approvals.created_at OR
                        (newer.created_at = approvals.created_at
                         AND newer.approval_id > approvals.approval_id))
               )
           )`,
      ).bind(result.githubDeploymentId, nowIso, deploymentId, nowIso),
      this.db.prepare(
        `UPDATE attempts
         SET status = 'running', version = 1, lease_generation = 1,
             lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
         WHERE attempt_id = ? AND run_id = ? AND mode = 'deploy'
           AND status = 'pending' AND version = 0 AND lease_generation = 0
           AND EXISTS (
             SELECT 1 FROM test_deployments
             WHERE deployment_id = ? AND status = 'created_unverified'
               AND github_deployment_id = ?
           )`,
      ).bind(
        leaseExpiresAt,
        nowIso,
        nowIso,
        deployment.attempt_id,
        deployment.run_id,
        deploymentId,
        result.githubDeploymentId,
      ),
    ]);
    const persisted = await this.context(deploymentId, outbox.runId);
    if (
      persisted?.status !== 'created_unverified' ||
      persisted.attempt_status !== 'running' || persisted.attempt_version !== 1 ||
      persisted.attempt_lease_generation !== 1
    ) throw new OutboxEffectError('test_deployment_state_conflict');
  }

  private async context(deploymentId: string, runId: string): Promise<DeploymentRow | null> {
    return await this.db.prepare(
      `SELECT deployments.deployment_id, deployments.run_id, deployments.run_version,
              deployments.plan_id, deployments.plan_version, deployments.plan_digest,
              deployments.plan_item_id, deployments.attempt_id, deployments.approval_id,
              deployments.repository, deployments.ref_sha, deployments.status,
              runs.state AS run_state, runs.version AS run_current_version,
              runs.active_plan_id, runs.active_plan_version, runs.active_plan_digest,
              plans.status AS plan_status, progress.status AS progress_status,
              progress.active_attempt_id AS progress_active_attempt_id,
              attempts.status AS attempt_status, attempts.version AS attempt_version,
              attempts.lease_generation AS attempt_lease_generation,
              approvals.decision AS approval_decision,
              approvals.expires_at AS approval_expires_at,
              EXISTS (SELECT 1 FROM invalidated_approvals
                      WHERE invalidated_approvals.approval_id = deployments.approval_id)
                AS approval_invalidated,
              EXISTS (SELECT 1 FROM trusted_effect_approvals
                      WHERE trusted_effect_approvals.approval_id = deployments.approval_id)
                AS approval_trusted,
              NOT EXISTS (
                SELECT 1 FROM approvals AS newer
                WHERE newer.run_id = approvals.run_id
                  AND newer.task_revision = approvals.task_revision
                  AND newer.plan_id = approvals.plan_id
                  AND newer.plan_version = approvals.plan_version
                  AND newer.plan_digest = approvals.plan_digest
                  AND newer.base_sha = approvals.base_sha
                  AND newer.effect = approvals.effect
                  AND (newer.created_at > approvals.created_at OR
                       (newer.created_at = approvals.created_at
                        AND newer.approval_id > approvals.approval_id))
              ) AS approval_latest
       FROM test_deployments AS deployments
       JOIN runs ON runs.run_id = deployments.run_id
       JOIN execution_plans AS plans ON plans.plan_id = deployments.plan_id
       JOIN plan_item_progress AS progress
         ON progress.plan_id = deployments.plan_id
        AND progress.item_id = deployments.plan_item_id
       JOIN attempts ON attempts.attempt_id = deployments.attempt_id
       JOIN approvals ON approvals.approval_id = deployments.approval_id
       WHERE deployments.deployment_id = ? AND deployments.run_id = ?`,
    ).bind(deploymentId, runId).first<DeploymentRow>();
  }
}
