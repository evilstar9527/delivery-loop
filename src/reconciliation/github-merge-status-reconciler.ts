import {
  GitHubPullRequestMergeFactSchema,
  type GitHubPullRequestMergeFact,
} from '../domain/github-merge-status.js';
import { canonicalSha256 } from '../domain/digest.js';
import type { GitHubMergeObservationTokenProvider } from './github-merge-gate-reconciler.js';
import {
  GitHubMergeStatusStore,
  type GitHubMergeObservationDisposition,
} from '../storage/github-merge-status-store.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;

export interface GitHubMergeStatusRequest {
  repository: string;
  number: number;
  url: string;
  headBranch: string;
  headSha: string;
  baseBranch: string;
}

export interface GitHubMergeStatusExternalFactClient {
  getMergeStatus(
    request: GitHubMergeStatusRequest,
  ): Promise<GitHubPullRequestMergeFact | null>;
}

export interface GitHubMergeStatusApiClientOptions {
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

interface ReconciliationCandidate {
  run_id: string;
  publication_id: string;
  repository: string;
  github_pr_number: number;
  github_pr_url: string;
  head_branch: string;
  head_sha: string;
  base_branch: string;
}

export interface GitHubMergeStatusBatchResult {
  runId: string;
  disposition: GitHubMergeObservationDisposition | 'pending' | 'unavailable';
}

function apiOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('GitHub API URL is invalid');
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/')
  ) throw new Error('GitHub API URL is invalid');
  return url.origin;
}

function safeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2_000) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.search !== '' || url.hash !== ''
  ) return null;
  return url.toString();
}

function normalizedDate(raw: unknown): string | null {
  if (typeof raw !== 'string' || !Number.isFinite(Date.parse(raw))) return null;
  return new Date(raw).toISOString();
}

function objectField(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === 'object' && nested !== null
    ? nested as Record<string, unknown>
    : null;
}

function validRequest(request: GitHubMergeStatusRequest): boolean {
  return REPOSITORY_PATTERN.test(request.repository) &&
    Number.isSafeInteger(request.number) && request.number > 0 &&
    safeUrl(request.url) === request.url && BRANCH_PATTERN.test(request.headBranch) &&
    SHA_PATTERN.test(request.headSha) && BRANCH_PATTERN.test(request.baseBranch);
}

