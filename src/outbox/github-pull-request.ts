import { canonicalSha256 } from '../domain/digest.js';
import { GITHUB_API_USER_AGENT } from '../github-api.js';
import { SecretScanner } from '../security/redaction.js';
import {
  FencedOutboxProcessor,
  OutboxEffectError,
  type FencedOutboxRecord,
  type OutboxDeliveryResult,
  type OutboxEffectOutcome,
} from './fenced-outbox.js';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface GitHubPullRequestRequest {
  repository: string;
  title: string;
  body: string;
  bodyDigest: string;
  headBranch: string;
  headSha: string;
  baseBranch: string;
}

export interface GitHubPullRequestFact {
  repository: string;
  number: number;
  url: string;
  state: 'open';
  draft: true;
  title: string;
  bodyDigest: string;
  headBranch: string;
  headSha: string;
  baseBranch: string;
  externalUpdatedAt: string;
}

export interface GitHubPullRequestResult {
  disposition: 'created' | 'existing';
  fact: GitHubPullRequestFact;
}

export interface GitHubPullRequestEffects {
  ensureDraftPullRequest(request: GitHubPullRequestRequest): Promise<GitHubPullRequestResult>;
}

export interface GitHubPullRequestTokenProvider {
  getPullRequestToken(repository: string): Promise<string>;
}

export interface GitHubPullRequestApiClientOptions {
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

export interface GitHubPullRequestProcessorOptions {
  now?: () => Date;
  generateLeaseToken?: () => string;
  outboxLeaseMs?: number;
  secrets?: readonly string[];
}

interface PullRequestResponse {
  number?: unknown;
  html_url?: unknown;
  state?: unknown;
  draft?: unknown;
  title?: unknown;
  body?: unknown;
  head?: unknown;
  base?: unknown;
  updated_at?: unknown;
}

interface PublicationRow {
  publication_id: string;
  run_id: string;
  run_version: number;
  draft_id: string;
  approval_id: string;
  repository: string;
  base_branch: string;
  head_branch: string;
  head_sha: string;
  title: string;
  body_digest: string;
  status: 'pending' | 'created_unverified' | 'verified';
  github_pr_number: number | null;
  github_pr_url: string | null;
  body: string;
  draft_run_version: number;
  task_revision: string;
  task_repository: string;
  task_base_branch: string;
  allow_repository_write: number;
  plan_id: string;
  plan_version: number;
  plan_digest: string;
  plan_status: string;
  plan_base_sha: string;
  run_state: string;
  current_run_version: number;
  run_base_sha: string | null;
  active_plan_id: string | null;
  active_plan_version: number | null;
  active_plan_digest: string | null;
  approval_decision: string;
  approval_expires_at: string;
  approval_created_at: string;
  approval_run_id: string;
  approval_task_revision: string;
  approval_plan_id: string;
  approval_plan_version: number;
  approval_plan_digest: string;
  approval_base_sha: string;
  approval_effect: string;
  has_repo_write_effect: number;
  incomplete_required_count: number;
  protected_gate_count: number;
  newer_attempt_count: number;
}

function apiOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('GitHub API URL is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new Error('GitHub API URL is invalid');
  }
  return url.origin;
}

function repositoryParts(repository: string): { owner: string; repo: string } {
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error('GitHub repository is invalid');
  const [owner, repo] = repository.split('/');
  if (owner === undefined || repo === undefined) throw new Error('GitHub repository is invalid');
  return { owner, repo };
}

function validBranch(branch: string): boolean {
  return (
    BRANCH_PATTERN.test(branch) &&
    !branch.includes('..') &&
    !branch.includes('//') &&
    !branch.endsWith('/') &&
    !branch.endsWith('.')
  );
}

function normalizedExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2_000) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) return null;
  return url.toString();
}

function normalizedDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

async function assertRequest(request: GitHubPullRequestRequest): Promise<void> {
  repositoryParts(request.repository);
  if (
    request.title.length < 1 ||
    request.title.length > 256 ||
    request.body.length < 1 ||
    new TextEncoder().encode(request.body).length > 65_536 ||
    !DIGEST_PATTERN.test(request.bodyDigest) ||
    await canonicalSha256(request.body) !== request.bodyDigest ||
    !validBranch(request.headBranch) ||
    !SHA_PATTERN.test(request.headSha) ||
    !validBranch(request.baseBranch) ||
    request.headBranch === request.baseBranch
  ) {
    throw new Error('GitHub pull request request is invalid');
  }
}

