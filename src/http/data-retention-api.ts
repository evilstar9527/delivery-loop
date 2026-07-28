import { Hono } from 'hono';
import { z } from 'zod';
import type { Bindings } from '../env.js';
import { DataRetentionStore } from '../storage/data-retention-store.js';
import { errorResponse } from './errors.js';
import { operationsAuthenticated } from './operations-auth.js';

const ScanBodySchema = z.object({
  mode: z.enum(['dry_run', 'execute']),
}).strict();

export function dataRetentionApi(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.post('/v1/data-retention/scans', async (c) => {
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    if ([...new URL(c.req.url).searchParams.keys()].length > 0) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid data retention request', false);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'invalid data retention request', false);
    }
    const parsed = ScanBodySchema.safeParse(raw);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid data retention request', false);
    }
    const scan = await new DataRetentionStore(
      c.env.DB_CONTROL,
      c.env.RAW_AGENT_OBJECTS,
    ).run(parsed.data.mode, 'operations', 25);
    c.header('cache-control', 'no-store');
    return c.json({ schemaVersion: '1', scan });
  });
  return app;
}
