import { canonicalSha256 } from '../domain/digest.js';
import { GITHUB_API_USER_AGENT, githubApiFetch } from '../github-api.js';
import {
  GitHubMergeGateFactSchema,
  type GitHubMergeGateFact,
  type GitHubRequiredCheckFact,
} from '../domain/github-merge-gate.js';
import {
  MergeGateError,
  MergeGateStore,
  type MergeGateEvaluationResult,
} from '../storage/merge-gate-store.js';
import type { GitHubReviewFeedbackFact } from '../storage/github-review-feedback-store.js';
import type {
  GitHubReviewFeedbackObservationRequest,
} from './github-review-feedback-reconciler.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const PASSING_CHECK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const CHECK_CONCLUSIONS = new Set([
  'action_required', 'cancelled', 'failure', 'neutral', 'skipped',
  'stale', 'startup_failure', 'success', 'timed_out',
]);
const MERGE_STATES = new Set([
  'clean', 'blocked', 'behind', 'dirty', 'draft', 'has_hooks',
  'unstable', 'unknown',
]);

export interface GitHubMergeObservationTokenProvider {
  getMergeObservationToken(repository: string): Promise<string>;
  getReviewObservationToken?(repository: string): Promise<string>;
}

export interface GitHubMergeGateApiClientOptions {
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export interface GitHubMergeGateObservationRequest {
  repository: string;
  number: number;
  headBranch: string;
  baseBranch: string;
}

export interface GitHubApprovalReviewFact {
  id: string;
  login: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  commitId: string;
  submittedAt: string;
}

export interface GitHubApprovalIdentityFact {
  repository: string;
  number: number;
  authorLogin: string;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  reviews: GitHubApprovalReviewFact[];
}

export interface GitHubMergeGateExternalFactClient {
  observeMergeGate(request: GitHubMergeGateObservationRequest): Promise<GitHubMergeGateFact>;
}

export type GitHubMergeGateReconciliationResult =
  | MergeGateEvaluationResult
  | { disposition: 'not_found' | 'stale' };

export interface GitHubMergeGateBatchResult {
  runId: string;
  result: GitHubMergeGateReconciliationResult | { disposition: 'unavailable' };
}

export interface GitHubMergeGateReconcilerOptions {
  now?: () => Date;
}

interface CandidateRow {
  run_id: string;
  run_version: number;
  repository: string;
  github_pr_number: number;
  head_branch: string;
  base_branch: string;
}

interface RequiredCheckDefinition {
  context: string;
  integrationId: number | null;
}

interface CheckRun {
  name: string;
  integrationId: number | null;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
}

interface CommitStatus {
  context: string;
  state: 'error' | 'failure' | 'pending' | 'success';
}

interface Review {
  id: string;
  login: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  commitId: string;
  submittedAt: string;
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
    url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')
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

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function safePositiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function safeText(value: unknown, maximum = 255): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum &&
    !/[\0\r\n]/.test(value) ? value : null;
}

function sanitizedHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function responseJson(response: Response, operation: string): Promise<unknown> {
  if (
    response.status !== 200 ||
    /\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')
  ) {
    await response.body?.cancel();
    throw new Error(`${operation} failed`);
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error(`${operation} response is invalid`);
  }
  let text: string;
  try {
    if (response.body === null) {
      text = '';
    } else {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error('response too large');
        }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      text = new TextDecoder().decode(bytes);
    }
  } catch {
    throw new Error(`${operation} response is invalid`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${operation} response is invalid`);
  }
}

/** Read-only GitHub adapter for the complete pre-merge fact set. */
export class GitHubMergeGateApiClient implements GitHubMergeGateExternalFactClient {
  private readonly apiBaseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(
    private readonly tokenProvider: GitHubMergeObservationTokenProvider,
    options: GitHubMergeGateApiClientOptions = {},
  ) {
    this.apiBaseUrl = apiOrigin(options.apiBaseUrl ?? 'https://api.github.com');
    this.fetcher = githubApiFetch(options.fetch);
  }

  async observeMergeGate(request: GitHubMergeGateObservationRequest): Promise<GitHubMergeGateFact> {
    if (
      !REPOSITORY_PATTERN.test(request.repository) ||
      !Number.isSafeInteger(request.number) || request.number <= 0 ||
      !safeBranch(request.headBranch) || !safeBranch(request.baseBranch)
    ) throw new Error('GitHub merge observation request is invalid');
    const token = await this.tokenProvider.getMergeObservationToken(request.repository);
    if (token.length < 1 || token.length > 2_000 || /[\0\r\n]/.test(token)) {
      throw new Error('GitHub merge observation token is unavailable');
    }
    const headers = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': GITHUB_API_USER_AGENT,
      'x-github-api-version': '2022-11-28',
    };
    const repositoryUrl = `${this.apiBaseUrl}/repos/${request.repository}`;
    const pullRequest = object(await this.getJson(
      `${repositoryUrl}/pulls/${request.number}`,
      headers,
      'GitHub pull request merge query',
    ));
    const head = object(pullRequest?.head);
    const base = object(pullRequest?.base);
    const headRepository = object(head?.repo)?.full_name;
    const baseRepository = object(base?.repo)?.full_name;
    const pullRequestAuthorLogin = object(pullRequest?.user)?.login;
    const headSha = head?.sha;
    const pullRequestBaseSha = base?.sha;
    const externalUpdatedAt = pullRequest?.updated_at;
    const mergeable = pullRequest?.mergeable;
    const mergeState = pullRequest?.mergeable_state;
    if (
      (pullRequest?.state !== 'open' && pullRequest?.state !== 'closed') ||
      typeof pullRequest.draft !== 'boolean' ||
      (mergeable !== true && mergeable !== false && mergeable !== null) ||
      typeof mergeState !== 'string' || !MERGE_STATES.has(mergeState) ||
      head?.ref !== request.headBranch || base?.ref !== request.baseBranch ||
      headRepository !== request.repository || baseRepository !== request.repository ||
      typeof pullRequestAuthorLogin !== 'string' ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(pullRequestAuthorLogin) ||
      typeof headSha !== 'string' || !SHA_PATTERN.test(headSha) ||
      typeof pullRequestBaseSha !== 'string' || !SHA_PATTERN.test(pullRequestBaseSha) ||
      typeof externalUpdatedAt !== 'string' || !Number.isFinite(Date.parse(externalUpdatedAt))
    ) throw new Error('GitHub pull request merge query response is invalid');

    const encodedBase = request.baseBranch.split('/').map(encodeURIComponent).join('/');
    const reference = object(await this.getJson(
      `${repositoryUrl}/git/ref/heads/${encodedBase}`,
      headers,
      'GitHub merge base reference query',
    ));
    const referenceObject = object(reference?.object);
    const baseSha = referenceObject?.sha;
    if (
      reference?.ref !== `refs/heads/${request.baseBranch}` ||
      referenceObject?.type !== 'commit' ||
      typeof baseSha !== 'string' || !SHA_PATTERN.test(baseSha)
    ) throw new Error('GitHub merge base reference response is invalid');

    const rulesRaw = await this.getJson(
      `${repositoryUrl}/rules/branches/${encodedBase}`,
      headers,
      'GitHub merge rules query',
    );
    const { checks: requiredCheckDefinitions, requiredApprovals } = this.rules(rulesRaw);
    const checkRunsRaw = await this.getJson(
      `${repositoryUrl}/commits/${headSha}/check-runs?filter=latest&per_page=100`,
      headers,
      'GitHub merge check runs query',
    );
    const statusesRaw = await this.getJson(
      `${repositoryUrl}/commits/${headSha}/status?per_page=100`,
      headers,
      'GitHub merge commit statuses query',
    );
    const reviewsRaw = await this.getJson(
      `${repositoryUrl}/pulls/${request.number}/reviews?per_page=100`,
      headers,
      'GitHub merge reviews query',
    );
    const checkRuns = this.checkRuns(checkRunsRaw);
    const statuses = this.statuses(statusesRaw);
    const requiredChecks = requiredCheckDefinitions.map((definition) =>
      this.resolveRequiredCheck(definition, checkRuns, statuses));
    const reviews = this.reviews(reviewsRaw);
    const latestReviews = this.latestReviews(reviews, headSha);
    const approvedReviewCount = latestReviews.filter((review) => review.state === 'APPROVED').length;
    const reviewDecision = latestReviews.some((review) => review.state === 'CHANGES_REQUESTED')
      ? 'changes_requested'
      : requiredApprovals > 0 && approvedReviewCount >= requiredApprovals
        ? 'approved'
        : 'review_required';
    const policyDigest = await canonicalSha256({
      requiredChecks: requiredCheckDefinitions,
      requiredApprovals,
    });
    const checksDigest = await canonicalSha256(requiredChecks);
    const reviewsDigest = await canonicalSha256(latestReviews);
    return GitHubMergeGateFactSchema.parse({
      schemaVersion: '1',
      repository: request.repository,
      number: request.number,
      pullRequestAuthorLogin,
      headBranch: request.headBranch,
      headSha,
      baseBranch: request.baseBranch,
      baseSha,
      pullRequestBaseSha,
      state: pullRequest.state,
      draft: pullRequest.draft,
      mergeability: mergeable === true
        ? 'mergeable'
        : mergeable === false ? 'conflicting' : 'unknown',
      mergeState,
      reviewDecision,
      requiredApprovals,
      approvedReviewCount,
      requiredChecks,
      policyDigest,
      checksDigest,
      reviewsDigest,
      externalUpdatedAt: new Date(externalUpdatedAt).toISOString(),
    });
  }

  /** Read-only compensation source for a missed exact-head review webhook. */
  async observeReviewFeedback(
    request: GitHubReviewFeedbackObservationRequest,
  ): Promise<GitHubReviewFeedbackFact[]> {
    if (
      !REPOSITORY_PATTERN.test(request.repository) ||
      !Number.isSafeInteger(request.number) || request.number <= 0 ||
      !safeBranch(request.headBranch) || !safeBranch(request.baseBranch)
    ) throw new Error('GitHub review feedback request is invalid');
    const token = await (this.tokenProvider.getReviewObservationToken?.(request.repository) ??
      this.tokenProvider.getMergeObservationToken(request.repository));
    if (token.length < 1 || token.length > 2_000 || /[\0\r\n]/.test(token)) {
      throw new Error('GitHub review feedback token is unavailable');
    }
    const headers = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': GITHUB_API_USER_AGENT,
      'x-github-api-version': '2022-11-28',
    };
    const repositoryUrl = `${this.apiBaseUrl}/repos/${request.repository}`;
    const pullRequest = object(await this.getJson(
      `${repositoryUrl}/pulls/${request.number}`,
      headers,
      'GitHub review feedback PR query',
    ));
    const head = object(pullRequest?.head);
    const base = object(pullRequest?.base);
    const headSha = head?.sha;
    if (
      pullRequest?.state !== 'open' ||
      head?.ref !== request.headBranch || base?.ref !== request.baseBranch ||
      object(head?.repo)?.full_name !== request.repository ||
      object(base?.repo)?.full_name !== request.repository ||
      typeof headSha !== 'string' || !SHA_PATTERN.test(headSha)
    ) throw new Error('GitHub review feedback PR response is invalid');

    const rawReviews = await this.getJson(
      `${repositoryUrl}/pulls/${request.number}/reviews?per_page=100`,
      headers,
      'GitHub review feedback reviews query',
    );
    if (!Array.isArray(rawReviews) || rawReviews.length >= 100) {
      throw new Error('GitHub review feedback reviews response is invalid');
    }
    const latest = new Map<string, {
      fact: GitHubReviewFeedbackFact;
      state: string;
    }>();
    for (const raw of rawReviews) {
      const row = object(raw);
      const idRaw = row?.id;
      const reviewId = typeof idRaw === 'number' && Number.isSafeInteger(idRaw) && idRaw > 0
        ? String(idRaw)
        : typeof idRaw === 'string' && /^[0-9]+$/.test(idRaw) ? idRaw : null;
      const login = safeText(object(row?.user)?.login, 100);
      const state = row?.state;
      const commitId = row?.commit_id;
      const submittedAt = row?.submitted_at;
      const body = row?.body;
      const url = sanitizedHttpsUrl(row?.html_url);
      if (
        reviewId === null || login === null ||
        (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED' &&
          state !== 'COMMENTED' && state !== 'DISMISSED') ||
        typeof commitId !== 'string' || !SHA_PATTERN.test(commitId) ||
        typeof submittedAt !== 'string' || !Number.isFinite(Date.parse(submittedAt)) ||
        (state === 'CHANGES_REQUESTED' && (
          typeof body !== 'string' || body.trim().length === 0 ||
          new TextEncoder().encode(body).length > 65_536 ||
          url === null
        ))
      ) throw new Error('GitHub review feedback reviews response is invalid');
      if (commitId !== headSha) continue;
      const normalizedSubmittedAt = new Date(submittedAt).toISOString();
      const fact: GitHubReviewFeedbackFact = {
        repository: request.repository,
        number: request.number,
        reviewId,
        body: typeof body === 'string' ? body : '',
        bodyDigest: await canonicalSha256(typeof body === 'string' ? body : ''),
        sourceHeadSha: headSha,
        branch: request.headBranch,
        baseBranch: request.baseBranch,
        url: url ?? 'https://github.com/',
        submittedAt: normalizedSubmittedAt,
      };
      const current = latest.get(login);
      if (
        current === undefined || fact.submittedAt > current.fact.submittedAt ||
        (fact.submittedAt === current.fact.submittedAt && fact.reviewId > current.fact.reviewId)
      ) latest.set(login, { fact, state });
    }
    return [...latest.values()]
      .filter((entry) => entry.state === 'CHANGES_REQUESTED')
      .map((entry) => entry.fact)
      .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt) ||
        left.reviewId.localeCompare(right.reviewId));
  }

  /** Read-only actor fact for identity-bound approval evidence; no write scope or mutation. */
  async observeApprovalIdentity(
    request: GitHubMergeGateObservationRequest,
  ): Promise<GitHubApprovalIdentityFact> {
    if (
      !REPOSITORY_PATTERN.test(request.repository) ||
      !Number.isSafeInteger(request.number) || request.number <= 0 ||
      !safeBranch(request.headBranch) || !safeBranch(request.baseBranch)
    ) throw new Error('GitHub approval identity request is invalid');
    const token = await this.tokenProvider.getMergeObservationToken(request.repository);
    if (token.length < 1 || token.length > 2_000 || /[\0\r\n]/.test(token)) {
      throw new Error('GitHub approval identity token is unavailable');
    }
    const headers = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': GITHUB_API_USER_AGENT,
      'x-github-api-version': '2022-11-28',
    };
    const repositoryUrl = `${this.apiBaseUrl}/repos/${request.repository}`;
    const pullRequest = object(await this.getJson(
      `${repositoryUrl}/pulls/${request.number}`,
      headers,
      'GitHub approval identity PR query',
    ));
    const head = object(pullRequest?.head);
    const base = object(pullRequest?.base);
    const headRepository = object(head?.repo)?.full_name;
    const baseRepository = object(base?.repo)?.full_name;
    const authorLogin = object(pullRequest?.user)?.login;
    const headSha = head?.sha;
    if (
      head?.ref !== request.headBranch || base?.ref !== request.baseBranch ||
      headRepository !== request.repository || baseRepository !== request.repository ||
      typeof authorLogin !== 'string' ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(authorLogin) ||
      typeof headSha !== 'string' || !SHA_PATTERN.test(headSha) ||
      pullRequest?.state !== 'open'
    ) throw new Error('GitHub approval identity PR response is invalid');
    const reviews = this.reviews(await this.getJson(
      `${repositoryUrl}/pulls/${request.number}/reviews?per_page=100`,
      headers,
      'GitHub approval identity reviews query',
    ));
    return {
      repository: request.repository,
      number: request.number,
      authorLogin,
      headBranch: request.headBranch,
      baseBranch: request.baseBranch,
      headSha,
      reviews,
    };
  }

  private async getJson(
    url: string,
    headers: Record<string, string>,
    operation: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, { method: 'GET', headers });
    } catch {
      throw new Error(`${operation} failed`);
    }
    return await responseJson(response, operation);
  }

  private rules(input: unknown): { checks: RequiredCheckDefinition[]; requiredApprovals: number } {
    if (!Array.isArray(input) || input.length > 100) {
      throw new Error('GitHub merge rules response is invalid');
    }
    const checks = new Map<string, RequiredCheckDefinition>();
    let requiredApprovals = 0;
    for (const rawRule of input) {
      const rule = object(rawRule);
      const parameters = object(rule?.parameters);
      if (rule?.type === 'required_status_checks') {
        const required = parameters?.required_status_checks;
        if (!Array.isArray(required) || required.length > 100) {
          throw new Error('GitHub merge rules response is invalid');
        }
        for (const rawCheck of required) {
          const check = object(rawCheck);
          const context = safeText(check?.context);
          const integrationId = check?.integration_id === null
            ? null
            : safePositiveInteger(check?.integration_id);
          if (context === null || (check?.integration_id !== null && integrationId === null)) {
            throw new Error('GitHub merge rules response is invalid');
          }
          checks.set(`${context}\0${integrationId ?? ''}`, { context, integrationId });
        }
      }
      if (rule?.type === 'pull_request') {
        const count = safeInteger(parameters?.required_approving_review_count);
        if (count === null || count > 100) {
          throw new Error('GitHub merge rules response is invalid');
        }
        requiredApprovals = Math.max(requiredApprovals, count);
      }
    }
    return {
      checks: [...checks.values()].sort((left, right) =>
        `${left.context}\0${left.integrationId ?? ''}`.localeCompare(
          `${right.context}\0${right.integrationId ?? ''}`,
        )),
      requiredApprovals,
    };
  }

  private checkRuns(input: unknown): CheckRun[] {
    const body = object(input);
    const totalCount = safeInteger(body?.total_count);
    const rows = body?.check_runs;
    if (
      totalCount === null || !Array.isArray(rows) || rows.length > 100 ||
      totalCount !== rows.length
    ) throw new Error('GitHub merge check runs response is invalid');
    return rows.map((raw): CheckRun => {
      const row = object(raw);
      const name = safeText(row?.name);
      const status = row?.status;
      const conclusion = row?.conclusion;
      const integrationId = object(row?.app)?.id === null
        ? null
        : safePositiveInteger(object(row?.app)?.id);
      if (
        name === null ||
        (status !== 'queued' && status !== 'in_progress' && status !== 'completed') ||
        (conclusion !== null && (typeof conclusion !== 'string' ||
          !CHECK_CONCLUSIONS.has(conclusion))) ||
        (status === 'completed' && conclusion === null) ||
        (status !== 'completed' && conclusion !== null) ||
        integrationId === null
      ) throw new Error('GitHub merge check runs response is invalid');
      return { name, integrationId, status, conclusion };
    });
  }

  private statuses(input: unknown): CommitStatus[] {
    const rows = object(input)?.statuses;
    if (!Array.isArray(rows) || rows.length > 100) {
      throw new Error('GitHub merge commit statuses response is invalid');
    }
    const latest = new Map<string, CommitStatus>();
    for (const raw of rows) {
      const row = object(raw);
      const context = safeText(row?.context);
      const state = row?.state;
      if (
        context === null ||
        (state !== 'error' && state !== 'failure' && state !== 'pending' && state !== 'success')
      ) throw new Error('GitHub merge commit statuses response is invalid');
      if (!latest.has(context)) latest.set(context, { context, state });
    }
    return [...latest.values()];
  }

  private reviews(input: unknown): Review[] {
    if (!Array.isArray(input) || input.length >= 100) {
      throw new Error('GitHub merge reviews response is invalid');
    }
    return input.map((raw): Review => {
      const row = object(raw);
      const idRaw = row?.id;
      const id = typeof idRaw === 'number' && Number.isSafeInteger(idRaw) && idRaw > 0
        ? String(idRaw)
        : typeof idRaw === 'string' && /^[0-9]+$/.test(idRaw) ? idRaw : null;
      const login = safeText(object(row?.user)?.login, 100);
      const state = row?.state;
      const commitId = row?.commit_id;
      const submittedAt = row?.submitted_at;
      if (
        id === null || login === null ||
        (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED' &&
          state !== 'COMMENTED' && state !== 'DISMISSED') ||
        typeof commitId !== 'string' || !SHA_PATTERN.test(commitId) ||
        typeof submittedAt !== 'string' || !Number.isFinite(Date.parse(submittedAt))
      ) throw new Error('GitHub merge reviews response is invalid');
      return {
        id,
        login,
        state,
        commitId,
        submittedAt: new Date(submittedAt).toISOString(),
      };
    });
  }

  private latestReviews(reviews: readonly Review[], headSha: string): Review[] {
    const latest = new Map<string, Review>();
    for (const review of reviews) {
      if (review.commitId !== headSha) continue;
      const current = latest.get(review.login);
      if (
        current === undefined || review.submittedAt > current.submittedAt ||
        (review.submittedAt === current.submittedAt && review.id > current.id)
      ) latest.set(review.login, review);
    }
    return [...latest.values()].sort((left, right) => left.login.localeCompare(right.login));
  }

  private resolveRequiredCheck(
    definition: RequiredCheckDefinition,
    checkRuns: readonly CheckRun[],
    statuses: readonly CommitStatus[],
  ): GitHubRequiredCheckFact {
    const matchingRuns = checkRuns.filter((run) =>
      run.name === definition.context &&
      (definition.integrationId === null || run.integrationId === definition.integrationId));
    const matchingStatuses = definition.integrationId === null
      ? statuses.filter((status) => status.context === definition.context)
      : [];
    const states = [
      ...matchingRuns.map((run): GitHubRequiredCheckFact['state'] =>
        run.status !== 'completed'
          ? 'pending'
          : PASSING_CHECK_CONCLUSIONS.has(run.conclusion ?? '') ? 'passed' : 'failed'),
      ...matchingStatuses.map((status): GitHubRequiredCheckFact['state'] =>
        status.state === 'success' ? 'passed'
          : status.state === 'pending' ? 'pending' : 'failed'),
    ];
    const state: GitHubRequiredCheckFact['state'] = states.includes('passed')
      ? 'passed'
      : states.includes('pending') ? 'pending'
        : states.includes('failed') ? 'failed' : 'missing';
    return { ...definition, state };
  }
}

/** Scheduled coordinator; external reads may repeat, D1 decisions converge. */
export class GitHubMergeGateReconciler {
  private readonly now: () => Date;

  constructor(
    private readonly db: D1Database,
    private readonly client: GitHubMergeGateExternalFactClient,
    options: GitHubMergeGateReconcilerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async reconcileRun(runId: string): Promise<GitHubMergeGateReconciliationResult> {
    if (!ID_PATTERN.test(runId)) return { disposition: 'not_found' };
    const candidate = await this.candidate(runId);
    if (candidate === null) {
      return await this.hasDecision(runId)
        ? await this.duplicate(runId)
        : { disposition: 'not_found' };
    }
    const fact = await this.client.observeMergeGate({
      repository: candidate.repository,
      number: candidate.github_pr_number,
      headBranch: candidate.head_branch,
      baseBranch: candidate.base_branch,
    });
    try {
      return await new MergeGateStore(this.db).evaluate({
        runId,
        expectedRunVersion: candidate.run_version,
        fact,
        observedAt: this.now().toISOString(),
      }, this.now());
    } catch (error) {
      if (error instanceof MergeGateError && error.code === 'state_conflict') {
        return await this.hasDecision(runId)
          ? await this.duplicate(runId)
          : { disposition: 'stale' };
      }
      throw error;
    }
  }

  async reconcileBatch(limit = 25): Promise<GitHubMergeGateBatchResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('GitHub merge gate reconciliation limit must be between 1 and 100');
    }
    const rows = await this.db.prepare(
      `SELECT DISTINCT runs.run_id
       FROM runs
       JOIN pull_request_publications AS publications ON publications.run_id = runs.run_id
       WHERE runs.state IN ('pull_request_open', 'awaiting_review')
         AND publications.status = 'verified'
       ORDER BY runs.updated_at, runs.run_id LIMIT ?`,
    ).bind(limit).all<{ run_id: string }>();
    const results: GitHubMergeGateBatchResult[] = [];
    for (const row of rows.results) {
      try {
        results.push({ runId: row.run_id, result: await this.reconcileRun(row.run_id) });
      } catch {
        results.push({ runId: row.run_id, result: { disposition: 'unavailable' } });
      }
    }
    return results;
  }

  private async candidate(runId: string): Promise<CandidateRow | null> {
    return await this.db.prepare(
      `SELECT runs.run_id, runs.version AS run_version,
              publications.repository, publications.github_pr_number,
              publications.head_branch, publications.base_branch
       FROM runs
       JOIN execution_plans AS plans ON plans.plan_id = runs.active_plan_id
       JOIN pull_request_publications AS publications ON publications.run_id = runs.run_id
       WHERE runs.run_id = ? AND runs.state IN ('pull_request_open', 'awaiting_review')
         AND plans.status = 'active' AND publications.status = 'verified'
         AND publications.github_pr_number IS NOT NULL
       ORDER BY publications.updated_at DESC, publications.publication_id DESC LIMIT 1`,
    ).bind(runId).first<CandidateRow>();
  }

  private async hasDecision(runId: string): Promise<boolean> {
    return await this.db.prepare(
      'SELECT decision_id FROM merge_gate_decisions WHERE run_id = ? LIMIT 1',
    ).bind(runId).first<{ decision_id: string }>() !== null;
  }

  private async duplicate(runId: string): Promise<{
    disposition: 'duplicate';
    decisionId: string;
    observationId: string;
    evaluationId: string;
    runVersion: number;
  }> {
    const row = await this.db.prepare(
      `SELECT decision_id, observation_id, evaluation_id, run_version
       FROM merge_gate_decisions WHERE run_id = ?
       ORDER BY created_at DESC, decision_id DESC LIMIT 1`,
    ).bind(runId).first<{
      decision_id: string;
      observation_id: string;
      evaluation_id: string;
      run_version: number;
    }>();
    if (row === null) throw new Error('merge gate decision projection is unavailable');
    return {
      disposition: 'duplicate',
      decisionId: row.decision_id,
      observationId: row.observation_id,
      evaluationId: row.evaluation_id,
      runVersion: row.run_version + 1,
    };
  }
}
