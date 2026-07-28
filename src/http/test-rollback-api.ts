import { Hono } from 'hono';
import { z } from 'zod';
import {
  GitHubOidcConfigurationError,
  GitHubOidcVerificationError,
  GitHubOidcVerifier,
} from '../auth/github-oidc.js';
import type { Bindings } from '../env.js';
import {
  TestRollbackRunnerError,
  TestRollbackRunnerStore,
} from '../storage/test-rollback-runner-store.js';
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

function runnerError(
  c: Parameters<typeof errorResponse>[0],
  error: TestRollbackRunnerError,
): Response {
  if (error.code === 'not_found') {
    return errorResponse(c, 404, 'not_found', 'test rollback not found', false);
  }
  if (error.code === 'binding_mismatch') {
    return errorResponse(c, 403, 'policy_denied', 'test rollback binding rejected', false);
  }
  return errorResponse(c, 409, 'conflict', 'test rollback state changed', false);
}

export function testRollbackApi(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();

  app.post('/v1/test-rollbacks/:rollbackId/oidc-attestation', async (c) => {
    const rollbackId = c.req.param('rollbackId');
    if (!ID_PATTERN.test(rollbackId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid test rollback id', false);
    }
    const token = oidcToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'GitHub OIDC token required', false);
    }
    const store = new TestRollbackRunnerStore(c.env.DB_CONTROL);
    let expectation;
    try {
      expectation = await store.expectation(rollbackId);
    } catch (error) {
      if (error instanceof TestRollbackRunnerError) return runnerError(c, error);
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
      const result = await store.attest(rollbackId, token, claims);
      c.header('cache-control', 'no-store');
      return c.json(result);
    } catch (error) {
      if (error instanceof TestRollbackRunnerError) return runnerError(c, error);
      throw error;
    }
  });

  app.post('/v1/test-rollbacks/:rollbackId/result', async (c) => {
    const rollbackId = c.req.param('rollbackId');
    if (!ID_PATTERN.test(rollbackId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid test rollback id', false);
    }
    const token = oidcToken(c.req.header('authorization'));
    if (token === null) {
      return errorResponse(c, 401, 'unauthenticated', 'GitHub OIDC token required', false);
    }
    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 400, 'invalid_argument', 'invalid rollback result', false);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid rollback result', false);
    }
    const parsed = ResultBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid rollback result', false);
    }
    const store = new TestRollbackRunnerStore(c.env.DB_CONTROL);
    let expectation;
    try {
      expectation = await store.expectation(rollbackId);
    } catch (error) {
      if (error instanceof TestRollbackRunnerError) return runnerError(c, error);
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
      const result = await store.report(rollbackId, token, claims, parsed.data);
      c.header('cache-control', 'no-store');
      return c.json(result);
    } catch (error) {
      if (error instanceof TestRollbackRunnerError) return runnerError(c, error);
      throw error;
    }
  });

  return app;
}

