import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../env.js';
import { secureStructuredLogSink } from '../observability/structured-log.js';
import { feishuDeliveryCardReconcilerFromEnv } from '../outbox/feishu-delivery-card-runtime.js';
import { FeishuDeliveryCardRefreshError } from '../reconciliation/feishu-delivery-card-reconciler.js';
import { configuredSecrets } from '../security/runtime-secrets.js';
import { errorResponse } from './errors.js';
import { operationsAuthenticated } from './operations-auth.js';

const RefreshBodySchema = z.object({
  expectedPresentationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/),
  expectedRevision: z.number().int().positive(),
  expectedDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();

export function feishuDeliveryCardRefreshApi(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.get('/v1/runs/:runId/feishu-card', async (c) => {
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    if (new URL(c.req.url).search !== '') {
      return errorResponse(c, 400, 'invalid_argument', 'invalid delivery card query', false);
    }
    let reconciler;
    try {
      reconciler = feishuDeliveryCardReconcilerFromEnv(c.env);
    } catch {
      return errorResponse(c, 503, 'unavailable', 'delivery card query unavailable', true);
    }
    if (reconciler === null) {
      return errorResponse(c, 503, 'unavailable', 'delivery card query unavailable', true);
    }
    const card = await reconciler.operationsView(c.req.param('runId'));
    if (card === null) {
      return errorResponse(c, 404, 'not_found', 'delivery card not found', false);
    }
    c.header('cache-control', 'no-store');
    return c.json({ schemaVersion: '1', card });
  });
  app.post('/v1/runs/:runId/feishu-card/refresh', async (c) => {
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    if (new URL(c.req.url).search !== '') {
      return errorResponse(c, 400, 'invalid_argument', 'invalid card refresh request', false);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid card refresh request', false);
    }
    const parsed = RefreshBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid card refresh request', false);
    }
    let reconciler;
    try {
      reconciler = feishuDeliveryCardReconcilerFromEnv(c.env);
    } catch {
      return errorResponse(c, 503, 'unavailable', 'card refresh unavailable', true);
    }
    if (reconciler === null) {
      return errorResponse(c, 503, 'unavailable', 'card refresh unavailable', true);
    }
    try {
      const result = await reconciler.requestRefresh({
        runId: c.req.param('runId'),
        ...parsed.data,
      });
      secureStructuredLogSink({
        component: 'feishu_delivery_card',
        secrets: configuredSecrets(c.env),
      })({
        schemaVersion: '1',
        event: 'feishu_delivery_card_refresh_requested',
        runId: result.runId,
        requestId: result.requestId,
        presentationId: result.presentationId,
        outboxId: result.outboxId,
        created: result.requestDisposition === 'created',
        observedAt: new Date().toISOString(),
      });
      c.header('cache-control', 'no-store');
      return c.json({ accepted: true, schemaVersion: '1', ...result }, 202);
    } catch (error) {
      if (!(error instanceof FeishuDeliveryCardRefreshError)) throw error;
      if (error.code === 'not_found') {
        return errorResponse(c, 404, 'not_found', 'delivery card not found', false);
      }
      if (error.code === 'stale_snapshot') {
        return errorResponse(c, 409, 'stale_revision', 'delivery card snapshot is stale', false);
      }
      return errorResponse(c, 400, 'invalid_argument', 'invalid card refresh request', false);
    }
  });
  return app;
}
