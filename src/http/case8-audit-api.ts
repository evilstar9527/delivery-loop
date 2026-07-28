import { Hono } from 'hono';
import type { Bindings } from '../env.js';
import { Case8AuditLogger } from '../observability/case8-audit-log.js';
import { secureStructuredLogSink } from '../observability/structured-log.js';
import { configuredSecrets } from '../security/runtime-secrets.js';
import {
  Case8AuditReportError,
  Case8AuditReportStore,
} from '../storage/case8-audit-report-store.js';
import { errorResponse } from './errors.js';
import { operationsAuthenticated } from './operations-auth.js';

function reportError(c: Parameters<typeof errorResponse>[0], error: Case8AuditReportError) {
  if (error.code === 'invalid_request') {
    return errorResponse(c, 400, 'invalid_argument', 'invalid audit report request', false);
  }
  if (error.code === 'not_found') {
    return errorResponse(c, 404, 'not_found', 'audit report Run not found', false);
  }
  if (error.code === 'time_budget_exceeded') {
    return errorResponse(c, 504, 'timeout', 'audit report exceeded time budget', true);
  }
  return errorResponse(c, 409, 'conflict', 'audit report projection conflicts', false);
}

export function case8AuditApi(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.get('/v1/runs/:runId/audit', async (c) => {
    if (!operationsAuthenticated(
      c.env.OPERATIONS_TOKEN,
      c.req.header('authorization'),
    )) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const params = new URL(c.req.url).searchParams;
    if ([...params.keys()].length > 0) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid audit report query', false);
    }
    try {
      const report = await new Case8AuditReportStore(c.env.DB_CONTROL).generate(
        c.req.param('runId'),
      );
      new Case8AuditLogger(secureStructuredLogSink({
        component: 'case8_audit',
        secrets: configuredSecrets(c.env),
      })).generated(report);
      c.header('cache-control', 'no-store');
      c.header('server-timing', `case8;dur=${report.queryDurationMs}`);
      return c.json(report);
    } catch (error) {
      if (error instanceof Case8AuditReportError) return reportError(c, error);
      throw error;
    }
  });
  return app;
}
