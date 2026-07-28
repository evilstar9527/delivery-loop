import { Hono } from 'hono';
import { MonitorAlertWebhookV1Schema } from '../domain/monitor-alert.js';
import type { Bindings } from '../env.js';
import { configuredSecrets } from '../security/runtime-secrets.js';
import { monitorAdapterRuntimeFromEnv } from '../monitor/runtime.js';
import { MONITOR_HMAC, verifyMonitorSignature } from '../monitor/webhook-hmac.js';
import {
  MonitorAlertCandidateStore,
  MonitorAlertIngressError,
  MonitorAlertIngressStore,
} from '../storage/monitor-alert-ingress-store.js';
import {
  MonitorAlertEvidenceStore,
  MonitorAlertEvidenceStoreError,
} from '../storage/monitor-alert-evidence-store.js';
import { errorResponse } from './errors.js';
import { operationsAuthenticated } from './operations-auth.js';

const MAX_BODY_BYTES = 256 * 1_024;

export function monitorAlertApi(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();

  app.post('/v1/webhooks/monitor/:adapter', async (c) => {
    if (c.req.param('adapter') !== 'generic') {
      return errorResponse(c, 404, 'not_found', 'monitor adapter not found', false);
    }
    let runtime;
    try {
      runtime = monitorAdapterRuntimeFromEnv(c.env);
    } catch {
      return errorResponse(c, 503, 'unavailable', 'monitor adapter configuration invalid', false);
    }
    if (runtime === null) {
      return errorResponse(c, 503, 'unavailable', 'monitor adapter not configured', false);
    }
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return errorResponse(c, 400, 'invalid_argument', 'monitor body must be JSON', false);
    }
    let body: string;
    try {
      body = await c.req.text();
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'monitor body must be JSON', false);
    }
    if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
      return errorResponse(c, 413, 'invalid_argument', 'monitor body is too large', false);
    }
    const signature = c.req.header(MONITOR_HMAC.signatureHeader);
    if (
      signature === undefined ||
      !await verifyMonitorSignature(runtime.secret, body, signature)
    ) {
      return errorResponse(c, 401, 'unauthenticated', 'monitor signature invalid', false);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body) as unknown;
    } catch {
      return errorResponse(c, 400, 'invalid_argument', 'monitor body must be JSON', false);
    }
    const parsed = MonitorAlertWebhookV1Schema.safeParse(raw);
    if (!parsed.success) {
      return errorResponse(c, 400, 'invalid_argument', 'monitor event is invalid', false);
    }
    try {
      const result = await new MonitorAlertIngressStore(
        c.env.DB_CONTROL,
        c.env.TASK_OBJECTS,
        {
          profile: runtime.profile,
          secrets: configuredSecrets(c.env),
        },
      ).accept(parsed.data);
      c.header('cache-control', 'no-store');
      return c.json({ schemaVersion: '1', accepted: true, ...result }, 202);
    } catch (error) {
      if (error instanceof MonitorAlertIngressError) {
        if (error.code === 'invalid_request') {
          return errorResponse(c, 400, 'invalid_argument', 'monitor event is invalid', false);
        }
        if (error.code === 'repository_not_allowed' || error.code === 'secret_detected') {
          return errorResponse(c, 403, 'policy_denied', 'monitor event is not allowed', false);
        }
        if (error.code === 'event_conflict' || error.code === 'state_conflict') {
          return errorResponse(c, 409, 'conflict', 'monitor event conflicts', false);
        }
        return errorResponse(c, 503, 'unavailable', 'monitor storage unavailable', true);
      }
      throw error;
    }
  });

  app.get('/v1/triage/monitor', async (c) => {
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
      const candidates = await new MonitorAlertCandidateStore(c.env.DB_CONTROL)
        .list(Number(rawLimit));
      c.header('cache-control', 'no-store');
      return c.json({ schemaVersion: '1', candidates });
    } catch (error) {
      if (error instanceof MonitorAlertIngressError) {
        return errorResponse(c, 409, 'conflict', 'triage projection conflicts', false);
      }
      throw error;
    }
  });

  app.get('/v1/operations/monitor-alert/evidence', async (c) => {
    if (!operationsAuthenticated(c.env.OPERATIONS_TOKEN, c.req.header('authorization'))) {
      return errorResponse(c, 401, 'unauthenticated', 'authentication required', false);
    }
    const params = new URL(c.req.url).searchParams;
    if (
      [...params.keys()].some((key) => key !== 'tenantKey' && key !== 'eventId') ||
      params.getAll('tenantKey').length !== 1 || params.getAll('eventId').length !== 1
    ) return errorResponse(c, 400, 'invalid_argument', 'invalid evidence query', false);
    try {
      const projection = await new MonitorAlertEvidenceStore(
        c.env.DB_CONTROL,
        c.env.TASK_OBJECTS,
      ).get({
        tenantKey: params.get('tenantKey') ?? '',
        eventId: params.get('eventId') ?? '',
      });
      c.header('cache-control', 'no-store');
      return c.json(projection);
    } catch (error) {
      if (error instanceof MonitorAlertEvidenceStoreError) {
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
