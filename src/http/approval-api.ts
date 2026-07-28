import { Hono } from 'hono';
import type { Bindings } from '../env.js';
import {
  IdentityBoundApprovalError,
  IdentityBoundApprovalRequestBodySchema,
  IdentityBoundApprovalStore,
} from '../storage/identity-bound-approval-store.js';
import { errorResponse } from './errors.js';
import { QuotaOverrideRequestBodySchema } from '../domain/quota.js';
import {
  QuotaOverrideError,
  QuotaOverrideStore,
} from '../storage/quota-override-store.js';

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MAX_APPROVAL_BODY_BYTES = 8 * 1024;

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function isApprovalAdapter(
  configuredToken: string | undefined,
  authorization: string | undefined,
): boolean {
  return configuredToken !== undefined && authorization !== undefined &&
    authorization.startsWith('Bearer ') &&
    constantTimeEqual(authorization.slice('Bearer '.length), configuredToken);
}

/** Accepts identity facts only from an independently authenticated source adapter. */
export function approvalApi(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();

  app.post('/v1/runs/:runId/approvals', async (c) => {
    if (!isApprovalAdapter(
      c.env.APPROVAL_ADAPTER_TOKEN,
      c.req.header('authorization'),
    )) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const runId = c.req.param('runId');
    if (!RESOURCE_ID_PATTERN.test(runId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid approval target', false);
    }
    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 400, 'invalid_argument', 'invalid approval request', false);
    }
    let body: unknown;
    try {
      const text = await c.req.text();
      if (new TextEncoder().encode(text).length > MAX_APPROVAL_BODY_BYTES) {
        throw new Error('oversized');
      }
      body = JSON.parse(text) as unknown;
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid approval request', false);
    }
    const parsed = IdentityBoundApprovalRequestBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid approval request', false);
    }
    try {
      const result = await new IdentityBoundApprovalStore(c.env.DB_CONTROL).decide({
        runId,
        ...parsed.data,
      });
      c.header('cache-control', 'no-store');
      return c.json(result, result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof IdentityBoundApprovalError) {
        switch (error.code) {
          case 'invalid_request':
            return errorResponse(c, 400, 'invalid_argument', 'invalid approval request', false);
          case 'not_found':
            return errorResponse(c, 404, 'not_found', 'approval target not found', false);
          case 'source_conflict':
            return errorResponse(c, 409, 'conflict', 'approval source conflicts', false);
          case 'state_conflict':
            return errorResponse(c, 409, 'conflict', 'approval state changed', false);
        }
      }
      throw error;
    }
  });

  app.post('/v1/runs/:runId/quota-overrides', async (c) => {
    if (!isApprovalAdapter(
      c.env.APPROVAL_ADAPTER_TOKEN,
      c.req.header('authorization'),
    )) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const runId = c.req.param('runId');
    if (!RESOURCE_ID_PATTERN.test(runId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid quota override target', false);
    }
    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 400, 'invalid_argument', 'invalid quota override request', false);
    }
    let body: unknown;
    try {
      const text = await c.req.text();
      if (new TextEncoder().encode(text).length > MAX_APPROVAL_BODY_BYTES) {
        throw new Error('oversized');
      }
      body = JSON.parse(text) as unknown;
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid quota override request', false);
    }
    const parsed = QuotaOverrideRequestBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid quota override request', false);
    }
    try {
      const result = await new QuotaOverrideStore(c.env.DB_CONTROL).decide({
        ...parsed.data,
        runId,
      });
      c.header('cache-control', 'no-store');
      return c.json(result, result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof QuotaOverrideError) {
        switch (error.code) {
          case 'invalid_request':
            return errorResponse(c, 400, 'invalid_argument', 'invalid quota override request', false);
          case 'not_found':
            return errorResponse(c, 404, 'not_found', 'quota override target not found', false);
          case 'not_p0':
            return errorResponse(c, 403, 'policy_denied', 'quota override requires P0', false);
          case 'source_conflict':
            return errorResponse(c, 409, 'conflict', 'quota override source conflicts', false);
          case 'state_conflict':
            return errorResponse(c, 409, 'conflict', 'quota override state changed', false);
        }
      }
      throw error;
    }
  });

  return app;
}
