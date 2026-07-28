import { Hono } from 'hono';
import { z } from 'zod';
import {
  GitHubOidcConfigurationError,
  GitHubOidcVerificationError,
  GitHubOidcVerifier,
} from '../auth/github-oidc.js';
import type { Bindings } from '../env.js';
import {
  TestAcceptanceRunnerError,
  TestAcceptanceRunnerStore,
} from '../storage/test-acceptance-runner-store.js';
import { errorResponse } from './errors.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MAX_OIDC_TOKEN_LENGTH = 20_000;

const ResultBodySchema = z.object({
  exitCode: z.number().int().min(0).max(255),
  durationMs: z.number().int().nonnegative().max(3_600_000),
}).strict();

function oidcToken(authorization: string | undefined): string | null {
  if (
    authorization === undefined || !authorization.startsWith('Bearer ') ||
    authorization.length > MAX_OIDC_TOKEN_LENGTH
  ) return null;
  const token = authorization.slice('Bearer '.length);
  return token.length === 0 ? null : token;
}

async function verifiedClaims(
  env: Bindings,
  audience: string,
  token: string,
): Promise<Awaited<ReturnType<GitHubOidcVerifier['verify']>>> {
  const verifier = new GitHubOidcVerifier({
    audience,
    ...(env.GITHUB_OIDC_JWKS === undefined ? {} : { jwksJson: env.GITHUB_OIDC_JWKS }),
    ...(env.GITHUB_OIDC_JWKS_URL === undefined ? {} : { jwksUrl: env.GITHUB_OIDC_JWKS_URL }),
  });
  return await verifier.verify(token);
}

function runnerError(c: Parameters<typeof errorResponse>[0], error: TestAcceptanceRunnerError): Response {
  if (error.code === 'not_found') {
    return errorResponse(c, 404, 'not_found', 'test acceptance not found', false);
  }
  if (error.code === 'binding_mismatch') {
    return errorResponse(c, 403, 'policy_denied', 'test acceptance binding rejected', false);
  }
  return errorResponse(c, 409, 'conflict', 'test acceptance state changed', false);
}

export function testAcceptanceApi(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();

  app.post('/v1/test-acceptances/:acceptanceId/oidc-attestation', async (c) => {
    const acceptanceId = c.req.param('acceptanceId');
    if (!ID_PATTERN.test(acceptanceId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid test acceptance id', false);
    }
    const token = oidcToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'GitHub OIDC token required', false);
    }
    const store = new TestAcceptanceRunnerStore(c.env.DB_CONTROL);
    let expectation;
    try {
      expectation = await store.expectation(acceptanceId);
    } catch (error) {
      if (error instanceof TestAcceptanceRunnerError) return runnerError(c, error);
      throw error;
    }
    let claims;
    try {
      claims = await verifiedClaims(c.env, expectation.audience, token);
    } catch (error) {
      if (error instanceof GitHubOidcConfigurationError) {
        return errorResponse(c, 503, 'unavailable', 'OIDC verifier unavailable', true);
      }
      if (error instanceof GitHubOidcVerificationError) {
        return errorResponse(c, 401, 'unauthenticated', 'GitHub OIDC token invalid', false);
      }
      throw error;
    }
    try {
      const result = await store.attest(acceptanceId, token, claims);
      c.header('cache-control', 'no-store');
      return c.json(result);
    } catch (error) {
      if (error instanceof TestAcceptanceRunnerError) return runnerError(c, error);
      throw error;
    }
  });

  app.post('/v1/test-acceptances/:acceptanceId/result', async (c) => {
    const acceptanceId = c.req.param('acceptanceId');
    if (!ID_PATTERN.test(acceptanceId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid test acceptance id', false);
    }
    const token = oidcToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'GitHub OIDC token required', false);
    }
    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 400, 'invalid_argument', 'invalid acceptance result', false);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid acceptance result', false);
    }
    const parsed = ResultBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid acceptance result', false);
    }
    const store = new TestAcceptanceRunnerStore(c.env.DB_CONTROL);
    let expectation;
    try {
      expectation = await store.expectation(acceptanceId);
    } catch (error) {
      if (error instanceof TestAcceptanceRunnerError) return runnerError(c, error);
      throw error;
    }
    let claims;
    try {
      claims = await verifiedClaims(c.env, expectation.audience, token);
    } catch (error) {
      if (error instanceof GitHubOidcConfigurationError) {
        return errorResponse(c, 503, 'unavailable', 'OIDC verifier unavailable', true);
      }
      if (error instanceof GitHubOidcVerificationError) {
        return errorResponse(c, 401, 'unauthenticated', 'GitHub OIDC token invalid', false);
      }
      throw error;
    }
    try {
      const result = await store.report(acceptanceId, token, claims, parsed.data);
      c.header('cache-control', 'no-store');
      return c.json(result);
    } catch (error) {
      if (error instanceof TestAcceptanceRunnerError) return runnerError(c, error);
      throw error;
    }
  });

  return app;
}