function objectField(value: unknown, field: string): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  const nested = (value as Record<string, unknown>)[field];
  return typeof nested === 'object' && nested !== null
    ? nested as Record<string, unknown>
    : null;
}

function identityMatches(response: PullRequestResponse, request: GitHubPullRequestRequest): boolean {
  const head = typeof response.head === 'object' && response.head !== null
    ? response.head as Record<string, unknown>
    : null;
  const base = typeof response.base === 'object' && response.base !== null
    ? response.base as Record<string, unknown>
    : null;
  return (
    head?.ref === request.headBranch &&
    objectField(head, 'repo')?.full_name === request.repository &&
    base?.ref === request.baseBranch &&
    objectField(base, 'repo')?.full_name === request.repository
  );
}

async function parsePullRequestFact(
  raw: unknown,
  request: GitHubPullRequestRequest,
): Promise<GitHubPullRequestFact> {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('GitHub pull request response is invalid');
  }
  const response = raw as PullRequestResponse;
  const head = response.head as Record<string, unknown> | undefined;
  const number = response.number;
  const url = normalizedExternalUrl(response.html_url);
  const externalUpdatedAt = normalizedDate(response.updated_at);
  if (
    !identityMatches(response, request) ||
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    url === null ||
    response.state !== 'open' ||
    response.draft !== true ||
    response.title !== request.title ||
    response.body !== request.body ||
    head?.sha !== request.headSha ||
    externalUpdatedAt === null ||
    await canonicalSha256(response.body) !== request.bodyDigest
  ) {
    throw new Error('GitHub pull request response is invalid');
  }
  return {
    repository: request.repository,
    number,
    url,
    state: 'open',
    draft: true,
    title: request.title,
    bodyDigest: request.bodyDigest,
    headBranch: request.headBranch,
    headSha: request.headSha,
    baseBranch: request.baseBranch,
    externalUpdatedAt,
  };
}

export function pullRequestFactMatches(
  fact: GitHubPullRequestFact,
  request: GitHubPullRequestRequest,
): boolean {
  return (
    fact.repository === request.repository &&
    Number.isSafeInteger(fact.number) &&
    fact.number > 0 &&
    normalizedExternalUrl(fact.url) === fact.url &&
    fact.state === 'open' &&
    fact.draft === true &&
    fact.title === request.title &&
    fact.bodyDigest === request.bodyDigest &&
    fact.headBranch === request.headBranch &&
    fact.headSha === request.headSha &&
    fact.baseBranch === request.baseBranch &&
    normalizedDate(fact.externalUpdatedAt) === fact.externalUpdatedAt
  );
}

