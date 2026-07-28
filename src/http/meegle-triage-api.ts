import { Hono } from 'hono';
import type { Bindings } from '../env.js';
import {
  MeegleTriageCandidateStore,
  MeegleWorkItemIngressError,
} from '../storage/meegle-work-item-ingress-store.js';
import { errorResponse } from './errors.js';
import { operationsAuthenticated } from './operations-auth.js';

export function meegleTriageApi(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.get('/v1/triage/meegle', async (c) => {
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const params = new URL(c.req.url).searchParams;
    if ([...params.keys()].some((key) => key !== 'limit') || params.getAll('limit').length > 1) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid triage query', false);
    }
    const rawLimit = params.get('limit') ?? '50';
    if (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid triage query', false);
    }
    try {
      const candidates = await new MeegleTriageCandidateStore(c.env.DB_CONTROL)
        .list(Number(rawLimit));
      c.header('cache-control', 'no-store');
      return c.json({ schemaVersion: '1', candidates });
    } catch (error) {
      if (error instanceof MeegleWorkItemIngressError) {
        return errorResponse(c, 409, 'conflict', 'triage projection conflicts', false);
      }
      throw error;
    }
  });
  return app;
}
