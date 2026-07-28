import { Hono } from 'hono';
import type { Bindings } from '../env.js';
import {
  SupplementalContextEvidenceStore,
  SupplementalContextEvidenceStoreError,
} from '../storage/supplemental-context-evidence-store.js';
import { errorResponse } from './errors.js';
import { operationsAuthenticated } from './operations-auth.js';

export function supplementalContextEvidenceApi(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.get('/v1/operations/supplemental-context/evidence', async (c) => {
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const params = new URL(c.req.url).searchParams;
    if (
      [...params.keys()].some((key) => key !== 'contextId') ||
      params.getAll('contextId').length !== 1
    ) return errorResponse(c, 400, 'invalid_argument', 'invalid evidence query', false);
    try {
      const projection = await new SupplementalContextEvidenceStore(
        c.env.DB_CONTROL,
        c.env.TASK_OBJECTS,
      ).get(params.get('contextId') ?? '');
      c.header('cache-control', 'no-store');
      return c.json(projection);
    } catch (error) {
      if (error instanceof SupplementalContextEvidenceStoreError) {
        if (error.code === 'invalid_query') {
          return errorResponse(c, 400, 'invalid_argument', 'invalid evidence query', false);
        }
        if (error.code === 'not_found') {
          return errorResponse(c, 404, 'not_found', 'evidence not found', false);
        }
        return errorResponse(c, 409, 'conflict', 'evidence projection conflicts', false);
      }
      throw error;
    }
  });
  return app;
}