/** Least-privilege GitHub REST adapter for an exact same-repository Draft PR. */
export class GitHubPullRequestApiClient implements GitHubPullRequestEffects {
  private readonly apiBaseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly tokenProvider: GitHubPullRequestTokenProvider,
    options: GitHubPullRequestApiClientOptions = {},
  ) {
    this.apiBaseUrl = apiOrigin(options.apiBaseUrl ?? 'https://api.github.com');
    this.fetcher = options.fetch ?? fetch;
  }

  async ensureDraftPullRequest(request: GitHubPullRequestRequest): Promise<GitHubPullRequestResult> {
    await assertRequest(request);
    const token = await this.token(request.repository);
    const existing = await this.findExisting(request, token);
    if (existing !== null) return { disposition: 'existing', fact: existing };
    const response = await this.safeFetch(
      `${this.apiBaseUrl}/repos/${request.repository}/pulls`,
      {
        method: 'POST',
        headers: this.headers(token, true),
        body: JSON.stringify({
          title: request.title,
          body: request.body,
          head: request.headBranch,
          base: request.baseBranch,
          draft: true,
          maintainer_can_modify: false,
        }),
      },
    );
    if (response.status !== 201) {
      await response.body?.cancel();
      throw new Error('GitHub pull request creation failed');
    }
    return {
      disposition: 'created',
      fact: await this.responseFact(response, request),
    };
  }

  async getPullRequest(
    request: GitHubPullRequestRequest,
    number: number,
  ): Promise<GitHubPullRequestFact> {
    await assertRequest(request);
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new Error('GitHub pull request number is invalid');
    }
    const token = await this.token(request.repository);
    const response = await this.safeFetch(
      `${this.apiBaseUrl}/repos/${request.repository}/pulls/${number}`,
      { method: 'GET', headers: this.headers(token, false) },
    );
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error('GitHub pull request query failed');
    }
    return await this.responseFact(response, request);
  }

  private async findExisting(
    request: GitHubPullRequestRequest,
    token: string,
  ): Promise<GitHubPullRequestFact | null> {
    const { owner } = repositoryParts(request.repository);
    const query = new URLSearchParams({
      state: 'all',
      head: `${owner}:${request.headBranch}`,
      base: request.baseBranch,
      per_page: '30',
    });
    const response = await this.safeFetch(
      `${this.apiBaseUrl}/repos/${request.repository}/pulls?${query.toString()}`,
      { method: 'GET', headers: this.headers(token, false) },
    );
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error('GitHub pull request reconciliation failed');
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error('GitHub pull request response is invalid');
    }
    if (!Array.isArray(body)) throw new Error('GitHub pull request response is invalid');
    const matching = body.filter((candidate) =>
      typeof candidate === 'object' && candidate !== null &&
      identityMatches(candidate as PullRequestResponse, request));
    if (matching.length === 0) return null;
    if (matching.length !== 1) throw new Error('GitHub pull request response is invalid');
    return await parsePullRequestFact(matching[0], request);
  }

  private async responseFact(
    response: Response,
    request: GitHubPullRequestRequest,
  ): Promise<GitHubPullRequestFact> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error('GitHub pull request response is invalid');
    }
    return await parsePullRequestFact(body, request);
  }

  private async token(repository: string): Promise<string> {
    const token = await this.tokenProvider.getPullRequestToken(repository);
    if (token.length < 1 || token.length > 2_000 || /[\0\r\n]/.test(token)) {
      throw new Error('GitHub pull request token is unavailable');
    }
    return token;
  }

  private headers(token: string, content: boolean): Record<string, string> {
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      ...(content ? { 'content-type': 'application/json' } : {}),
      'user-agent': GITHUB_API_USER_AGENT,
      'x-github-api-version': '2022-11-28',
    };
  }

  private async safeFetch(input: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(input, init);
    } catch {
      throw new Error('GitHub pull request request failed');
    }
  }
}

/** Shared fenced outbox consumer; the GitHub create response never advances Run state. */
export class GitHubPullRequestOutboxProcessor {
  private readonly now: () => Date;
  private readonly fenced: FencedOutboxProcessor;
  private readonly scanner: SecretScanner;

