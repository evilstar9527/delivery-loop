import { canonicalSha256 } from '../domain/digest.js';
import {
  GitHubBaseObservationFactSchema,
  PlanRevisionError,
  PlanRevisionStore,
  type GitHubBaseObservationFact,
} from '../storage/plan-revision-store.js';
import {
  GitHubBaseConflictError,
  GitHubBaseConflictFactSchema,
  GitHubBaseConflictStore,
  type GitHubBaseConflictFact,
} from '../storage/github-base-conflict-store.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const REPLAN_STATES = new Set([
  'awaiting_approval',
  'executing',
  'verifying',
  'pull_request_open',
  'awaiting_review',
  'ready_to_merge',
  'blocked',
]);

export type GitHubBaseResolutionErrorCode =
  | 'credential_unavailable'
  | 'reference_unavailable'
  | 'reference_invalid';

/** Safe stage classification for the read-only repository base lookup. */
export class GitHubBaseResolutionError extends Error {
  constructor(
    readonly code: GitHubBaseResolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubBaseResolutionError';
  }
}

export interface GitHubBaseObservationTokenProvider {
  getBaseObservationToken(repository: string): Promise<string>;
}

export interface GitHubBaseShaResolver {
  resolveBaseSha(repository: string, baseBranch: string): Promise<string>;
}

export interface GitHubBaseApiClientOptions {
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export type GitHubBaseObservationResult =
  | { disposition: 'unchanged'; headSha: string }
  | { disposition: 'fast_forward'; fact: GitHubBaseObservationFact }
  | { disposition: 'non_fast_forward'; fact: GitHubBaseConflictFact };

export interface GitHubBaseExternalFactClient {
  observeBase(
    repository: string,
    baseBranch: string,
    beforeSha: string,
  ): Promise<GitHubBaseObservationResult>;
}

export type GitHubBaseReconciliationDisposition =
  | 'replanning'
  | 'duplicate'
  | 'unchanged'
  | 'blocked'
  | 'stale'
  | 'not_found';

export interface GitHubBaseBatchResult {
  runId: string;
  disposition: GitHubBaseReconciliationDisposition | 'unavailable';
}

export interface GitHubBaseObservationReconcilerOptions {
  now?: () => Date;
}

interface CandidateRow {
  run_id: string;
  run_state: string;
  run_version: number;
  base_sha: string;
  active_plan_id: string;
  active_plan_version: number;
  active_plan_digest: string;
  plan_status: string;
  plan_base_sha: string;
  repository: string;
  base_branch: string;
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
  ) throw new Error('GitHub API URL is invalid');
  return url.origin;
}

