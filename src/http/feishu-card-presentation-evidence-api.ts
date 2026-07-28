import { Hono } from 'hono';
import type { Bindings } from '../env.js';
import { feishuDeliveryCardReconcilerFromEnv } from '../outbox/feishu-delivery-card-runtime.js';
import { errorResponse } from './errors.js';
import { operationsAuthenticated } from './operations-auth.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export function feishuCardPresentationEvidenceApi(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.get('/v1/operations/feishu-card-presentation/evidence', async (c) => {
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const url = new URL(c.req.url);
    if (
      [...url.searchParams.keys()].some((key) => key !== 'runId') ||
      url.searchParams.getAll('runId').length !== 1
    ) return errorResponse(c, 400, 'invalid_argument', 'invalid evidence query', false);
    const runId = url.searchParams.get('runId') ?? '';
    if (!ID_PATTERN.test(runId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid evidence query', false);
    }
    let reconciler;
    try {
      reconciler = feishuDeliveryCardReconcilerFromEnv(c.env);
    } catch {
      return errorResponse(c, 503, 'unavailable', 'evidence query unavailable', true);
    }
    if (reconciler === null) {
      return errorResponse(c, 503, 'unavailable', 'evidence query unavailable', true);
    }
    const evidence = await reconciler.presentationEvidenceView(runId);
    if (evidence === null) {
      return errorResponse(c, 404, 'not_found', 'card evidence not found', false);
    }
    c.header('cache-control', 'no-store');
    return c.json({ schemaVersion: '1', evidence });
  });
  return app;
}