  constructor(
    private readonly db: D1Database,
    private readonly effects: GitHubPullRequestEffects,
    options: GitHubPullRequestProcessorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.scanner = new SecretScanner({ secrets: options.secrets ?? [] });
    this.fenced = new FencedOutboxProcessor(
      db,
      'github_api',
      async (outbox) => await this.perform(outbox),
      {
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.generateLeaseToken === undefined
          ? {}
          : { generateLeaseToken: options.generateLeaseToken }),
        ...(options.outboxLeaseMs === undefined ? {} : { leaseMs: options.outboxLeaseMs }),
        unavailableErrorCode: 'github_pull_request_unavailable',
      },
    );
  }

  async deliver(outboxId: string): Promise<OutboxDeliveryResult> {
    return await this.fenced.deliver(outboxId);
  }

  async drain(limit = 25): Promise<OutboxDeliveryResult[]> {
    return await this.fenced.drain(limit);
  }

  private async perform(outbox: FencedOutboxRecord): Promise<OutboxEffectOutcome | void> {
    if (outbox.kind !== 'pull_request') {
      throw new OutboxEffectError('unsupported_pull_request_kind');
    }
    const prefix = 'd1://pull-request-publications/';
    if (!outbox.payloadRef.startsWith(prefix)) {
      throw new OutboxEffectError('pull_request_ref_invalid');
    }
    const publicationId = outbox.payloadRef.slice(prefix.length);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(publicationId)) {
      throw new OutboxEffectError('pull_request_ref_invalid');
    }
    const publication = await this.publication(publicationId);
    if (publication === null || publication.run_id !== outbox.runId) {
      throw new OutboxEffectError('pull_request_ref_invalid');
    }
    if (publication.status === 'verified') return { settledCode: 'pull_request_verified' };
    const now = this.now();
    const decision = await this.deliveryDecision(publication, now);
    if (decision !== null) return { settledCode: decision };
    const request: GitHubPullRequestRequest = {
      repository: publication.repository,
      title: publication.title,
      body: publication.body,
      bodyDigest: publication.body_digest,
      headBranch: publication.head_branch,
      headSha: publication.head_sha,
      baseBranch: publication.base_branch,
    };
    if (this.scanner.scan({ title: request.title, body: request.body }).length > 0) {
      return { settledCode: 'pull_request_secret_detected' };
    }
    const result = await this.effects.ensureDraftPullRequest(request);
    if (!pullRequestFactMatches(result.fact, request)) {
      throw new OutboxEffectError('pull_request_fact_invalid');
    }
    const updated = await this.db.prepare(
      `UPDATE pull_request_publications
       SET status = CASE WHEN status = 'pending' THEN 'created_unverified' ELSE status END,
           github_pr_number = ?, github_pr_url = ?, updated_at = ?
       WHERE publication_id = ? AND run_id = ?
         AND status IN ('pending', 'created_unverified')
         AND (github_pr_number IS NULL OR github_pr_number = ?)
         AND (github_pr_url IS NULL OR github_pr_url = ?)
         AND EXISTS (
           SELECT 1 FROM runs
           WHERE runs.run_id = pull_request_publications.run_id
             AND runs.state = 'verifying'
             AND runs.version = pull_request_publications.run_version
         )`,
    ).bind(
      result.fact.number,
      result.fact.url,
      now.toISOString(),
      publication.publication_id,
      publication.run_id,
      result.fact.number,
      result.fact.url,
    ).run();
    if (updated.meta.changes !== 1) {
      const current = await this.publication(publicationId);
      if (
        current?.status === 'verified' &&
        current.github_pr_number === result.fact.number
      ) return { settledCode: 'pull_request_verified' };
      if (
        current?.status === 'created_unverified' &&
        current.github_pr_number === result.fact.number &&
        current.github_pr_url === result.fact.url
      ) return;
      throw new OutboxEffectError('pull_request_publication_changed');
    }
  }

  private async deliveryDecision(
    publication: PublicationRow,
    now: Date,
  ): Promise<'pull_request_stale' | 'approval_expired' | 'approval_invalid' | null> {
    if (
      publication.run_state !== 'verifying' ||
      publication.current_run_version !== publication.run_version ||
      publication.draft_run_version !== publication.run_version ||
      publication.run_base_sha === null ||
      publication.active_plan_id !== publication.plan_id ||
      publication.active_plan_version !== publication.plan_version ||
      publication.active_plan_digest !== publication.plan_digest ||
      publication.plan_status !== 'active' ||
      publication.plan_base_sha !== publication.run_base_sha ||
      publication.task_repository !== publication.repository ||
      publication.task_base_branch !== publication.base_branch ||
      publication.allow_repository_write !== 1 ||
      publication.has_repo_write_effect !== 1 ||
      publication.incomplete_required_count !== 0 ||
      publication.protected_gate_count !== 0 ||
      publication.newer_attempt_count !== 0 ||
      publication.approval_run_id !== publication.run_id ||
      publication.approval_task_revision !== publication.task_revision ||
      publication.approval_plan_id !== publication.plan_id ||
      publication.approval_plan_version !== publication.plan_version ||
      publication.approval_plan_digest !== publication.plan_digest ||
      publication.approval_base_sha !== publication.plan_base_sha ||
      publication.approval_effect !== 'repo_write' ||
      await canonicalSha256(publication.body) !== publication.body_digest
    ) return 'pull_request_stale';
    if (publication.approval_decision !== 'approve') return 'approval_invalid';
    const invalidated = await this.db.prepare(
      `SELECT approval_id FROM invalidated_approvals WHERE approval_id = ?`,
    ).bind(publication.approval_id).first<{ approval_id: string }>();
    if (invalidated !== null) return 'approval_invalid';
    if (
      !Number.isFinite(Date.parse(publication.approval_expires_at)) ||
      publication.approval_expires_at <= now.toISOString()
    ) return 'approval_expired';
    const newerReject = await this.db.prepare(
      `SELECT approval_id FROM approvals
       WHERE run_id = ? AND task_revision = ? AND plan_id = ?
         AND plan_version = ? AND plan_digest = ? AND base_sha = ?
         AND effect = 'repo_write' AND decision = 'reject'
         AND (created_at > ? OR (created_at = ? AND approval_id > ?))
       ORDER BY created_at DESC, approval_id DESC LIMIT 1`,
    ).bind(
      publication.run_id,
      publication.task_revision,
      publication.plan_id,
      publication.plan_version,
      publication.plan_digest,
      publication.plan_base_sha,
      publication.approval_created_at,
      publication.approval_created_at,
      publication.approval_id,
    ).first<{ approval_id: string }>();
    return newerReject === null ? null : 'approval_invalid';
  }

  private async publication(publicationId: string): Promise<PublicationRow | null> {
    return await this.db.prepare(
      `SELECT pull_request_publications.*,
              pull_request_drafts.body, pull_request_drafts.run_version AS draft_run_version,
              tasks.task_revision, tasks.target_repository AS task_repository,
              tasks.target_base_branch AS task_base_branch,
              tasks.allow_repository_write,
              execution_plans.plan_id, execution_plans.plan_version,
              execution_plans.digest AS plan_digest,
              execution_plans.status AS plan_status,
              execution_plans.base_sha AS plan_base_sha,
              runs.state AS run_state, runs.version AS current_run_version,
              runs.base_sha AS run_base_sha, runs.active_plan_id,
              runs.active_plan_version, runs.active_plan_digest,
              approvals.decision AS approval_decision,
              approvals.expires_at AS approval_expires_at,
              approvals.created_at AS approval_created_at,
              approvals.run_id AS approval_run_id,
              approvals.task_revision AS approval_task_revision,
              approvals.plan_id AS approval_plan_id,
              approvals.plan_version AS approval_plan_version,
              approvals.plan_digest AS approval_plan_digest,
              approvals.base_sha AS approval_base_sha,
              approvals.effect AS approval_effect,
              CASE WHEN EXISTS (
                SELECT 1 FROM plan_item_effects
                WHERE plan_item_effects.plan_id = execution_plans.plan_id
                  AND plan_item_effects.effect = 'repo_write'
              ) THEN 1 ELSE 0 END AS has_repo_write_effect,
              (SELECT COUNT(*) FROM plan_items
               JOIN plan_item_progress
                 ON plan_item_progress.plan_id = plan_items.plan_id
                AND plan_item_progress.item_id = plan_items.item_id
               WHERE plan_items.plan_id = execution_plans.plan_id
                 AND plan_items.required = 1
                 AND plan_item_progress.status <> 'passed') AS incomplete_required_count,
              (SELECT COUNT(*) FROM plan_item_progress
               WHERE plan_item_progress.plan_id = execution_plans.plan_id
                 AND plan_item_progress.protected_path_gate_id IS NOT NULL) AS protected_gate_count,
              (SELECT COUNT(*) FROM attempts AS newer
               JOIN attempts AS published_attempt
                 ON published_attempt.attempt_id = pull_request_drafts.attempt_id
               WHERE newer.run_id = runs.run_id
                 AND newer.mode IN ('implement', 'review_fix')
                 AND newer.ordinal > published_attempt.ordinal) AS newer_attempt_count
       FROM pull_request_publications
       JOIN pull_request_drafts
         ON pull_request_drafts.draft_id = pull_request_publications.draft_id
       JOIN runs ON runs.run_id = pull_request_publications.run_id
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans ON execution_plans.plan_id = pull_request_drafts.plan_id
       JOIN approvals ON approvals.approval_id = pull_request_publications.approval_id
       WHERE pull_request_publications.publication_id = ?`,
    ).bind(publicationId).first<PublicationRow>();
  }
}
