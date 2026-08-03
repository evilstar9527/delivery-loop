import { importPKCS8, SignJWT } from 'jose';
import type { GitHubInstallationTokenProvider } from '../outbox/github-dispatcher.js';
import type { GitHubPullRequestTokenProvider } from '../outbox/github-pull-request.js';
import type { GitHubDeploymentTokenProvider } from '../outbox/github-test-deployment.js';
import type { GitHubProductionDeploymentTokenProvider } from '../outbox/github-production-deployment.js';
import type { GitHubProductionDeploymentObservationTokenProvider } from '../reconciliation/github-production-deployment-status-reconciler.js';
import type { GitHubTestDeploymentObservationTokenProvider } from '../reconciliation/github-test-deployment-status-reconciler.js';
import type { GitHubDeliveryPolicyTokenProvider } from '../reconciliation/test-rollback-reconciler.js';
import type { GitHubWriteCredentialProvider } from '../storage/repo-write-credential-store.js';
import {
  classifySafeTransportFailure,
  type SafeTransportFailureKind,
} from '../security/transport-error.js';

const TOKEN_REFRESH_SKEW_MS = 60_000;
const INSTALLATION_TOKEN_REQUEST_TIMEOUT_MS = 10_000;
const PEM_EDGE = '-----';
const PKCS1_BEGIN = `${PEM_EDGE}BEGIN RSA PRIVATE KEY${PEM_EDGE}`;
const PKCS1_END = `${PEM_EDGE}END RSA PRIVATE KEY${PEM_EDGE}`;
const PKCS8_BEGIN = `${PEM_EDGE}BEGIN PRIVATE KEY${PEM_EDGE}`;
const PKCS8_END = `${PEM_EDGE}END PRIVATE KEY${PEM_EDGE}`;
const RSA_ALGORITHM_IDENTIFIER = Uint8Array.from([
  0x30, 0x0d,
  0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
]);

export const GITHUB_APP_CREDENTIAL_ERROR_CODES = [
  'credential_signing_unavailable',
  'credential_auth_rejected',
  'credential_installation_not_found',
  'credential_policy_rejected',
  'credential_request_invalid',
  'credential_transport_unavailable',
  'credential_upstream_unavailable',
  'credential_response_invalid',
] as const;

export type GitHubAppCredentialErrorCode =
  typeof GITHUB_APP_CREDENTIAL_ERROR_CODES[number];

/** Fixed diagnostic stage with no private key, JWT, response body, or raw error detail. */
export class GitHubAppCredentialError extends Error {
  constructor(readonly code: GitHubAppCredentialErrorCode) {
    super(`GitHub App credential failed: ${code}`);
    this.name = 'GitHubAppCredentialError';
  }
}

function credentialFailure(code: GitHubAppCredentialErrorCode): never {
  throw new GitHubAppCredentialError(code);
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

function derLength(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) {
    credentialFailure('credential_signing_unavailable');
  }
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 0x100);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function decodePemBody(pem: string, begin: string, end: string): Uint8Array {
  const start = pem.indexOf(begin);
  const finish = pem.indexOf(end);
  if (start !== 0 || finish <= begin.length || pem.indexOf(begin, 1) !== -1) {
    credentialFailure('credential_signing_unavailable');
  }
  const suffix = pem.slice(finish + end.length).trim();
  const body = pem.slice(begin.length, finish).replaceAll(/\s/g, '');
  if (suffix !== '' || body === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
    credentialFailure('credential_signing_unavailable');
  }
  let binary: string;
  try {
    binary = atob(body);
  } catch {
    credentialFailure('credential_signing_unavailable');
  }
  if (binary.length < 64 || binary.length > 16_384) {
    credentialFailure('credential_signing_unavailable');
  }
  return Uint8Array.from(binary, (value) => value.charCodeAt(0));
}

function encodePem(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g);
  if (lines === null) credentialFailure('credential_signing_unavailable');
  return `${PKCS8_BEGIN}\n${lines.join('\n')}\n${PKCS8_END}`;
}

