import { describe, expect, it } from 'vitest';
import { createCloudflareTelemetryToolBridge } from '../src/tools/cloudflare-telemetry-worker.js';

const INTERNAL_TOKEN = 'internal-tool-bridge-token-value';
const TOOL_BRIDGE_SK = 'tb_sk_live_tool_bridge_value';
const REQUEST_ID = '2085560401799000064';

const env = {
  TOOL_BRIDGE_INTERNAL_TOKEN: INTERNAL_TOKEN,
  TOOL_BRIDGE_BASE_URL: 'https://tool-bridge.example',
  TOOL_BRIDGE_SK,
  TOOL_BRIDGE_SLS_LOGSTORE: 'tipsy-chat',
  TOOL_BRIDGE_SLS_ENVIRONMENT: 'prod',
};

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

function result(traceId = REQUEST_ID): string {
  return [
    '**SLS [prod] query**',
    `WARN service/character.go:3237 trace_id:${traceId} uid:1778279597200329343`,
    'ACCESS middleware/access.go:79 path:/character/detail',
  ].join('\n');
}

describe('Tipsy Tool Bridge SLS adapter', () => {
  it('maps bounded locators to the fixed production SLS read tool', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const app = createCloudflareTelemetryToolBridge({
      fetcher: async (input, init) => {
        requests.push({ url: String(input), init: init ?? {} });
        return Response.json(result());
      },
    });

    const response = await app.fetch(call('/htbp/logs/search', {
      uid: '1778279597200329343',
      cid: '1780446342879247552',
    }), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      schemaVersion: '1',
      requestIds: [REQUEST_ID],
      result: result(),
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      'https://tool-bridge.example/mcp/tipsy/tipsy-analytics__sls_query_logs',
    );
    expect(requests[0]!.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(new Headers(requests[0]!.init.headers).get('authorization')).toBe(`Bearer ${TOOL_BRIDGE_SK}`);
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
      logstore: 'tipsy-chat',
      query: '1778279597200329343 AND 1780446342879247552',
      minutes_ago: 20160,
      limit: 20,
      env: 'prod',
    });
  });

  it('uses the exact selected SLS trace id for the second bounded query', async () => {
    const app = createCloudflareTelemetryToolBridge({
      fetcher: async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({ query: REQUEST_ID });
        return Response.json(result());
      },
    });

    const response = await app.fetch(call('/htbp/traces/get', { requestId: REQUEST_ID }), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: '1',
      requestId: REQUEST_ID,
      result: result(),
    });
  });

  it('fails closed for auth, schema, missing trace identity, upstream failure, and Secrets', async () => {
    const app = createCloudflareTelemetryToolBridge({
      fetcher: async (_input, init) => {
        const query = JSON.parse(String(init?.body)).query as string;
        if (query === 'missing') return Response.json('no trace here');
        if (query === 'upstream') return Response.json({ code: 'unavailable' }, { status: 503 });
        return Response.json(`${result()} ${TOOL_BRIDGE_SK}`);
      },
    });

    expect((await app.fetch(new Request('https://tool-bridge.test/htbp/logs/search', {
      method: 'POST',
    }), env)).status).toBe(401);
    expect((await app.fetch(call('/htbp/logs/search', { query: '*' }), env)).status).toBe(400);
    expect((await app.fetch(call('/htbp/traces/get', { requestId: 'missing' }), env)).status).toBe(503);
    expect((await app.fetch(call('/htbp/traces/get', { requestId: 'upstream' }), env)).status).toBe(503);
    expect((await app.fetch(call('/htbp/logs/search', { uid: '1778279597200329343' }), env)).status)
      .toBe(503);
  });

  it('rejects invalid provider configuration before forwarding', async () => {
    let calls = 0;
    const app = createCloudflareTelemetryToolBridge({
      fetcher: async () => {
        calls += 1;
        return Response.json(result());
      },
    });

    const response = await app.fetch(call('/htbp/logs/search', { uid: '1778279597200329343' }), {
      ...env,
      TOOL_BRIDGE_BASE_URL: 'http://untrusted.example',
    });

    expect(response.status).toBe(503);
    expect(calls).toBe(0);
  });
});
