import { Hono } from 'hono';
import type { Bindings } from '../env.js';
import { DashboardOverviewStore } from '../storage/dashboard-overview-store.js';
import { DASHBOARD_HTML } from './dashboard-page.js';
import { errorResponse } from './errors.js';
import { operationsAuthenticated } from './operations-auth.js';

export function dashboardApi(now: () => Date = () => new Date()): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();

  // The board shell is a static, self-contained HTML document. It carries no
  // data; the browser fetches the JSON projection below with the operations
  // token the operator pastes in, so serving the shell itself stays open while
  // every byte of run/repo/sandbox data remains behind the token.
  app.get('/dashboard', (c) => {
    c.header('content-type', 'text/html; charset=utf-8');
    c.header('cache-control', 'no-store');
    return c.body(DASHBOARD_HTML);
  });

  app.get('/v1/dashboard/overview', async (c) => {
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const rawLimit = c.req.query('limit');
    let limit = 200;
    if (rawLimit !== undefined) {
      const parsed = Number(rawLimit);
      if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 500) {
        return errorResponse(c, 400, 'invalid_argument', 'invalid limit', false);
      }
      limit = parsed;
    }
    const overview = await new DashboardOverviewStore(c.env.DB_CONTROL).overview(now(), limit);
    c.header('cache-control', 'no-store');
    return c.json(overview);
  });

  return app;
}
