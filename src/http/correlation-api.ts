import { Hono } from 'hono';
import type { Bindings } from '../env.js';
import { CorrelationLogger } from '../observability/correlation-log.js';
import { secureStructuredLogSink } from '../observability/structured-log.js';
import { configuredSecrets } from '../security/runtime-secrets.js';
import {
  CorrelationLookupSchema,
  CorrelationQueryStore,
} from '../storage/correlation-query-store.js';
import { errorResponse } from './errors.js';

const ALLOWED_QUERY_KEYS = new Set(['kind', 'id', 'repository']);

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

function authenticated(configured: string | undefined, authorization: string | undefined): boolean {
  return configured !== undefined && authorization?.startsWith('Bearer ') === true &&
    constantTimeEqual(authorization.slice('Bearer '.length), configured);
}

export function correlationApi(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.get('/v1/correlations', async (c) => {
    if (!authenticated(c.env.TASK_INTAKE_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const params = new URL(c.req.url).searchParams;
    if (
      [...params.keys()].some((key) => !ALLOWED_QUERY_KEYS.has(key)) ||
      [...ALLOWED_QUERY_KEYS].some((key) => params.getAll(key).length > 1)
    ) return errorResponse(c, 400, 'invalid_argument', 'invalid correlation query', false);
    const candidate: Record<string, string> = {};
    for (const key of ALLOWED_QUERY_KEYS) {
      const value = params.get(key);
      if (value !== null) candidate[key] = value;
    }
    const parsed = CorrelationLookupSchema.safeParse(candidate);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid correlation query', false);
    }
    const view = await new CorrelationQueryStore(c.env.DB_CONTROL).resolve(parsed.data);
    if (view === null) {
      return errorResponse(c, 404, 'not_found', 'correlation not found', false);
    }
    new CorrelationLogger(secureStructuredLogSink({
      component: 'correlation',
      secrets: configuredSecrets(c.env),
    })).lookup(view);
    c.header('cache-control', 'no-store');
    return c.json(view);
  });
  return app;
}
