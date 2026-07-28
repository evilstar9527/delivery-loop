import { Hono } from 'hono';
import { z } from 'zod';
import { R2BackupManager } from '../backup/r2-backup-manager.js';
import type { Bindings } from '../env.js';
import {
  BackupRestoreCoordinator,
  BackupRestoreError,
  BackupSnapshotStore,
} from '../storage/backup-restore-store.js';
import { errorResponse } from './errors.js';
import { operationsAuthenticated } from './operations-auth.js';

const RestoreBodySchema = z.object({
  backupId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/),
  manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();

function coordinator(env: Bindings): BackupRestoreCoordinator {
  return new BackupRestoreCoordinator(
    env.DB_CONTROL,
    new R2BackupManager(env.BACKUP_OBJECTS, {
      task: env.TASK_OBJECTS,
      checkpoint: env.CHECKPOINT_OBJECTS,
    }),
  );
}

function storeError(c: Parameters<typeof errorResponse>[0], error: BackupRestoreError) {
  if (error.code === 'not_found') {
    return errorResponse(c, 404, 'not_found', 'backup restore resource not found', false);
  }
  if (error.code === 'invalid_request') {
    return errorResponse(c, 400, 'invalid_argument', 'invalid backup restore request', false);
  }
  return errorResponse(c, 409, 'conflict', 'backup restore state conflicts', false);
}

async function body(c: Parameters<typeof errorResponse>[0]): Promise<
  z.infer<typeof RestoreBodySchema> | null
> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return null;
  }
  const parsed = RestoreBodySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function backupApi(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.use('/v1/backups/*', async (c, next) => {
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    await next();
  });
  app.use('/v1/restores/*', async (c, next) => {
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    await next();
  });
  app.get('/v1/backups', async (c) => {
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const params = new URL(c.req.url).searchParams;
    if ([...params.keys()].some((key) => key !== 'limit') || params.getAll('limit').length > 1) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid backup query', false);
    }
    const rawLimit = params.get('limit') ?? '50';
    if (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid backup query', false);
    }
    try {
      const backups = await new BackupSnapshotStore(c.env.DB_CONTROL).list(Number(rawLimit));
      c.header('cache-control', 'no-store');
      return c.json({ schemaVersion: '1', backups });
    } catch (error) {
      if (error instanceof BackupRestoreError) return storeError(c, error);
      throw error;
    }
  });
  app.post('/v1/restores/:restoreId/fence', async (c) => {
    const parsed = await body(c);
    if (parsed === null) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid backup restore request', false);
    }
    try {
      const restore = await coordinator(c.env).fenceAndRestore({
        restoreId: c.req.param('restoreId'),
        ...parsed,
      });
      c.header('cache-control', 'no-store');
      return c.json({ accepted: true, ...restore }, 202);
    } catch (error) {
      if (error instanceof BackupRestoreError) return storeError(c, error);
      throw error;
    }
  });
  app.post('/v1/restores/:restoreId/complete', async (c) => {
    const parsed = await body(c);
    if (parsed === null) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid backup restore request', false);
    }
    try {
      const recovery = coordinator(c.env);
      const current = await recovery.get(c.req.param('restoreId'));
      if (current === null) throw new BackupRestoreError('not_found');
      if (
        current.backupId !== parsed.backupId ||
        current.manifestDigest !== parsed.manifestDigest
      ) throw new BackupRestoreError('manifest_conflict');
      const restore = await recovery.complete(current.restoreId);
      c.header('cache-control', 'no-store');
      return c.json({ completed: true, ...restore });
    } catch (error) {
      if (error instanceof BackupRestoreError) return storeError(c, error);
      throw error;
    }
  });
  app.get('/v1/restores/:restoreId', async (c) => {
    try {
      const restore = await coordinator(c.env).get(c.req.param('restoreId'));
      if (restore === null) throw new BackupRestoreError('not_found');
      c.header('cache-control', 'no-store');
      return c.json({ schemaVersion: '1', restore });
    } catch (error) {
      if (error instanceof BackupRestoreError) return storeError(c, error);
      throw error;
    }
  });
  return app;
}
