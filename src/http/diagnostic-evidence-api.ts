import { Hono } from 'hono';
import type { Bindings } from '../env.js';
import {
  DiagnosticEvidenceError,
  DiagnosticEvidenceQueryStore,
} from '../storage/diagnostic-evidence-store.js';
import { errorResponse } from './errors.js';
import { operationsAuthenticated } from './operations-auth.js';

export function diagnosticEvidenceApi(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.get('/v1/runs/:runId/diagnostic-evidence', async (c) => {
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    if ([...new URL(c.req.url).searchParams.keys()].length > 0) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid diagnostic Evidence query', false);
    }
    try {
      const projection = await new DiagnosticEvidenceQueryStore(c.env.DB_CONTROL).get(
        c.req.param('runId'),
      );
      if (projection === null) {
        return errorResponse(c, 404, 'not_found', 'diagnostic Evidence Run not found', false);
      }
      c.header('cache-control', 'no-store');
      return c.json(projection);
    } catch (error) {
      if (error instanceof DiagnosticEvidenceError) {
        if (error.code === 'invalid_request') {
          return errorResponse(c, 400, 'invalid_argument', 'invalid diagnostic Evidence query', false);
        }
        return errorResponse(c, 409, 'conflict', 'diagnostic Evidence projection conflicts', false);
      }
      throw error;
    }
  });
  return app;
}