/** Read-only PR status adapter using the existing merge-observation token profile. */
export class GitHubMergeStatusApiClient implements GitHubMergeStatusExternalFactClient {
  private readonly apiBaseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly tokenProvider: GitHubMergeObservationTokenProvider,
    options: GitHubMergeStatusApiClientOptions = {},
  ) {
    this.apiBaseUrl = apiOrigin(options.apiBaseUrl ?? 'https://api.github.com');
    this.fetcher = options.fetch ?? fetch;
  }

  async getMergeStatus(
    request: GitHubMergeStatusRequest,
  ): Promise<GitHubPullRequestMergeFact | null> {
    if (!validRequest(request)) throw new Error('GitHub merge status request is invalid');
    const token = await this.tokenProvider.getMergeObservationToken(request.repository);
    if (token.length < 1 || token.length > 2_000 || /[\0\r\n]/.test(token)) {
      throw new Error('GitHub merge observation token is unavailable');
    }
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.apiBaseUrl}/repos/${request.repository}/pulls/${request.number}`,
        {
          method: 'GET',
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'x-github-api-version': '2022-11-28',
          },
        },
      );
    } catch {
      throw new Error('GitHub merge status request failed');
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error('GitHub merge status query failed');
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new Error('GitHub merge status response is invalid');
    }
    return this.parse(raw, request);
  }

  private parse(
    raw: unknown,
    request: GitHubMergeStatusRequest,
  ): GitHubPullRequestMergeFact | null {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('GitHub merge status response is invalid');
    }
    const body = raw as Record<string, unknown>;
    const head = objectField(body, 'head');
    const base = objectField(body, 'base');
    const repositoryMatches = objectField(head, 'repo')?.full_name === request.repository &&
      objectField(base, 'repo')?.full_name === request.repository;
    const url = safeUrl(body.html_url);
    const updatedAt = normalizedDate(body.updated_at);
    if (
      body.number !== request.number || !repositoryMatches || url !== request.url ||
      head?.ref !== request.headBranch || head.sha !== request.headSha ||
      base?.ref !== request.baseBranch || updatedAt === null ||
      (body.state !== 'open' && body.state !== 'closed') || typeof body.merged !== 'boolean'
    ) throw new Error('GitHub merge status response is invalid');
    if (!body.merged) return null;
    const mergedAt = normalizedDate(body.merged_at);
    const mergedBy = objectField(body, 'merged_by');
    const parsed = GitHubPullRequestMergeFactSchema.safeParse({
      schemaVersion: '1',
      repository: request.repository,
      number: request.number,
      url,
      state: body.state,
      merged: body.merged,
      headBranch: request.headBranch,
      headSha: request.headSha,
      baseBranch: request.baseBranch,
      mergeSha: body.merge_commit_sha,
      mergedByLogin: mergedBy?.login,
      mergedAt,
      externalUpdatedAt: updatedAt,
    });
    if (!parsed.success) throw new Error('GitHub merge status response is invalid');
    return parsed.data;
  }
}

/** Repairs lost merge webhooks without creating or merging a pull request. */
export class GitHubMergeStatusReconciler {
  constructor(
    private readonly db: D1Database,
    private readonly client: GitHubMergeStatusExternalFactClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcileRun(
    runId: string,
  ): Promise<GitHubMergeObservationDisposition | 'pending' | 'not_found'> {
    if (!ID_PATTERN.test(runId)) return 'not_found';
    const candidate = await this.candidate(runId);
    if (candidate === null) return 'not_found';
    const fact = await this.client.getMergeStatus({
      repository: candidate.repository,
      number: candidate.github_pr_number,
      url: candidate.github_pr_url,
      headBranch: candidate.head_branch,
      headSha: candidate.head_sha,
      baseBranch: candidate.base_branch,
    });
    if (fact === null) return 'pending';
    const factDigest = await canonicalSha256(fact);
    const identity = await canonicalSha256({
      source: 'github_api',
      runId,
      publicationId: candidate.publication_id,
      factDigest,
    });
    return await new GitHubMergeStatusStore(this.db).applyApiObservation({
      observationId: `merge_api_${identity.slice('sha256:'.length, 'sha256:'.length + 52)}`,
      factDigest,
      fact,
      observedAt: this.now().toISOString(),
    });
  }

  async reconcileBatch(limit = 25): Promise<GitHubMergeStatusBatchResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('GitHub merge status reconciliation limit is invalid');
    }
    const candidates = await this.db.prepare(
      `SELECT runs.run_id
       FROM runs
       JOIN merge_gate_decisions ON merge_gate_decisions.run_id = runs.run_id
       WHERE runs.state = 'ready_to_merge'
         AND merge_gate_decisions.run_version + 1 = runs.version
         AND NOT EXISTS (SELECT 1 FROM github_merges WHERE github_merges.run_id = runs.run_id)
       ORDER BY runs.updated_at, runs.run_id LIMIT ?`,
    ).bind(limit).all<{ run_id: string }>();
    const results: GitHubMergeStatusBatchResult[] = [];
    for (const candidate of candidates.results) {
      try {
        const disposition = await this.reconcileRun(candidate.run_id);
        if (disposition !== 'not_found') {
          results.push({ runId: candidate.run_id, disposition });
        }
      } catch {
        results.push({ runId: candidate.run_id, disposition: 'unavailable' });
      }
    }
    return results;
  }

  private async candidate(runId: string): Promise<ReconciliationCandidate | null> {
    return await this.db.prepare(
      `SELECT runs.run_id, publications.publication_id, publications.repository,
              publications.github_pr_number, publications.github_pr_url,
              publications.head_branch, decisions.head_sha,
              publications.base_branch
       FROM runs
       JOIN merge_gate_decisions AS decisions ON decisions.run_id = runs.run_id
       JOIN pull_request_publications AS publications
         ON publications.publication_id = decisions.publication_id
       WHERE runs.run_id = ? AND runs.state = 'ready_to_merge'
         AND decisions.run_version + 1 = runs.version
         AND publications.status = 'verified'
         AND publications.github_pr_number IS NOT NULL
         AND publications.github_pr_url IS NOT NULL
         AND publications.head_sha = decisions.head_sha
         AND NOT EXISTS (SELECT 1 FROM github_merges WHERE github_merges.run_id = runs.run_id)
       ORDER BY decisions.created_at DESC, decisions.decision_id DESC LIMIT 1`,
    ).bind(runId).first<ReconciliationCandidate>();
  }
}
