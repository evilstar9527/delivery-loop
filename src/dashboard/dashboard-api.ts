import { Hono } from 'hono';
import type { Bindings } from '../env.js';
import { errorResponse } from '../http/errors.js';
import { operationsAuthenticated } from '../http/operations-auth.js';
import { DASHBOARD_HTML } from './dashboard-page.js';
import { DashboardOverviewStore } from './overview-store.js';
import { DashboardApprovalStore } from './dashboard-approval-store.js';
import { TaskDetailStore } from './task-detail-store.js';
import { SandboxSessionStore } from './sandbox-session-store.js';
import {
  DashboardDeleteStore,
  type DeleteRunOutcome,
} from './dashboard-delete-store.js';
import {
  cloudflareSandboxEffectsFromEnv,
} from '../executor/plugins/cloudflare-sandbox/cloudflare-sandbox-runtime.js';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SANDBOX_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const MAX_DELETE_BATCH = 50;

/** Parses the shared delete request body. Absent body means "no cascade". */
async function deleteRequest(
  request: Request,
): Promise<{ cascadeSandboxes: boolean; runIds: string[] } | null> {
  let raw: unknown = {};
  const text = await request.text();
  if (text.trim().length > 0) {
    if (new TextEncoder().encode(text).length > 8_192) return null;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const cascade = body.cascadeSandboxes;
  if (cascade !== undefined && typeof cascade !== 'boolean') return null;
  let runIds: string[] = [];
  if (body.runIds !== undefined) {
    if (!Array.isArray(body.runIds)) return null;
    const unique = [...new Set(body.runIds)];
    if (
      unique.length === 0 || unique.length > MAX_DELETE_BATCH ||
      unique.some((id) => typeof id !== 'string' || !RUN_ID_PATTERN.test(id))
    ) return null;
    runIds = unique as string[];
  }
  const known = new Set(['cascadeSandboxes', 'runIds']);
  if (Object.keys(body).some((key) => !known.has(key))) return null;
  return { cascadeSandboxes: cascade === true, runIds };
}

/** True when nothing was removed solely because live containers are attached. */
function sandboxBlocked(outcomes: readonly DeleteRunOutcome[]): boolean {
  return outcomes.some((outcome) => outcome.status === 'sandbox_active');
}

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

  // Task detail: original request (from R2), agent DOD plan + progress, state.
  app.get('/v1/dashboard/runs/:runId', async (c) => {
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const runId = c.req.param('runId');
    if (!RUN_ID_PATTERN.test(runId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid run id', false);
    }
    const detail = await new TaskDetailStore(c.env.DB_CONTROL, c.env.TASK_OBJECTS).detail(runId);
    c.header('cache-control', 'no-store');
    if (detail === null) {
      return errorResponse(c, 404, 'not_found', 'run not found', false);
    }
    return c.json(detail);
  });

  // Operator approval of the pre-execution repo_write gate. This only records a
  // repo_write approval (the sole effect an awaiting_approval run waits on),
  // which the execution-progress reconciler then consumes to advance the run to
  // executing. It cannot approve merge or production_deploy — those stay
  // identity-bound and gate later states. Guarded by the same operations token
  // the board uses; the plan key is derived server-side from live state.
  app.post('/v1/dashboard/runs/:runId/approve', async (c) => {
    c.header('cache-control', 'no-store');
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const runId = c.req.param('runId');
    if (!RUN_ID_PATTERN.test(runId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid run id', false);
    }
    const result = await new DashboardApprovalStore(c.env.DB_CONTROL).approve(runId, now());
    if (result.status === 'not_approvable') {
      return errorResponse(c, 409, 'conflict', 'run is not awaiting approval', false);
    }
    return c.json(result, result.created ? 201 : 200);
  });

  // Live session for a run's sandbox: counter-only progress records the runner
  // writes to the container's stdout, plus stderr diagnostics. This is a pure
  // read — it cannot change execution state or reap a container.
  app.get('/v1/dashboard/runs/:runId/session', async (c) => {
    c.header('cache-control', 'no-store');
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const runId = c.req.param('runId');
    if (!RUN_ID_PATTERN.test(runId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid run id', false);
    }
    const session = await new SandboxSessionStore(c.env.DB_CONTROL, c.env).session(runId);
    if (session === null) {
      return errorResponse(c, 404, 'not_found', 'run has no active sandbox', false);
    }
    return c.json(session);
  });

  // Operator removal of a task from the board. This is deliberately NOT a row
  // deletion: 77 tables reference runs(run_id) and ten do not cascade, so the
  // DELETE would be rejected, and correlation/evidence reads are anchored on the
  // run row. The run is cancelled through the existing Attempt lifecycle path
  // (token revocation, lease fencing, outbox settle, workflow_cancel) and then
  // hidden. Live containers are only destroyed when the caller says so, which is
  // what the 409 below asks the operator to confirm.
  app.post('/v1/dashboard/runs/:runId/delete', async (c) => {
    c.header('cache-control', 'no-store');
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const runId = c.req.param('runId');
    if (!RUN_ID_PATTERN.test(runId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid run id', false);
    }
    const parsed = await deleteRequest(c.req.raw);
    if (parsed === null || parsed.runIds.length > 0) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid delete request', false);
    }
    const outcome = await new DashboardDeleteStore(c.env.DB_CONTROL, c.env, now)
      .deleteRun(runId, parsed.cascadeSandboxes);
    if (outcome.status === 'not_found') {
      return errorResponse(c, 404, 'not_found', 'run not found', false);
    }
    if (outcome.status === 'sandbox_active') {
      return c.json({ status: outcome.status, blocked: [outcome] }, 409);
    }
    if (outcome.status === 'conflict') {
      return errorResponse(c, 409, 'conflict', 'run cannot be removed in its current state', false);
    }
    return c.json(outcome);
  });

  // Batch removal. Reports one outcome per run rather than failing the whole
  // batch, so a mixed selection tells the operator exactly what happened. When
  // any run still has a live container and cascade was not authorised, nothing
  // in that batch is removed — the operator confirms once and retries.
  app.post('/v1/dashboard/runs/delete', async (c) => {
    c.header('cache-control', 'no-store');
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const parsed = await deleteRequest(c.req.raw);
    if (parsed === null || parsed.runIds.length === 0) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid delete request', false);
    }
    const store = new DashboardDeleteStore(c.env.DB_CONTROL, c.env, now);
    if (!parsed.cascadeSandboxes) {
      const blocking = await store.activeSandboxes(parsed.runIds);
      if (blocking.length > 0) {
        const blocked = [...new Set(blocking.map((sandbox) => sandbox.runId))].map((runId) => ({
          runId,
          status: 'sandbox_active' as const,
          sandboxes: blocking.filter((sandbox) => sandbox.runId === runId),
          terminatedSandboxes: [],
        }));
        return c.json({ status: 'sandbox_active', blocked, results: [] }, 409);
      }
    }
    const results: DeleteRunOutcome[] = [];
    for (const runId of parsed.runIds) {
      results.push(await store.deleteRun(runId, parsed.cascadeSandboxes));
    }
    return c.json({
      status: sandboxBlocked(results) ? 'sandbox_active' : 'ok',
      deleted: results.filter((result) => result.status === 'deleted').length,
      results,
    });
  });

  // Graceful sandbox termination, addressed by sandbox id so it also reaches
  // orphaned containers that no longer have a control-plane row (the only way
  // to reap those). The executor SIGTERMs the process and destroys the
  // container; run, attempt, plan and PR records are all left intact.
  app.post('/v1/dashboard/sandboxes/:sandboxId/cancel', async (c) => {
    c.header('cache-control', 'no-store');
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const sandboxId = c.req.param('sandboxId');
    if (!SANDBOX_ID_PATTERN.test(sandboxId)) {
      return errorResponse(c, 400, 'invalid_argument', 'invalid sandbox id', false);
    }
    const effects = cloudflareSandboxEffectsFromEnv(c.env);
    const origin = c.env.AGENT_EXECUTOR_URL;
    if (effects === null || origin === undefined) {
      return errorResponse(c, 503, 'unavailable', 'executor transport unconfigured', true);
    }
    try {
      const disposition = await effects.cancelSandbox(origin, sandboxId, 'run_cancelled');
      return c.json({ sandboxId, disposition });
    } catch {
      return errorResponse(c, 502, 'upstream_error', 'sandbox cancel failed', true);
    }
  });

  return app;
}
