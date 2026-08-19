import { describe, expect, it } from 'vitest';
import { DirectToolBridgeDiagnosticClient } from '../src/runner/direct-tool-bridge.js';

const SK = 'tb_admin_direct_runtime_secret_value';
const TRACE_ID = '2085560401799000064';

function result(...traceIds: string[]): string {
  return traceIds.map((traceId) =>
    `WARN service/character.go:3237 trace_id:${traceId} cid:1780446342879247552`).join('\n');
}

describe('direct executor Tool Bridge runtime', () => {
  it('calls the exact HTBP SLS tool from the runtime and ignores short false-positive ids', async () => {
    const requests: Request[] = [];
    const client = new DirectToolBridgeDiagnosticClient({
      baseUrl: 'https://tool-bridge.example',
      sk: SK,
      logstore: 'tipsy-chat',
      environment: 'prod',
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(`${result('3', TRACE_ID)}\ntrace_id:${TRACE_ID}`);
      },
    });

    const response = await client.searchLogs({
      uid: '',
      cid: '1780446342879247552',
      path: '',
    });

    expect(response).toEqual({
      schemaVersion: '1',
      requestIds: [TRACE_ID],
      result: `${result('3', TRACE_ID)}\ntrace_id:${TRACE_ID}`,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      'https://tool-bridge.example/mcp/tipsy/tipsy-analytics__sls_query_logs',
    );
    expect(requests[0]!.redirect).toBe('manual');
    expect(requests[0]!.headers.get('authorization')).toBe(`Bearer ${SK}`);
    expect(await requests[0]!.json()).toEqual({
      logstore: 'tipsy-chat',
      query: '1780446342879247552',
      minutes_ago: 20160,
      limit: 20,
      env: 'prod',
    });
  });

  it('queries the selected exact trace id without a control-plane response adapter', async () => {
    const queries: string[] = [];
    const client = new DirectToolBridgeDiagnosticClient({
      baseUrl: 'https://tool-bridge.example/',
      sk: SK,
      logstore: 'lightspeed-hk',
      environment: 'test',
      fetch: async (_input, init) => {
        queries.push(String(JSON.parse(String(init?.body)).query));
        return Response.json(result(TRACE_ID));
      },
    });

    await expect(client.getTrace({ requestId: TRACE_ID })).resolves.toEqual({
      schemaVersion: '1',
      requestId: TRACE_ID,
      result: result(TRACE_ID),
    });
    expect(queries).toEqual([TRACE_ID]);
  });

  it('fails closed for redirects, malformed results, missing exact traces, and Secret reflection', async () => {
    const responseFor = (response: Response) => new DirectToolBridgeDiagnosticClient({
      baseUrl: 'https://tool-bridge.example',
      sk: SK,
      logstore: 'tipsy-chat',
      environment: 'prod',
      fetch: async () => response,
    });

    await expect(responseFor(new Response(null, { status: 302 })).searchLogs({
      uid: '1770369991319196871', cid: '', path: '',
    })).rejects.toMatchObject({ category: 'upstream_error' });
    await expect(responseFor(Response.json({ result: 'not a string' })).searchLogs({
      uid: '1770369991319196871', cid: '', path: '',
    })).rejects.toMatchObject({ category: 'invalid_response' });
    await expect(responseFor(Response.json(result('3085560401799000064'))).getTrace({
      requestId: TRACE_ID,
    })).rejects.toMatchObject({ category: 'invalid_response' });
    await expect(responseFor(Response.json(`${result(TRACE_ID)} ${SK}`)).getTrace({
      requestId: TRACE_ID,
    })).rejects.toMatchObject({ category: 'invalid_response' });
  });

  it('classifies timeout and upstream failures without exposing upstream bodies', async () => {
    const clientFor = (fetchImplementation: typeof fetch) =>
      new DirectToolBridgeDiagnosticClient({
        baseUrl: 'https://tool-bridge.example',
        sk: SK,
        logstore: 'tipsy-chat',
        environment: 'prod',
        fetch: fetchImplementation,
      });
    await expect(clientFor(async () => {
      throw new DOMException('bounded timeout detail', 'TimeoutError');
    }).searchLogs({ uid: '1770369991319196871' })).rejects.toMatchObject({
      category: 'timeout',
      message: 'Direct Tool Bridge call failed: timeout',
    });
    await expect(clientFor(async () => new Response('upstream secret body', { status: 503 }))
      .searchLogs({ uid: '1770369991319196871' })).rejects.toMatchObject({
        category: 'upstream_error',
        message: 'Direct Tool Bridge call failed: upstream_error',
      });
  });
});