function normalizePrivateKeyPem(input: string): string {
  const pem = input.trim();
  if (pem.length < 100 || pem.length > 20_000) {
    credentialFailure('credential_signing_unavailable');
  }
  if (pem.startsWith(PKCS8_BEGIN)) {
    decodePemBody(pem, PKCS8_BEGIN, PKCS8_END);
    return pem;
  }
  if (!pem.startsWith(PKCS1_BEGIN)) {
    credentialFailure('credential_signing_unavailable');
  }
  const pkcs1 = decodePemBody(pem, PKCS1_BEGIN, PKCS1_END);
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const privateKey = concatBytes(Uint8Array.of(0x04), derLength(pkcs1.length), pkcs1);
  const body = concatBytes(version, RSA_ALGORITHM_IDENTIFIER, privateKey);
  return encodePem(concatBytes(Uint8Array.of(0x30), derLength(body.length), body));
}

export interface GitHubAppInstallationTokenProviderOptions {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  allowedRepositories: readonly string[];
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  transportDiagnostic?: (record: GitHubAppCredentialTransportDiagnostic) => void;
}

export interface GitHubAppCredentialTransportDiagnostic {
  schemaVersion: '1';
  event: 'github_app_installation_token_transport_failed';
  operation: 'installation_token_exchange';
  failureKind: SafeTransportFailureKind;
  requestAttempts: 1;
}

