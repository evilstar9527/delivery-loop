import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../env.js';
import { secureStructuredLogSink } from '../observability/structured-log.js';
import { configuredSecrets } from '../security/runtime-secrets.js';
import {
  OutboxDeadLetterError,
  OutboxDeadLetterStore,
} from '../outbox/outbox-dead-letter.js';
import { errorResponse } from './errors.js';
import { operationsAuthenticated } from './operations-auth.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const ALLOWED_LIST_QUERY_KEYS = new Set(['status', 'limit']);
const ReplayBodySchema = z.object({
  expectedOutboxAttemptCount: z.number().int().nonnegative(),
  reasonCode: z.enum(['operator_retry', 'upstream_recovered', 'configuration_fixed']),
}).strict();

function storeError(c: Parameters<typeof errorResponse>[0], error: OutboxDeadLetterError) {
  if (error.code === 'not_found') {
    return errorResponse(c, 404, 'not_found', 'dead letter not found', false);
  }
  if (error.code === 'state_conflict') {
    return errorResponse(c, 409, 'conflict', 'dead letter state conflicts', false);
  }
  return errorResponse(c, 400, 'invalid_argument', 'invalid dead letter request', false);
}

export function deadLetterApi(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.use('/v1/dead-letters/*', async (c, next) => {
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    await next();
  });
  app.get('/v1/dead-letters', async (c) => {
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const params = new URL(c.req.url).searchParams;
    if (
      [...params.keys()].some((key) => !ALLOWED_LIST_QUERY_KEYS.has(key)) ||
      [...ALLOWED_LIST_QUERY_KEYS].some((key) => params.getAll(key).length > 1)
    ) return errorResponse(c, 400, 'invalid_argument', 'invalid dead letter query', false);
    const status = params.get('status') ?? 'open';
    const rawLimit = params.get('limit') ?? '50';
    if (
      !['open', 'replay_requested', 'resolved'].includes(status) ||
      !/^[1-9][0-9]{0,2}$/.test(rawLimit) ||
      Number(rawLimit) > 100
    ) return errorResponse(c, 400, 'invalid_argument', 'invalid dead letter query', false);
    try {
      const deadLetters = await new OutboxDeadLetterStore(c.env.DB_CONTROL).list(
        status as 'open' | 'replay_requested' | 'resolved',
        Number(rawLimit),
      );
      c.header('cache-control', 'no-store');
      return c.json({ schemaVersion: '1', deadLetters });
    } catch (error) {
      if (error instanceof OutboxDeadLetterError) return storeError(c, error);
      throw error;
    }
  });
  app.post('/v1/dead-letters/:deadLetterId/replay', async (c) => {
    const deadLetterId = c.req.param('deadLetterId');
    if (!ID_PATTERN.test(deadLetterId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid dead letter request', false);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid dead letter request', false);
    }
    const parsed = ReplayBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid dead letter request', false);
    }
    try {
      const replay = await new OutboxDeadLetterStore(c.env.DB_CONTROL).replay({
        deadLetterId,
        expectedOutboxAttemptCount: parsed.data.expectedOutboxAttemptCount,
        reasonCode: parsed.data.reasonCode,
        requestedAt: new Date(),
      });
      secureStructuredLogSink({
        component: 'outbox_dead_letter',
        secrets: configuredSecrets(c.env),
      })({
        schemaVersion: '1',
        event: 'outbox_dead_letter_replay_requested',
        deadLetterId: replay.deadLetterId,
        outboxId: replay.outboxId,
        replayId: replay.replayId,
        reasonCode: parsed.data.reasonCode,
        created: replay.created,
        observedAt: new Date().toISOString(),
      });
      c.header('cache-control', 'no-store');
      return c.json({ accepted: true, ...replay }, 202);
    } catch (error) {
      if (error instanceof OutboxDeadLetterError) return storeError(c, error);
      throw error;
    }
  });
  return app;
}
