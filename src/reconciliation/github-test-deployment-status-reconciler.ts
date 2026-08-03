import { canonicalSha256 } from '../domain/digest.js';
import { GITHUB_API_USER_AGENT, githubApiFetch } from '../github-api.js';
import {
  GitHubTestDeploymentStatusStore,
  type GitHubTestDeploymentStatusDisposition,
  type GitHubTestDeploymentStatusFact,
} from '../storage/github-test-deployment-status-store.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface GitHubTestDeploymentObservationTokenProvider {
  getTestDeploymentObservationToken(repository: string): Promise<string>;
}

export interface GitHubTestDeploymentStatusRequest {
  deploymentId: string;
  repository: string;
  githubDeploymentId: string;
  refSha: string;
}

export interface GitHubTestDeploymentStatusExternalFactClient {
  getTestDeploymentStatus(
    request: GitHubTestDeploymentStatusRequest,
  ): Promise<GitHubTestDeploymentStatusFact | null>;
}

export interface GitHubTestDeploymentStatusApiClientOptions {
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

interface CandidateRow {
  deployment_id: string;
  run_id: string;
  repository: string;
  github_deployment_id: string;
  ref_sha: string;
}

export interface GitHubTestDeploymentStatusBatchResult {
  deploymentId: string;
  runId: string;
  disposition: GitHubTestDeploymentStatusDisposition | 'pending' | 'unavailable';
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

function githubId(value: unknown): string | null {
  if (typeof value === 'string' && /^[1-9][0-9]{0,31}$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  return null;
}

function normalizedDate(raw: unknown): string | null {
  if (typeof raw !== 'string' || !Number.isFinite(Date.parse(raw))) return null;
  return new Date(raw).toISOString();
}

function safeUrl(raw: unknown): string | null {
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 2_000) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function objectPayload(raw: unknown): Record<string, unknown> | null {
  return typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : null;
}

function validRequest(request: GitHubTestDeploymentStatusRequest): boolean {
  return ID_PATTERN.test(request.deploymentId) &&
    REPOSITORY_PATTERN.test(request.repository) &&
    /^[1-9][0-9]{0,31}$/.test(request.githubDeploymentId) &&
    SHA_PATTERN.test(request.refSha);
}

/** Read-only Deployments API adapter copied from the production-status shape. */
export class GitHubTestDeploymentStatusApiClient
implements GitHubTestDeploymentStatusExternalFactClient {
  private readonly apiBaseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly tokenProvider: GitHubTestDeploymentObservationTokenProvider,
    options: GitHubTestDeploymentStatusApiClientOptions = {},
  ) {
    this.apiBaseUrl = apiOrigin(options.apiBaseUrl ?? 'https://api.github.com');
    this.fetcher = githubApiFetch(options.fetch);
  }

  async getTestDeploymentStatus(
    request: GitHubTestDeploymentStatusRequest,
  ): Promise<GitHubTestDeploymentStatusFact | null> {
    if (!validRequest(request)) {
      throw new Error('GitHub test deployment status request is invalid');
    }
    const token = await this.tokenProvider.getTestDeploymentObservationToken(request.repository);
    if (token.length < 1 || token.length > 2_000 || /[\0\r\n]/.test(token)) {
      throw new Error('GitHub test deployment observation token is unavailable');
    }
    const headers = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': GITHUB_API_USER_AGENT,
      'x-github-api-version': '2022-11-28',
    };
    const deploymentPath =
      `/repos/${request.repository}/deployments/${request.githubDeploymentId}`;
    const deployment = await this.getJson(`${this.apiBaseUrl}${deploymentPath}`, headers);
    this.assertDeployment(deployment, request);
    const statuses = await this.getJson(
      `${this.apiBaseUrl}${deploymentPath}/statuses?per_page=100`,
      headers,
    );
    if (!Array.isArray(statuses) || statuses.length > 100) {
      throw new Error('GitHub test deployment status response is invalid');
    }
    const ordered = statuses.map((status) => {
      const body = objectPayload(status);
      const updatedAt = normalizedDate(body?.updated_at);
      if (body === null || updatedAt === null) {
        throw new Error('GitHub test deployment status response is invalid');
      }
      return { status, updatedAt };
    }).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return ordered[0] === undefined
      ? null
      : this.parseStatus(ordered[0].status, request, deploymentPath);
  }