function numericId(value: string, label: string): string {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
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

function repositoryName(repository: string): string {
  const match = repository.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (match?.[2] === undefined) throw new Error('GitHub repository is invalid');
  return match[2];
}

/** GitHub App JWT -> repository-narrowed, short-lived installation token. */
export class GitHubAppInstallationTokenProvider implements
  GitHubInstallationTokenProvider,
  GitHubPullRequestTokenProvider,
  GitHubDeploymentTokenProvider,
  GitHubProductionDeploymentTokenProvider,
  GitHubProductionDeploymentObservationTokenProvider,
  GitHubTestDeploymentObservationTokenProvider,
  GitHubDeliveryPolicyTokenProvider,
  GitHubWriteCredentialProvider {
  private readonly appId: string;
  private readonly installationId: string;
  private readonly privateKeyPem: string;
  private readonly allowedRepositories: ReadonlySet<string>;
  private readonly apiBaseUrl: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly transportDiagnostic:
    ((record: GitHubAppCredentialTransportDiagnostic) => void) | undefined;
  private readonly cache = new Map<string, CachedToken>();
  private readonly pending = new Map<string, Promise<string>>();
  private readonly pullRequestCache = new Map<string, CachedToken>();
  private readonly pullRequestPending = new Map<string, Promise<string>>();
  private readonly baseObservationCache = new Map<string, CachedToken>();
  private readonly baseObservationPending = new Map<string, Promise<string>>();
  private readonly mergeObservationCache = new Map<string, CachedToken>();
  private readonly mergeObservationPending = new Map<string, Promise<string>>();
  private readonly deploymentCache = new Map<string, CachedToken>();
  private readonly deploymentPending = new Map<string, Promise<string>>();
  private readonly deploymentObservationCache = new Map<string, CachedToken>();
  private readonly deploymentObservationPending = new Map<string, Promise<string>>();
  private readonly productionDeploymentCache = new Map<string, CachedToken>();
  private readonly productionDeploymentPending = new Map<string, Promise<string>>();
  private readonly productionDeploymentObservationCache = new Map<string, CachedToken>();
  private readonly productionDeploymentObservationPending = new Map<string, Promise<string>>();
  private readonly acceptanceCache = new Map<string, CachedToken>();
  private readonly acceptancePending = new Map<string, Promise<string>>();
  private readonly rollbackCache = new Map<string, CachedToken>();
  private readonly rollbackPending = new Map<string, Promise<string>>();
  private readonly rollbackObservationCache = new Map<string, CachedToken>();
  private readonly rollbackObservationPending = new Map<string, Promise<string>>();
  private readonly policyObservationCache = new Map<string, CachedToken>();
  private readonly policyObservationPending = new Map<string, Promise<string>>();

  constructor(options: GitHubAppInstallationTokenProviderOptions) {
    this.appId = numericId(options.appId, 'GitHub App ID');
    this.installationId = numericId(options.installationId, 'GitHub App installation ID');
    this.privateKeyPem = normalizePrivateKeyPem(options.privateKeyPem);
    this.allowedRepositories = new Set(options.allowedRepositories);
    if (this.allowedRepositories.size === 0) {
      throw new Error('GitHub repository allowlist must not be empty');
    }
    for (const repository of this.allowedRepositories) repositoryName(repository);
    this.apiBaseUrl = apiOrigin(options.apiBaseUrl ?? 'https://api.github.com');
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.transportDiagnostic = options.transportDiagnostic;
  }

  async getInstallationToken(repository: string): Promise<string> {
    if (!this.allowedRepositories.has(repository)) {
      throw new Error('GitHub repository is not allowed');
    }
    const now = this.now().getTime();
    const cached = this.cache.get(repository);
    if (cached !== undefined && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
      return cached.token;
    }
    const inFlight = this.pending.get(repository);
    if (inFlight !== undefined) return await inFlight;
    const request = this.requestCredential(repository, {
      actions: 'write',
      contents: 'read',
    }).then((credential) => {
      this.cache.set(repository, credential);
      return credential.token;
    }).finally(() => this.pending.delete(repository));
    this.pending.set(repository, request);
    return await request;
  }

  async issueWriteCredential(repository: string): Promise<{ token: string; expiresAt: string }> {
    this.assertAllowedRepository(repository);
    const credential = await this.requestCredential(repository, {
      contents: 'write',
      pull_requests: 'write',
    });
    return {
      token: credential.token,
      expiresAt: new Date(credential.expiresAt).toISOString(),
    };
  }

  async getPullRequestToken(repository: string): Promise<string> {
    this.assertAllowedRepository(repository);
    const now = this.now().getTime();
    const cached = this.pullRequestCache.get(repository);
    if (cached !== undefined && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
      return cached.token;
    }
    const inFlight = this.pullRequestPending.get(repository);
    if (inFlight !== undefined) return await inFlight;
    const request = this.requestCredential(repository, {
      pull_requests: 'write',
    }).then((credential) => {
      this.pullRequestCache.set(repository, credential);
      return credential.token;
    }).finally(() => this.pullRequestPending.delete(repository));
    this.pullRequestPending.set(repository, request);
    return await request;
  }

  async getBaseObservationToken(repository: string): Promise<string> {
    this.assertAllowedRepository(repository);
    const now = this.now().getTime();
    const cached = this.baseObservationCache.get(repository);
    if (cached !== undefined && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
      return cached.token;
    }
    const inFlight = this.baseObservationPending.get(repository);
    if (inFlight !== undefined) return await inFlight;
    const request = this.requestCredential(repository, {
      contents: 'read',
    }).then((credential) => {
      this.baseObservationCache.set(repository, credential);
      return credential.token;
    }).finally(() => this.baseObservationPending.delete(repository));
    this.baseObservationPending.set(repository, request);
    return await request;
  }

  async getMergeObservationToken(repository: string): Promise<string> {
    this.assertAllowedRepository(repository);
    const now = this.now().getTime();
    const cached = this.mergeObservationCache.get(repository);
    if (cached !== undefined && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
      return cached.token;
    }
    const inFlight = this.mergeObservationPending.get(repository);
    if (inFlight !== undefined) return await inFlight;
    const request = this.requestCredential(repository, {
      checks: 'read',
      contents: 'read',
      pull_requests: 'read',
      statuses: 'read',
    }).then((credential) => {
      this.mergeObservationCache.set(repository, credential);
      return credential.token;
    }).finally(() => this.mergeObservationPending.delete(repository));
    this.mergeObservationPending.set(repository, request);
    return await request;
  }

  /** A deployment effect never reuses the Actions, PR, contents-write, or merge token. */
  async getDeploymentToken(repository: string): Promise<string> {
    this.assertAllowedRepository(repository);
    const now = this.now().getTime();
    const cached = this.deploymentCache.get(repository);
    if (cached !== undefined && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
      return cached.token;
    }
    const inFlight = this.deploymentPending.get(repository);
    if (inFlight !== undefined) return await inFlight;
    const request = this.requestCredential(repository, {
      deployments: 'write',
    }).then((credential) => {
      this.deploymentCache.set(repository, credential);
      return credential.token;
    }).finally(() => this.deploymentPending.delete(repository));
    this.deploymentPending.set(repository, request);
    return await request;
  }

  /** Test deployment reconciliation is read-only and never reuses its effect token. */
  async getTestDeploymentObservationToken(repository: string): Promise<string> {
    this.assertAllowedRepository(repository);
    const now = this.now().getTime();
    const cached = this.deploymentObservationCache.get(repository);
    if (cached !== undefined && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
      return cached.token;
    }
    const inFlight = this.deploymentObservationPending.get(repository);
    if (inFlight !== undefined) return await inFlight;
    const request = this.requestCredential(repository, {
      deployments: 'read',
    }).then((credential) => {
      this.deploymentObservationCache.set(repository, credential);
      return credential.token;
    }).finally(() => this.deploymentObservationPending.delete(repository));
    this.deploymentObservationPending.set(repository, request);
    return await request;
  }

  /** Deployment-triggered Action observation uses the same isolated read cache. */
  async getDeploymentObservationToken(repository: string): Promise<string> {
    return await this.getTestDeploymentObservationToken(repository);
  }

  /** Production deployment approval never reuses the test deployment token cache. */
  async getProductionDeploymentToken(repository: string): Promise<string> {
    this.assertAllowedRepository(repository);
    const now = this.now().getTime();
    const cached = this.productionDeploymentCache.get(repository);
    if (cached !== undefined && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
      return cached.token;
    }
    const inFlight = this.productionDeploymentPending.get(repository);
    if (inFlight !== undefined) return await inFlight;
    const request = this.requestCredential(repository, {
      deployments: 'write',
    }).then((credential) => {
      this.productionDeploymentCache.set(repository, credential);
      return credential.token;
    }).finally(() => this.productionDeploymentPending.delete(repository));
    this.productionDeploymentPending.set(repository, request);
    return await request;
  }

  /** Final status reconciliation is read-only and never reuses the write-token cache. */
  async getProductionDeploymentObservationToken(repository: string): Promise<string> {
    this.assertAllowedRepository(repository);
    const now = this.now().getTime();
    const cached = this.productionDeploymentObservationCache.get(repository);
    if (cached !== undefined && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
      return cached.token;
    }
    const inFlight = this.productionDeploymentObservationPending.get(repository);
    if (inFlight !== undefined) return await inFlight;
    const request = this.requestCredential(repository, {
      deployments: 'read',
    }).then((credential) => {
      this.productionDeploymentObservationCache.set(repository, credential);
      return credential.token;
    }).finally(() => this.productionDeploymentObservationPending.delete(repository));
    this.productionDeploymentObservationPending.set(repository, request);
    return await request;
  }

  /** Acceptance dispatch uses a distinct credential lifecycle from Agent execution. */
  async getAcceptanceToken(repository: string): Promise<string> {
    this.assertAllowedRepository(repository);
    const now = this.now().getTime();
    const cached = this.acceptanceCache.get(repository);
    if (cached !== undefined && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
      return cached.token;
    }
    const inFlight = this.acceptancePending.get(repository);
    if (inFlight !== undefined) return await inFlight;
    const request = this.requestCredential(repository, {
      actions: 'write',
      contents: 'read',
    }).then((credential) => {
      this.acceptanceCache.set(repository, credential);
      return credential.token;
    }).finally(() => this.acceptancePending.delete(repository));
    this.acceptancePending.set(repository, request);
    return await request;
  }

  /** Automatic rollback uses a distinct Actions credential lifecycle. */
  async getRollbackToken(repository: string): Promise<string> {
    this.assertAllowedRepository(repository);
    const now = this.now().getTime();
    const cached = this.rollbackCache.get(repository);
    if (cached !== undefined && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
      return cached.token;
    }
    const inFlight = this.rollbackPending.get(repository);
    if (inFlight !== undefined) return await inFlight;
    const request = this.requestCredential(repository, {
      actions: 'write',
      contents: 'read',
    }).then((credential) => {
      this.rollbackCache.set(repository, credential);
      return credential.token;
    }).finally(() => this.rollbackPending.delete(repository));
    this.rollbackPending.set(repository, request);
    return await request;
  }

  /** Lost rollback webhooks are repaired with an Actions-read-only credential. */
  async getRollbackObservationToken(repository: string): Promise<string> {
    this.assertAllowedRepository(repository);
    const now = this.now().getTime();
    const cached = this.rollbackObservationCache.get(repository);
    if (cached !== undefined && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
      return cached.token;
    }
    const inFlight = this.rollbackObservationPending.get(repository);
    if (inFlight !== undefined) return await inFlight;
    const request = this.requestCredential(repository, {
      actions: 'read',
    }).then((credential) => {
      this.rollbackObservationCache.set(repository, credential);
      return credential.token;
    }).finally(() => this.rollbackObservationPending.delete(repository));
    this.rollbackObservationPending.set(repository, request);
    return await request;
  }

  /** Policy discovery is read-only and cannot dispatch the rollback workflow. */
  async getPolicyObservationToken(repository: string): Promise<string> {
    this.assertAllowedRepository(repository);
    const now = this.now().getTime();
    const cached = this.policyObservationCache.get(repository);
    if (cached !== undefined && cached.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
      return cached.token;
    }
    const inFlight = this.policyObservationPending.get(repository);
    if (inFlight !== undefined) return await inFlight;
    const request = this.requestCredential(repository, {
      contents: 'read',
    }).then((credential) => {
      this.policyObservationCache.set(repository, credential);
      return credential.token;
    }).finally(() => this.policyObservationPending.delete(repository));
    this.policyObservationPending.set(repository, request);
    return await request;
  }

  async revokeWriteCredential(token: string): Promise<void> {
    if (token.length < 1 || token.length > 2_000 || /[\0\r\n]/.test(token)) {
      throw new Error('GitHub installation token is invalid');
    }
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.apiBaseUrl}/installation/token`, {
        method: 'DELETE',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
        },
      });
    } catch {
      throw new Error('GitHub installation token revocation failed');
    }
    if (response.status !== 204) {
      await response.body?.cancel();
      throw new Error('GitHub installation token revocation failed');
    }
  }

  private assertAllowedRepository(repository: string): void {
    if (!this.allowedRepositories.has(repository)) {
      throw new Error('GitHub repository is not allowed');
    }
  }

  private async requestCredential(
    repository: string,
    permissions: Record<string, 'read' | 'write'>,
  ): Promise<CachedToken> {
    this.assertAllowedRepository(repository);
    let jwt: string;
    try {
      const signingKey = await importPKCS8(this.privateKeyPem, 'RS256');
      const nowSeconds = Math.floor(this.now().getTime() / 1_000);
      jwt = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(this.appId)
        .setIssuedAt(nowSeconds - 60)
        .setExpirationTime(nowSeconds + 540)
        .sign(signingKey);
    } catch {
      credentialFailure('credential_signing_unavailable');
    }
    const requestUrl =
      `${this.apiBaseUrl}/app/installations/${this.installationId}/access_tokens`;
    const requestInit: RequestInit = {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({
        repositories: [repositoryName(repository)],
        permissions,
      }),
      // workerd intentionally does not implement RequestRedirect="error".
      // Manual mode preserves the fail-closed policy: fetch returns the
      // redirect response without following it, and the status handling
      // below rejects every non-201 response without reading its body.
      redirect: 'manual',
      signal: AbortSignal.timeout(INSTALLATION_TOKEN_REQUEST_TIMEOUT_MS),
    };
    try {
      // Keep request construction separate from network execution so edge
      // runtime option rejection cannot be misreported as host transport.
      void new Request(requestUrl, requestInit);
    } catch {
      credentialFailure('credential_request_invalid');
    }
    let response: Response;
    try {
      response = await this.fetchImplementation(requestUrl, requestInit);
    } catch (error) {
      try {
        this.transportDiagnostic?.({
          schemaVersion: '1',
          event: 'github_app_installation_token_transport_failed',
          operation: 'installation_token_exchange',
          failureKind: classifySafeTransportFailure(error),
          requestAttempts: 1,
        });
      } catch {
        // Diagnostic delivery cannot replace or expose the fixed credential stage.
      }
      credentialFailure('credential_transport_unavailable');
    }
    if (response.status !== 201) {
      try {
        void response.body?.cancel().catch(() => undefined);
      } catch {
        // The upstream body and cancellation error are both intentionally discarded.
      }
      if (response.status === 401 || response.status === 403) {
        credentialFailure('credential_auth_rejected');
      }
      if (response.status === 404) {
        credentialFailure('credential_installation_not_found');
      }
      if (response.status === 422) {
        credentialFailure('credential_policy_rejected');
      }
      if (response.status >= 500 && response.status <= 599) {
        credentialFailure('credential_upstream_unavailable');
      }
      credentialFailure('credential_response_invalid');
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      credentialFailure('credential_response_invalid');
    }
    if (typeof body !== 'object' || body === null) {
      credentialFailure('credential_response_invalid');
    }
    const token = (body as Record<string, unknown>).token;
    const expiresAtRaw = (body as Record<string, unknown>).expires_at;
    const expiresAt = typeof expiresAtRaw === 'string' ? Date.parse(expiresAtRaw) : Number.NaN;
    if (
      typeof token !== 'string' ||
      token.length < 1 ||
      token.length > 2_000 ||
      /[\0\r\n]/.test(token) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= this.now().getTime() + TOKEN_REFRESH_SKEW_MS
    ) {
      credentialFailure('credential_response_invalid');
    }
    return { token, expiresAt };
  }
}
