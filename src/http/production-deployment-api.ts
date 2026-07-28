import { Hono } from 'hono';
import {
  GitHubOidcConfigurationError,
  GitHubOidcVerificationError,
  GitHubOidcVerifier,
} from '../auth/github-oidc.js';
import type { Bindings } from '../env.js';
import {
  ProductionDeploymentOidcError,
  ProductionDeploymentOidcStore,
} from '../storage/production-deployment-oidc-store.js';
import { errorResponse } from './errors.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MAX_OIDC_TOKEN_LENGTH = 20_000;

export function productionDeploymentApi(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.post('/v1/production-deployments/:deploymentId/oidc-attestation', async (c) => {
    const deploymentId = c.req.param('deploymentId');
    if (!ID_PATTERN.test(deploymentId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid production deployment id', false);
    }
    const authorization = c.req.header('authorization');
    if (
      authorization === undefined || !authorization.startsWith('Bearer ') ||
      authorization.length > MAX_OIDC_TOKEN_LENGTH
    ) return errorResponse(c, 401, 'unauthenticated', 'GitHub OIDC token required', false);
    const oidcToken = authorization.slice('Bearer '.length);
    const store = new ProductionDeploymentOidcStore(c.env.DB_CONTROL);
    let expectation;
    try {
      expectation = await store.expectation(deploymentId);
    } catch (error) {
      if (error instanceof ProductionDeploymentOidcError && error.code === 'not_found') {
        return errorResponse(c, 404, 'not_found', 'production deployment not found', false);
      }
      throw error;
    }
    let verifier: GitHubOidcVerifier;
    try {
      verifier = new GitHubOidcVerifier({
        audience: expectation.audience,
        ...(c.env.GITHUB_OIDC_JWKS === undefined ? {} : { jwksJson: c.env.GITHUB_OIDC_JWKS }),
        ...(c.env.GITHUB_OIDC_JWKS_URL === undefined
          ? {}
          : { jwksUrl: c.env.GITHUB_OIDC_JWKS_URL }),
      });
    } catch (error) {
      if (error instanceof GitHubOidcConfigurationError) {
        return errorResponse(c, 503, 'unavailable', 'OIDC verifier unavailable', true);
      }
      throw error;
    }
    let claims;
    try {
      claims = await verifier.verify(oidcToken);
    } catch (error) {
      if (error instanceof GitHubOidcVerificationError) {
        return errorResponse(c, 401, 'unauthenticated', 'GitHub OIDC token invalid', false);
      }
      throw error;
    }
    try {
      const result = await store.attest(deploymentId, oidcToken, claims);
      c.header('cache-control', 'no-store');
      return c.json(result);
    } catch (error) {
      if (error instanceof ProductionDeploymentOidcError) {
        if (error.code === 'not_found') {
          return errorResponse(c, 404, 'not_found', 'production deployment not found', false);
        }
        if (error.code === 'binding_mismatch') {
          return errorResponse(c, 403, 'policy_denied', 'production deployment binding rejected', false);
        }
        return errorResponse(c, 409, 'conflict', 'production deployment state changed', false);
      }
      throw error;
    }
  });
  return app;
}
