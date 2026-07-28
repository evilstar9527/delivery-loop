import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';

export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const DEFAULT_GITHUB_OIDC_AUDIENCE = 'delivery-loop-control-plane';
export const DEFAULT_GITHUB_OIDC_JWKS_URL =
  'https://token.actions.githubusercontent.com/.well-known/jwks';

export interface GitHubOidcClaims {
  repository: string;
  workflowRef: string;
  sha: string;
  runId: string;
  subject: string;
  environment: string | null;
}

export interface GitHubOidcVerifierOptions {
  audience?: string;
  jwksJson?: string;
  jwksUrl?: string;
}

export class GitHubOidcConfigurationError extends Error {
  constructor() {
    super('GitHub OIDC verifier is not configured correctly');
    this.name = 'GitHubOidcConfigurationError';
  }
}

export class GitHubOidcVerificationError extends Error {
  constructor() {
    super('GitHub OIDC token is invalid');
    this.name = 'GitHubOidcVerificationError';
  }
}

function localJwks(raw: string): JWTVerifyGetKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new GitHubOidcConfigurationError();
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('keys' in parsed) ||
    !Array.isArray(parsed.keys)
  ) {
    throw new GitHubOidcConfigurationError();
  }
  return createLocalJWKSet(parsed as JSONWebKeySet);
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new GitHubOidcVerificationError();
  return value;
}

/**
 * GitHub OIDC verifier. The createRemoteJWKSet + jwtVerify skeleton is copied
 * from Watt's production OAuth verifier; GitHub-specific claims are then made
 * mandatory and bound by AttemptExchangeStore.
 */
export class GitHubOidcVerifier {
  private readonly audience: string;
  private readonly keySet: JWTVerifyGetKey;

  constructor(options: GitHubOidcVerifierOptions = {}) {
    this.audience = options.audience ?? DEFAULT_GITHUB_OIDC_AUDIENCE;
    if (this.audience.length === 0) throw new GitHubOidcConfigurationError();
    try {
      this.keySet =
        options.jwksJson === undefined
          ? createRemoteJWKSet(new URL(options.jwksUrl ?? DEFAULT_GITHUB_OIDC_JWKS_URL))
          : localJwks(options.jwksJson);
    } catch (error) {
      if (error instanceof GitHubOidcConfigurationError) throw error;
      throw new GitHubOidcConfigurationError();
    }
  }

  async verify(token: string): Promise<GitHubOidcClaims> {
    try {
      const { payload } = await jwtVerify(token, this.keySet, {
        issuer: GITHUB_OIDC_ISSUER,
        audience: this.audience,
        algorithms: ['RS256'],
        maxTokenAge: '10m',
        requiredClaims: ['sub', 'iat', 'exp'],
      });
      return {
        repository: requiredString(payload.repository),
        workflowRef: requiredString(payload.job_workflow_ref ?? payload.workflow_ref),
        sha: requiredString(payload.sha),
        runId: requiredString(payload.run_id),
        subject: requiredString(payload.sub),
        environment: typeof payload.environment === 'string' && payload.environment.length > 0
          ? payload.environment
          : null,
      };
    } catch (error) {
      if (error instanceof GitHubOidcConfigurationError) throw error;
      throw new GitHubOidcVerificationError();
    }
  }
}
