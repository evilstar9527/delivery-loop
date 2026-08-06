import { describe, expect, it } from 'vitest';
import { createCloudflareTelemetryToolBridge } from '../src/tools/cloudflare-telemetry-worker.js';

const ACCOUNT_ID = 'b'.repeat(32);
const REQUEST_ID = 'request_id_1234';
const INTERNAL_TOKEN = 'internal-tool-bridge-token-value';
const OBSERVABILITY_TOKEN = 'cloudflare-observability-token-value';
const NOW = new Date('2026-08-06T12:00:00.000Z');

const env = {
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  CLOUDFLARE_OBSERVABILITY_TOKEN: OBSERVABILITY_TOKEN,
  TELEMETRY_SOURCE_SERVICE: 'delivery-loop-control-plane',
  TOOL_BRIDGE_INTERNAL_TOKEN: INTERNAL_TOKEN,
};

function event(source: Record<string, unknown> = { event: 'run_stuck_detected', component: 'run_stuck' }) {
  return {
    $metadata: {
      account: ACCOUNT_ID,
      service: 'delivery-loop-control-plane',
      requestId: REQUEST_ID,
      type: 'cf-worker',
    },
    $workers: { requestId: REQUEST_ID, truncated: false },
    dataset: 'cloudflare-workers',
    timestamp: NOW.getTime() - 1_000,
    source,
  };
}

function response(view: unknown, source?: Record<string, unknown>): Response {
  const value = event(source);
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result: {
      run: { accountId: ACCOUNT_ID, dry: true },
      ...(view === 'events'
        ? { events: { count: 1, events: [value] } }
        : { invocations: { [REQUEST_ID]: [value] } }),
    },
  });
}

function call(path: string, args: Record<string, unknown>, token = INTERNAL_TOKEN): Request {
  return new Request(`https://tool-bridge.test${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ arguments: args }),
  });
}

describe('Cloudflare telemetry tool bridge', () => {
  it('maps a safe component path to one bounded events query', async () => {
    const requests: Record<string, unknown>[] = [];
    const app = createCloudflareTelemetryToolBridge({
      now: () => NOW,
      fetcher: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        return response(body.view);
      },
    });

    const result = await app.fetch(call('/htbp/logs/search', { path: 'run_stuck' }), env);

    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toEqual({
      schemaVersion: '1',
      matched: 1,
      events: [{
        requestId: REQUEST_ID,
        timestamp: '2026-08-06T11:59:59.000Z',
        source: { event: 'run_stuck_detected', component: 'run_stuck' },
      }],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      view: 'events',
      dry: true,
      limit: 5,
      timeframe: {
        from: NOW.getTime() - 24 * 60 * 60_000,
        to: NOW.getTime(),
      },
      parameters: {
        filters: expect.arrayContaining([
          { key: '$metadata.service', operation: 'eq', type: 'string', value: 'delivery-loop-control-plane' },
          { key: 'component', operation: 'eq', type: 'string', value: 'run_stuck' },
        ]),
      },
    });
  });

  it('binds traces/get to the request id returned by logs/search', async () => {
    const app = createCloudflareTelemetryToolBridge({
      now: () => NOW,
      fetcher: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.view).toBe('invocations');
        expect(body).toMatchObject({
          parameters: {
            filters: expect.arrayContaining([
              { key: '$metadata.requestId', operation: 'eq', type: 'string', value: REQUEST_ID },
            ]),
          },
        });
        return response(body.view);
      },
    });

    const result = await app.fetch(call('/htbp/traces/get', { requestId: REQUEST_ID }), env);

    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      schemaVersion: '1',
      requestId: REQUEST_ID,
      events: [{ requestId: REQUEST_ID }],
    });
  });

  it('fails closed for missing auth, unknown arguments, and response Secrets', async () => {
    const app = createCloudflareTelemetryToolBridge({
      now: () => NOW,
      fetcher: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response(body.view, { authorization: OBSERVABILITY_TOKEN });
      },
    });

    const missingAuth = await app.fetch(new Request('https://tool-bridge.test/htbp/logs/search', {
      method: 'POST',
    }), env);
    expect(missingAuth.status).toBe(401);

    const invalid = await app.fetch(call('/htbp/logs/search', { query: '*' }), env);
    expect(invalid.status).toBe(400);

    const leaked = await app.fetch(call('/htbp/logs/search', { path: 'run_stuck' }), env);
    expect(leaked.status).toBe(503);
    expect(await leaked.json()).toEqual({ error: 'upstream_unavailable' });
  });

  it('rejects invocation events whose metadata does not match the requested id', async () => {
    const app = createCloudflareTelemetryToolBridge({
      now: () => NOW,
      fetcher: async () => {
        const mismatched = {
          ...event(),
          $metadata: {
            ...event().$metadata,
            requestId: 'different_request_id',
          },
          $workers: { requestId: 'different_request_id', truncated: false },
        };
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result: {
            run: { accountId: ACCOUNT_ID, dry: true },
            invocations: { [REQUEST_ID]: [mismatched] },
          },
        });
      },
    });

    const result = await app.fetch(call('/htbp/traces/get', { requestId: REQUEST_ID }), env);

    expect(result.status).toBe(503);
  });
});