  private async getJson(url: string, headers: Record<string, string>): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, { method: 'GET', headers });
    } catch {
      throw new Error('GitHub test deployment status query failed');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('GitHub test deployment status query failed');
    }
    if (/\brel\s*=\s*["']?next["']?/i.test(response.headers.get('link') ?? '')) {
      await response.body?.cancel();
      throw new Error('GitHub test deployment status response is invalid');
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new Error('GitHub test deployment status response is invalid');
    }
    if (response.body === null) throw new Error('GitHub test deployment status response is invalid');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('GitHub test deployment status response is invalid');
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new Error('GitHub test deployment status response is invalid');
    }
  }

  private assertDeployment(
    raw: unknown,
    request: GitHubTestDeploymentStatusRequest,
  ): void {
    const body = objectPayload(raw);
    const payload = objectPayload(body?.payload);
    if (
      body === null || githubId(body.id) !== request.githubDeploymentId ||
      body.sha !== request.refSha || body.task !== 'delivery-loop:test' ||
      body.environment !== 'test' || payload?.schema_version !== '1' ||
      payload.delivery_deployment_id !== request.deploymentId
    ) throw new Error('GitHub test deployment response is invalid');
  }

  private parseStatus(
    raw: unknown,
    request: GitHubTestDeploymentStatusRequest,
    deploymentPath: string,
  ): GitHubTestDeploymentStatusFact | null {
    const body = objectPayload(raw);
    if (body === null) throw new Error('GitHub test deployment status response is invalid');
    if (!['in_progress', 'success', 'failure', 'error'].includes(String(body.state))) {
      return null;
    }
    const updatedAt = normalizedDate(body.updated_at);
    const environmentUrl = safeUrl(body.environment_url);
    if (
      body.deployment_url !== `${this.apiBaseUrl}${deploymentPath}` ||
      body.environment !== 'test' || updatedAt === null ||
      (body.environment_url !== null && body.environment_url !== '' && environmentUrl === null)
    ) throw new Error('GitHub test deployment status response is invalid');
    return {
      repository: request.repository,
      githubDeploymentId: request.githubDeploymentId,
      deploymentId: request.deploymentId,
      sha: request.refSha,
      task: 'delivery-loop:test',
      environment: 'test',
      state: body.state as GitHubTestDeploymentStatusFact['state'],
      environmentUrl,
      externalUpdatedAt: updatedAt,
    };
  }
}

/** Repairs missed test deployment_status webhooks through the same projector. */
export class GitHubTestDeploymentStatusReconciler {
  constructor(
    private readonly db: D1Database,
    private readonly client: GitHubTestDeploymentStatusExternalFactClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcileDeployment(
    deploymentId: string,
  ): Promise<GitHubTestDeploymentStatusDisposition | 'pending' | 'not_found'> {
    if (!ID_PATTERN.test(deploymentId)) return 'not_found';
    const candidate = await this.candidate(deploymentId);
    if (candidate === null) return 'not_found';
    const fact = await this.client.getTestDeploymentStatus({
      deploymentId: candidate.deployment_id,
      repository: candidate.repository,
      githubDeploymentId: candidate.github_deployment_id,
      refSha: candidate.ref_sha,
    });
    if (fact === null) return 'pending';
    const factDigest = await canonicalSha256(fact);
    const identity = await canonicalSha256({
      source: 'github_api',
      deploymentId,
      factDigest,
    });
    return await new GitHubTestDeploymentStatusStore(this.db).applyApiObservation({
      observationId:
        `test_deploy_api_${identity.slice('sha256:'.length, 'sha256:'.length + 48)}`,
      factDigest,
      fact,
      observedAt: this.now().toISOString(),
    });
  }

  async reconcileBatch(limit = 25): Promise<GitHubTestDeploymentStatusBatchResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('test deployment status reconciliation limit is invalid');
    }
    const candidates = await this.db.prepare(
      `SELECT deployment_id, run_id FROM test_deployments
       WHERE status IN ('created_unverified', 'in_progress')
         AND github_deployment_id IS NOT NULL
       ORDER BY updated_at, deployment_id LIMIT ?`,
    ).bind(limit).all<{ deployment_id: string; run_id: string }>();
    const results: GitHubTestDeploymentStatusBatchResult[] = [];
    for (const candidate of candidates.results) {
      try {
        const disposition = await this.reconcileDeployment(candidate.deployment_id);
        if (disposition !== 'not_found') {
          results.push({
            deploymentId: candidate.deployment_id,
            runId: candidate.run_id,
            disposition,
          });
        }
      } catch {
        results.push({
          deploymentId: candidate.deployment_id,
          runId: candidate.run_id,
          disposition: 'unavailable',
        });
      }
    }
    return results;
  }

  private async candidate(deploymentId: string): Promise<CandidateRow | null> {
    return await this.db.prepare(
      `SELECT deployment_id, run_id, repository, github_deployment_id, ref_sha
       FROM test_deployments
       WHERE deployment_id = ? AND status IN ('created_unverified', 'in_progress')
         AND github_deployment_id IS NOT NULL`,
    ).bind(deploymentId).first<CandidateRow>();
  }
}
