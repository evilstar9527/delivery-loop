import { Hono } from 'hono';
import type { Bindings } from '../env.js';
import {
  MeegleWorkItemEvidenceStore,
  MeegleWorkItemEvidenceStoreError,
} from '../storage/meegle-work-item-evidence-store.js';
import { errorResponse } from './errors.js';
import { operationsAuthenticated } from './operations-auth.js';

export function meegleWorkItemEvidenceApi(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.get('/v1/operations/meegle/evidence', async (c) => {
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const params = new URL(c.req.url).searchParams;
    if (
      [...params.keys()].some((key) => key !== 'tenantKey' && key !== 'eventId') ||
      params.getAll('tenantKey').length !== 1 || params.getAll('eventId').length !== 1
    ) return errorResponse(c, 400, 'invalid_argument', 'invalid evidence query', false);
    try {
      const projection = await new MeegleWorkItemEvidenceStore(
        c.env.DB_CONTROL,
        c.env.TASK_OBJECTS,
      ).get({
        tenantKey: params.get('tenantKey') ?? '',
        eventId: params.get('eventId') ?? '',
      });
      c.header('cache-control', 'no-store');
      return c.json(projection);
    } catch (error) {
      if (error instanceof MeegleWorkItemEvidenceStoreError) {
        if (error.code === 'invalid_query') {
          return errorResponse(c, 400, 'invalid_argument', 'invalid evidence query', false);
        }
        return errorResponse(c, 409, 'conflict', 'evidence projection conflicts', false);
      }
      throw error;
    }
  });
  return app;
}
