import type { GitHubPullRequestTokenProvider } from '../outbox/github-pull-request.js';
import type { GitHubDeploymentTokenProvider } from '../outbox/github-test-deployment.js';
import type { GitHubProductionDeploymentTokenProvider } from '../outbox/github-production-deployment.js';
import type { GitHubProductionDeploymentObservationTokenProvider } from '../reconciliation/github-production-deployment-status-reconciler.js';
import type { GitHubTestDeploymentObservationTokenProvider } from '../reconciliation/github-test-deployment-status-reconciler.js';
import type { GitHubDeliveryPolicyTokenProvider } from '../reconciliation/test-rollback-reconciler.js';
import type { GitHubWriteCredentialProvider } from '../storage/repo-write-credential-store.js';
import type { GitHubBaseObservationTokenProvider } from '../reconciliation/github-base-observation-reconciler.js';
import type { GitHubMergeObservationTokenProvider } from '../reconciliation/github-merge-gate-reconciler.js';

const MAX_TOKEN_LENGTH = 2_000;
const WRITE_CREDENTIAL_LEASE_MS = 15 * 60_000;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface GitHubPatTokenProviderOptions {
  pat: string;
  allowedRepositories: readonly string[];
  /** Optional upstream PAT expiry. It is never extended by the control plane. */
  patExpiresAt?: string;
  now?: () => Date;
}

/** The single capability surface consumed by all GitHub adapters. */
export interface GitHubRepositoryTokenProvider extends
  GitHubBaseObservationTokenProvider,
  GitHubMergeObservationTokenProvider,
  GitHubPullRequestTokenProvider,
  GitHubDeploymentTokenProvider,
  GitHubProductionDeploymentTokenProvider,
  GitHubProductionDeploymentObservationTokenProvider,
  GitHubTestDeploymentObservationTokenProvider,
  GitHubDeliveryPolicyTokenProvider,
  GitHubWriteCredentialProvider {
  getInstallationToken(repository: string): Promise<string>;
  getDeploymentObservationToken?(repository: string): Promise<string>;
  getProductionDeploymentObservationToken(repository: string): Promise<string>;
  getAcceptanceToken?(repository: string): Promise<string>;
  getRollbackToken?(repository: string): Promise<string>;
  getRollbackObservationToken?(repository: string): Promise<string>;
}

function validateToken(token: string): string {
  if (
    typeof token !== 'string' || token.length < 1 || token.length > MAX_TOKEN_LENGTH ||
    /[\0\r\n]/.test(token)
  ) throw new Error('GitHub PAT is invalid');
  return token;
}

function parseExpiry(value: string | undefined, now: Date): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= now.getTime()) {
    throw new Error('GitHub PAT expiry is invalid');
  }
  return parsed;
}

/**
 * Personal access token provider. PATs are long-lived upstream credentials, so
 * this class only emulates the existing capability interface and never claims
 * to provide GitHub App installation-level permission isolation or revocation.
 */
export class GitHubPatTokenProvider implements GitHubRepositoryTokenProvider {
  readonly writeCredentialPersistence = 'provider_reference' as const;
  private readonly pat: string;
  private readonly allowedRepositories: ReadonlySet<string>;
  private readonly patExpiresAt: number | undefined;
  private readonly now: () => Date;

  constructor(options: GitHubPatTokenProviderOptions) {
    this.pat = validateToken(options.pat);
    if (options.allowedRepositories.length === 0) {
      throw new Error('GitHub repository allowlist must not be empty');
    }
    for (const repository of options.allowedRepositories) {
      if (!REPOSITORY_PATTERN.test(repository)) throw new Error('GitHub repository is invalid');
    }
    this.allowedRepositories = new Set(options.allowedRepositories);
    this.now = options.now ?? (() => new Date());
    this.patExpiresAt = parseExpiry(options.patExpiresAt, this.now());
  }

  async getInstallationToken(repository: string): Promise<string> {
    return this.token(repository);
  }

  async getPullRequestToken(repository: string): Promise<string> { return this.token(repository); }
  async getBaseObservationToken(repository: string): Promise<string> {
    return this.token(repository);
  }
  async getMergeObservationToken(repository: string): Promise<string> {
    return this.token(repository);
  }
  async getReviewObservationToken(repository: string): Promise<string> {
    return this.token(repository);
  }
  async getDeploymentToken(repository: string): Promise<string> { return this.token(repository); }
  async getTestDeploymentObservationToken(repository: string): Promise<string> {
    return this.token(repository);
  }
  async getDeploymentObservationToken(repository: string): Promise<string> {
    return this.token(repository);
  }
  async getProductionDeploymentToken(repository: string): Promise<string> {
    return this.token(repository);
  }
  async getProductionDeploymentObservationToken(repository: string): Promise<string> {
    return this.token(repository);
  }
  async getAcceptanceToken(repository: string): Promise<string> { return this.token(repository); }
  async getRollbackToken(repository: string): Promise<string> { return this.token(repository); }
  async getRollbackObservationToken(repository: string): Promise<string> {
    return this.token(repository);
  }
  async getPolicyObservationToken(repository: string): Promise<string> {
    return this.token(repository);
  }

  async issueWriteCredential(repository: string): Promise<{ token: string; expiresAt: string }> {
    const token = this.token(repository);
    const leaseExpiry = this.now().getTime() + WRITE_CREDENTIAL_LEASE_MS;
    const expiresAt = Math.min(leaseExpiry, this.patExpiresAt ?? leaseExpiry);
    if (expiresAt <= this.now().getTime()) throw new Error('GitHub PAT is expired');
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** GitHub cannot revoke a PAT through the App installation-token endpoint. */
  async revokeWriteCredential(token: string): Promise<void> {
    validateToken(token);
  }

  private token(repository: string): string {
    if (!this.allowedRepositories.has(repository)) {
      throw new Error('GitHub repository is not allowed');
    }
    if (this.patExpiresAt !== undefined && this.patExpiresAt <= this.now().getTime()) {
      throw new Error('GitHub PAT is expired');
    }
    return this.pat;
  }
}
