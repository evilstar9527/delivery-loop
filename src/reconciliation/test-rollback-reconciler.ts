import {
  MAX_DELIVERY_POLICY_BYTES,
  DeliveryPolicyError,
  parseDeliveryPolicy,
  type ParsedDeliveryPolicy,
} from '../domain/delivery-policy.js';
import { GITHUB_API_USER_AGENT, githubApiFetch } from '../github-api.js';
import { testRollbackTargetFromPolicy } from '../domain/test-rollback.js';
import {
  TestRollbackStore,
  TestRollbackStoreError,
  type TestRollbackCandidate,
} from '../storage/test-rollback-store.js';

export interface GitHubDeliveryPolicyTokenProvider {
  getPolicyObservationToken(repository: string): Promise<string>;
}

export interface TestRollbackPolicyClient {
  getDeliveryPolicy(repository: string, refSha: string): Promise<ParsedDeliveryPolicy | null>;
}

export type GitHubDeliveryPolicyErrorCode = 'invalid_policy' | 'unavailable';

export class GitHubDeliveryPolicyError extends Error {
  constructor(readonly code: GitHubDeliveryPolicyErrorCode) {
    super(`GitHub delivery policy read failed: ${code}`);
    this.name = 'GitHubDeliveryPolicyError';
  }
}

export interface GitHubDeliveryPolicyApiClientOptions {
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
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

/** Reads only delivery.yaml at an exact SHA with a contents:read-only token. */
export class GitHubDeliveryPolicyApiClient implements TestRollbackPolicyClient {
  private readonly apiBaseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(
    private readonly tokens: GitHubDeliveryPolicyTokenProvider,
    options: GitHubDeliveryPolicyApiClientOptions = {},
  ) {
    this.apiBaseUrl = apiOrigin(options.apiBaseUrl ?? 'https://api.github.com');
    this.fetcher = githubApiFetch(options.fetch);
  }

  async getDeliveryPolicy(
    repository: string,
    refSha: string,
  ): Promise<ParsedDeliveryPolicy | null> {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      !/^[a-f0-9]{40}$/.test(refSha)
    ) throw new GitHubDeliveryPolicyError('invalid_policy');
    const token = await this.tokens.getPolicyObservationToken(repository);
    if (token.length < 1 || token.length > 2_000 || /[\0\r\n]/.test(token)) {
      throw new GitHubDeliveryPolicyError('unavailable');
    }
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.apiBaseUrl}/repos/${repository}/contents/delivery.yaml?ref=${refSha}`,
        {
          method: 'GET',
          headers: {
            accept: 'application/vnd.github.raw+json',
            authorization: `Bearer ${token}`,
            'user-agent': GITHUB_API_USER_AGENT,
            'x-github-api-version': '2022-11-28',
          },
          redirect: 'error',
        },
      );
    } catch {
      throw new GitHubDeliveryPolicyError('unavailable');
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new GitHubDeliveryPolicyError('unavailable');
    }
    const body = await response.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > MAX_DELIVERY_POLICY_BYTES) {
      throw new GitHubDeliveryPolicyError('invalid_policy');
    }
    try {
      return await parseDeliveryPolicy(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } catch (error) {
      if (error instanceof DeliveryPolicyError || error instanceof TypeError) {
        throw new GitHubDeliveryPolicyError('invalid_policy');
      }
      throw error;
    }
  }
}

export type TestRollbackReconciliationDisposition =
  | 'scheduled'
  | 'duplicate'
  | 'not_declared'
  | 'policy_missing'
  | 'policy_invalid'
  | 'unavailable';

export interface TestRollbackReconciliationResult {
  sourceKind: TestRollbackCandidate['sourceKind'];
  sourceId: string;
  disposition: TestRollbackReconciliationDisposition;
}

/** Converts verified test failures into a rollback only after exact-SHA policy observation. */
export class TestRollbackReconciler {
  constructor(
    private readonly db: D1Database,
    private readonly policies: TestRollbackPolicyClient,
    private readonly allowedRepositories: ReadonlySet<string>,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (allowedRepositories.size === 0) {
      throw new Error('test rollback repository allowlist must not be empty');
    }
  }

  async reconcileBatch(limit = 25): Promise<TestRollbackReconciliationResult[]> {
    const store = new TestRollbackStore(this.db);
    const candidates = await store.candidates(limit);
    const results: TestRollbackReconciliationResult[] = [];
    for (const candidate of candidates) {
      if (!this.allowedRepositories.has(candidate.repository)) {
        results.push({
          sourceKind: candidate.sourceKind,
          sourceId: candidate.sourceId,
          disposition: 'unavailable',
        });
        continue;
      }
      const input = {
        sourceKind: candidate.sourceKind,
        sourceId: candidate.sourceId,
        sourceEvidenceId: candidate.sourceEvidenceId,
        expectedRunVersion: candidate.runVersion,
      };
      try {
        const parsed = await this.policies.getDeliveryPolicy(
          candidate.repository,
          candidate.refSha,
        );
        if (parsed === null) {
          await store.recordNoContract(input, 'policy_missing', null, this.now());
          results.push({
            sourceKind: candidate.sourceKind,
            sourceId: candidate.sourceId,
            disposition: 'policy_missing',
          });
          continue;
        }
        const target = await testRollbackTargetFromPolicy(
          candidate.repository,
          candidate.sourceKind,
          parsed,
        );
        if (target === null) {
          await store.recordNoContract(input, 'not_declared', parsed.digest, this.now());
          results.push({
            sourceKind: candidate.sourceKind,
            sourceId: candidate.sourceId,
            disposition: 'not_declared',
          });
          continue;
        }
        const scheduled = await store.schedule(input, target, this.now());
        results.push({
          sourceKind: candidate.sourceKind,
          sourceId: candidate.sourceId,
          disposition: scheduled.created ? 'scheduled' : 'duplicate',
        });
      } catch (error) {
        if (error instanceof GitHubDeliveryPolicyError) {
          if (error.code === 'invalid_policy') {
            await store.recordNoContract(input, 'policy_invalid', null, this.now());
            results.push({
              sourceKind: candidate.sourceKind,
              sourceId: candidate.sourceId,
              disposition: 'policy_invalid',
            });
          } else {
            results.push({
              sourceKind: candidate.sourceKind,
              sourceId: candidate.sourceId,
              disposition: 'unavailable',
            });
          }
          continue;
        }
        if (error instanceof TestRollbackStoreError) {
          results.push({
            sourceKind: candidate.sourceKind,
            sourceId: candidate.sourceId,
            disposition: error.code === 'not_found' || error.code === 'state_conflict'
              ? 'duplicate'
              : 'unavailable',
          });
          continue;
        }
        throw error;
      }
    }
    return results;
  }
}