function safeBranch(value: string): boolean {
  return BRANCH_PATTERN.test(value) && !value.includes('..') && !value.includes('//');
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

async function responseJson(response: Response, operation: string): Promise<unknown> {
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`${operation} failed`);
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new Error(`${operation} response is invalid`);
  }
  if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) {
    throw new Error(`${operation} response is invalid`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${operation} response is invalid`);
  }
}

/** Read-only GitHub REST adapter: exact ref head plus explicit commit relationship. */
export class GitHubBaseApiClient implements
  GitHubBaseExternalFactClient,
  GitHubBaseShaResolver {
  private readonly apiBaseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(
    private readonly tokenProvider: GitHubBaseObservationTokenProvider,
    options: GitHubBaseApiClientOptions = {},
  ) {
    this.apiBaseUrl = apiOrigin(options.apiBaseUrl ?? 'https://api.github.com');
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async resolveBaseSha(repository: string, baseBranch: string): Promise<string> {
    return (await this.readBaseReference(repository, baseBranch)).headSha;
  }

  async observeBase(
    repository: string,
    baseBranch: string,
    beforeSha: string,
  ): Promise<GitHubBaseObservationResult> {
    if (
      !REPOSITORY_PATTERN.test(repository) ||
      !safeBranch(baseBranch) ||
      !SHA_PATTERN.test(beforeSha)
    ) throw new Error('GitHub base observation request is invalid');
    const reference = await this.readBaseReference(repository, baseBranch);
    const { headSha: afterSha, headers, referenceDigest } = reference;
    if (afterSha === beforeSha) return { disposition: 'unchanged', headSha: beforeSha };

    let comparisonResponse: Response;
    try {
      comparisonResponse = await this.fetcher(
        `${this.apiBaseUrl}/repos/${repository}/compare/${beforeSha}...${afterSha}`,
        { method: 'GET', headers },
      );
    } catch {
      throw new Error('GitHub base comparison query failed');
    }
    const comparisonBody = object(await responseJson(
      comparisonResponse,
      'GitHub base comparison query',
    ));
    const relationship = comparisonBody?.status;
    const aheadBy = nonnegativeInteger(comparisonBody?.ahead_by);
    const behindBy = nonnegativeInteger(comparisonBody?.behind_by);
    const baseCommit = object(comparisonBody?.base_commit)?.sha;
    const mergeBaseCommit = object(comparisonBody?.merge_base_commit)?.sha;
    if (
      (relationship !== 'ahead' && relationship !== 'behind' &&
        relationship !== 'diverged' && relationship !== 'identical') ||
      aheadBy === null ||
      behindBy === null ||
      typeof baseCommit !== 'string' ||
      typeof mergeBaseCommit !== 'string' ||
      !SHA_PATTERN.test(baseCommit) ||
      !SHA_PATTERN.test(mergeBaseCommit) ||
      baseCommit !== beforeSha
    ) throw new Error('GitHub base comparison response is invalid');
    const comparisonDigest = await canonicalSha256({
      status: relationship,
      aheadBy,
      behindBy,
      baseCommitSha: baseCommit,
      mergeBaseCommitSha: mergeBaseCommit,
      comparedHeadSha: afterSha,
    });
    if (
      relationship !== 'ahead' ||
      aheadBy <= 0 ||
      behindBy !== 0 ||
      mergeBaseCommit !== beforeSha
    ) {
      return {
        disposition: 'non_fast_forward',
        fact: GitHubBaseConflictFactSchema.parse({
          schemaVersion: '1',
          repository,
          baseBranch,
          beforeSha,
          afterSha,
          relationship: relationship === 'ahead' ? 'diverged' : relationship,
          aheadBy,
          behindBy,
          mergeBaseSha: mergeBaseCommit,
          referenceDigest,
          comparisonDigest,
        }),
      };
    }
    return {
      disposition: 'fast_forward',
      fact: GitHubBaseObservationFactSchema.parse({
        schemaVersion: '1',
        repository,
        baseBranch,
        beforeSha,
        afterSha,
        relationship: 'ahead',
        aheadBy,
        referenceDigest,
        comparisonDigest,
      }),
    };
  }

  private async readBaseReference(
    repository: string,
    baseBranch: string,
  ): Promise<{
    headSha: string;
    referenceDigest: string;
    headers: Record<string, string>;
  }> {
    if (!REPOSITORY_PATTERN.test(repository) || !safeBranch(baseBranch)) {
      throw new Error('GitHub base reference request is invalid');
    }
    let token: string;
    try {
      token = await this.tokenProvider.getBaseObservationToken(repository);
    } catch {
      throw new GitHubBaseResolutionError(
        'credential_unavailable',
        'GitHub base observation token is unavailable',
      );
    }
    if (token.length < 1 || token.length > 2_000 || /[\0\r\n]/.test(token)) {
      throw new GitHubBaseResolutionError(
        'credential_unavailable',
        'GitHub base observation token is unavailable',
      );
    }
    const headers = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    };
    const encodedBranch = baseBranch.split('/').map(encodeURIComponent).join('/');
    let referenceResponse: Response;
    try {
      referenceResponse = await this.fetcher(
        `${this.apiBaseUrl}/repos/${repository}/git/ref/heads/${encodedBranch}`,
        { method: 'GET', headers },
      );
    } catch {
      throw new GitHubBaseResolutionError(
        'reference_unavailable',
        'GitHub base reference query failed',
      );
    }
    if (referenceResponse.status !== 200) {
      try {
        await referenceResponse.body?.cancel();
      } catch {
        // The upstream body is intentionally discarded and never becomes diagnostic output.
      }
      throw new GitHubBaseResolutionError(
        'reference_unavailable',
        'GitHub base reference query failed',
      );
    }
    let referenceText: string;
    try {
      referenceText = await referenceResponse.text();
    } catch {
      throw new GitHubBaseResolutionError(
        'reference_unavailable',
        'GitHub base reference query response is invalid',
      );
    }
    if (new TextEncoder().encode(referenceText).length > MAX_RESPONSE_BYTES) {
      throw new GitHubBaseResolutionError(
        'reference_invalid',
        'GitHub base reference query response is invalid',
      );
    }
    let referenceJson: unknown;
    try {
      referenceJson = JSON.parse(referenceText) as unknown;
    } catch {
      throw new GitHubBaseResolutionError(
        'reference_invalid',
        'GitHub base reference query response is invalid',
      );
    }
    const referenceBody = object(referenceJson);
    const referenceObject = object(referenceBody?.object);
    const afterSha = referenceObject?.sha;
    if (
      referenceBody?.ref !== `refs/heads/${baseBranch}` ||
      referenceObject?.type !== 'commit' ||
      typeof afterSha !== 'string' ||
      !SHA_PATTERN.test(afterSha)
    ) {
      throw new GitHubBaseResolutionError(
        'reference_invalid',
        'GitHub base reference response is invalid',
      );
    }
    const referenceDigest = await canonicalSha256({
      ref: referenceBody.ref,
      objectType: referenceObject.type,
      sha: afterSha,
    });
    return { headSha: afterSha, referenceDigest, headers };
  }
}

/** Scheduled producer that turns a GitHub-confirmed fast-forward into Plan re-analysis. */
export class GitHubBaseObservationReconciler {
  private readonly now: () => Date;

  constructor(
    private readonly db: D1Database,
    private readonly client: GitHubBaseExternalFactClient,
    options: GitHubBaseObservationReconcilerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async reconcileRun(runId: string): Promise<GitHubBaseReconciliationDisposition> {
    if (!ID_PATTERN.test(runId)) return 'not_found';
    const candidate = await this.candidate(runId);
    if (candidate === null) return 'not_found';
    if (!this.eligible(candidate)) {
      if (await this.hasConflict(runId)) return 'blocked';
      return await this.hasObservation(runId) ? 'duplicate' : 'not_found';
    }
    const observed = await this.client.observeBase(
      candidate.repository,
      candidate.base_branch,
      candidate.base_sha,
    );
    if (observed.disposition === 'unchanged') {
      return observed.headSha === candidate.base_sha ? 'unchanged' : 'stale';
    }
    if (observed.disposition === 'non_fast_forward') {
      if (
        observed.fact.repository !== candidate.repository ||
        observed.fact.baseBranch !== candidate.base_branch ||
        observed.fact.beforeSha !== candidate.base_sha
      ) return 'stale';
      try {
        await new GitHubBaseConflictStore(this.db).block({
          runId: candidate.run_id,
          expectedRunVersion: candidate.run_version,
          fact: observed.fact,
          observedAt: this.now().toISOString(),
        }, this.now());
        return 'blocked';
      } catch (error) {
        if (
          error instanceof GitHubBaseConflictError &&
          (error.code === 'state_conflict' || error.code === 'not_found')
        ) return await this.hasConflict(runId) ? 'blocked' : 'stale';
        throw error;
      }
    }
    if (
      observed.fact.repository !== candidate.repository ||
      observed.fact.baseBranch !== candidate.base_branch ||
      observed.fact.beforeSha !== candidate.base_sha
    ) return 'stale';
    try {
      const revision = await new PlanRevisionStore(this.db).beginFromBaseObservation({
        runId: candidate.run_id,
        expectedRunVersion: candidate.run_version,
        fact: observed.fact,
        observedAt: this.now().toISOString(),
      }, this.now());
      return revision.created ? 'replanning' : 'duplicate';
    } catch (error) {
      if (
        error instanceof PlanRevisionError &&
        (error.code === 'state_conflict' || error.code === 'not_found')
      ) return 'stale';
      throw error;
    }
  }

  async reconcileBatch(limit = 25): Promise<GitHubBaseBatchResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('GitHub base reconciliation limit must be between 1 and 100');
    }
    const candidates = await this.db.prepare(
      `SELECT runs.run_id
       FROM runs
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       WHERE runs.state IN (
         'awaiting_approval', 'executing', 'verifying', 'pull_request_open',
         'awaiting_review', 'ready_to_merge', 'blocked'
       )
         AND runs.base_sha IS NOT NULL
         AND plans.status = 'active' AND plans.base_sha = runs.base_sha
       ORDER BY runs.updated_at, runs.run_id
       LIMIT ?`,
    ).bind(limit).all<{ run_id: string }>();
    const results: GitHubBaseBatchResult[] = [];
    for (const candidate of candidates.results) {
      try {
        results.push({
          runId: candidate.run_id,
          disposition: await this.reconcileRun(candidate.run_id),
        });
      } catch {
        results.push({ runId: candidate.run_id, disposition: 'unavailable' });
      }
    }
    return results;
  }

  private async candidate(runId: string): Promise<CandidateRow | null> {
    return await this.db.prepare(
      `SELECT runs.run_id, runs.state AS run_state, runs.version AS run_version,
              runs.base_sha, runs.active_plan_id, runs.active_plan_version,
              runs.active_plan_digest, plans.status AS plan_status,
              plans.base_sha AS plan_base_sha,
              tasks.target_repository AS repository,
              tasks.target_base_branch AS base_branch
       FROM runs
       JOIN tasks ON tasks.task_id = runs.task_id
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       WHERE runs.run_id = ? AND runs.base_sha IS NOT NULL`,
    ).bind(runId).first<CandidateRow>();
  }

  private eligible(candidate: CandidateRow): boolean {
    return REPLAN_STATES.has(candidate.run_state) &&
      candidate.plan_status === 'active' &&
      candidate.plan_base_sha === candidate.base_sha &&
      REPOSITORY_PATTERN.test(candidate.repository) &&
      safeBranch(candidate.base_branch) &&
      SHA_PATTERN.test(candidate.base_sha);
  }

  private async hasObservation(runId: string): Promise<boolean> {
    return await this.db.prepare(
      'SELECT observation_id FROM github_base_observations WHERE run_id = ? LIMIT 1',
    ).bind(runId).first<{ observation_id: string }>() !== null;
  }

  private async hasConflict(runId: string): Promise<boolean> {
    return await this.db.prepare(
      'SELECT conflict_id FROM github_base_conflicts WHERE run_id = ? LIMIT 1',
    ).bind(runId).first<{ conflict_id: string }>() !== null;
  }
}
