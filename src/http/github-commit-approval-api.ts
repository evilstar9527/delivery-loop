import { Hono } from 'hono';
import type { Bindings } from '../env.js';
import {
  GitHubCommitApprovalError,
  GitHubCommitApprovalRequestSchema,
  GitHubCommitApprovalService,
  type GitHubCommitApprovalClient,
  type GitHubCommitApprovalFact,
} from '../github-commit-approval.js';
import { githubCommitApprovalClientFromEnv } from '../github-commit-approval-runtime.js';
import { errorResponse } from './errors.js';
import { operationsAuthenticated } from './operations-auth.js';

export type { GitHubCommitApprovalClient, GitHubCommitApprovalFact };

export interface GitHubCommitApprovalApiOptions {
  clientFromEnv?: (env: Bindings) => GitHubCommitApprovalClient | null;
  now?: () => Date;
}

function mappedError(
  c: Parameters<typeof errorResponse>[0],
  error: GitHubCommitApprovalError,
): Response {
  if (error.code === 'invalid_request') {
    return errorResponse(c, 400, 'invalid_argument', 'invalid GitHub approval request', false);
  }
  if (error.code === 'not_found') {
    return errorResponse(c, 404, 'not_found', 'GitHub approval target not found', false);
  }
  if (error.code === 'external_unavailable') {
    return errorResponse(c, 503, 'unavailable', 'GitHub approval fact unavailable', true);
  }
  return errorResponse(c, 409, 'conflict', 'GitHub approval fact or state changed', false);
}

export function githubCommitApprovalApi(
  options: GitHubCommitApprovalApiOptions = {},
): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  const clientFromEnv = options.clientFromEnv ?? githubCommitApprovalClientFromEnv;

  app.get('/v1/runs/:runId/github-commit-approval-template', async (c) => {
    c.header('cache-control', 'no-store');
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    let client: GitHubCommitApprovalClient | null;
    try {
      client = clientFromEnv(c.env);
    } catch {
      return errorResponse(c, 503, 'unavailable', 'GitHub approval configuration unavailable', true);
    }
    if (client === null) {
      return errorResponse(c, 503, 'unavailable', 'GitHub approval configuration unavailable', true);
    }
    try {
      return c.json(await new GitHubCommitApprovalService(
        c.env.DB_CONTROL,
        client,
        options.now,
      ).template(c.req.param('runId')));
    } catch (error) {
      if (error instanceof GitHubCommitApprovalError) return mappedError(c, error);
      throw error;
    }
  });

  app.post('/v1/runs/:runId/github-commit-approvals', async (c) => {
    c.header('cache-control', 'no-store');
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    if (c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      return errorResponse(c, 400, 'invalid_argument', 'invalid GitHub approval request', false);
    }
    let body: unknown;
    try {
      const text = await c.req.text();
      if (new TextEncoder().encode(text).length > 4_096) throw new Error('oversized');
      body = JSON.parse(text) as unknown;
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid GitHub approval request', false);
    }
    const parsed = GitHubCommitApprovalRequestSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid GitHub approval request', false);
    }
    let client: GitHubCommitApprovalClient | null;
    try {
      client = clientFromEnv(c.env);
    } catch {
      return errorResponse(c, 503, 'unavailable', 'GitHub approval configuration unavailable', true);
    }
    if (client === null) {
      return errorResponse(c, 503, 'unavailable', 'GitHub approval configuration unavailable', true);
    }
    try {
      const result = await new GitHubCommitApprovalService(
        c.env.DB_CONTROL,
        client,
        options.now,
      ).approve(c.req.param('runId'), parsed.data.commentId);
      if (result.status !== 'accepted') {
        return errorResponse(c, 403, 'policy_denied', 'GitHub approval identity rejected', false);
      }
      return c.json(result, result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof GitHubCommitApprovalError) return mappedError(c, error);
      throw error;
    }
  });

  return app;
}
