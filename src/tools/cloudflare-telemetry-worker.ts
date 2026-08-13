import { Hono } from 'hono';
import { z } from 'zod';
import { SecretScanner } from '../security/redaction.js';

const MAX_RESPONSE_BYTES = 256 * 1_024;
const QUERY_WINDOW_MINUTES = 14 * 24 * 60;
const QUERY_LIMIT = 20;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const TOOL_BRIDGE_URL_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/?$/;
const SLS_LOGSTORE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SLS_ENVIRONMENT_PATTERN = /^(?:prod|test)$/;
const SLS_TOOL_PATH = '/mcp/tipsy/tipsy-analytics__sls_query_logs';

interface TelemetryBindings {
  TOOL_BRIDGE_INTERNAL_TOKEN: string;
  TOOL_BRIDGE_BASE_URL: string;
  TOOL_BRIDGE_SK: string;
  TOOL_BRIDGE_SLS_LOGSTORE: string;
  TOOL_BRIDGE_SLS_ENVIRONMENT: string;
}

interface TelemetryWorkerOptions {
  fetcher?: typeof fetch;
}

const EnvelopeSchema = z.object({
  arguments: z.record(z.string(), z.json()),
}).strict();

const LogArgumentsSchema = z.object({
  uid: z.string().regex(ID_PATTERN).optional(),
  cid: z.string().regex(ID_PATTERN).optional(),
  path: z.string().regex(ID_PATTERN).optional(),
}).strict().refine(
  (value) => value.uid !== undefined || value.cid !== undefined || value.path !== undefined,
  { message: 'one diagnostic locator is required' },
);

const TraceArgumentsSchema = z.object({
  requestId: z.string().regex(REQUEST_ID_PATTERN),
}).strict();

async function sameSecret(left: string, right: string): Promise<boolean> {
  const bytes = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [a, b] = await Promise.all([bytes(left), bytes(right)]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let difference = av.length ^ bv.length;
  for (let index = 0; index < Math.min(av.length, bv.length); index += 1) {
    difference |= av[index]! ^ bv[index]!;
  }
  return difference === 0;
}

function bearer(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length);
  return token.length > 0 ? token : null;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('invalid_response');
  if (response.body === null) throw new Error('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('invalid_response');
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function locatorQuery(input: z.infer<typeof LogArgumentsSchema>): string {
  return [input.uid, input.cid, input.path]
    .filter((value): value is string => value !== undefined)
    .join(' AND ');
}

function upstreamUrl(env: TelemetryBindings): string {
  if (!TOOL_BRIDGE_URL_PATTERN.test(env.TOOL_BRIDGE_BASE_URL)) {
    throw new Error('invalid_configuration');
  }
  return `${env.TOOL_BRIDGE_BASE_URL.replace(/\/$/, '')}${SLS_TOOL_PATH}`;
}

function upstreamArguments(env: TelemetryBindings, query: string): Record<string, unknown> {
  if (
    !SLS_LOGSTORE_PATTERN.test(env.TOOL_BRIDGE_SLS_LOGSTORE) ||
    !SLS_ENVIRONMENT_PATTERN.test(env.TOOL_BRIDGE_SLS_ENVIRONMENT)
  ) throw new Error('invalid_configuration');
  return {
    logstore: env.TOOL_BRIDGE_SLS_LOGSTORE,
    query,
    minutes_ago: QUERY_WINDOW_MINUTES,
    limit: QUERY_LIMIT,
    env: env.TOOL_BRIDGE_SLS_ENVIRONMENT,
  };
}

async function queryToolBridge(
  env: TelemetryBindings,
  fetcher: typeof fetch,
  query: string,
): Promise<string> {
  const response = await fetcher(upstreamUrl(env), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${env.TOOL_BRIDGE_SK}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(upstreamArguments(env, query)),
    // Cloudflare workerd rejects `redirect: error` before issuing the request.
    // Keep redirects observable and reject every non-2xx response below.
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('upstream_error');
  }
  const raw = await boundedJson(response);
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('invalid_response');
  const scanner = new SecretScanner({
    secrets: [env.TOOL_BRIDGE_SK, env.TOOL_BRIDGE_INTERNAL_TOKEN],
  });
  if (scanner.scanText(raw, '$.result').length > 0) throw new Error('invalid_response');
  return raw;
}

function requestIds(raw: string): string[] {
  const matches = [...raw.matchAll(/\btrace_id:([A-Za-z0-9][A-Za-z0-9_-]{0,199})\b/g)]
    .map((match) => match[1]!)
    .filter((value) => REQUEST_ID_PATTERN.test(value));
  return [...new Set(matches)].slice(0, QUERY_LIMIT);
}

export function createCloudflareTelemetryToolBridge(
  options: TelemetryWorkerOptions = {},
): Hono<{ Bindings: TelemetryBindings }> {
  const app = new Hono<{ Bindings: TelemetryBindings }>();
  const fetcher = options.fetcher ?? fetch;

  app.use('*', async (c, next) => {
    c.header('cache-control', 'no-store');
    const supplied = bearer(c.req.header('authorization'));
    if (supplied === null || !await sameSecret(supplied, c.env.TOOL_BRIDGE_INTERNAL_TOKEN)) {
      return c.json({ error: 'unauthenticated' }, 401);
    }
    await next();
  });

  app.post('/htbp/logs/search', async (c) => {
    const envelope = EnvelopeSchema.safeParse(await c.req.json().catch(() => null));
    const parsed = envelope.success
      ? LogArgumentsSchema.safeParse(envelope.data.arguments)
      : { success: false as const };
    if (!parsed.success) return c.json({ error: 'invalid_argument' }, 400);
    try {
      const result = await queryToolBridge(c.env, fetcher, locatorQuery(parsed.data));
      const ids = requestIds(result);
      if (ids.length === 0) throw new Error('invalid_response');
      return c.json({ schemaVersion: '1', requestIds: ids, result });
    } catch {
      return c.json({ error: 'upstream_unavailable' }, 503);
    }
  });

  app.post('/htbp/traces/get', async (c) => {
    const envelope = EnvelopeSchema.safeParse(await c.req.json().catch(() => null));
    const parsed = envelope.success
      ? TraceArgumentsSchema.safeParse(envelope.data.arguments)
      : { success: false as const };
    if (!parsed.success) return c.json({ error: 'invalid_argument' }, 400);
    try {
      const result = await queryToolBridge(c.env, fetcher, parsed.data.requestId);
      if (!requestIds(result).includes(parsed.data.requestId)) throw new Error('invalid_response');
      return c.json({ schemaVersion: '1', requestId: parsed.data.requestId, result });
    } catch {
      return c.json({ error: 'upstream_unavailable' }, 503);
    }
  });

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}

export const cloudflareTelemetryToolBridge = createCloudflareTelemetryToolBridge();

export default { fetch: cloudflareTelemetryToolBridge.fetch };
